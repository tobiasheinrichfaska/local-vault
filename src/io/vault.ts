// A vault (instance): opens once before the app shows anything, holds the data key in memory and
// the opened slots, and writes every change encrypted. A slot that cannot be opened (other key,
// damaged — or plain: no way back to unencrypted) is never overwritten: writing to it is refused
// and the reason shown. Each `createVault` call has its own state.
import { storageName, validateConfig, type VaultConfig } from '../logic/config.ts';
import { resolveTexts, type VaultTexts } from '../logic/texts.ts';
import {
  bundleWithLock,
  bundleWithoutLock,
  createDataKey,
  isSealed,
  openBundle,
  openText,
  parseBundle,
  sealText,
  type Bundle,
} from '../logic/vault.ts';
import { browserEnvironment, guardEnvironment, type VaultEnvironment } from './environment.ts';

export type StartResult =
  | { readonly kind: 'open' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'error'; readonly error: string };

export interface Vault {
  readonly config: VaultConfig;
  /** The English defaults with the app's texts on top. */
  readonly texts: VaultTexts;
  /** The browser store name of a slot (`<prefix>-<slot>`). */
  storageName(slot: string): string;
  /**
   * Before the app shows anything: the device key, the data key (made on the very first start) and,
   * without the app lock, the data. With the lock on: `locked` until `unlock`.
   */
  startVault(): Promise<StartResult>;
  /** With the app lock on; `false` for a wrong password. */
  unlock(password: string): Promise<StartResult | false>;
  isVaultOpen(): boolean;
  isLockOn(): boolean;
  /**
   * A slot as it was stored (opened), null when there is none. Throws while the vault is closed and
   * for a slot that could not be opened (never an empty value a save would write over real data).
   */
  readSlot(slot: string): string | null;
  /**
   * Takes the new state at once (readers see it) and writes it encrypted right after; the storage
   * error, if any, comes through `onError`. Returns the reason when refused (a slot that could not
   * be opened), otherwise undefined.
   */
  writeSlot(slot: string, value: string): string | undefined;
  /** Resolves when everything written so far is stored. */
  saved(): Promise<void>;
  /** Every storage error after the fact (writing is asynchronous); returns the unsubscribe function. */
  onError(listener: (error: string) => void): () => void;
  /** Locks now: waits for the last write, then reloads (the opened data leaves memory). */
  lockNow(): void;
  /** Gives up this device's data (unreadable, or the password forgotten): empty, under a new data key. */
  startAnew(): Promise<void>;
  /** The app lock on (or a new password); returns the reason when it failed, otherwise undefined. */
  setLock(password: string, current?: string, rounds?: number): Promise<string | undefined>;
  removeLock(current: string): Promise<string | undefined>;
}

