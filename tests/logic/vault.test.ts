import { describe, expect, it } from 'vitest';
import { base64url, fromBase64url } from '../../src/logic/base64url.ts';
import {
  bundleWithLock,
  bundleWithoutLock,
  checkPassword,
  createDataKey,
  createDeviceKey,
  isSealed,
  LOCK_AFTER_MINUTES,
  openBundle,
  openText,
  parseBundle,
  sealText,
  shouldRelock,
} from '../../src/logic/vault.ts';

const defined = <T>(x: T | undefined): T => {
  if (x === undefined) throw new Error('missing');
  return x;
};

const P = 'app';
const ROUNDS_FAST = 1000; // fast in tests; real use is ROUNDS (600 000)

describe('base64url', () => {
  it('round-trips all byte values without padding or unsafe characters', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    const text = base64url(bytes);
    expect(text).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(fromBase64url(text)).toEqual(bytes);
    expect(base64url(new Uint8Array([251, 255]))).toBe('-_8');
    expect(base64url(new Uint8Array())).toBe('');
  });

  it('refuses characters outside the alphabet', () => {
    expect(() => fromBase64url('ab+/')).toThrow();
    expect(() => fromBase64url('ab=')).toThrow();
  });
});

describe('encrypted slots', () => {
  it('opens only with the same key and in the same slot', async () => {
    const k = await createDataKey();
    const raw = await sealText(P, k, 'app-data', '{"name":"Sample"}');
    expect(raw).not.toContain('"name"'); // quotes never occur in base64url
    expect(isSealed(P, raw)).toBe(true);
    expect(await openText(P, k, 'app-data', raw)).toBe('{"name":"Sample"}');
    // swapped into another slot, or opened with another key: nothing
    expect(await openText(P, k, 'app-other', raw)).toBeUndefined();
    expect(await openText(P, await createDataKey(), 'app-data', raw)).toBeUndefined();
  });

  it('a changed piece is refused, a plain value is not recognised as sealed', async () => {
    const k = await createDataKey();
    const raw = JSON.parse(await sealText(P, k, 'p', 'x')) as { ct: string };
    const ct = raw.ct.startsWith('A') ? `B${raw.ct.slice(1)}` : `A${raw.ct.slice(1)}`;
    expect(await openText(P, k, 'p', JSON.stringify({ ...raw, ct }))).toBeUndefined();
    expect(isSealed(P, '{"group":{"id":"g"}}')).toBe(false);
    expect(isSealed(P, 'not json')).toBe(false);
    expect(await openText(P, k, 'p', '{"group":{"id":"g"}}')).toBeUndefined();
  });

  it('the stored marker carries the prefix; another prefix does not open it', async () => {
    const k = await createDataKey();
    const raw = await sealText(P, k, 'app-data', 'x');
    expect((JSON.parse(raw) as { m: string }).m).toBe('app-vault:1');
    expect(isSealed('other', raw)).toBe(false);
    expect(await openText('other', k, 'app-data', raw)).toBeUndefined();
  });
});

