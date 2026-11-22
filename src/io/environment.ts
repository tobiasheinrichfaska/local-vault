// Where a vault keeps its pieces: the browser (IndexedDB for the keys, localStorage for the
// encrypted slots) or, in tests, memory. `guardEnvironment` makes sure no store name outside the
// app's prefix is ever touched.
import { databaseName, hasPrefix } from '../logic/config.ts';
import { DEFAULT_TEXTS, type VaultTexts } from '../logic/texts.ts';
import { CHUNK_MARK } from '../logic/blobs.ts';
import { createDeviceKey, type Bundle, type Piece, type UsersBundle } from '../logic/vault.ts';

/**
 * A record of the blob store: `{iv, ct}` as the earlier one-piece blob and the blocks, `v` set on the
 * head of a blob in blocks (the earlier format has none). Which key holds which is the vault's business.
 */
export interface StoredBlob extends Piece {
  readonly v?: number;
}

/** What `updateBundle` found and did. */
export interface BundleUpdate {
  /** What is stored afterwards (the new bundle when `written`, else what was there). */
  readonly value: unknown;
  readonly written: boolean;
}

export interface VaultEnvironment {
  /** The device key, made and stored on first use (one key even for two callers at once). */
  deviceKey(): Promise<CryptoKey>;
  readBundle(): Promise<unknown>;
  writeBundle(bundle: Bundle | UsersBundle): Promise<void>;
  /**
   * Reads the stored bundle and, in the same step, replaces it: `update` gets what is stored right now
   * and returns the new bundle, or undefined to leave it. No other writer (a second tab) comes in
   * between — one IndexedDB transaction in the browser. `update` must be synchronous and not throw.
   */
  updateBundle(
    update: (current: unknown) => Bundle | UsersBundle | undefined,
  ): Promise<BundleUpdate>;
  /** Removes the key bundle (users mode: start anew goes back to the set-up). */
  clearBundle(): Promise<void>;
  /** `name` is the full store name (`<prefix>-<slot>`). */
  read(name: string): string | null;
  /** Throws when the browser does not store it (full, forbidden). */
  write(name: string, value: string): void;
  remove(name: string): void;
  /**
   * Blobs: encrypted records under keys, kept in IndexedDB — no size limit of localStorage's kind, no
   * text round trip. A key is a blob name (the head, or the whole blob of the earlier format) or a block
   * key, which starts with `CHUNK_MARK` (`~`) and so sorts after every blob name. Keys are whatever the
   * vault validated.
   */
  readBlob(key: string): Promise<StoredBlob | undefined>;
  writeBlob(key: string, record: StoredBlob): Promise<void>;
  removeBlob(key: string): Promise<void>;
  /** Removes these keys in one step (missing ones are fine). */
  removeBlobs(keys: readonly string[]): Promise<void>;
  /** Every key (blob names and block keys) starting with `prefix`, sorted — keys only, no values read. */
  listBlobKeys(prefix?: string): Promise<string[]>;
  /** Every blob name (no block key), sorted, with its record: the head, or the whole piece of the earlier format. */
  listBlobHeads(): Promise<{ name: string; record: StoredBlob }[]>;
  /** Removes every record (start anew: they would be unreadable under a new data key). */
  clearBlobs(): Promise<void>;
}

const STORE = 'vault';
const BLOBS = 'blobs';
/** 1: the key bundle (store `vault`); 2: adds the store `blobs`. */
const DB_VERSION = 2;

type BrowserMessages = Pick<
  VaultTexts,
  'indexedDbUnavailable' | 'vaultUnreachable' | 'vaultNotStored' | 'vaultBlocked'
>;

