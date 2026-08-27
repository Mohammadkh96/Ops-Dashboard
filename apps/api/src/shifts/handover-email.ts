/**
 * The handover, as the desk reads it.
 *
 * This is an email, which means it is 2003 HTML: tables, inline styles, no
 * flexbox, no grid, no external stylesheet. Gmail strips <style> blocks in
 * some clients and collapses CSS grid in most, which is why the KPI strip
 * below is a <table> — as a grid it stacked into a vertical list on exactly
 * the phones the night shift reads it on.
 *
 * The shape follows what the desk already worked to:
 *
 *   • ONE PIVOT FOR THE DAY, not one email per shift in isolation. Metrics
 *     down the side, shifts across the top, the shift that just closed
 *     highlighted. Reading "deposits are down" matters only against the
 *     shifts either side of it.
 *   • THE DAY TOTAL COLUMN ONLY APPEARS FROM THE SECOND SHIFT. On the first
 *     one it would be a copy of the only column, which reads as a mistake.
 *   • REFUNDS ARE REPORTED AND NEVER NETTED. Volume is deposits plus
 *     withdrawals; a refund is not negative volume, it is a different event.
 *   • THE CURRENCY BREAKDOWN COLLAPSES to one sentence while everything is in
 *     one currency, and expands into a pivot by itself the first time a
 *     second currency appears. A table with one row repeating the totals
 *     above it is noise that teaches people to skip the section.
 */

export type HandoverColumn = {
  id: string;
  slot: number | null;
  name: string;
  agent: string;
  endedAtLocal: string | null;
  financials: {
    deposits: { count: number; amount: number };
    withdrawals: { count: number; amount: number };
    refunds: { count: number; amount: number };
    volume: number;
    declined: number;
    pending: number;
    successRate: number | null;
    byPsp: {
      psp: string;
      deposits: number;
      depositAmount: number;
      withdrawals: number;
      withdrawalAmount: number;
      refunds: number;
      refundAmount: number;
      volume: number;
    }[];
    byCurrency: { currency: string; count: number; amount: number }[];
    currencies: string[];
  };
};

export type HandoverInput = {
  day: string;
  dayLabel: string;
  slotsPerDay: number;
  columns: HandoverColumn[];
  /** The shift this email is about — highlighted, and named in the subject. */
  currentId: string;
  shiftName: string;
  from: string;
  to: string | null;
  durationMins: number;
  notes: string | null;
  kyc: unknown;
  tickets: { num?: string; subject?: string; desc?: string; status?: string }[];
  incidents: { ref: string; title: string; severity: string; status: string }[];
  openTasks: { title: string; priority: string; status: string }[];
};

// Takes only what can BE text. Accepting `unknown` here meant an object could
// reach it and render as "[object Object]" in somebody's inbox — escaped, and
// still wrong.
const esc = (v: string | number | null | undefined): string =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (m) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[m] as string,
  );

const money = (n: number) =>
  Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const short = (n: number) => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
};

const duration = (mins: number) =>
  mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;

// Inline styles, reused rather than repeated — an email has no stylesheet, and
// a table of literals is where a column ends up a different grey to its row.
const S = {
  head: "padding:9px 10px;font-family:'IBM Plex Mono',Consolas,monospace;font-size:9px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:#94A3B8;border-bottom:2px solid #E2E8F0;vertical-align:bottom;",
  rowLabel:
    'padding:10px 12px;border-bottom:1px solid #E2E8F0;font-size:12px;font-weight:600;color:#475569;white-space:nowrap;',
  cell: "padding:10px;border-bottom:1px solid #E2E8F0;font-family:'IBM Plex Mono',Consolas,monospace;font-size:12px;text-align:right;white-space:nowrap;",
  section:
    "font-family:'IBM Plex Mono',Consolas,monospace;font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#94A3B8;margin:0 0 10px;",
  table:
    'width:100%;border-collapse:collapse;background:#FFFFFF;border:1px solid #E2E8F0;border-radius:8px;overflow:hidden;margin-bottom:8px;',
  note: 'font-size:11px;color:#94A3B8;margin:0 0 24px;line-height:1.5;',
  th: "padding:8px 12px;font-family:'IBM Plex Mono',Consolas,monospace;font-size:9px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#94A3B8;text-align:left;",
  td: 'padding:9px 12px;border-bottom:1px solid #E2E8F0;font-size:12px;',
};

