// The vault of a page. Regression: with the vault still closed, reading must throw — an empty
// value taken instead would later be saved over the real (encrypted) data.
import { describe, expect, it } from 'vitest';
import { memoryEnvironment, type VaultEnvironment } from '../../src/io/environment.ts';
import { createVault } from '../../src/io/vault.ts';
import { createDataKey, isSealed, sealText } from '../../src/logic/vault.ts';

const ROUNDS_FAST = 1000;
const OLD = JSON.stringify({ item: { id: 'i', name: 'Sample' } });
const P = 'app';
const KEY = 'app-data'; // the browser store name of the slot "data"

const make = (env: VaultEnvironment = memoryEnvironment()) =>
  createVault({ prefix: P, slots: ['data'], minRounds: 1000 }, env);

describe('starting the vault', () => {
  it('the very first start makes the keys and opens empty', async () => {
    const vault = make();
    expect(await vault.startVault()).toEqual({ kind: 'open' });
    expect(vault.readSlot('data')).toBeNull();
    expect(vault.isLockOn()).toBe(false);
  });

  it('a plain value in a slot is not read: it does not open, and is never overwritten', async () => {
    const env = memoryEnvironment();
    env.raw.set(KEY, OLD);
    const vault = make(env);
    expect((await vault.startVault()).kind).toBe('error');
    expect(vault.writeSlot('data', '{}')).toMatch(/Not saved/);
    await vault.saved();
    expect(env.raw.get(KEY)).toBe(OLD);
    expect(isSealed(P, OLD)).toBe(false);
  });

  it('what is written is stored encrypted and there again after a restart', async () => {
    const env = memoryEnvironment();
    const vault = make(env);
    await vault.startVault();
    vault.writeSlot('data', '{"amount":12}');
    expect(vault.readSlot('data')).toBe('{"amount":12}'); // in memory at once
    await vault.saved();
    expect(env.raw.get(KEY)).not.toContain('"amount"');
    await vault.startVault();
    expect(vault.readSlot('data')).toBe('{"amount":12}');
    // a second instance on the same storage (another page load) reads it too
    const again = make(env);
    await again.startVault();
    expect(again.readSlot('data')).toBe('{"amount":12}');
  });

  it('closed: reading and writing throw (never an empty value)', async () => {
    const env = memoryEnvironment();
    const vault = make(env);
    await vault.startVault();
    expect(await vault.setLock('Secret-2026', undefined, ROUNDS_FAST)).toBeUndefined();
    expect(await vault.startVault()).toEqual({ kind: 'locked' });
    expect(vault.isVaultOpen()).toBe(false);
    expect(() => vault.readSlot('data')).toThrow(/not open/);
    expect(() => vault.writeSlot('data', '{}')).toThrow(/not open/);
  });

  it('a damaged key bundle is an error, not a fresh start over the data', async () => {
    const env = memoryEnvironment();
    await env.writeBundle({ m: 'app-vault-bundle:1', kind: 'nonsense' } as never);
    const vault = make(env);
    const result = await vault.startVault();
    expect(result.kind).toBe('error');
    expect(vault.isVaultOpen()).toBe(false);
  });

  it('a device key that does not match the bundle is an error', async () => {
    const env = memoryEnvironment();
    await make(env).startVault();
    const other = memoryEnvironment();
    const wrong: VaultEnvironment = {
      ...other,
      readBundle: () => env.readBundle(),
      writeBundle: () => Promise.resolve(),
      updateBundle: async () => ({ value: await env.readBundle(), written: false }),
    };
    const result = await make(wrong).startVault();
    expect(result.kind).toBe('error');
  });

  it('a storage failure at start is an error result, not a throw', async () => {
    const broken: VaultEnvironment = {
      ...memoryEnvironment(),
      deviceKey: () => Promise.reject(new Error('no IndexedDB')),
    };
    expect(await make(broken).startVault()).toEqual({
      kind: 'error',
      error: 'Storage not reachable: no IndexedDB',
    });
  });
});