describe('the data key and its bundle', () => {
  it('without the lock: the device key alone opens it, and it cannot be read out', async () => {
    const device = await createDeviceKey();
    const data = await createDataKey();
    const raw = await sealText(P, data, 'p', 'secret');
    const bundle = await bundleWithoutLock(P, device, data);
    expect(parseBundle(P, JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
    const opened = await openBundle(P, device, bundle);
    expect(opened).toBeDefined();
    expect(await openText(P, defined(opened), 'p', raw)).toBe('secret');
    await expect(crypto.subtle.exportKey('raw', defined(opened))).rejects.toThrow();
    // another device's key opens nothing
    expect(await openBundle(P, await createDeviceKey(), bundle)).toBeUndefined();
  });

  it('the device key itself is not extractable', async () => {
    const device = await createDeviceKey();
    expect(device.extractable).toBe(false);
    await expect(crypto.subtle.exportKey('raw', device)).rejects.toThrow();
  });

  it('with the lock: only the right password and the device key together', async () => {
    const device = await createDeviceKey();
    const data = await createDataKey();
    const raw = await sealText(P, data, 'p', 'secret');
    const bundle = await bundleWithLock(P, device, data, 'Secret-2026', ROUNDS_FAST);
    expect(parseBundle(P, JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
    expect(await openBundle(P, device, bundle)).toBeUndefined();
    expect(await openBundle(P, device, bundle, 'secret-2026')).toBeUndefined();
    expect(await openBundle(P, await createDeviceKey(), bundle, 'Secret-2026')).toBeUndefined();
    const opened = await openBundle(P, device, bundle, 'Secret-2026');
    expect(await openText(P, defined(opened), 'p', raw)).toBe('secret');
  });

  it('lock on, new password, lock off: the data stays readable, nothing is encrypted anew', async () => {
    const device = await createDeviceKey();
    const data = await createDataKey();
    const raw = await sealText(P, data, 'p', 'secret');
    const without = await bundleWithoutLock(P, device, data);
    const locked = await bundleWithLock(
      P,
      device,
      defined(await openBundle(P, device, without, undefined, true)),
      'one-1',
      ROUNDS_FAST,
    );
    const changed = await bundleWithLock(
      P,
      device,
      defined(await openBundle(P, device, locked, 'one-1', true)),
      'two-2',
      ROUNDS_FAST,
    );
    expect(await openBundle(P, device, changed, 'one-1')).toBeUndefined();
    const off = await bundleWithoutLock(
      P,
      device,
      defined(await openBundle(P, device, changed, 'two-2', true)),
    );
    expect(await openText(P, defined(await openBundle(P, device, off)), 'p', raw)).toBe('secret');
  });

  it('the password is compared Unicode-normalised (NFC)', async () => {
    const device = await createDeviceKey();
    const bundle = await bundleWithLock(P, device, await createDataKey(), 'Grüße-1', ROUNDS_FAST);
    expect(await openBundle(P, device, bundle, 'Grüße-1')).toBeDefined();
    // the same text with decomposed umlauts
    expect(await openBundle(P, device, bundle, 'Grüße-1')).toBeDefined();
  });

  it('a damaged or foreign bundle is not read', async () => {
    const device = await createDeviceKey();
    const bundle = await bundleWithLock(P, device, await createDataKey(), 'one-1', ROUNDS_FAST);
    expect(parseBundle(P, { ...bundle, rounds: 10 })).toBeUndefined();
    expect(parseBundle(P, { ...bundle, rounds: 1.5 })).toBeUndefined();
    expect(parseBundle(P, { ...bundle, salt: undefined })).toBeUndefined();
    expect(parseBundle(P, { ...bundle, m: 'other' })).toBeUndefined();
    expect(parseBundle(P, { ...bundle, kind: 'other' })).toBeUndefined();
    expect(parseBundle(P, null)).toBeUndefined();
    expect(parseBundle('other', bundle)).toBeUndefined(); // another prefix's bundle
  });
});

describe('password and locking again', () => {
  it('a password needs six characters and the same twice', () => {
    expect(checkPassword('12345', '12345')).toMatch(/At least 6/);
    expect(checkPassword('123456', '123457')).toMatch(/differ/);
    expect(checkPassword('123456', '123456')).toBeUndefined();
    expect(checkPassword('äöüßéè', 'äöüßéè')).toBeUndefined();
  });

  it('the messages come from the texts passed in', () => {
    const texts = { passwordTooShort: (n: number) => `min ${n}`, passwordsDiffer: 'verschieden' };
    expect(checkPassword('1', '1', texts)).toBe('min 6');
    expect(checkPassword('123456', '1234567', texts)).toBe('verschieden');
  });

  it('locks again after the minutes in the background, not before', () => {
    const ms = LOCK_AFTER_MINUTES * 60_000;
    expect(LOCK_AFTER_MINUTES).toBe(5);
    expect(shouldRelock(undefined, 10 * ms)).toBe(false);
    expect(shouldRelock(1000, 1000 + ms - 1)).toBe(false);
    expect(shouldRelock(1000, 1000 + ms)).toBe(true);
  });
});
