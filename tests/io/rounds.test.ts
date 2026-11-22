// PBKDF2 rounds: what is written is also what is read (no ring or bundle made "damaged" by a
// value the API took), and a foreign entry with few rounds is refused.
import { describe, expect, it } from 'vitest';
import { memoryEnvironment } from '../../src/io/environment.ts';
import { createVault } from '../../src/io/vault.ts';
import { validateConfig } from '../../src/logic/config.ts';
import {
  DEFAULT_MIN_ROUNDS,
  MAX_ROUNDS,
  ROUNDS,
  bundleWithLock,
  checkRounds,
  createDataKey,
  createDeviceKey,
  createUserEntry,
  parseBundle,
  parseUsersBundle,
  userEntryFromText,
  userEntryToText,
  usersBundle,
} from '../../src/logic/vault.ts';

const P = 'app';
const R = 1000;
const PASS = 'Eine Passphrase';
const bad = [10, 999, 1.5, NaN, MAX_ROUNDS + 1, -5];

const users = (minRounds?: number) =>
  createVault(
    { prefix: P, slots: ['data'], mode: 'users', ...(minRounds ? { minRounds } : {}) },
    memoryEnvironment(),
  );

describe('rounds are checked when written, like when read', () => {
  it('checkRounds: whole numbers from the lowest to 3 million', () => {
    expect(DEFAULT_MIN_ROUNDS).toBe(100_000);
    expect(MAX_ROUNDS).toBe(3_000_000);
    expect(checkRounds(DEFAULT_MIN_ROUNDS)).toBe(true);
    expect(checkRounds(ROUNDS)).toBe(true);
    expect(checkRounds(MAX_ROUNDS)).toBe(true);
    expect(checkRounds(DEFAULT_MIN_ROUNDS - 1)).toBe(false);
    expect(checkRounds(MAX_ROUNDS + 1)).toBe(false);
    expect(checkRounds(150_000.5)).toBe(false);
    expect(checkRounds('200000')).toBe(false);
    expect(checkRounds(1000, 1000)).toBe(true);
  });

  it('the crypto pieces refuse what they would not read back', async () => {
    const data = await createDataKey();
    for (const r of bad) {
      await expect(createUserEntry(P, 'anna', PASS, data, r, R)).rejects.toThrow(RangeError);
      await expect(bundleWithLock(P, await createDeviceKey(), data, PASS, r, R)).rejects.toThrow(
        RangeError,
      );
    }
    // the default lowest count applies when none is passed
    await expect(createUserEntry(P, 'anna', PASS, data, R)).rejects.toThrow(RangeError);
  });

  it('users mode: setup, add, change refuse a bad count and store nothing', async () => {
    for (const r of bad) {
      const v = users(R);
      await v.startVault();
      expect((await v.setupFirstUser('anna', PASS, r)).kind, String(r)).toBe('error');
      expect(v.users()).toEqual([]);
    }
    const v = users(R);
    await v.startVault();
    await v.setupFirstUser('anna', PASS, R);
    const by = { user: 'anna', passphrase: PASS };
    for (const r of bad) {
      expect(await v.addUser('bernd', 'Bernds Passphrase', by, r), String(r)).toMatch(/rounds/);
      expect(await v.changeUserPassphrase('anna', PASS, 'Neue Passphrase', r), String(r)).toMatch(
        /rounds/,
      );
    }
    expect(v.users()).toEqual(['anna']);
  });

  it('device mode: setLock refuses a bad count and leaves the lock off', async () => {
    const v = createVault({ prefix: P, slots: ['data'], minRounds: R }, memoryEnvironment());
    await v.startVault();
    for (const r of bad) expect(await v.setLock('Secret-2026', undefined, r)).toMatch(/rounds/);
    expect(v.isLockOn()).toBe(false);
    expect(await v.startVault()).toEqual({ kind: 'open' });
  });

  it('what is accepted is read back after a restart (the lowest and the highest allowed)', async () => {
    const env = memoryEnvironment();
    const config = { prefix: P, slots: ['data'], mode: 'users', minRounds: R } as const;
    const v = createVault(config, env);
    await v.startVault();
    expect(await v.setupFirstUser('anna', PASS, R)).toEqual({ kind: 'open' });
    const again = createVault(config, env);
    expect((await again.startVault()).kind).toBe('locked'); // not "damaged"
    expect(await again.loginUser('anna', PASS)).toEqual({ kind: 'open' });
  });
});