/** The environment of a real page; the database is called `<prefix>-vault`. */
export function browserEnvironment(
  prefix: string,
  messages: BrowserMessages = DEFAULT_TEXTS,
): VaultEnvironment {
  const dbName = databaseName(prefix);

  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, DB_VERSION);
      let blocked = false;
      // another tab (or an older version of the app) still holds version 1 open: say so, don't wait for ever
      request.onblocked = () => {
        blocked = true;
        reject(new Error(messages.vaultBlocked));
      };
      // Creates only what is missing: version 1 data (the key bundle, the device key) stays as it is.
      request.onupgradeneeded = () => {
        const names = request.result.objectStoreNames;
        if (!names.contains(STORE)) request.result.createObjectStore(STORE);
        if (!names.contains(BLOBS)) request.result.createObjectStore(BLOBS);
      };
      request.onsuccess = () => {
        if (blocked) return request.result.close(); // came too late: the caller has given up
        // a newer page asking for an upgrade is never blocked by this connection
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error(messages.indexedDbUnavailable));
    });
  }

  async function idb<T>(
    mode: IDBTransactionMode,
    work: (s: IDBObjectStore) => T,
    store: string = STORE,
  ): Promise<T> {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const result = work(tx.objectStore(store));
        tx.oncomplete = () => resolve(result);
        // the browser's own error is passed on as it is (a full storage: name `QuotaExceededError`)
        tx.onerror = (event) =>
          reject(
            (event.target as IDBRequest | null)?.error ??
              tx.error ??
              new Error(messages.vaultUnreachable),
          );
        // a full storage aborts the transaction (QuotaExceededError) — not always with an error event
        tx.onabort = () => reject(tx.error ?? new Error(messages.vaultNotStored));
      });
    } finally {
      db.close();
    }
  }

  return {
    async deviceKey() {
      const fresh = await createDeviceKey();
      let stored: CryptoKey = fresh;
      // Read and write in one transaction: a second tab never replaces the first key.
      await idb('readwrite', (store) => {
        const request = store.get('device');
        request.onsuccess = () => {
          if (request.result instanceof CryptoKey) stored = request.result;
          else store.put(fresh, 'device');
        };
      });
      return stored;
    },
    async readBundle() {
      let value: unknown;
      await idb('readonly', (store) => {
        const request = store.get('bundle');
        request.onsuccess = () => (value = request.result);
      });
      return value;
    },
    async writeBundle(bundle) {
      await idb('readwrite', (store) => store.put(bundle, 'bundle'));
    },
    async updateBundle(update) {
      let result: BundleUpdate = { value: undefined, written: false };
      await idb('readwrite', (store) => {
        const request = store.get('bundle');
        request.onsuccess = () => {
          const next = update(request.result);
          if (next === undefined) result = { value: request.result, written: false };
          else {
            store.put(next, 'bundle');
            result = { value: next, written: true };
          }
        };
      });
      return result;
    },
    async clearBundle() {
      await idb('readwrite', (store) => store.delete('bundle'));
    },
    read: (name) => localStorage.getItem(name),
    write: (name, value) => localStorage.setItem(name, value),
    remove: (name) => localStorage.removeItem(name),
    async readBlob(key) {
      let value: unknown;
      await idb(
        'readonly',
        (store) => {
          const request = store.get(key);
          request.onsuccess = () => (value = request.result);
        },
        BLOBS,
      );
      return isRecord(value) ? value : undefined;
    },
    async writeBlob(key, record) {
      const stored = record.v === undefined ? { iv: record.iv, ct: record.ct } : { ...record };
      await idb('readwrite', (store) => store.put(stored, key), BLOBS);
    },
    async removeBlob(key) {
      await idb('readwrite', (store) => store.delete(key), BLOBS);
    },
    async removeBlobs(keys) {
      if (keys.length === 0) return;
      await idb(
        'readwrite',
        (store) => {
          for (const key of keys) store.delete(key);
        },
        BLOBS,
      );
    },
    async listBlobKeys(prefix = '') {
      let keys: IDBValidKey[] = [];
      await idb(
        'readonly',
        (store) => {
          const request = store.getAllKeys(
            prefix === '' ? undefined : IDBKeyRange.bound(prefix, `${prefix}\uffff`),
          );
          request.onsuccess = () => (keys = request.result);
        },
        BLOBS,
      );
      return keys.filter((k): k is string => typeof k === 'string').sort();
    },
    async listBlobHeads() {
      const found: { name: string; record: StoredBlob }[] = [];
      await idb(
        'readonly',
        (store) => {
          // blob names all sort before the block keys: only that range is read, no block is loaded
          const request = store.openCursor(IDBKeyRange.upperBound(CHUNK_MARK, true));
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            const value: unknown = cursor.value;
            if (typeof cursor.key === 'string' && isRecord(value)) {
              found.push({ name: cursor.key, record: value });
            }
            cursor.continue();
          };
        },
        BLOBS,
      );
      return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    },
    async clearBlobs() {
      await idb('readwrite', (store) => store.clear(), BLOBS);
    },
  };
}

