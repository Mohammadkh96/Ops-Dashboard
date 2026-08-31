import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Credentials at rest.
 *
 * PSP keys have to live in the database rather than the environment, because
 * the whole point of the "Add PSP" button is adding one without a redeploy.
 * That is a real cost — a database is backed up, replicated, and reachable
 * through every SQL injection an application will ever have — so nothing is
 * stored in the clear.
 *
 * AES-256-GCM. Authenticated, so a modified ciphertext fails to decrypt rather
 * than yielding plausible rubbish that gets sent to a payment provider as a
 * key. A fresh random IV per value, because reusing one under the same key in
 * GCM is not a weakness, it is a break: two ciphertexts under one IV leak the
 * XOR of the plaintexts and the authentication key with them.
 *
 * THE KEY IS NOT IN THE DATABASE. It comes from the environment, where the
 * host keeps it encrypted and out of every backup and dump. A stolen database
 * is then ciphertext and nothing else, which is the entire reason for this
 * file.
 *
 * WHAT THIS DOES NOT PROTECT AGAINST. Somebody who can run code in the API
 * process has the key and the database, so they have the credentials. That is
 * true of every design that lets a server use a credential, and pretending
 * otherwise is how people end up trusting a system more than it deserves. What
 * this contains is the much likelier accident: a leaked dump, a shared
 * read-replica, a screenshot of a table.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified and fastest for.
const TAG_BYTES = 16;

/** Marks a value as belonging to this scheme, and which version of it. */
const PREFIX = 'v1';

export class SecretBoxError extends Error {}

/**
 * The key, derived from the environment.
 *
 * SHA-256 of whatever CREDENTIALS_KEY holds, so any passphrase length produces
 * a valid 32-byte key. That is deliberately NOT a password-hashing function:
 * this value is a generated secret from `openssl rand`, not something a person
 * chose, so there is nothing for a slow KDF to defend against — and running one
 * on every request would cost more than it buys.
 */
function key(): Buffer {
  const raw = process.env.CREDENTIALS_KEY ?? '';
  if (raw.length < 32) {
    throw new SecretBoxError(
      'CREDENTIALS_KEY is not set, or is shorter than 32 characters. ' +
        'Generate one with `node -e "console.log(require(\'crypto\')' +
        '.randomBytes(48).toString(\'base64\'))"` and set it in the API ' +
        'environment. Without it, provider credentials cannot be stored or read.',
    );
  }
  return createHash('sha256').update(raw, 'utf8').digest();
}

/** Whether a key is configured at all, for reporting without throwing. */
export function credentialsKeyConfigured(): boolean {
  return (process.env.CREDENTIALS_KEY ?? '').length >= 32;
}

/**
 * Encrypts one secret.
 *
 * Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. The parts are separate
 * rather than concatenated because a length-prefixed blob is one off-by-one
 * away from decrypting the wrong bytes, and this is read by code that must
 * either work or fail loudly.
 */
export function seal(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const body = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [PREFIX, b64(iv), b64(tag), b64(body)].join('.');
}

/** Decrypts one secret, or throws. */
export function open(sealed: string): string {
  const parts = (sealed ?? '').split('.');
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new SecretBoxError(
      'That stored credential is not in a format this build understands.',
    );
  }
  const [, ivPart, tagPart, bodyPart] = parts;
  const iv = unb64(ivPart);
  const tag = unb64(tagPart);
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new SecretBoxError('That stored credential is malformed.');
  }

  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([
      decipher.update(unb64(bodyPart)),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // final() throws when the tag does not verify. The likeliest cause by far
    // is a CHANGED CREDENTIALS_KEY, not tampering — and somebody staring at
    // "unsupported state or unable to authenticate data" will not guess that.
    throw new SecretBoxError(
      'Could not decrypt a stored credential. The most likely cause is that ' +
        'CREDENTIALS_KEY has changed since it was saved — every credential ' +
        'stored under the old key has to be entered again.',
    );
  }
}

/**
 * Whether two secrets are the same, without leaking which byte differed.
 *
 * Only used for comparing a submitted value against a stored one; the lengths
 * are compared first because timingSafeEqual throws on a mismatch, and that
 * throw would itself be the timing signal it exists to avoid.
 */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/**
 * The last four characters, for confirming which key is stored.
 *
 * NOT for display on a screen — see integrations.service.ts on why a mask is a
 * poor idea in general. This exists for one narrow case: an administrator who
 * has just pasted a key and wants to confirm the right one landed. Four
 * characters of a 32-character key is not enough to reconstruct it, and the
 * person reading it already holds the whole thing.
 */
export function hint(plaintext: string): string {
  return plaintext.length <= 4 ? '••••' : `••••${plaintext.slice(-4)}`;
}

const b64 = (b: Buffer) => b.toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');
