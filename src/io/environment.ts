// Where a vault keeps its pieces: the browser (IndexedDB for the keys, localStorage for the
// encrypted slots) or, in tests, memory. `guardEnvironment` makes sure no store name outside the
// app's prefix is ever touched.
import { databaseName, hasPrefix } from '../logic/config.ts';
import { DEFAULT_TEXTS, type VaultTexts } from '../logic/texts.ts';
import { createDeviceKey, type Bundle } from '../logic/vault.ts';

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
}

const STORE = 'vault';

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
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error(messages.indexedDbUnavailable));
    });
  }

  async function idb<T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => T): Promise<T> {
    const db = await openDb();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const result = work(tx.objectStore(STORE));
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
  };
}

/** Tests: a vault in memory. */
export function memoryEnvironment(): VaultEnvironment & {
  /** As localStorage. */
  readonly raw: Map<string, string>;
} {
  const raw = new Map<string, string>();
  let key: Promise<CryptoKey> | undefined;
  let storedBundle: unknown;
  return {
    raw,
    deviceKey: () => (key ??= createDeviceKey()),
    readBundle: async () => storedBundle,
    writeBundle: async (b) => void (storedBundle = b),
    read: (s) => raw.get(s) ?? null,
    write: (s, v) => void raw.set(s, v),
    remove: (s) => void raw.delete(s),
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
  };
}
