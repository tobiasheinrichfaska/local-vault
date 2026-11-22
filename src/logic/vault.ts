// Data at rest: everything a device stores is AES-GCM encrypted. One random data key encrypts it;
// the data key itself lies wrapped — by the device key alone (non-extractable, the browser uses it,
// nobody reads it out), or with the app lock on also by a key from the password (PBKDF2), and that
// again by the device key. Turning the lock on or off, or a new password, only wraps the data key
// anew; the data stays as it is. Every piece is bound to its slot (additional data), so pieces
// cannot be swapped between slots. The stored markers carry the app's prefix.
import { base64url, fromBase64url } from './base64url.ts';
import { DEFAULT_TEXTS } from './texts.ts';

const envelope = (prefix: string) => `${prefix}-vault:1`;
const bundleMarker = (prefix: string) => `${prefix}-vault-bundle:1`;
const AES = { name: 'AES-GCM', length: 256 } as const;
/** OWASP 2023 for PBKDF2-HMAC-SHA256; about a second on a phone, once per unlocking. */
export const ROUNDS = 600_000;
export const MIN_PASSWORD = 6;

const utf8 = (text: string) => new TextEncoder().encode(text);
const random = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const additional = (prefix: string, slot: string) => utf8(`${envelope(prefix)}|${slot}`);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isB64 = (v: unknown, min = 1): v is string =>
  typeof v === 'string' && v.length >= min && /^[A-Za-z0-9_-]+$/.test(v);

/** The device key: never leaves the browser, also wraps the data key. */
export function createDeviceKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(AES, false, ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']);
}

/** A new data key — extractable only until it is wrapped (`bundleWithoutLock`, `bundleWithLock`). */
export function createDataKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(AES, true, ['encrypt', 'decrypt']);
}

export interface Piece {
  readonly iv: Uint8Array;
  readonly ct: Uint8Array;
}

export async function seal(
  prefix: string,
  key: CryptoKey,
  slot: string,
  plain: Uint8Array,
): Promise<Piece> {
  const iv = random(12);
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: additional(prefix, slot) },
    key,
    new Uint8Array(plain),
  );
  return { iv, ct: new Uint8Array(ct) };
}

/** Undefined when the key is another one, the slot another one or the piece was changed. */
export async function open(
  prefix: string,
  key: CryptoKey,
  slot: string,
  piece: Piece,
): Promise<Uint8Array | undefined> {
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: new Uint8Array(piece.iv),
        additionalData: additional(prefix, slot),
      },
      key,
      new Uint8Array(piece.ct),
    );
    return new Uint8Array(plain);
  } catch {
    return undefined;
  }
}

/** A stored text, encrypted: `{"m":"<prefix>-vault:1","iv":…,"ct":…}`. */
export async function sealText(
  prefix: string,
  key: CryptoKey,
  slot: string,
  text: string,
): Promise<string> {
  const { iv, ct } = await seal(prefix, key, slot, utf8(text));
  return JSON.stringify({ m: envelope(prefix), iv: base64url(iv), ct: base64url(ct) });
}

function pieceFrom(prefix: string, raw: string): Piece | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isObject(value) ||
    value.m !== envelope(prefix) ||
    !isB64(value.iv, 16) ||
    !isB64(value.ct, 22)
  ) {
    return undefined;
  }
  return { iv: fromBase64url(value.iv), ct: fromBase64url(value.ct) };
}

/** Whether a stored text is encrypted (a plain one is never read, there is no way back). */
export function isSealed(prefix: string, raw: string): boolean {
  return pieceFrom(prefix, raw) !== undefined;
}

export async function openText(
  prefix: string,
  key: CryptoKey,
  slot: string,
  raw: string,
): Promise<string | undefined> {
  const piece = pieceFrom(prefix, raw);
  const plain = piece && (await open(prefix, key, slot, piece));
  if (!plain) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch {
    return undefined;
  }
}

/** The wrapped data key as it is stored. */
export type Bundle =
  | { readonly m: string; readonly kind: 'device'; readonly iv: string; readonly ct: string }
  | {
      readonly m: string;
      readonly kind: 'password';
      readonly salt: string;
      readonly rounds: number;
      readonly ivPassword: string;
      readonly iv: string;
      readonly ct: string;
    };

const BUNDLE_SLOT = 'data-key';

async function passwordKey(password: string, salt: Uint8Array, rounds: number) {
  const base = await crypto.subtle.importKey(
    'raw',
    utf8(password.normalize('NFC')),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new Uint8Array(salt), iterations: rounds },
    base,
    AES,
    false,
    ['wrapKey', 'unwrapKey'],
  );
}

