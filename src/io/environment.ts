// Where a vault keeps its pieces: the browser (IndexedDB for the keys, localStorage for the
// encrypted slots) or, in tests, memory. `guardEnvironment` makes sure no store name outside the
// app's prefix is ever touched.
import { databaseName, hasPrefix } from '../logic/config.ts';
import { DEFAULT_TEXTS, type VaultTexts } from '../logic/texts.ts';
import { createDeviceKey, type Bundle, type Piece } from '../logic/vault.ts';

export interface VaultEnvironment {
  /** The device key, made and stored on first use (one key even for two callers at once). */
  deviceKey(): Promise<CryptoKey>;
  readBundle(): Promise<unknown>;
  writeBundle(bundle: Bundle): Promise<void>;
  /** `name` is the full store name (`<prefix>-<slot>`). */
  read(name: string): string | null;
  /** Throws when the browser does not store it (full, forbidden). */
  write(name: string, value: string): void;
  remove(name: string): void;
  /**
   * Blobs: encrypted pieces under free names (`vault.putBytes`), kept in IndexedDB — no size limit
   * of localStorage's kind, no text round trip. The name is whatever the vault validated.
   */
  readBlob(name: string): Promise<Piece | undefined>;
  writeBlob(name: string, piece: Piece): Promise<void>;
  removeBlob(name: string): Promise<void>;
  /** Every blob name, sorted. */
  listBlobs(): Promise<string[]>;
  /** Removes every blob (start anew: they would be unreadable under a new data key). */
  clearBlobs(): Promise<void>;
}

const STORE = 'vault';
const BLOBS = 'blobs';
/** 1: the key bundle (store `vault`); 2: adds the store `blobs`. */
const DB_VERSION = 2;

type BrowserMessages = Pick<
  VaultTexts,
  'indexedDbUnavailable' | 'vaultUnreachable' | 'vaultNotStored'
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
      // Creates only what is missing: version 1 data (the key bundle, the device key) stays as it is.
      request.onupgradeneeded = () => {
        const names = request.result.objectStoreNames;
        if (!names.contains(STORE)) request.result.createObjectStore(STORE);
        if (!names.contains(BLOBS)) request.result.createObjectStore(BLOBS);
      };
      request.onsuccess = () => {
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
        tx.onerror = () => reject(tx.error ?? new Error(messages.vaultUnreachable));
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
    read: (name) => localStorage.getItem(name),
    write: (name, value) => localStorage.setItem(name, value),
    remove: (name) => localStorage.removeItem(name),
    async readBlob(name) {
      let value: unknown;
      await idb(
        'readonly',
        (store) => {
          const request = store.get(name);
          request.onsuccess = () => (value = request.result);
        },
        BLOBS,
      );
      return isPiece(value) ? value : undefined;
    },
    async writeBlob(name, piece) {
      await idb('readwrite', (store) => store.put({ iv: piece.iv, ct: piece.ct }, name), BLOBS);
    },
    async removeBlob(name) {
      await idb('readwrite', (store) => store.delete(name), BLOBS);
    },
    async listBlobs() {
      let names: IDBValidKey[] = [];
      await idb(
        'readonly',
        (store) => {
          const request = store.getAllKeys();
          request.onsuccess = () => (names = request.result);
        },
        BLOBS,
      );
      return names.filter((n): n is string => typeof n === 'string').sort();
    },
    async clearBlobs() {
      await idb('readwrite', (store) => store.clear(), BLOBS);
    },
  };
}

const isPiece = (v: unknown): v is Piece =>
  typeof v === 'object' &&
  v !== null &&
  (v as Piece).iv instanceof Uint8Array &&
  (v as Piece).ct instanceof Uint8Array;

/** Tests: a vault in memory. */
export function memoryEnvironment(): VaultEnvironment & {
  /** As localStorage. */
  readonly raw: Map<string, string>;
  /** As the IndexedDB store of blobs. */
  readonly blobs: Map<string, Piece>;
} {
  const raw = new Map<string, string>();
  const blobs = new Map<string, Piece>();
  let key: Promise<CryptoKey> | undefined;
  let storedBundle: unknown;
  return {
    raw,
    blobs,
    deviceKey: () => (key ??= createDeviceKey()),
    readBundle: async () => storedBundle,
    writeBundle: async (b) => void (storedBundle = b),
    read: (s) => raw.get(s) ?? null,
    write: (s, v) => void raw.set(s, v),
    remove: (s) => void raw.delete(s),
    readBlob: async (n) => blobs.get(n),
    writeBlob: async (n, p) => void blobs.set(n, p),
    removeBlob: async (n) => void blobs.delete(n),
    listBlobs: async () => [...blobs.keys()].sort(),
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
    read: (name) => env.read(check(name)),
    write: (name, value) => env.write(check(name), value),
    remove: (name) => env.remove(check(name)),
    // blobs live in the database `<prefix>-vault`, which is the prefix's own
    readBlob: (name) => env.readBlob(name),
    writeBlob: (name, piece) => env.writeBlob(name, piece),
    removeBlob: (name) => env.removeBlob(name),
    listBlobs: () => env.listBlobs(),
    clearBlobs: () => env.clearBlobs(),
  };
}