const SEVERITY_COLOURS: Record<string, { bg: string; fg: string }> = {
  CRITICAL: { bg: '#FEE2E2', fg: '#DC2626' },
  HIGH: { bg: '#FEF3C7', fg: '#D97706' },
  MEDIUM: { bg: '#DBEAFE', fg: '#2563EB' },
  LOW: { bg: '#DCFCE7', fg: '#16A34A' },
};

/** A column header: which shift, worked by whom, closed when. */
function columnHead(c: HandoverColumn, current: boolean): string {
  const tint = current ? 'background:#FFFBEB;color:#D97706;' : '';
  const sub = current ? '#B45309' : '#64748B';
  return `<th style="${S.head}text-align:right;${tint}">Shift ${c.slot ?? '?'}
    <div style="font-size:10px;font-weight:600;letter-spacing:0;text-transform:none;color:${sub};margin-top:3px;">${esc(c.name)} · ${esc(c.agent)}</div>
    <div style="font-size:9px;font-weight:400;letter-spacing:0;text-transform:none;color:#94A3B8;margin-top:2px;">${esc(c.endedAtLocal ?? '')}${current ? ' · this shift' : ''}</div></th>`;
}

export function buildHandoverEmail(input: HandoverInput): {
  subject: string;
  html: string;
} {
  const cols = input.columns;
  const showDayTotal = cols.length > 1;
  const isCurrent = (c: HandoverColumn) => c.id === input.currentId;
  const current = cols.find(isCurrent) ?? cols[cols.length - 1];
  const currentFin = current?.financials;

  // Day totals, summed from the columns rather than re-queried, so the row and
  // the total can never disagree about what a shift did.
  const agg = cols.reduce(
    (a, c) => {
      const f = c.financials;
      a.depCount += f.deposits.count;
      a.depAmount += f.deposits.amount;
      a.wdCount += f.withdrawals.count;
      a.wdAmount += f.withdrawals.amount;
      a.refCount += f.refunds.count;
      a.refAmount += f.refunds.amount;
      a.volume += f.volume;
      a.declined += f.declined;
      a.pending += f.pending;
      return a;
    },
    {
      depCount: 0,
      depAmount: 0,
      wdCount: 0,
      wdAmount: 0,
      refCount: 0,
      refAmount: 0,
      volume: 0,
      declined: 0,
      pending: 0,
    },
  );

  const caption = `${esc(input.dayLabel)} · shift${cols.length === 1 ? '' : 's'} ${cols
    .map((c) => c.slot ?? '?')
    .join(', ')} of ${Math.max(input.slotsPerDay, cols.length)}`;

  const pivotHead = `<tr>
      <th style="${S.head}text-align:left;">&nbsp;</th>
      ${cols.map((c) => columnHead(c, isCurrent(c))).join('')}
      ${showDayTotal ? `<th style="${S.head}text-align:right;background:#F1F5F9;color:#1E293B;border-left:1px solid #E2E8F0;">Day total<div style="font-size:10px;font-weight:600;letter-spacing:0;text-transform:none;color:#64748B;margin-top:3px;">${esc(input.dayLabel)}</div></th>` : ''}
    </tr>`;

  const metrics: {
    label: string;
    colour: string;
    cell: (f: HandoverColumn['financials']) => string;
    total: string;
  }[] = [
    {
      label: 'Deposits',
      colour: '#16A34A',
      cell: (f) => `${f.deposits.count} · $${money(f.deposits.amount)}`,
      total: `${agg.depCount} · $${money(agg.depAmount)}`,
    },
    {
      label: 'Withdrawals',
      colour: '#DC2626',
      cell: (f) => `${f.withdrawals.count} · $${money(f.withdrawals.amount)}`,
      total: `${agg.wdCount} · $${money(agg.wdAmount)}`,
    },
    {
      label: 'Refunds',
      colour: '#2563EB',
      cell: (f) => `${f.refunds.count} · $${money(f.refunds.amount)}`,
      total: `${agg.refCount} · $${money(agg.refAmount)}`,
    },
    {
      label: 'Declined',
      colour: '#64748B',
      cell: (f) => String(f.declined),
      total: String(agg.declined),
    },
    {
      label: 'Still in flight',
      colour: '#64748B',
      cell: (f) => String(f.pending),
      total: String(agg.pending),
    },
    {
      label: 'Approved rate',
      colour: '#64748B',
      // Null, not 0%: nothing was decided, which is a different fact from
      // everything being declined.
      cell: (f) => (f.successRate === null ? '—' : `${f.successRate}%`),
      total: '',
    },
  ];

  const pivotBody = metrics
    .map(
      (m) => `<tr>
      <td style="${S.rowLabel}">${m.label}</td>
      ${cols
        .map(
          (c) =>
            `<td style="${S.cell}color:${m.colour};${isCurrent(c) ? 'background:#FFFBEB;font-weight:700;' : ''}">${m.cell(c.financials)}</td>`,
        )
        .join('')}
      ${showDayTotal ? `<td style="${S.cell}color:${m.colour};font-weight:700;background:#F1F5F9;border-left:1px solid #E2E8F0;">${m.total || '—'}</td>` : ''}
    </tr>`,
    )
    .join('');

  const pivotTotal = `<tr>
      <td style="padding:12px;background:#1E293B;color:#fff;font-family:'IBM Plex Mono',Consolas,monospace;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;">Volume</td>
      ${cols
        .map(
          (c) =>
            `<td style="padding:12px 10px;background:${isCurrent(c) ? '#D97706' : '#334155'};color:#fff;font-family:'IBM Plex Mono',Consolas,monospace;font-size:13px;font-weight:700;text-align:right;white-space:nowrap;">$${money(c.financials.volume)}</td>`,
        )
        .join('')}
      ${showDayTotal ? `<td style="padding:12px 10px;background:#0F172A;color:#FBBF24;font-family:'IBM Plex Mono',Consolas,monospace;font-size:14px;font-weight:800;text-align:right;white-space:nowrap;border-left:1px solid #334155;">$${money(agg.volume)}</td>` : ''}
    </tr>`;

  // ── terminals, down the side ────────────────────────────────────────────
  const pspNames: string[] = [];
  const pspDay = new Map<
    string,
    { volume: number; dep: number; wd: number; ref: number }
  >();
  const pspCell = new Map<
    string,
    HandoverColumn['financials']['byPsp'][number]
  >();
  cols.forEach((c, i) => {
    for (const p of c.financials.byPsp) {
      if (!pspDay.has(p.psp)) {
        pspNames.push(p.psp);
        pspDay.set(p.psp, { volume: 0, dep: 0, wd: 0, ref: 0 });
      }
      const d = pspDay.get(p.psp)!;
      d.volume += p.volume;
      d.dep += p.depositAmount;
      d.wd += p.withdrawalAmount;
      d.ref += p.refundAmount;
      pspCell.set(`${p.psp}|${i}`, p);
    }
  });
  pspNames.sort(
    (a, b) => (pspDay.get(b)?.volume ?? 0) - (pspDay.get(a)?.volume ?? 0),
  );

  const pspRows = pspNames.length
    ? pspNames
        .map((name) => {
          const d = pspDay.get(name)!;
          return `<tr>
        <td style="padding:9px 10px;border-bottom:1px solid #E2E8F0;font-size:12px;font-weight:600;color:#1E293B;">${esc(name)}</td>
        ${cols
          .map((c, i) => {
            const p = pspCell.get(`${name}|${i}`);
            if (!p)
              return `<td style="${S.cell}color:#CBD5E1;${isCurrent(c) ? 'background:#FFFBEB;' : ''}">—</td>`;
            return `<td style="${S.cell}color:#D97706;${isCurrent(c) ? 'background:#FFFBEB;font-weight:700;' : ''}">$${money(p.volume)}<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">${p.deposits + p.withdrawals} tx</div></td>`;
          })
          .join('')}
        <td style="${S.cell}background:#F1F5F9;border-left:1px solid #E2E8F0;color:#D97706;font-weight:700;">${showDayTotal ? `$${money(d.volume)}` : ''}
          <div style="font-size:9px;font-weight:400;margin-top:2px;color:#16A34A;">D $${money(d.dep)}</div>
          <div style="font-size:9px;font-weight:400;color:#DC2626;">W $${money(d.wd)}</div>
          ${d.ref > 0 ? `<div style="font-size:9px;font-weight:400;color:#2563EB;">R $${money(d.ref)}</div>` : ''}
        </td>
      </tr>`;
        })
        .join('')
    : `<tr><td colspan="${cols.length + 2}" style="padding:14px;color:#94A3B8;font-size:12px;text-align:center;">No settled payments on any terminal.</td></tr>`;

  // ── currency ────────────────────────────────────────────────────────────
  const allCurrencies = Array.from(
    new Set(cols.flatMap((c) => c.financials.currencies)),
  );
  const currencyBlock =
    allCurrencies.length === 0
      ? // Nothing settled at all. "Everything settled in —" is the sentence a
        // template writes when it assumes there is always something; on a
        // genuinely quiet night it reads as a broken report rather than a
        // quiet night.
        `<p style="${S.section}">Currency</p>
    <div style="background:#FFFFFF;border:1px solid #E2E8F0;border-radius:8px;padding:14px 16px;margin-bottom:24px;font-size:12px;color:#475569;line-height:1.6;">
      Nothing settled in this period, so there is no currency to break down.
    </div>`
      : allCurrencies.length === 1
        ? `<p style="${S.section}">Currency</p>
    <div style="background:#FFFFFF;border:1px solid #E2E8F0;border-radius:8px;padding:14px 16px;margin-bottom:24px;font-size:12px;color:#475569;line-height:1.6;">
      Everything settled in <strong style="font-family:'IBM Plex Mono',Consolas,monospace;color:#1E293B;">${esc(allCurrencies[0])}</strong>, so the figures above are already the whole currency picture. A breakdown appears here by itself the first time a second currency is used.
    </div>`
        : `<p style="${S.section}">Currency — ${caption}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="${S.table}">
      <thead><tr>
        <th style="${S.head}text-align:left;">Currency</th>
        ${cols.map((c) => columnHead(c, isCurrent(c))).join('')}
        ${showDayTotal ? `<th style="${S.head}text-align:right;background:#F1F5F9;color:#1E293B;border-left:1px solid #E2E8F0;">Day total</th>` : ''}
      </tr></thead>
      <tbody>${allCurrencies
        .map((cur) => {
          const dayTotal = cols.reduce(
            (s, c) =>
              s +
              (c.financials.byCurrency.find((x) => x.currency === cur)
                ?.amount ?? 0),
            0,
          );
          return `<tr>
          <td style="padding:9px 10px;border-bottom:1px solid #E2E8F0;font-family:'IBM Plex Mono',Consolas,monospace;font-size:12px;font-weight:600;">${esc(cur)}</td>
          ${cols
            .map((c) => {
              const x = c.financials.byCurrency.find((y) => y.currency === cur);
              if (!x)
                return `<td style="${S.cell}color:#CBD5E1;${isCurrent(c) ? 'background:#FFFBEB;' : ''}">—</td>`;
              return `<td style="${S.cell}${isCurrent(c) ? 'background:#FFFBEB;font-weight:700;' : ''}">$${money(x.amount)}<div style="font-size:9px;color:#94A3B8;font-weight:400;margin-top:2px;">${x.count} tx</div></td>`;
            })
            .join('')}
          ${showDayTotal ? `<td style="${S.cell}background:#F1F5F9;border-left:1px solid #E2E8F0;font-weight:700;">$${money(dayTotal)}</td>` : ''}
        </tr>`;
        })
        .join('')}</tbody>
    </table>`;

  // ── KPI strip: a TABLE, because a grid stacks vertically in Gmail ───────
  const tiles = [
    {
      label: 'Deposits',
      value: `$${short(currentFin?.deposits.amount ?? 0)}`,
      colour: '#16A34A',
    },
    {
      label: 'Withdrawals',
      value: `$${short(currentFin?.withdrawals.amount ?? 0)}`,
      colour: '#DC2626',
    },
    {
      label: 'Refunds',
      value: `$${short(currentFin?.refunds.amount ?? 0)}`,
      colour: '#2563EB',
    },
    {
      label: 'Approved',
      value:
        currentFin?.successRate === null || currentFin === undefined
          ? '—'
          : `${currentFin.successRate}%`,
      colour: '#2563EB',
    },
    {
      label: 'Open tasks',
      value: String(input.openTasks.length),
      colour: input.openTasks.length ? '#D97706' : '#64748B',
    },
    {
      label: 'Open incidents',
      value: String(input.incidents.length),
      colour: input.incidents.length ? '#DC2626' : '#64748B',
    },
  ];
  const kpiStrip = `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;border-bottom:1px solid #E2E8F0;background:#FFFFFF;">
    <tr>${tiles
      .map(
        (t) =>
          `<td width="16.6%" style="padding:16px 6px;text-align:center;border-right:1px solid #E2E8F0;"><div style="font-family:'IBM Plex Mono',Consolas,monospace;font-size:15px;font-weight:700;color:${t.colour};white-space:nowrap;">${esc(t.value)}</div><div style="font-family:'IBM Plex Mono',Consolas,monospace;font-size:8px;letter-spacing:.6px;text-transform:uppercase;color:#94A3B8;margin-top:4px;">${t.label}</div></td>`,
      )
      .join('')}</tr>
  </table>`;

  // ── the lists ───────────────────────────────────────────────────────────
  const ticketRows = input.tickets.length
    ? input.tickets
        .map(
          (t) => `<tr>
        <td style="${S.td}font-family:'IBM Plex Mono',Consolas,monospace;font-weight:700;">#${esc(t.num || '—')}</td>
        <td style="${S.td}font-weight:600;">${esc(t.subject || '—')}</td>
        <td style="${S.td}color:#475569;">${esc(t.desc || '—')}</td>
        <td style="${S.td}">${esc(t.status || 'Pending')}</td>
      </tr>`,
        )
        .join('')
    : `<tr><td colspan="4" style="padding:12px;color:#94A3B8;font-size:12px;text-align:center;">No tickets carried over.</td></tr>`;

  const incidentRows = input.incidents.length
    ? input.incidents
        .map((i) => {
          const c =
            SEVERITY_COLOURS[String(i.severity).toUpperCase()] ??
            SEVERITY_COLOURS.MEDIUM;
          return `<tr>
        <td style="${S.td}font-family:'IBM Plex Mono',Consolas,monospace;">${esc(i.ref)}</td>
        <td style="${S.td}">${esc(i.title)}</td>
        <td style="${S.td}"><span style="font-family:'IBM Plex Mono',Consolas,monospace;font-size:10px;font-weight:700;padding:2px 8px;border-radius:3px;background:${c.bg};color:${c.fg};">${esc(i.severity)}</span></td>
        <td style="${S.td}color:#DC2626;font-family:'IBM Plex Mono',Consolas,monospace;font-size:11px;">${esc(i.status)}</td>
      </tr>`;
        })
        .join('')
    : `<tr><td colspan="4" style="padding:12px;color:#16A34A;font-size:12px;text-align:center;">No open incidents anywhere.</td></tr>`;

  const taskRows = input.openTasks.length
    ? `<p style="${S.section}">Left unfinished (${input.openTasks.length})</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="${S.table}">
      <tbody>${input.openTasks
        .map(
          (t) =>
            `<tr><td style="${S.td}">${esc(t.title)}</td><td style="${S.td}text-align:right;color:#64748B;font-size:11px;">${esc(t.priority)} · ${esc(t.status)}</td></tr>`,
        )
        .join('')}</tbody>
    </table>
    <p style="${S.note}">These carry to the next shift. Nothing here was hidden by closing the shift.</p>`
    : '';

  const kycBlock = input.kyc
    ? `<p style="${S.section}">KYC queue at close</p>
    <div style="background:#FFFFFF;border:1px solid #E2E8F0;border-radius:8px;padding:14px 16px;margin-bottom:24px;font-size:12px;color:#475569;line-height:1.8;">${kycLines(input.kyc)}</div>`
    : '';

  const notesBlock = input.notes
    ? `<p style="${S.section}">From ${esc(input.from)}</p>
    <div style="background:#FFFBEB;border:1px solid #FDE68A;border-left:3px solid #D97706;border-radius:0 8px 8px 0;padding:16px;font-size:13px;color:#1E293B;line-height:1.7;margin-bottom:24px;white-space:pre-wrap;">${esc(input.notes)}</div>`
    : '';

  const subject = `[Handover] ${input.shiftName} — ${input.from} → ${input.to ?? 'next'} · ${input.dayLabel}`;

  const html = `<div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:680px;margin:auto;background:#F8FAFC;color:#1E293B;border-radius:10px;overflow:hidden;border:1px solid #E2E8F0;">
  <div style="padding:22px 28px;background:#FFFFFF;border-bottom:2px solid #F1F5F9;">
    <div style="font-family:'IBM Plex Mono',Consolas,monospace;font-size:10px;font-weight:700;color:#D97706;letter-spacing:2px;text-transform:uppercase;margin-bottom:6px;">Shift handover</div>
    <div style="font-size:18px;font-weight:700;margin-bottom:4px;">${esc(input.shiftName)} shift</div>
    <div style="font-size:13px;color:#64748B;">Closed by <strong>${esc(input.from)}</strong> → <strong>${esc(input.to ?? 'nobody yet')}</strong> &nbsp;·&nbsp; ${duration(input.durationMins)} &nbsp;·&nbsp; <strong>${esc(input.dayLabel)}</strong>, shift <strong>${current?.slot ?? '?'} of ${Math.max(input.slotsPerDay, cols.length)}</strong></div>
  </div>
  ${kpiStrip}
  <div style="padding:24px 28px;">
    <p style="${S.section}">The day so far — ${caption}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="${S.table}">
      <thead>${pivotHead}</thead>
      <tbody>${pivotBody}${pivotTotal}</tbody>
    </table>
    <p style="${S.note}">Settled payments only, counted once at their latest state. Volume is deposits plus withdrawals; refunds are shown but never netted into it.</p>

    ${currencyBlock}

    <p style="${S.section}">By terminal — ${caption}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="${S.table}">
      <thead><tr>
        <th style="${S.head}text-align:left;">Terminal</th>
        ${cols.map((c) => columnHead(c, isCurrent(c))).join('')}
        <th style="${S.head}text-align:right;background:#F1F5F9;color:#1E293B;border-left:1px solid #E2E8F0;">${showDayTotal ? 'Day total' : 'Split'}</th>
      </tr></thead>
      <tbody>${pspRows}</tbody>
    </table>
    <p style="${S.note}"><span style="color:#16A34A;font-weight:600;">D</span> deposits · <span style="color:#DC2626;font-weight:600;">W</span> withdrawals · <span style="color:#2563EB;font-weight:600;">R</span> refunds, reported separately.</p>

    ${kycBlock}

    <p style="${S.section}">Tickets still open (${input.tickets.length})</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="${S.table}">
      <thead><tr style="background:#F8FAFC;"><th style="${S.th}">Ticket</th><th style="${S.th}">Subject</th><th style="${S.th}">Detail</th><th style="${S.th}">Status</th></tr></thead>
      <tbody>${ticketRows}</tbody>
    </table>
    <div style="margin-bottom:24px;"></div>

    <p style="${S.section}">Open incidents — all shifts (${input.incidents.length})</p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="${S.table}">
      <thead><tr style="background:#F8FAFC;"><th style="${S.th}">Ref</th><th style="${S.th}">What</th><th style="${S.th}">Severity</th><th style="${S.th}">Status</th></tr></thead>
      <tbody>${incidentRows}</tbody>
    </table>
    <p style="${S.note}">Everything still open, not only this shift&rsquo;s — the next person inherits all of it.</p>

    ${taskRows}
    ${notesBlock}
  </div>
  <div style="padding:14px 28px;background:#FFFFFF;border-top:1px solid #E2E8F0;font-family:'IBM Plex Mono',Consolas,monospace;font-size:10px;color:#94A3B8;">
    OpsOS · generated from the payment data, not from an upload
  </div>
