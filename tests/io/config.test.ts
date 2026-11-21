// The seam to the app: the config decides every store name, and instances do not share state.
import { describe, expect, it } from 'vitest';
import { guardEnvironment, memoryEnvironment } from '../../src/io/environment.ts';
import type { VaultEnvironment } from '../../src/io/environment.ts';
import { createVault } from '../../src/io/vault.ts';
import { databaseName, storageName, validateConfig } from '../../src/logic/config.ts';

/** A memory environment that remembers every store name it is asked for. */
function recording() {
  const names: string[] = [];
  const base = memoryEnvironment();
  const env: VaultEnvironment & { raw: Map<string, string> } = {
    ...base,
    read: (n) => (names.push(n), base.read(n)),
    write: (n, v) => (names.push(n), base.write(n, v)),
    remove: (n) => (names.push(n), base.remove(n)),
  };
  return { env, names };
}

describe('config', () => {
  it('accepts lower-case words joined by hyphens', () => {
    expect(() => validateConfig({ prefix: 'my-app', slots: ['data', 'settings-1'] })).not.toThrow();
  });

  it('refuses a bad prefix, bad or duplicate slot names and no slots', () => {
    expect(() => validateConfig({ prefix: '', slots: ['a'] })).toThrow(/prefix/);
    expect(() => validateConfig({ prefix: 'App', slots: ['a'] })).toThrow(/prefix/);
    expect(() => validateConfig({ prefix: 'a b', slots: ['a'] })).toThrow(/prefix/);
    expect(() => validateConfig({ prefix: 'app-', slots: ['a'] })).toThrow(/prefix/);
    expect(() => validateConfig({ prefix: 'app', slots: [] })).toThrow(/at least one/);
    expect(() => validateConfig({ prefix: 'app', slots: ['a/b'] })).toThrow(/slot/);
    expect(() => validateConfig({ prefix: 'app', slots: ['a', 'a'] })).toThrow(/Duplicate/);
    expect(() => createVault({ prefix: 'x y', slots: ['a'] }, memoryEnvironment())).toThrow();
  });

  it('names the stores from the prefix', () => {
    expect(storageName('app', 'data')).toBe('app-data');
    expect(databaseName('app')).toBe('app-vault');
  });
});

describe('prefix enforcement', () => {
  it('every store name the vault touches starts with the prefix', async () => {
    const { env, names } = recording();
    const vault = createVault({ prefix: 'zed', slots: ['one', 'two'] }, env);
    await vault.startVault();
    vault.writeSlot('one', 'a');
    vault.writeSlot('two', 'b');
    await vault.saved();
    await vault.startAnew();
    expect(names.length).toBeGreaterThanOrEqual(6);
    expect(names.filter((n) => !n.startsWith('zed-'))).toEqual([]);
    expect(vault.storageName('one')).toBe('zed-one');
    expect([...env.raw.keys()].sort()).toEqual([]); // start anew removed both
  });

  it('the guard refuses a store name outside the prefix', () => {
    const env = guardEnvironment('app', memoryEnvironment());
    expect(() => env.read('other-data')).toThrow(/does not start with "app-"/);
    expect(() => env.write('data', 'x')).toThrow();
    expect(() => env.remove('apple')).toThrow(); // prefix is `app-`, not `app`
    expect(env.read('app-data')).toBeNull();
  });

  it('an unknown slot is refused for reading and writing', async () => {
    const vault = createVault({ prefix: 'app', slots: ['data'] }, memoryEnvironment());
    await vault.startVault();
    expect(() => vault.readSlot('nope')).toThrow(/Unknown slot/);
    expect(() => vault.writeSlot('nope', 'x')).toThrow(/Unknown slot/);
    expect(() => vault.storageName('app-data')).toThrow(/Unknown slot/);
  });

  it('several slots are encrypted and stored on their own', async () => {
    const env = memoryEnvironment();
    const vault = createVault({ prefix: 'app', slots: ['one', 'two'] }, env);
    await vault.startVault();
    vault.writeSlot('one', 'first');
    vault.writeSlot('two', 'second');
    await vault.saved();
    expect([...env.raw.keys()].sort()).toEqual(['app-one', 'app-two']);
    await vault.startVault();
    expect(vault.readSlot('one')).toBe('first');
    expect(vault.readSlot('two')).toBe('second');
  });
});

describe('two vaults', () => {
  it('do not share state', async () => {
    const a = createVault({ prefix: 'aaa', slots: ['data'] }, memoryEnvironment());
    const b = createVault({ prefix: 'bbb', slots: ['data'] }, memoryEnvironment());
    await a.startVault();
    expect(b.isVaultOpen()).toBe(false);
    expect(() => b.readSlot('data')).toThrow(/not open/);
    await b.startVault();
    a.writeSlot('data', 'from a');
    await a.saved();
    expect(b.readSlot('data')).toBeNull();
    await a.setLock('Secret-2026', undefined, 1000);
    expect(a.isLockOn()).toBe(true);
    expect(b.isLockOn()).toBe(false);
  });

  it('keep their own listeners', async () => {
    const full: VaultEnvironment = {
      ...memoryEnvironment(),
      write: () => {
        throw new Error('full');
      },
    };
    const a = createVault({ prefix: 'aaa', slots: ['data'] }, full);
    const b = createVault({ prefix: 'bbb', slots: ['data'] }, memoryEnvironment());
    await a.startVault();
    await b.startVault();
    const heardA: string[] = [];
    const heardB: string[] = [];
    a.onError((e) => heardA.push(e));
    b.onError((e) => heardB.push(e));
    a.writeSlot('data', 'x');
    await a.saved();
    expect(heardA).toHaveLength(1);
    expect(heardB).toEqual([]);
  });
});