const isRecord = (v: unknown): v is StoredBlob =>
  typeof v === 'object' &&
  v !== null &&
  (v as Piece).iv instanceof Uint8Array &&
  (v as Piece).ct instanceof Uint8Array &&
  ((v as StoredBlob).v === undefined || typeof (v as StoredBlob).v === 'number');

/** Tests: a vault in memory. */
export function memoryEnvironment(): VaultEnvironment & {
  /** As localStorage. */
  readonly raw: Map<string, string>;
  /** As the IndexedDB store of blobs (heads, blocks, old pieces). */
  readonly blobs: Map<string, StoredBlob>;
} {
  const raw = new Map<string, string>();
  const blobs = new Map<string, StoredBlob>();
  let key: Promise<CryptoKey> | undefined;
  let storedBundle: unknown;
  return {
    raw,
    blobs,
    deviceKey: () => (key ??= createDeviceKey()),
    readBundle: async () => storedBundle,
    writeBundle: async (b) => void (storedBundle = b),
    updateBundle: async (update) => {
      const next = update(storedBundle);
      if (next === undefined) return { value: storedBundle, written: false };
      storedBundle = next;
      return { value: next, written: true };
    },
    clearBundle: async () => void (storedBundle = undefined),
    read: (s) => raw.get(s) ?? null,
    write: (s, v) => void raw.set(s, v),
    remove: (s) => void raw.delete(s),
    readBlob: async (k) => blobs.get(k),
    writeBlob: async (k, r) => void blobs.set(k, r),
    removeBlob: async (k) => void blobs.delete(k),
    removeBlobs: async (keys) => void keys.forEach((k) => blobs.delete(k)),
    listBlobKeys: async (prefix = '') =>
      [...blobs.keys()].filter((k) => k.startsWith(prefix)).sort(),
    listBlobHeads: async () =>
      [...blobs]
        .filter(([k]) => !k.startsWith(CHUNK_MARK))
        .map(([name, record]) => ({ name, record }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    clearBlobs: async () => blobs.clear(),
  };
}

/** The same environment, but any store name outside `<prefix>-` throws instead of being touched. */
export function guardEnvironment(prefix: string, env: VaultEnvironment): VaultEnvironment {
  const check = (name: string) => {
    if (!hasPrefix(prefix, name)) {
      throw new Error(`Store name "${name}" does not start with "${prefix}-"`);
    }
    return name;
  };
  return {
    deviceKey: () => env.deviceKey(),
    readBundle: () => env.readBundle(),
    writeBundle: (bundle) => env.writeBundle(bundle),
    updateBundle: (update) => env.updateBundle(update),
    clearBundle: () => env.clearBundle(),
    read: (name) => env.read(check(name)),
    write: (name, value) => env.write(check(name), value),
    remove: (name) => env.remove(check(name)),
    // blobs live in the database `<prefix>-vault`, which is the prefix's own
    readBlob: (key) => env.readBlob(key),
    writeBlob: (key, record) => env.writeBlob(key, record),
    removeBlob: (key) => env.removeBlob(key),
    removeBlobs: (keys) => env.removeBlobs(keys),
    listBlobKeys: (prefix) => env.listBlobKeys(prefix),
    listBlobHeads: () => env.listBlobHeads(),
    clearBlobs: () => env.clearBlobs(),
  };
}
