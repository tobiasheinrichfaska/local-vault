// Blob sizes, a full storage as a recognisable error, and the helpers for the browser's storage.
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserEnvironment, memoryEnvironment } from '../../src/io/environment.ts';
import { isQuotaError, requestPersistence, storageEstimate } from '../../src/io/storage.ts';
import { createVault } from '../../src/io/vault.ts';

const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

let n = 0;
afterEach(() => vi.restoreAllMocks());

const quota = () => new DOMException('The quota has been exceeded.', 'QuotaExceededError');

describe('listBytesInfo', () => {
  async function fill(env = memoryEnvironment()) {
    const v = createVault({ prefix: 'app', slots: ['data'] }, env);
    await v.startVault();
    await v.putBytes('doc:b', new Uint8Array(100));
    await v.putBytes('doc:a', new Uint8Array(0));
    await v.putBytes('img:x', new Uint8Array(1234));
    return v;
  }

  it('names and plain sizes, sorted; the prefix filters (memory)', async () => {
    const v = await fill();
    expect(await v.listBytesInfo()).toEqual([
      { name: 'doc:a', size: 0 },
      { name: 'doc:b', size: 100 },
      { name: 'img:x', size: 1234 },
    ]);
    expect(await v.listBytesInfo('doc:')).toEqual([
      { name: 'doc:a', size: 0 },
      { name: 'doc:b', size: 100 },
    ]);
    expect(await v.listBytes('doc:')).toEqual(['doc:a', 'doc:b']);
  });

  it('the same in IndexedDB', async () => {
    const prefix = `info${++n}`;
    const v = createVault({ prefix, slots: ['data'] }, browserEnvironment(prefix));
    await v.startVault();
    await v.putBytes('doc:b', new Uint8Array(100));
    await v.putBytes('doc:a', new Uint8Array(7));
    expect(await v.listBytesInfo()).toEqual([
      { name: 'doc:a', size: 7 },
      { name: 'doc:b', size: 100 },
    ]);
  });

  it('throws while closed', async () => {
    const v = createVault({ prefix: 'app', slots: ['data'] }, memoryEnvironment());
    await expect(v.listBytesInfo()).rejects.toThrow(/not open/);
  });
});

describe('a full storage', () => {
  it('putBytes rejects with the browser’s error as cause (memory stand-in)', async () => {
    const env = memoryEnvironment();
    const cause = quota();
    const v = createVault(
      { prefix: 'app', slots: ['data'] },
      { ...env, writeBlob: () => Promise.reject(cause) },
    );
    await v.startVault();
    const error = await v.putBytes('doc:a', new Uint8Array(1)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Not saved/);
    expect((error as Error).cause).toBe(cause);
    expect(isQuotaError(error)).toBe(true);
  });

  it('putBytes in IndexedDB: a quota error of the browser is recognisable', async () => {
    const prefix = `quota${++n}`;
    const v = createVault({ prefix, slots: ['data'] }, browserEnvironment(prefix));
    await v.startVault();
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw quota();
    });
    const error = await v.putBytes('doc:a', new Uint8Array(1)).then(
      () => undefined,
      (e: unknown) => e,
    );
    put.mockRestore();
    expect(isQuotaError(error)).toBe(true);
    expect(((error as Error).cause as DOMException).name).toBe('QuotaExceededError');
    await v.putBytes('doc:a', new Uint8Array(1)); // and it works again afterwards
  });

  it('an aborted transaction without an error gives the generic message', async () => {
    const prefix = `abort${++n}`;
    const env = browserEnvironment(prefix);
    // a request fails with the quota error: the browser aborts the transaction with that error
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
    ) {
      this.transaction.abort();
      return undefined as never;
    });
    const error = await env.writeBlob('a', { iv: new Uint8Array(1), ct: new Uint8Array(1) }).then(
      () => undefined,
      (e: unknown) => e,
    );
    put.mockRestore();
    expect(error).toBeInstanceOf(Error); // the generic message when the browser gives none
    expect(isQuotaError(error)).toBe(false);
  });

  it('a request that fails inside the transaction passes its own error on, not a generic one', async () => {
    const prefix = `request${++n}`;
    const env = browserEnvironment(prefix);
    // the second add of one key fails in the request (as a full storage does): its error is the browser's
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      value: unknown,
      key?: IDBValidKey,
    ) {
      this.add(value, key);
      return this.add(value, key);
    });
    const error = await env.writeBlob('a', { iv: new Uint8Array(1), ct: new Uint8Array(1) }).then(
      () => undefined,
      (e: unknown) => e,
    );
    put.mockRestore();
    expect((error as DOMException).name).toBe('ConstraintError');
  });

  it('isQuotaError looks through causes, and only for a quota error', () => {
    expect(isQuotaError(quota())).toBe(true);
    expect(isQuotaError(new Error('x', { cause: new Error('y', { cause: quota() }) }))).toBe(true);
    expect(isQuotaError(new Error('x'))).toBe(false);
    expect(isQuotaError(undefined)).toBe(false);
    expect(isQuotaError('QuotaExceededError')).toBe(false);
    const loop: { name?: string; cause?: unknown } = {};
    loop.cause = loop;
    expect(isQuotaError(loop)).toBe(false); // no endless loop
  });
});

describe('storageEstimate and requestPersistence', () => {
  it('pass on what navigator.storage says', async () => {
    const nav = {
      storage: {
        estimate: () => Promise.resolve({ usage: 5, quota: 100, usageDetails: {} }),
        persist: () => Promise.resolve(true),
      },
    };
    expect(await storageEstimate(nav)).toEqual({ usage: 5, quota: 100 });
    expect(await requestPersistence(nav)).toBe(true);
    expect(await requestPersistence({ storage: { persist: () => Promise.resolve(false) } })).toBe(
      false,
    );
  });

  it('answer "unknown" without navigator.storage, and never throw', async () => {
    expect(await storageEstimate({})).toBeUndefined();
    expect(await requestPersistence({})).toBe(false);
    expect(await storageEstimate({ storage: {} })).toBeUndefined();
    const failing = {
      storage: {
        estimate: () => Promise.reject(new Error('no')),
        persist: () => Promise.reject(new Error('no')),
      },
    };
    expect(await storageEstimate(failing)).toBeUndefined();
    expect(await requestPersistence(failing)).toBe(false);
  });

  it('use the global navigator when none is passed', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { storage: { estimate: () => Promise.resolve({ usage: 1, quota: 2 }) } },
    });
    try {
      expect(await storageEstimate()).toEqual({ usage: 1, quota: 2 });
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });
});

describe('an open database held by another tab', () => {
  it('says so instead of waiting for ever, and works once the other lets go', async () => {
    const prefix = `blocked${++n}`;
    // a version 1 database held open by an older page that never closes (no versionchange handler)
    const old = await new Promise<IDBDatabase>((ok, fail) => {
      const r = indexedDB.open(`${prefix}-vault`, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('vault');
      r.onsuccess = () => ok(r.result);
      r.onerror = () => fail(r.error);
    });
    const env = browserEnvironment(prefix);
    await expect(env.listBlobKeys()).rejects.toThrow(/in use by another tab/);
    old.close();
    await new Promise((r) => setTimeout(r, 20)); // the pending upgrade finishes and is closed again
    expect(await env.listBlobKeys()).toEqual([]);
  });
});