interface Opened {
  readonly device: CryptoKey;
  bundle: Bundle;
  data: CryptoKey;
  readonly content: Map<string, string | null>;
  /** Slots that could not be opened — never overwritten. */
  readonly unreadable: Set<string>;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `env` defaults to the browser (IndexedDB + localStorage); tests pass `memoryEnvironment()`. */
export function createVault(config: VaultConfig, env?: VaultEnvironment): Vault {
  validateConfig(config);
  const { prefix } = config;
  const texts = resolveTexts(config.texts);
  const environment = guardEnvironment(prefix, env ?? browserEnvironment(prefix, texts));
  const name = (slot: string) => {
    if (!config.slots.includes(slot)) throw new Error(`Unknown slot: "${slot}"`);
    return storageName(prefix, slot);
  };

  let device: CryptoKey | undefined;
  let bundle: Bundle | undefined;
  let opened: Opened | undefined;
  const waiting = new Map<string, string>(); // by slot
  let running: Promise<void> | undefined;
  const listeners = new Set<(error: string) => void>();

  const report = (error: string) => {
    for (const l of [...listeners]) l(error);
  };

  async function loadContent(data: CryptoKey) {
    const content = new Map<string, string | null>();
    const unreadable = new Set<string>();
    for (const slot of config.slots) {
      const raw = environment.read(name(slot));
      if (raw === null) content.set(slot, null);
      // plain: never read — that would be a way back to unencrypted
      else if (!isSealed(prefix, raw)) unreadable.add(slot);
      else {
        const plain = await openText(prefix, data, name(slot), raw);
        if (plain === undefined) unreadable.add(slot);
        else content.set(slot, plain);
      }
    }
    return { content, unreadable };
  }

  async function openWith(data: CryptoKey): Promise<StartResult> {
    if (!device || !bundle) return { kind: 'error', error: texts.notStarted };
    const { content, unreadable } = await loadContent(data);
    opened = { device, bundle, data, content, unreadable };
    if (unreadable.size > 0) return { kind: 'error', error: texts.dataUnreadable };
    return { kind: 'open' };
  }

  function requireOpen(): Opened {
    if (!opened) throw new Error(texts.notOpen);
    return opened;
  }

  async function work(): Promise<void> {
    try {
      for (;;) {
        const next = waiting.entries().next();
        if (next.done) return;
        const [slot, value] = next.value;
        waiting.delete(slot);
        const o = opened;
        if (!o) return waiting.clear();
        try {
          environment.write(name(slot), await sealText(prefix, o.data, name(slot), value));
        } catch (error) {
          report(texts.notSaved(message(error)));
        }
      }
    } finally {
      running = undefined;
    }
  }

  async function rewrap(make: (data: CryptoKey) => Promise<Bundle>, password?: string) {
    const o = requireOpen();
    const extractable = await openBundle(prefix, o.device, o.bundle, password, true);
    if (!extractable) return texts.wrongCurrentPassword;
    const next = await make(extractable);
    try {
      await environment.writeBundle(next);
    } catch (error) {
      return texts.notSaved(message(error));
    }
    o.bundle = next;
    bundle = next;
    return undefined;
  }

  const saved = () => running ?? Promise.resolve();

  return {
    config,
    texts,
    storageName: name,

    async startVault() {
      opened = undefined;
      try {
        device = await environment.deviceKey();
        const storedBundle = await environment.readBundle();
        const read = parseBundle(prefix, storedBundle);
        if (storedBundle !== undefined && !read) return { kind: 'error', error: texts.keyDamaged };
        if (!read) {
          const fresh = await createDataKey();
          bundle = await bundleWithoutLock(prefix, device, fresh);
          await environment.writeBundle(bundle);
        } else bundle = read;
        if (bundle.kind === 'password') return { kind: 'locked' };
        const data = await openBundle(prefix, device, bundle);
        if (!data) return { kind: 'error', error: texts.keyMismatch };
        return await openWith(data);
      } catch (error) {
        return { kind: 'error', error: texts.storageUnreachable(message(error)) };
      }
    },

    async unlock(password) {
      if (!device || !bundle) return { kind: 'error', error: texts.notStarted };
      const data = await openBundle(prefix, device, bundle, password);
      return data ? openWith(data) : false;
    },

    isVaultOpen: () => opened !== undefined,
    isLockOn: () => bundle?.kind === 'password',

    readSlot(slot) {
      name(slot); // unknown slot throws
      const o = requireOpen();
      if (o.unreadable.has(slot)) throw new Error(texts.slotUnreadable);
      return o.content.get(slot) ?? null;
    },

    writeSlot(slot, value) {
      name(slot);
      const o = requireOpen();
      if (o.unreadable.has(slot)) {
        const error = texts.notSavedUnreadable;
        report(error);
        return error;
      }
      o.content.set(slot, value);
      waiting.set(slot, value);
      running ??= Promise.resolve().then(work);
      return undefined;
    },

    saved,

    onError(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    lockNow() {
      void saved().finally(() => location.reload());
    },

    async startAnew() {
      const d = device ?? (await environment.deviceKey());
      for (const slot of config.slots) environment.remove(name(slot));
      const fresh = await bundleWithoutLock(prefix, d, await createDataKey());
      await environment.writeBundle(fresh);
      waiting.clear();
      opened = undefined;
      device = d;
      bundle = fresh;
    },

    async setLock(password, current, rounds) {
      const o = requireOpen();
      return rewrap((d) => bundleWithLock(prefix, o.device, d, password, rounds), current);
    },

    async removeLock(current) {
      const o = requireOpen();
      return rewrap((d) => bundleWithoutLock(prefix, o.device, d), current);
    },
  };
}
