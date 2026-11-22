// Users mode: a key ring, the data key wrapped per user by his passphrase.
import { describe, expect, it } from 'vitest';
import { memoryEnvironment, type VaultEnvironment } from '../../src/io/environment.ts';
import { createVault } from '../../src/io/vault.ts';
import { userEntryFromText, userEntryToText } from '../../src/logic/vault.ts';

const R = 1000;
const P = 'app';
const make = (env: VaultEnvironment = memoryEnvironment()) =>
  createVault({ prefix: P, slots: ['data'], mode: 'users', minRounds: 1000 }, env);

async function setUp(env = memoryEnvironment()) {
  const vault = make(env);
  expect(await vault.startVault()).toEqual({ kind: 'setup' });
  expect(await vault.setupFirstUser('anna', 'Annas Passphrase', R)).toEqual({ kind: 'open' });
  return { env, vault };
}

describe('users mode: set-up and login', () => {
  it('starts in set-up, opens after the first user and keeps data under a restart', async () => {
    const { env, vault } = await setUp();
    expect(vault.currentUser()).toBe('anna');
    expect(vault.users()).toEqual(['anna']);
    vault.writeSlot('data', '{"x":1}');
    await vault.putBytes('file:a', new Uint8Array([1, 2, 3]));
    await vault.saved();
    expect(env.raw.get('app-data')).not.toContain('"x"');
    const again = make(env);
    expect(await again.startVault()).toEqual({ kind: 'locked' });
    expect(again.users()).toEqual(['anna']);
    expect(again.currentUser()).toBeUndefined();
    expect(() => again.readSlot('data')).toThrow(/not open/);
    expect(await again.loginUser('anna', 'falsche Passphrase')).toBe(false);
    expect(await again.loginUser('niemand', 'Annas Passphrase')).toBe(false);
    expect(await again.loginUser('anna', 'Annas Passphrase')).toEqual({ kind: 'open' });
    expect(again.readSlot('data')).toBe('{"x":1}');
    expect(await again.getBytes('file:a')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('refuses a weak passphrase, a bad name and a second set-up', async () => {
    const vault = make();
    await vault.startVault();
    expect((await vault.setupFirstUser('anna', 'kurz', R)).kind).toBe('error');
    expect((await vault.setupFirstUser('', 'Eine Passphrase', R)).kind).toBe('error');
    expect((await vault.setupFirstUser(' anna', 'Eine Passphrase', R)).kind).toBe('error');
    expect((await vault.setupFirstUser('a\nb', 'Eine Passphrase', R)).kind).toBe('error');
    expect(await vault.setupFirstUser('anna', 'Eine Passphrase', R)).toEqual({ kind: 'open' });
    expect((await vault.setupFirstUser('bernd', 'Eine Passphrase', R)).kind).toBe('error');
  });

  it('a bundle of the device mode, or a damaged ring, is an error and is never overwritten', async () => {
    const env = memoryEnvironment();
    const device = createVault({ prefix: P, slots: ['data'] }, env);
    expect((await device.startVault()).kind).toBe('open');
    const users = make(env);
    expect((await users.startVault()).kind).toBe('error');
    // the unreadable bundle stays; neither a set-up nor a join replaces it
    const vorher = await env.readBundle();
    expect((await users.setupFirstUser('anna', 'Eine Passphrase', R)).kind).toBe('error');
    expect(await users.joinWithEntry('x', 'Eine Passphrase')).toMatchObject({ kind: 'error' });
    expect(await env.readBundle()).toBe(vorher);
  });

  it('refuses users calls in device mode and the device lock in users mode', async () => {
    const device = createVault({ prefix: P, slots: ['data'] }, memoryEnvironment());
    await device.startVault();
    await expect(device.loginUser('a', 'b')).rejects.toThrow(/no users/);
    const { vault } = await setUp();
    expect(await vault.setLock('Eine Passphrase', undefined, R)).toMatch(/users mode/);
    expect(await vault.removeLock('x')).toMatch(/users mode/);
    expect(await vault.unlock('x')).toMatchObject({ kind: 'error' });
    expect(vault.isLockOn()).toBe(true);
  });
});

describe('users mode: several users, one data key', () => {
  it('a second user reads what the first wrote; removed users cannot get in', async () => {
    const { env, vault } = await setUp();
    vault.writeSlot('data', 'geheim');
    await vault.saved();
    expect(
      await vault.addUser('bernd', 'Bernds Passphrase', { user: 'anna', passphrase: 'falsch' }, R),
    ).toMatch(/wrong/i);
    expect(
      await vault.addUser('bernd', 'kurz', { user: 'anna', passphrase: 'Annas Passphrase' }, R),
    ).toBeTruthy();
    expect(
      await vault.addUser(
        'anna',
        'Eine Passphrase',
        { user: 'anna', passphrase: 'Annas Passphrase' },
        R,
      ),
    ).toMatch(/already|exists/i);
    expect(
      await vault.addUser(
        'bernd',
        'Bernds Passphrase',
        { user: 'anna', passphrase: 'Annas Passphrase' },
        R,
      ),
    ).toBeUndefined();
    expect(vault.users()).toEqual(['anna', 'bernd']);

    const bernd = make(env);
    await bernd.startVault();
    expect(await bernd.loginUser('bernd', 'Annas Passphrase')).toBe(false);
    expect(await bernd.loginUser('bernd', 'Bernds Passphrase')).toEqual({ kind: 'open' });
    expect(bernd.readSlot('data')).toBe('geheim');

    // he cannot remove himself, nor an unknown user; anna can remove bernd
    expect(await bernd.removeUser('bernd')).toBeTruthy();
    expect(await bernd.removeUser('niemand')).toBeTruthy();
    const anna = make(env);
    await anna.startVault();
    await anna.loginUser('anna', 'Annas Passphrase');
    expect(await anna.removeUser('bernd')).toBeUndefined();
    expect(await anna.removeUser('anna')).toMatch(/yourself/);
    const late = make(env);
    await late.startVault();
    expect(late.users()).toEqual(['anna']);
    expect(await late.loginUser('bernd', 'Bernds Passphrase')).toBe(false);
  });

  it('a new passphrase: the old one is dead, the data stays', async () => {
    const { env, vault } = await setUp();
    vault.writeSlot('data', 'bleibt');
    await vault.saved();
    expect(await vault.changeUserPassphrase('anna', 'falsch', 'Neue Passphrase', R)).toMatch(
      /wrong/i,
    );
    expect(
      await vault.changeUserPassphrase('bernd', 'Annas Passphrase', 'Neue Passphrase', R),
    ).toBeTruthy();
    expect(await vault.changeUserPassphrase('anna', 'Annas Passphrase', 'kurz', R)).toBeTruthy();
    expect(
      await vault.changeUserPassphrase('anna', 'Annas Passphrase', 'Neue Passphrase', R),
    ).toBeUndefined();
    const again = make(env);
    await again.startVault();
    expect(await again.loginUser('anna', 'Annas Passphrase')).toBe(false);
    expect(await again.loginUser('anna', 'Neue Passphrase')).toEqual({ kind: 'open' });
    expect(again.readSlot('data')).toBe('bleibt');
  });
});

describe('users mode: the entry as text (a server keeps it for the user)', () => {
  it('a fresh device joins with the text and the passphrase, and reads the same data', async () => {
    const { env, vault } = await setUp();
    vault.writeSlot('data', 'vom Server geholt');
    await vault.putBytes('file:b', new Uint8Array([9]));
    await vault.saved();
    const text = vault.userEntry('anna');
    expect(text).toBeTruthy();
    expect(vault.userEntry('niemand')).toBeUndefined();
    // what the server stored comes back; the data itself comes from elsewhere (a full state, packages)
    const fresh = memoryEnvironment();
    for (const [k, v] of env.raw) fresh.raw.set(k, v);
    for (const [k, v] of env.blobs) fresh.blobs.set(k, v);
    const neu = make(fresh);
    // a device that still has a ring does not take another
    expect(
      await make(env)
        .joinWithEntry(text ?? '', 'Annas Passphrase')
        .catch(() => undefined),
    ).toBeDefined();
    expect(await neu.startVault()).toEqual({ kind: 'setup' });
    expect(await neu.joinWithEntry('kein Eintrag', 'Annas Passphrase')).toMatchObject({
      kind: 'error',
    });
    expect(await neu.joinWithEntry(text ?? '', 'falsche Passphrase')).toBe(false);
    expect(await neu.joinWithEntry(text ?? '', 'Annas Passphrase')).toEqual({ kind: 'open' });
    expect(neu.currentUser()).toBe('anna');
    expect(neu.readSlot('data')).toBe('vom Server geholt');
    expect(await neu.getBytes('file:b')).toEqual(new Uint8Array([9]));
    // and it stays: a restart asks for the login
    const spaeter = make(fresh);
    expect(await spaeter.startVault()).toEqual({ kind: 'locked' });
    expect(await spaeter.loginUser('anna', 'Annas Passphrase')).toEqual({ kind: 'open' });
  });

  it('reads an entry strictly and keeps the user name inside (not swappable)', async () => {
    const { vault } = await setUp();
    const text = vault.userEntry('anna') ?? '';
    const ok = userEntryFromText(P, text, 1000);
    expect(ok?.user).toBe('anna');
    expect(userEntryToText(P, ok!)).toBe(text);
    const o = JSON.parse(text) as Record<string, unknown>;
    for (const bad of [
      'kein json',
      '[]',
      JSON.stringify({ ...o, m: 'other-vault-users:1' }),
      JSON.stringify({ ...o, rounds: 999 }),
      JSON.stringify({ ...o, salt: 'AAAA' }),
      JSON.stringify({ ...o, ct: 5 }),
      JSON.stringify({ ...o, user: '' }),
    ])
      expect(userEntryFromText(P, bad, 1000), String(bad)).toBeUndefined();
    // the user name is part of the authenticated data: the entry of anna under another name does not open
    const swapped = userEntryFromText(P, JSON.stringify({ ...o, user: 'bernd' }), 1000);
    const env2 = memoryEnvironment();
    const other = make(env2);
    await other.startVault();
    expect(
      await other.joinWithEntry(JSON.stringify({ ...o, user: 'bernd' }), 'Annas Passphrase'),
    ).toBe(false);
    expect(swapped?.user).toBe('bernd');
  });
});

describe('users mode: start anew', () => {
  it('removes data, blobs and the ring and goes back to the set-up', async () => {
    const { env, vault } = await setUp();
    vault.writeSlot('data', 'weg');
    await vault.putBytes('file:c', new Uint8Array([1]));
    await vault.saved();
    await vault.startAnew();
    expect(env.blobs.size).toBe(0);
    expect(env.raw.size).toBe(0);
    const again = make(env);
    expect(await again.startVault()).toEqual({ kind: 'setup' });
    expect(await again.setupFirstUser('neu', 'Eine Passphrase', R)).toEqual({ kind: 'open' });
    expect(again.readSlot('data')).toBeNull();
  });
});