describe('the app lock', () => {
  const locked = async () => {
    const env = memoryEnvironment();
    const vault = make(env);
    await vault.startVault();
    vault.writeSlot('data', OLD);
    await vault.saved();
    expect(await vault.setLock('Secret-2026', undefined, ROUNDS_FAST)).toBeUndefined();
    return { env, vault };
  };

  it('opens only with the right password', async () => {
    const { vault } = await locked();
    expect(await vault.startVault()).toEqual({ kind: 'locked' });
    expect(await vault.unlock('wrong-1')).toBe(false);
    expect(vault.isVaultOpen()).toBe(false);
    expect(await vault.unlock('Secret-2026')).toEqual({ kind: 'open' });
    expect(vault.readSlot('data')).toBe(OLD);
    expect(vault.isLockOn()).toBe(true);
  });

  it('a new password replaces the old one; off needs the current one', async () => {
    const { vault } = await locked();
    expect(await vault.setLock('new-new', 'wrong-1', ROUNDS_FAST)).toMatch(/wrong/);
    expect(await vault.setLock('new-new', 'Secret-2026', ROUNDS_FAST)).toBeUndefined();
    await vault.startVault();
    expect(await vault.unlock('Secret-2026')).toBe(false);
    expect(await vault.unlock('new-new')).toEqual({ kind: 'open' });
    expect(await vault.removeLock('Secret-2026')).toMatch(/wrong/);
    expect(await vault.removeLock('new-new')).toBeUndefined();
    expect(await vault.startVault()).toEqual({ kind: 'open' });
    expect(vault.readSlot('data')).toBe(OLD);
  });

  it('turning the lock on does not re-encrypt the data', async () => {
    const env = memoryEnvironment();
    const vault = make(env);
    await vault.startVault();
    vault.writeSlot('data', OLD);
    await vault.saved();
    const before = env.raw.get(KEY);
    await vault.setLock('Secret-2026', undefined, ROUNDS_FAST);
    expect(env.raw.get(KEY)).toBe(before);
  });

  it('lockNow waits for the last write, then reloads', async () => {
    const env = memoryEnvironment();
    const vault = make(env);
    await vault.startVault();
    let reloaded = false;
    const previous = (globalThis as { location?: unknown }).location;
    (globalThis as { location?: unknown }).location = {
      reload: () => {
        reloaded = true;
        // closed first (the keys left the memory), and the write was stored before the reload
        expect(vault.isVaultOpen()).toBe(false);
        expect(env.raw.has(KEY)).toBe(true);
      },
    };
    try {
      vault.writeSlot('data', OLD);
      vault.lockNow();
      await vault.saved();
      await new Promise((r) => setTimeout(r, 0));
      expect(reloaded).toBe(true);
    } finally {
      (globalThis as { location?: unknown }).location = previous;
    }
  });
});

describe('when something is wrong', () => {
  it('data that does not open is never overwritten, and reading it throws', async () => {
    const env = memoryEnvironment();
    const foreign = await sealText(P, await createDataKey(), KEY, OLD);
    env.raw.set(KEY, foreign);
    const vault = make(env);
    expect((await vault.startVault()).kind).toBe('error');
    expect(() => vault.readSlot('data')).toThrow(/could not be opened/);
    expect(vault.writeSlot('data', '{}')).toMatch(/Not saved/);
    await vault.saved();
    expect(env.raw.get(KEY)).toBe(foreign);
  });

  it('a piece moved from another slot does not open', async () => {
    const env = memoryEnvironment();
    const vault = make(env);
    await vault.startVault();
    vault.writeSlot('data', OLD);
    await vault.saved();
    const piece = env.raw.get(KEY) as string;
    env.raw.delete(KEY);
    env.raw.set('app-other', piece); // not a known slot: ignored
    expect(await vault.startVault()).toEqual({ kind: 'open' });
    env.raw.set(KEY, piece);
    expect(await vault.startVault()).toEqual({ kind: 'open' });
    // the same piece sealed for another slot name is refused
    const key = await createDataKey();
    env.raw.set(KEY, await sealText(P, key, 'app-other', OLD));
    expect((await vault.startVault()).kind).toBe('error');
  });

  it('"start anew" leaves empty data under a new key', async () => {
    const env = memoryEnvironment();
    env.raw.set(KEY, await sealText(P, await createDataKey(), KEY, OLD));
    const vault = make(env);
    expect((await vault.startVault()).kind).toBe('error');
    await vault.startAnew();
    expect(env.raw.has(KEY)).toBe(false);
    expect(await vault.startVault()).toEqual({ kind: 'open' });
    expect(vault.readSlot('data')).toBeNull();
  });

  it('"start anew" also drops a forgotten lock', async () => {
    const env = memoryEnvironment();
    const vault = make(env);
    await vault.startVault();
    vault.writeSlot('data', OLD);
    await vault.saved();
    await vault.setLock('Secret-2026', undefined, ROUNDS_FAST);
    await vault.startVault();
    await vault.startAnew();
    expect(await vault.startVault()).toEqual({ kind: 'open' });
    expect(vault.isLockOn()).toBe(false);
    expect(vault.readSlot('data')).toBeNull();
  });

  it('a storage error after the fact reaches whoever listens', async () => {
    const full: VaultEnvironment = {
      ...memoryEnvironment(),
      write: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const vault = make(full);
    await vault.startVault();
    const heard: string[] = [];
    const off = vault.onError((e) => heard.push(e));
    vault.writeSlot('data', '{}');
    await vault.saved();
    off();
    expect(heard).toEqual(['Not saved: QuotaExceededError']);
  });

  it('a refused write is reported to listeners too', async () => {
    const env = memoryEnvironment();
    env.raw.set(KEY, OLD);
    const vault = make(env);
    await vault.startVault();
    const heard: string[] = [];
    const off = vault.onError((e) => heard.push(e));
    vault.writeSlot('data', '{}');
    off();
    expect(heard).toHaveLength(1);
  });
});

describe('texts', () => {
  it("the app's texts replace the English defaults in what the vault returns", async () => {
    const env = memoryEnvironment();
    env.raw.set(KEY, OLD);
    const vault = createVault(
      { prefix: P, slots: ['data'], texts: { notSavedUnreadable: 'Nicht gespeichert.' } },
      env,
    );
    await vault.startVault();
    expect(vault.writeSlot('data', '{}')).toBe('Nicht gespeichert.');
    expect(vault.texts.wrongPassword).toBe('Wrong password.'); // default kept
  });
});
