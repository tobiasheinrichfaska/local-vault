// The browser environment against an IndexedDB (fake-indexeddb): the blob store, and the upgrade
// of a version 1 database (key bundle only) that must keep what it had.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { browserEnvironment } from '../../src/io/environment.ts';
import { createVault } from '../../src/io/vault.ts';

// Node has no localStorage: a small one, as a page has it
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

let n = 0;
let prefix = 'app';
beforeEach(() => {
  prefix = `app${++n}`; // a database of its own per test
});

const bytes = (...v: number[]) => new Uint8Array(v);

describe('blob store in IndexedDB', () => {
  it('read, write, replace, list, remove, clear', async () => {
    const env = browserEnvironment(prefix);
    expect(await env.readBlob('a')).toBeUndefined();
    await env.writeBlob('b', { iv: bytes(1), ct: bytes(2, 3) });
    await env.writeBlob('a', { iv: bytes(4), ct: bytes(5) });
    await env.writeBlob('a', { iv: bytes(6), ct: bytes(7) });
    expect(await env.readBlob('a')).toEqual({ iv: bytes(6), ct: bytes(7) });
    expect(await env.listBlobs()).toEqual(['a', 'b']);
    await env.removeBlob('a');
    expect(await env.listBlobs()).toEqual(['b']);
    await env.clearBlobs();
    expect(await env.listBlobs()).toEqual([]);
  });

  it('a stored value that is no piece reads as none (never a wrong shape)', async () => {
    const env = browserEnvironment(prefix);
    await env.writeBlob('a', { iv: bytes(1), ct: bytes(2) });
    const db = await new Promise<IDBDatabase>((ok, fail) => {
      const r = indexedDB.open(`${prefix}-vault`);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    });
    await new Promise<void>((ok) => {
      const tx = db.transaction('blobs', 'readwrite');
      tx.objectStore('blobs').put('plain text', 'a');
      tx.oncomplete = () => ok();
    });
    db.close();
    expect(await env.readBlob('a')).toBeUndefined();
  });

  it('a whole vault: the device key and the data come back after a new page load', async () => {
    const first = createVault({ prefix, slots: ['data'] }, browserEnvironment(prefix));
    expect(await first.startVault()).toEqual({ kind: 'open' });
    const doc = new Uint8Array(500_000).map((_, i) => i % 199);
    await first.putBytes('datei:abc', doc);
    await first.saved();
    const second = createVault({ prefix, slots: ['data'] }, browserEnvironment(prefix));
    expect(await second.startVault()).toEqual({ kind: 'open' });
    expect(Buffer.from((await second.getBytes('datei:abc'))!).equals(Buffer.from(doc))).toBe(true);
  });
});

describe('upgrade from version 1', () => {
  it('the key bundle and the device key of a version 1 database survive', async () => {
    // a version 1 database as the first release made it: one store `vault`
    await new Promise<void>((ok, fail) => {
      const r = indexedDB.open(`${prefix}-vault`, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('vault');
      r.onsuccess = () => {
        const tx = r.result.transaction('vault', 'readwrite');
        tx.objectStore('vault').put({ m: 'old bundle' }, 'bundle');
        tx.oncomplete = () => {
          r.result.close();
          ok();
        };
      };
      r.onerror = () => fail(r.error);
    });
    const env = browserEnvironment(prefix);
    expect(await env.readBundle()).toEqual({ m: 'old bundle' });
    expect(await env.listBlobs()).toEqual([]);
    await env.writeBlob('a', { iv: bytes(1), ct: bytes(2) });
    expect(await env.readBundle()).toEqual({ m: 'old bundle' });
  });
});