const gcm = (prefix: string, iv: Uint8Array) => ({
  name: 'AES-GCM',
  iv: new Uint8Array(iv),
  additionalData: additional(prefix, BUNDLE_SLOT),
});

/** The data key wrapped by the device key only (no app lock). */
export async function bundleWithoutLock(
  prefix: string,
  device: CryptoKey,
  data: CryptoKey,
): Promise<Bundle> {
  const iv = random(12);
  const ct = new Uint8Array(await crypto.subtle.wrapKey('raw', data, device, gcm(prefix, iv)));
  return { m: bundleMarker(prefix), kind: 'device', iv: base64url(iv), ct: base64url(ct) };
}

/** The data key wrapped by the password's key, and that by the device key (app lock on). */
export async function bundleWithLock(
  prefix: string,
  device: CryptoKey,
  data: CryptoKey,
  password: string,
  rounds = ROUNDS,
): Promise<Bundle> {
  const salt = random(16);
  const ivPassword = random(12);
  const inner = new Uint8Array(
    await crypto.subtle.wrapKey(
      'raw',
      data,
      await passwordKey(password, salt, rounds),
      gcm(prefix, ivPassword),
    ),
  );
  const { iv, ct } = await seal(prefix, device, BUNDLE_SLOT, inner);
  return {
    m: bundleMarker(prefix),
    kind: 'password',
    salt: base64url(salt),
    rounds,
    ivPassword: base64url(ivPassword),
    iv: base64url(iv),
    ct: base64url(ct),
  };
}

export function parseBundle(prefix: string, raw: unknown): Bundle | undefined {
  const m = bundleMarker(prefix);
  if (!isObject(raw) || raw.m !== m || !isB64(raw.iv, 16) || !isB64(raw.ct, 22)) {
    return undefined;
  }
  const { iv, ct } = raw;
  if (raw.kind === 'device') return { m, kind: 'device', iv, ct };
  const { salt, rounds, ivPassword } = raw;
  return raw.kind === 'password' &&
    isB64(salt, 22) &&
    isB64(ivPassword, 16) &&
    typeof rounds === 'number' &&
    Number.isInteger(rounds) &&
    rounds >= 1000 &&
    rounds <= 10_000_000
    ? { m, kind: 'password', salt, rounds, ivPassword, iv, ct }
    : undefined;
}

/**
 * The data key from its bundle; undefined for a wrong password (or another device key). `extractable`
 * only to wrap it anew (lock on/off, new password) — in use it stays non-extractable.
 */
export async function openBundle(
  prefix: string,
  device: CryptoKey,
  bundle: Bundle,
  password?: string,
  extractable = false,
): Promise<CryptoKey | undefined> {
  try {
    if (bundle.kind === 'device') {
      return await crypto.subtle.unwrapKey(
        'raw',
        new Uint8Array(fromBase64url(bundle.ct)),
        device,
        gcm(prefix, fromBase64url(bundle.iv)),
        AES,
        extractable,
        ['encrypt', 'decrypt'],
      );
    }
    if (password === undefined) return undefined;
    const inner = await open(prefix, device, BUNDLE_SLOT, {
      iv: fromBase64url(bundle.iv),
      ct: fromBase64url(bundle.ct),
    });
    if (!inner) return undefined;
    return await crypto.subtle.unwrapKey(
      'raw',
      new Uint8Array(inner),
      await passwordKey(password, fromBase64url(bundle.salt), bundle.rounds),
      gcm(prefix, fromBase64url(bundle.ivPassword)),
      AES,
      extractable,
      ['encrypt', 'decrypt'],
    );
  } catch {
    return undefined;
  }
}

/** Why a password is not taken, or undefined. */
export function checkPassword(
  password: string,
  repeated: string,
  texts: Pick<typeof DEFAULT_TEXTS, 'passwordTooShort' | 'passwordsDiffer'> = DEFAULT_TEXTS,
): string | undefined {
  if ([...password].length < MIN_PASSWORD) return texts.passwordTooShort(MIN_PASSWORD);
  if (password !== repeated) return texts.passwordsDiffer;
  return undefined;
}

// ---------------------------------------------------------------- users mode (key ring)
//
// An alternative to the device lock for apps with several people on one device: the data key is stored
// only wrapped by a key from each user's passphrase (PBKDF2), one entry per user. Without a login nothing
// can be opened; the device key plays no part. An entry is the user's key in the app and — as text — what
// an app may keep for him on a server (it cannot unwrap it without the passphrase).

