// `close()`: locks without reloading the page — waits for what is on its way, drops the keys and
// the opened data, keeps the stored keys so the next unlock/login works again.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { browserEnvironment, memoryEnvironment } from '../../src/io/environment.ts';
import { createVault } from '../../src/io/vault.ts';

const ls = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k),
  },
});

const R = 1000;
const ANNA = 'Annas Passphrase';
const device = (env = memoryEnvironment()) =>
  createVault({ prefix: 'app', slots: ['data'], minRounds: R }, env);
const users = (env = memoryEnvironment()) =>
  createVault({ prefix: 'app', slots: ['data'], mode: 'users', minRounds: R }, env);
const bytes = (...v: number[]) => new Uint8Array(v);

describe('close (device mode)', () => {
  it('afterwards the vault is closed: everything throws as before the start', async () => {
    const v = device();
    await v.startVault();
    v.writeSlot('data', 'x');
    await v.putBytes('b', bytes(1));
    await v.close();
    expect(v.isVaultOpen()).toBe(false);
    expect(() => v.readSlot('data')).toThrow(/not open/i);
    expect(() => v.writeSlot('data', 'y')).toThrow(/not open/i);
    await expect(v.putBytes('b', bytes(2))).rejects.toThrow(/not open/i);
    await expect(v.getBytes('b')).rejects.toThrow(/not open/i);
    await expect(v.listBytes()).rejects.toThrow(/not open/i);
    await expect(v.removeBytes('b')).rejects.toThrow(/not open/i);
    await expect(v.sweepBlobs()).rejects.toThrow(/not open/i);
  });

  it('what was written and not yet stored lands in the storage before close resolves', async () => {
    const env = memoryEnvironment();
    const v = device(env);
    await v.startVault();
    v.writeSlot('data', 'pending value');
    const blob = v.putBytes('doc', bytes(1, 2, 3)); // not awaited
    const closed = v.close();
    expect(env.raw.has('app-data')).toBe(false); // sealing is asynchronous: close must wait for it
    await closed;
    expect(env.raw.has('app-data')).toBe(true);
    await blob; // was not refused or cut
    expect(await env.listBlobKeys()).toContain('doc');
    const again = device(env);
    await again.startVault();
    expect(again.readSlot('data')).toBe('pending value');
    expect(await again.getBytes('doc')).toEqual(bytes(1, 2, 3));
  });

  it('from the moment close is called, new writes are refused — nothing half-written stays', async () => {
    const v = device();
    await v.startVault();
    v.writeSlot('data', 'a');
    const closed = v.close();
    expect(() => v.writeSlot('data', 'b')).toThrow(/not open/i);
    await expect(v.putBytes('x', bytes(1))).rejects.toThrow(/not open/i);
    await closed;
  });

  it('with the app lock on: unlock opens it again without a reload, the data is back', async () => {
    const env = memoryEnvironment();
    const v = device(env);
    await v.startVault();
    v.writeSlot('data', 'secret');
    await v.putBytes('doc', bytes(9));
    await v.setLock('Secret-2026', undefined, R);
    await v.close();
    expect(v.isLockOn()).toBe(true);
    expect(await v.unlock('wrong-pass')).toBe(false);
    expect(v.isVaultOpen()).toBe(false);
    expect(await v.unlock('Secret-2026')).toEqual({ kind: 'open' });
    expect(v.readSlot('data')).toBe('secret');
    expect(await v.getBytes('doc')).toEqual(bytes(9));
  });

  it('without the lock, startVault opens it again', async () => {
    const v = device();
    await v.startVault();
    v.writeSlot('data', 'kept');
    await v.close();
    expect(await v.startVault()).toEqual({ kind: 'open' });
    expect(v.readSlot('data')).toBe('kept');
  });

  it('close twice, or before any start, is fine', async () => {
    const v = device();
    await v.close();
    await v.startVault();
    await Promise.all([v.close(), v.close()]);
    await v.close();
    expect(v.isVaultOpen()).toBe(false);
  });

  it('the data of the opened slots is not served from memory after close and unlock', async () => {
    const env = memoryEnvironment();
    const v = device(env);
    await v.startVault();
    v.writeSlot('data', 'one');
    await v.setLock('Secret-2026', undefined, R);
    await v.close();
    // changed in the storage meanwhile (another tab): the next opening reads the storage again
    const other = device(env);
    await other.startVault();
    expect(await other.unlock('Secret-2026')).toEqual({ kind: 'open' });
    other.writeSlot('data', 'two');
    await other.saved();
    await v.unlock('Secret-2026');
    expect(v.readSlot('data')).toBe('two');
  });

  it('two instances are independent: closing one leaves the other open', async () => {
    const a = device();
    const b = createVault({ prefix: 'other', slots: ['data'], minRounds: R }, memoryEnvironment());
    await a.startVault();
    await b.startVault();
    b.writeSlot('data', 'b-data');
    await a.close();
    expect(a.isVaultOpen()).toBe(false);
    expect(b.isVaultOpen()).toBe(true);
    expect(b.readSlot('data')).toBe('b-data');
  });

  it('works against IndexedDB too', async () => {
    const prefix = 'cl1';
    const env = browserEnvironment(prefix);
    const v = createVault({ prefix, slots: ['data'], minRounds: R }, env);
    await v.startVault();
    v.writeSlot('data', 'idb');
    await v.putBytes('doc', bytes(5));
    await v.close();
    expect(v.isVaultOpen()).toBe(false);
    expect(await v.startVault()).toEqual({ kind: 'open' });
    expect(v.readSlot('data')).toBe('idb');
    expect(await v.getBytes('doc')).toEqual(bytes(5));
  });
});

