import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import {
  credentialsKeyConfigured,
  hint,
  open,
  seal,
  sealedLength,
  SecretBoxError,
} from '../common/secret-box';
import {
  AUTH_MODES,
  callPsp,
  describeWebPage,
  looksLikeWebPage,
  providerError,
  suggestAuthMode,
  readBalances,
  type AuthMode,
  type EndpointConfig,
} from './psp-connector';

/**
 * The PSPs this dashboard talks to directly.
 *
 * Paymaxis already gives us the transactions. What it does not give us is the
 * BALANCE sitting at each provider — which is why the Start-shift form asks a
 * person to type it, with a note saying an empty box is honest and a zero is a
 * claim. That is the gap this closes: a reading nobody has to trust a human to
 * copy correctly at 4am.
 *
 * TERMINALS, NOT PROVIDERS, are the unit. "Paystrax_Tradin SL" and
 * "Paystrax_Tradin" are two accounts at one provider with two balances and two
 * keys, and the terminal name is what joins a row here to the payments already
 * in the database. It is stored exactly as Paymaxis reports it — a tidied-up
 * version joins to nothing.
 */

/** The terminals seen in the payment data, as the desk names them. */
export const KNOWN_TERMINALS: { terminal: string; provider: string }[] = [
  { terminal: 'BEEM_TradinSL', provider: 'beem' },
  { terminal: 'APS_Tradin SL', provider: 'aps' },
  { terminal: 'APS_Tradin SL_Payout', provider: 'aps' },
  { terminal: 'ForumPay_Tradin SL', provider: 'forumpay' },
  { terminal: 'ForumPay_Tradin', provider: 'forumpay' },
  { terminal: 'MT_Tradin SL', provider: 'mt' },
  { terminal: 'MT_Tradin', provider: 'mt' },
  { terminal: 'Paystrax_Tradin SL', provider: 'paystrax' },
  { terminal: 'Paystrax_Tradin', provider: 'paystrax' },
  { terminal: 'HP_Tradin', provider: 'hp' },
  { terminal: 'VirtualPay_Tradin', provider: 'virtualpay' },
];