const usersMarker = (prefix: string) => `${prefix}-vault-users:1`;

export interface UserEntry {
  readonly user: string;
  readonly rounds: number;
  readonly salt: string;
  readonly iv: string;
  readonly ct: string;
}
export interface UsersBundle {
  readonly m: string;
  readonly kind: 'users';
  readonly entries: readonly UserEntry[];
}

export const isUserName = (v: unknown): v is string =>
  typeof v === 'string' &&
  v !== '' &&
  [...v].length <= 64 &&
  !/[\u0000-\u001f\u007f]/.test(v) &&
  v === v.trim();

const gcmUser = (prefix: string, user: string, iv: Uint8Array) => ({
  name: 'AES-GCM',
  iv: new Uint8Array(iv),
  additionalData: utf8(`${usersMarker(prefix)}|${user}`),
});

/** Wraps the (extractable) data key for one user. */
export async function createUserEntry(
  prefix: string,
  user: string,
  passphrase: string,
  data: CryptoKey,
  rounds = ROUNDS,
): Promise<UserEntry> {
  if (!isUserName(user)) throw new RangeError('Invalid user name');
  const salt = random(16);
  const iv = random(12);
  const ct = new Uint8Array(
    await crypto.subtle.wrapKey(
      'raw',
      data,
      await passwordKey(passphrase, salt, rounds),
      gcmUser(prefix, user, iv),
    ),
  );
  return { user, rounds, salt: base64url(salt), iv: base64url(iv), ct: base64url(ct) };
}

/**
 * The data key of an entry; undefined for a wrong passphrase. `extractable` only to wrap it for another
 * user — in use it stays non-extractable.
 */
export async function openUserEntry(
  prefix: string,
  entry: UserEntry,
  passphrase: string,
  extractable = false,
): Promise<CryptoKey | undefined> {
  try {
    return await crypto.subtle.unwrapKey(
      'raw',
      new Uint8Array(fromBase64url(entry.ct)),
      await passwordKey(passphrase, fromBase64url(entry.salt), entry.rounds),
      gcmUser(prefix, entry.user, fromBase64url(entry.iv)),
      AES,
      extractable,
      ['encrypt', 'decrypt'],
    );
  } catch {
    return undefined;
  }
}

function entryFrom(raw: unknown): UserEntry | undefined {
  if (!isObject(raw)) return undefined;
  const { user, rounds, salt, iv, ct } = raw;
  return isUserName(user) &&
    typeof rounds === 'number' &&
    Number.isInteger(rounds) &&
    rounds >= 1000 &&
    rounds <= 10_000_000 &&
    isB64(salt, 22) &&
    isB64(iv, 16) &&
    isB64(ct, 22)
    ? { user, rounds, salt, iv, ct }
    : undefined;
}

/** The stored key ring, strictly; undefined for anything else (also duplicate users, no entry at all). */
export function parseUsersBundle(prefix: string, raw: unknown): UsersBundle | undefined {
  if (
    !isObject(raw) ||
    raw.m !== usersMarker(prefix) ||
    raw.kind !== 'users' ||
    !Array.isArray(raw.entries)
  ) {
    return undefined;
  }
  const entries: UserEntry[] = [];
  for (const e of raw.entries) {
    const entry = entryFrom(e);
    if (!entry || entries.some((x) => x.user === entry.user)) return undefined;
    entries.push(entry);
  }
  return entries.length > 0 ? { m: usersMarker(prefix), kind: 'users', entries } : undefined;
}

export const usersBundle = (prefix: string, entries: readonly UserEntry[]): UsersBundle => ({
  m: usersMarker(prefix),
  kind: 'users',
  entries,
});

/** An entry as text (JSON), for an app that keeps it on a server. */
export const userEntryToText = (prefix: string, e: UserEntry): string =>
  JSON.stringify({ m: usersMarker(prefix), ...e });

/** Strict: anything but exactly an entry as `userEntryToText` made it gives undefined. */
export function userEntryFromText(prefix: string, text: string): UserEntry | undefined {
  try {
    const raw: unknown = JSON.parse(text);
    if (!isObject(raw) || raw.m !== usersMarker(prefix)) return undefined;
    return entryFrom(raw);
  } catch {
    return undefined;
  }
}

/** Minutes in the background after which the app locks again (with the lock on). */
export const LOCK_AFTER_MINUTES = 5;

export function shouldRelock(hiddenSince: number | undefined, now: number): boolean {
  return hiddenSince !== undefined && now - hiddenSince >= LOCK_AFTER_MINUTES * 60_000;
}