describe('close (users mode)', () => {
  it('forgets the key and the user, keeps the ring: login works again without a reload', async () => {
    const env = memoryEnvironment();
    const v = users(env);
    await v.startVault();
    await v.setupFirstUser('anna', ANNA, R);
    v.writeSlot('data', 'anna data');
    await v.putBytes('doc', bytes(4, 2));
    expect(v.currentUser()).toBe('anna');
    await v.close();
    expect(v.isVaultOpen()).toBe(false);
    expect(v.currentUser()).toBeUndefined();
    expect(v.users()).toEqual(['anna']);
    expect(() => v.readSlot('data')).toThrow(/not open/i);
    await expect(v.getBytes('doc')).rejects.toThrow(/not open/i);
    expect(await env.readBundle()).toBeDefined(); // the ring stays stored
    expect(await v.loginUser('anna', 'wrong passphrase')).toBe(false);
    expect(v.isVaultOpen()).toBe(false);
    expect(await v.loginUser('anna', ANNA)).toEqual({ kind: 'open' });
    expect(v.currentUser()).toBe('anna');
    expect(v.readSlot('data')).toBe('anna data');
    expect(await v.getBytes('doc')).toEqual(bytes(4, 2));
  });

  it('pending writes are stored first; a ring change in progress is not cut', async () => {
    const env = memoryEnvironment();
    const v = users(env);
    await v.startVault();
    await v.setupFirstUser('anna', ANNA, R);
    v.writeSlot('data', 'last words');
    await v.close();
    const again = users(env);
    await again.startVault();
    await again.loginUser('anna', ANNA);
    expect(again.readSlot('data')).toBe('last words');
  });

  it('a fresh start() after close reads the stored ring again', async () => {
    const env = memoryEnvironment();
    const first = users(env);
    await first.startVault();
    await first.setupFirstUser('anna', ANNA, R);
    await first.addUser('bernd', 'Bernds Passphrase', { user: 'anna', passphrase: ANNA }, R);
    const second = users(env);
    await second.startVault();
    await second.loginUser('anna', ANNA);
    await second.close();
    await first.removeUser('bernd');
    expect(second.users()).toEqual(['anna', 'bernd']); // its view of the ring is old ...
    expect(await second.startVault()).toEqual({ kind: 'locked' });
    expect(second.users()).toEqual(['anna']); // ... startVault reads the storage again
  });
});