describe('the lowest count for reading', () => {
  it('by default 100 000: an entry or bundle with fewer rounds is refused, 600 000 is read', async () => {
    const data = await createDataKey();
    const entry = await createUserEntry(P, 'anna', PASS, data, ROUNDS); // the standard count
    expect(parseUsersBundle(P, usersBundle(P, [entry]))?.entries[0]?.rounds).toBe(ROUNDS);
    expect(userEntryFromText(P, userEntryToText(P, entry))).toEqual(entry);
    const weak = { ...entry, rounds: DEFAULT_MIN_ROUNDS - 1 };
    expect(parseUsersBundle(P, usersBundle(P, [weak]))).toBeUndefined();
    expect(userEntryFromText(P, userEntryToText(P, weak))).toBeUndefined();
    expect(parseUsersBundle(P, usersBundle(P, [{ ...entry, rounds: MAX_ROUNDS }]))).toBeDefined();
    expect(
      parseUsersBundle(P, usersBundle(P, [{ ...entry, rounds: MAX_ROUNDS + 1 }])),
    ).toBeUndefined();
    const bundle = await bundleWithLock(P, await createDeviceKey(), data, PASS, ROUNDS);
    expect(parseBundle(P, bundle)).toEqual(bundle);
    expect(parseBundle(P, { ...bundle, rounds: 50_000 })).toBeUndefined();
    expect(parseBundle(P, { ...bundle, rounds: 50_000 }, 1000)).toBeDefined();
  });

  it('a vault without minRounds refuses a weak foreign entry; the app may set it explicitly', async () => {
    const data = await createDataKey();
    const weak = await createUserEntry(P, 'anna', PASS, data, R, R);
    const text = userEntryToText(P, weak);
    const strict = users();
    await strict.startVault();
    expect(await strict.joinWithEntry(text, PASS)).toMatchObject({ kind: 'error' });
    expect(strict.users()).toEqual([]);
    const lax = users(R);
    await lax.startVault();
    expect(await lax.joinWithEntry(text, PASS)).toEqual({ kind: 'open' });
  });

  it('a stored ring with few rounds is damaged for a strict vault, not silently opened', async () => {
    const env = memoryEnvironment();
    const config = { prefix: P, slots: ['data'], mode: 'users' } as const;
    const v = createVault({ ...config, minRounds: R }, env);
    await v.startVault();
    await v.setupFirstUser('anna', PASS, R);
    const strict = createVault(config, env);
    expect((await strict.startVault()).kind).toBe('error');
  });

  it('minRounds in the configuration is validated', () => {
    const ok = { prefix: P, slots: ['data'] };
    for (const m of [0, 1.5, MAX_ROUNDS + 1, -1])
      expect(() => validateConfig({ ...ok, minRounds: m }), String(m)).toThrow(/minRounds/);
    expect(() => validateConfig({ ...ok, minRounds: R })).not.toThrow();
    expect(() => validateConfig(ok)).not.toThrow();
  });
});

describe('user names are NFC-normalised', () => {
  const composed = 'José';
  const decomposed = 'José';

  it('one user, typed either way', async () => {
    const env = memoryEnvironment();
    const config = { prefix: P, slots: ['data'], mode: 'users', minRounds: R } as const;
    const v = createVault(config, env);
    await v.startVault();
    expect(await v.setupFirstUser(decomposed, PASS, R)).toEqual({ kind: 'open' });
    expect(v.users()).toEqual([composed]);
    expect(v.currentUser()).toBe(composed);
    expect(
      await v.addUser(decomposed, 'Eine andere', { user: composed, passphrase: PASS }, R),
    ).toMatch(/already|exists/i);
    const again = createVault(config, env);
    await again.startVault();
    expect(await again.loginUser(decomposed, PASS)).toEqual({ kind: 'open' });
    expect(again.userEntry(decomposed)).toBe(again.userEntry(composed));
    expect(await again.removeUser(decomposed)).toMatch(/yourself/);
  });
});