</div>`;

  return { subject, html };
}

/** The KYC snapshot as a line per entity, however the desk recorded it. */
function kycLines(kyc: unknown): string {
  if (!kyc || typeof kyc !== 'object') return '—';
  const entries = Object.entries(kyc as Record<string, unknown>);
  if (!entries.length) return '—';
  return entries
    .map(([entity, v]) => {
      const o = (v ?? {}) as Record<string, unknown>;
      // Only counts and text get through. A nested object here would render as
      // "[object Object] pending", which is the kind of line people read past
      // for months.
      const text = (x: unknown): string | null =>
        typeof x === 'number' || (typeof x === 'string' && x.trim() !== '')
          ? String(x)
          : null;
      const bits = ['registered', 'approved', 'rejected', 'pending']
        .map((k) => [k, text(o[k])] as const)
        .filter(([, val]) => val !== null)
        .map(([k, val]) => `${esc(val)} ${k}`);
      const reasons = text(o.reasons) ? ` — ${esc(text(o.reasons))}` : '';
      const label = entity.replace(/([a-z])([A-Z])/g, '$1 $2');
      return `<div><strong style="text-transform:capitalize;">${esc(label)}</strong>: ${bits.length ? bits.join(', ') : 'not recorded'}${reasons}</div>`;
    })
    .join('');
}