@Injectable()
export class PspsService {
  private readonly log = new Logger(PspsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every connection, WITHOUT the credentials.
   *
   * The encrypted values never leave this service. There is no endpoint that
   * returns them, decrypted or otherwise — a key is written once and used from
   * the server, and a screen that could show it back is a screen that leaks it
   * to anybody who reaches that URL.
   */
  async list() {
    await this.seed();
    const rows = await this.prisma.pspConnection.findMany({
      orderBy: [{ provider: 'asc' }, { terminal: 'asc' }],
    });
    return rows.map((p) => ({
      id: p.id,
      terminal: p.terminal,
      provider: p.provider,
      label: p.label,
      baseUrl: p.baseUrl,
      authMode: p.authMode,
      authName: p.authName,
      /** Whether a key is stored, and its last four — never the key. */
      hasKey: Boolean(p.apiKeyEnc),
      hasSecret: Boolean(p.apiSecretEnc),
      keyHint: p.keyHint,
      /**
       * Lengths only. Providers state the expected length in their rejections
       * ("should be 60 characters, but is 30"), and that is unactionable
       * without knowing what was actually stored — the alternative is counting
       * the characters of a live secret somewhere it should not be pasted.
       */
      keyLength: p.apiKeyEnc ? sealedLength(p.apiKeyEnc) : null,
      secretLength: p.apiSecretEnc ? sealedLength(p.apiSecretEnc) : null,
      endpoints: p.endpoints ?? {},
      enabled: p.enabled,
      lastOkAt: p.lastOkAt?.toISOString() ?? null,
      lastTriedAt: p.lastTriedAt?.toISOString() ?? null,
      lastError: p.lastError,
      balances: p.balances ?? null,
      /** Configured enough to be worth testing. */
      ready: Boolean(p.baseUrl && p.apiKeyEnc),
    }));
  }

  /** Whether credentials can be stored at all on this deployment. */
  keyStatus() {
    return {
      configured: credentialsKeyConfigured(),
      variable: 'CREDENTIALS_KEY',
    };
  }

  /**
   * Puts the eleven known terminals in, once.
   *
   * Unconfigured rows, so the screen opens with the desk's own PSP names on it
   * rather than an empty page and a form. Only into a completely empty table —
   * a terminal somebody deliberately removed must not reappear tomorrow.
   */
  private async seed() {
    const count = await this.prisma.pspConnection.count().catch(() => -1);
    if (count !== 0) return;
    await this.prisma.pspConnection
      .createMany({
        data: KNOWN_TERMINALS.map((t) => ({
          terminal: t.terminal,
          provider: t.provider,
          label: t.terminal,
        })),
        skipDuplicates: true,
      })
      .catch(() => undefined);
    this.log.log(`Seeded ${KNOWN_TERMINALS.length} PSP terminals.`);
  }

  /** Adds one by hand — the "Add PSP" button. */
  async create(input: {
    terminal?: string;
    provider?: string;
    label?: string;
  }) {
    const terminal = (input.terminal ?? '').trim();
    if (!terminal) {
      throw new BadRequestException(
        'A terminal name is required. Use exactly the name that appears on the payments — that is what joins this to the data.',
      );
    }
    const existing = await this.prisma.pspConnection.findUnique({
      where: { terminal },
    });
    if (existing) {
      throw new BadRequestException(`"${terminal}" is already in the list.`);
    }
    const provider =
      (input.provider ?? '').trim().toLowerCase() ||
      terminal.split(/[_\s]/)[0].toLowerCase();

    return this.prisma.pspConnection.create({
      data: {
        terminal,
        provider,
        label: (input.label ?? '').trim() || terminal,
      },
    });
  }

  /**
   * Updates one, encrypting anything secret on the way in.
   *
   * An ABSENT key leaves the stored one alone; an EMPTY STRING clears it. The
   * difference matters because this form is reopened to change a URL far more
   * often than to change a key, and a blank field that wiped the credential
   * every time would make the screen a trap.
   */
  async update(
    id: string,
    input: {
      label?: string;
      provider?: string;
      baseUrl?: string;
      authMode?: string;
      authName?: string;
      apiKey?: string;
      apiSecret?: string;
      endpoints?: Record<string, EndpointConfig>;
      enabled?: boolean;
    },
  ) {
    const conn = await this.prisma.pspConnection.findUnique({ where: { id } });
    if (!conn) throw new NotFoundException('No such PSP connection.');

    if (input.authMode && !AUTH_MODES.includes(input.authMode as AuthMode)) {
      throw new BadRequestException(
        `"${input.authMode}" is not an auth mode. Use one of: ${AUTH_MODES.join(', ')}.`,
      );
    }
    if (input.baseUrl && !/^https:\/\//i.test(input.baseUrl.trim())) {
      throw new BadRequestException(
        'The base URL must start with https:// — plain http would send the API key unencrypted.',
      );
    }

    const data: Record<string, unknown> = {};
    if (input.label !== undefined) data.label = input.label.trim();
    if (input.provider !== undefined) {
      data.provider = input.provider.trim().toLowerCase();
    }
    if (input.baseUrl !== undefined) {
      data.baseUrl = input.baseUrl.trim().replace(/\/$/, '') || null;
    }
    if (input.authMode !== undefined) data.authMode = input.authMode;
    if (input.authName !== undefined) {
      data.authName = input.authName.trim() || null;
    }
    if (input.endpoints !== undefined) {
      // A whole URL here gets concatenated onto the base and fails later as
      // "not a valid URL", which reads like a broken base URL rather than the
      // one wrong field it is.
      for (const [name, ep] of Object.entries(input.endpoints)) {
        if (/^https?:\/\//i.test((ep?.path ?? '').trim())) {
          throw new BadRequestException(
            `The ${name} endpoint wants only the path, not a full address — "/v1/balances", not "${ep.path}". It is joined onto the base URL.`,
          );
        }
      }
      data.endpoints = input.endpoints;
    }
    if (input.enabled !== undefined) data.enabled = input.enabled;

    if (input.apiKey !== undefined) {
      if (input.apiKey === '') {
        data.apiKeyEnc = null;
        data.keyHint = null;
      } else {
        data.apiKeyEnc = this.sealOrExplain(input.apiKey);
        data.keyHint = hint(input.apiKey);
      }
    }
    if (input.apiSecret !== undefined) {
      data.apiSecretEnc =
        input.apiSecret === '' ? null : this.sealOrExplain(input.apiSecret);
    }

    // Enabling something that cannot work would put a green row on a screen
    // whose whole purpose is to say what is actually connected.
    const willHaveKey =
      input.apiKey !== undefined
        ? input.apiKey !== ''
        : Boolean(conn.apiKeyEnc);
    const willHaveUrl =
      input.baseUrl !== undefined
        ? Boolean(data.baseUrl)
        : Boolean(conn.baseUrl);
    if (data.enabled === true && !(willHaveKey && willHaveUrl)) {
      throw new BadRequestException(
        'Add a base URL and an API key before enabling this connection.',
      );
    }

    await this.prisma.pspConnection.update({ where: { id }, data });
    return { ok: true };
  }

  /** Removes one. Nothing else points at it, so this really is a delete. */
  async remove(id: string) {
    const conn = await this.prisma.pspConnection.findUnique({ where: { id } });
    if (!conn) throw new NotFoundException('No such PSP connection.');
    await this.prisma.pspConnection.delete({ where: { id } });
    return { ok: true, terminal: conn.terminal };
  }

  /**
   * Calls the provider now and reports exactly what came back.
   *
   * The raw response is returned to the caller, which is unusual and is the
   * point: nobody here has the provider's documentation, so the way the right
   * `recordsPath` and field paths get found is by looking at what the provider
   * actually sends. A test that only said "failed" would leave somebody
   * guessing at JSON shapes.
   *
   * The credential is never in that response — it goes out in a header and the
   * reply is the provider's, not ours.
   */
  async test(id: string, capability = 'balance') {
    const conn = await this.prisma.pspConnection.findUnique({ where: { id } });
    if (!conn) throw new NotFoundException('No such PSP connection.');

    const endpoints = (conn.endpoints ?? {}) as Record<string, EndpointConfig>;
    const endpoint = endpoints[capability];
    if (!endpoint?.path) {
      throw new BadRequestException(
        `No ${capability} endpoint configured for ${conn.label}. Add the path the provider's documentation gives, e.g. /v1/balances.`,
      );
    }

    let creds: { key?: string; secret?: string };
    try {
      creds = {
        key: conn.apiKeyEnc ? open(conn.apiKeyEnc) : undefined,
        secret: conn.apiSecretEnc ? open(conn.apiSecretEnc) : undefined,
      };
    } catch (e) {
      throw new BadRequestException(
        e instanceof SecretBoxError
          ? e.message
          : 'Could not read the stored credential.',
      );
    }

    const result = await callPsp(conn, endpoint, creds);
    const now = new Date();

    // A 200 carrying an HTML page is not a successful call with no balances in
    // it — it is the wrong server. Checked before anything tries to read
    // records out of it, because "check your field paths" against a page of
    // font declarations is an hour nobody gets back.
    if (looksLikeWebPage(result.body)) {
      const message = describeWebPage(result.body);
      await this.prisma.pspConnection.update({
        where: { id },
        data: { lastTriedAt: now, lastError: message.slice(0, 500) },
      });
      return {
        ok: false as const,
        status: result.status,
        error: message,
        ms: result.ms,
        body: preview(result.body),
      };
    }

    // A provider that says no inside a 200 is still saying no, and its own
    // words beat anything we would infer from an empty result.
    const stated = result.ok ? providerError(result.body) : null;
    if (stated) {
      await this.prisma.pspConnection.update({
        where: { id },
        data: { lastTriedAt: now, lastError: stated.slice(0, 500) },
      });
      return {
        ok: false as const,
        status: result.status,
        error: `The provider answered, but refused: ${stated}`,
        ms: result.ms,
        body: preview(result.body),
      };
    }

    if (!result.ok) {
      // Our reading of the status code is a guess between four likely
      // mistakes; the provider's own sentence is not. "no api key" says which
      // of the four it is, where "check the API key, and whether it expects a
      // different auth mode" leaves somebody re-typing a key that was right.
      const said = providerError(result.body);
      // And when it named the scheme it wants, that beats both.
      const suggestion = suggestAuthMode(result.headers);
      const message = [
        result.error,
        said ? `The provider said: ${said}` : null,
        suggestion,
      ]
        .filter(Boolean)
        .join(' ');
      await this.prisma.pspConnection.update({
        where: { id },
        data: { lastTriedAt: now, lastError: message.slice(0, 500) },
      });
      return {
        ok: false as const,
        status: result.status,
        error: message,
        ms: result.ms,
        // What arrived, so a wrong path is diagnosable rather than mysterious.
        body: preview(result.body),
        headers: result.headers,
      };
    }

    const balances =
      capability === 'balance' ? readBalances(result.body, endpoint) : [];
    await this.prisma.pspConnection.update({
      where: { id },
      data: {
        lastTriedAt: now,
        lastOkAt: now,
        lastError: null,
        ...(capability === 'balance' && balances.length
          ? { balances: { at: now.toISOString(), rows: balances } }
          : {}),
      },
    });

    return {
      ok: true as const,
      status: result.status,
      ms: result.ms,
      balances,
      /** Said plainly: reaching the provider and reading it are two things. */
      note: balances.length
        ? undefined
        : 'The provider answered, but no balances could be read from it. Check the records path and the field paths against the response below.',
      body: preview(result.body),
    };
  }

  /** Reads every enabled connection — what the desk sees as "balances now". */
  async refreshAll() {
    const rows = await this.prisma.pspConnection.findMany({
      where: { enabled: true },
    });
    const results: { terminal: string; ok: boolean; error?: string }[] = [];
    for (const conn of rows) {
      try {
        const r = await this.test(conn.id, 'balance');
        results.push({ terminal: conn.terminal, ok: r.ok });
      } catch (e) {
        results.push({
          terminal: conn.terminal,
          ok: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    return { checked: results.length, results };
  }

  /** The balances the desk should see, newest reading per terminal. */
  async balances() {
    const rows = await this.prisma.pspConnection.findMany({
      where: { enabled: true },
      select: {
        terminal: true,
        label: true,
        provider: true,
        balances: true,
        lastOkAt: true,
        lastError: true,
      },
    });
    return rows.map((r) => ({
      terminal: r.terminal,
      label: r.label,
      provider: r.provider,
      reading: r.balances ?? null,
      at: r.lastOkAt?.toISOString() ?? null,
      // A stale reading beside its age, rather than a number pretending to be
      // current. The shift form asks for a balance "you inherited" — one from
      // six hours ago is not that.
      error: r.lastError,
    }));
  }

  private sealOrExplain(value: string): string {
    try {
      return seal(value);
    } catch (e) {
      throw new BadRequestException(
        e instanceof SecretBoxError
          ? e.message
          : 'Could not encrypt that credential.',
      );
    }
  }
}

/**
 * As much of a response as is useful to look at, and no more.
 *
 * Truncated because a provider's transaction list can be megabytes, and this
 * travels to a browser to be read by a person configuring field paths — the
 * first few hundred characters are where the shape is visible.
 */
function preview(body: unknown): unknown {
  if (body === undefined) return undefined;
  // An HTML page's first 4000 characters are `@font-face` rules. They are not
  // a shape anybody can map field paths onto, and the one useful thing about
  // the page — which page it is — has already been said in the error above.
  if (looksLikeWebPage(body)) {
    const text = body as string;
    return `An HTML page of ${text.length} characters. Not shown: it is a web page, not API data.`;
  }
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  if (text.length <= 4000) return body;
  return `${text.slice(0, 4000)}\n… (${text.length - 4000} more characters)`;
}
