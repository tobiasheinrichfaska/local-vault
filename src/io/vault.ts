// A vault (instance): opens once before the app shows anything, holds the data key in memory and
// the opened slots, and writes every change encrypted. A slot that cannot be opened (other key,
// damaged — or plain: no way back to unencrypted) is never overwritten: writing to it is refused
// and the reason shown. Each `createVault` call has its own state.
import { isBlobName, storageName, validateConfig, type VaultConfig } from '../logic/config.ts';
import { resolveTexts, type VaultTexts } from '../logic/texts.ts';
import {
  bundleWithLock,
  bundleWithoutLock,
  checkPassword,
  createDataKey,
  createUserEntry,
  isSealed,
  isUserName,
  openUserEntry,
  parseUsersBundle,
  userEntryFromText,
  userEntryToText,
  usersBundle,
  type UsersBundle,
  open as openPiece,
  openBundle,
  openText,
  parseBundle,
  seal as sealPiece,
  sealText,
  type Bundle,
} from '../logic/vault.ts';
import { browserEnvironment, guardEnvironment, type VaultEnvironment } from './environment.ts';

export type StartResult =
  | { readonly kind: 'open' }
  | { readonly kind: 'locked' }
  /** Users mode, nothing stored yet: `setupFirstUser` (or `joinWithEntry`) comes next. */
  | { readonly kind: 'setup' }
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
  /** With the app lock on; `false` for a wrong password. (Device mode.) */
  unlock(password: string): Promise<StartResult | false>;
  // ---- users mode (`config.mode === 'users'`): a key ring, the data key wrapped per user by his passphrase
  /** The first user: makes the data key, wraps it for him and opens. */
  setupFirstUser(user: string, passphrase: string, rounds?: number): Promise<StartResult>;
  /** Opens with a user's passphrase; `false` for a wrong one (or an unknown user). */
  loginUser(user: string, passphrase: string): Promise<StartResult | false>;
  /** The logged-in user (users mode, open vault). */
  currentUser(): string | undefined;
  /** Every user of the ring (known also while locked). */
  users(): readonly string[];
  /**
   * Adds a user: `by` (the logged-in user's passphrase) unwraps the data key once more to wrap it for him.
   * Returns the reason when refused, otherwise undefined.
   */
  addUser(
    user: string,
    passphrase: string,
    by: { readonly user: string; readonly passphrase: string },
    rounds?: number,
  ): Promise<string | undefined>;
  /** Removes another user (never yourself, never the last). Returns the reason when refused. */
  removeUser(user: string): Promise<string | undefined>;
  /** The logged-in user's new passphrase (the old one proves it). Returns the reason when refused. */
  changeUserPassphrase(
    user: string,
    current: string,
    next: string,
    rounds?: number,
  ): Promise<string | undefined>;
  /** A user's entry as text (what an app may keep for him on a server); undefined for an unknown user. */
  userEntry(user: string): string | undefined;
  /**
   * A fresh device (nothing stored): takes a user's entry from text (for example from a server after a
   * login there), opens it with his passphrase and keeps it as the ring. `false` for a wrong passphrase.
   */
  joinWithEntry(text: string, passphrase: string): Promise<StartResult | false>;
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
  // Blobs: encrypted bytes under free names (lower case, digits and `. _ : / -`, up to 200
  // characters) in IndexedDB, for what is too large or too many for slots (documents, blocks of a
  // big state). Each blob is bound to its name, so none can be swapped for another. Unlike slots
  // they are not held in memory: every call goes to the storage. They stay apart from the slots
  // (a slot name has no `:`), and "start anew" removes them with the slots. All of them throw
  // while the vault is closed.
  /** Stores the bytes encrypted; resolves when stored, rejects when the browser does not store them. */
  putBytes(name: string, bytes: Uint8Array): Promise<void>;
  /** The bytes, undefined when there is no such blob; throws for one that cannot be opened. */
  getBytes(name: string): Promise<Uint8Array | undefined>;
  removeBytes(name: string): Promise<void>;
  /** Names of all blobs, sorted; with `startsWith` only those beginning so. */
  listBytes(startsWith?: string): Promise<string[]>;
  /** Resolves when everything written so far (slots and blobs) is stored. */
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
  /** Device mode only. */
  readonly device?: CryptoKey;
  bundle?: Bundle;
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
  const writing = new Set<Promise<void>>(); // blobs on their way
  const listeners = new Set<(error: string) => void>();
  const usersMode = config.mode === 'users';
  let ring: UsersBundle | undefined;
  let loggedUser: string | undefined;
  /** Users mode: a stored bundle that could not be read — never replaced except by `startAnew`. */
  let damaged = false;

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

  async function openUsers(data: CryptoKey, user: string): Promise<StartResult> {
    const { content, unreadable } = await loadContent(data);
    opened = { data, content, unreadable };
    loggedUser = user;
    if (unreadable.size > 0) return { kind: 'error', error: texts.dataUnreadable };
    return { kind: 'open' };
  }

  const needUsers = () => {
    if (!usersMode) throw new Error(texts.notUsersMode);
  };

  async function writeRing(entries: UsersBundle['entries']): Promise<string | undefined> {
    const next = usersBundle(prefix, entries);
    try {
      await environment.writeBundle(next);
    } catch (error) {
      return texts.notSaved(message(error));
    }
    ring = next;
    return undefined;
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
    if (usersMode || !o.device || !o.bundle) return texts.notDeviceMode;
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

  const blobName = (name: string) => {
    if (!isBlobName(name)) throw new Error(`Invalid blob name: "${name}"`);
    return name;
  };
  // the piece is bound to this name (never to a slot's: a slot name has no colon)
  const blobSlot = (name: string) => `blob:${blobName(name)}`;

  async function track(write: Promise<void>): Promise<void> {
    const tracked = write.then(
      () => undefined,
      () => undefined,
    );
    writing.add(tracked);
    try {
      await write;
    } finally {
      writing.delete(tracked);
    }
  }

  const saved = async () => {
    await (running ?? Promise.resolve());
    await Promise.all([...writing]);
  };

  return {
    config,
    texts,
    storageName: name,

    async startVault() {
      opened = undefined;
      loggedUser = undefined;
      if (usersMode) {
        try {
          const stored = await environment.readBundle();
          damaged = false;
          if (stored === undefined) {
            ring = undefined;
            return { kind: 'setup' };
          }
          const read = parseUsersBundle(prefix, stored);
          if (!read) {
            damaged = true;
            return { kind: 'error', error: texts.keyDamaged };
          }
          ring = read;
          return { kind: 'locked' };
        } catch (error) {
          return { kind: 'error', error: texts.storageUnreachable(message(error)) };
        }
      }
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
      if (usersMode) return { kind: 'error', error: texts.notDeviceMode };
      if (!device || !bundle) return { kind: 'error', error: texts.notStarted };
      const data = await openBundle(prefix, device, bundle, password);
      return data ? openWith(data) : false;
    },

    isVaultOpen: () => opened !== undefined,
    isLockOn: () => (usersMode ? ring !== undefined : bundle?.kind === 'password'),

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

    async putBytes(name, bytes) {
      const slot = blobSlot(name);
      const o = requireOpen();
      await track(
        (async () => {
          try {
            await environment.writeBlob(name, await sealPiece(prefix, o.data, slot, bytes));
          } catch (error) {
            throw new Error(texts.notSaved(message(error)));
          }
        })(),
      );
    },

    async getBytes(name) {
      const slot = blobSlot(name);
      const o = requireOpen();
      const piece = await environment.readBlob(name);
      if (!piece) return undefined;
      const plain = await openPiece(prefix, o.data, slot, piece);
      if (!plain) throw new Error(texts.slotUnreadable);
      return plain;
    },

    async removeBytes(name) {
      blobName(name);
      requireOpen();
      await track(environment.removeBlob(name));
    },

    async listBytes(startsWith = '') {
      requireOpen();
      return (await environment.listBlobs()).filter((n) => n.startsWith(startsWith));
    },

    onError(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    lockNow() {
      void saved().finally(() => location.reload());
    },

    async startAnew() {
      if (usersMode) {
        for (const slot of config.slots) environment.remove(name(slot));
        await Promise.all([...writing]);
        await environment.clearBlobs();
        await environment.clearBundle();
        waiting.clear();
        opened = undefined;
        ring = undefined;
        loggedUser = undefined;
        damaged = false;
        return;
      }
      const d = device ?? (await environment.deviceKey());
      for (const slot of config.slots) environment.remove(name(slot));
      await Promise.all([...writing]);
      await environment.clearBlobs();
      const fresh = await bundleWithoutLock(prefix, d, await createDataKey());
      await environment.writeBundle(fresh);
      waiting.clear();
      opened = undefined;
      device = d;
      bundle = fresh;
    },

    async setLock(password, current, rounds) {
      const o = requireOpen();
      if (usersMode || !o.device) return texts.notDeviceMode;
      const dk = o.device;
      return rewrap((d) => bundleWithLock(prefix, dk, d, password, rounds), current);
    },

    async removeLock(current) {
      const o = requireOpen();
      if (usersMode || !o.device) return texts.notDeviceMode;
      const dk = o.device;
      return rewrap((d) => bundleWithoutLock(prefix, dk, d), current);
    },

    // ---- users mode

    async setupFirstUser(user, passphrase, rounds) {
      needUsers();
      if (ring) return { kind: 'error', error: texts.alreadySetUp };
      if (damaged) return { kind: 'error', error: texts.keyDamaged };
      if (!isUserName(user)) return { kind: 'error', error: texts.invalidUser };
      const weak = checkPassword(passphrase, passphrase, texts);
      if (weak) return { kind: 'error', error: weak };
      try {
        const entry = await createUserEntry(
          prefix,
          user,
          passphrase,
          await createDataKey(),
          rounds,
        );
        const problem = await writeRing([entry]);
        if (problem) return { kind: 'error', error: problem };
        const data = await openUserEntry(prefix, entry, passphrase);
        return data ? openUsers(data, user) : { kind: 'error', error: texts.keyMismatch };
      } catch (error) {
        return { kind: 'error', error: texts.storageUnreachable(message(error)) };
      }
    },

    async loginUser(user, passphrase) {
      needUsers();
      if (!ring) return { kind: 'error', error: texts.notStarted };
      const entry = ring.entries.find((e) => e.user === user);
      if (!entry) return false;
      const data = await openUserEntry(prefix, entry, passphrase);
      return data ? openUsers(data, user) : false;
    },

    currentUser: () => (opened ? loggedUser : undefined),
    users: () => ring?.entries.map((e) => e.user) ?? [],

    async addUser(user, passphrase, by, rounds) {
      needUsers();
      requireOpen();
      if (!ring) return texts.notStarted;
      if (!isUserName(user)) return texts.invalidUser;
      if (ring.entries.some((e) => e.user === user)) return texts.userExists;
      const weak = checkPassword(passphrase, passphrase, texts);
      if (weak) return weak;
      const own = ring.entries.find((e) => e.user === by.user);
      const data = own && (await openUserEntry(prefix, own, by.passphrase, true));
      if (!data) return texts.wrongCurrentPassword;
      return writeRing([
        ...ring.entries,
        await createUserEntry(prefix, user, passphrase, data, rounds),
      ]);
    },

    async removeUser(user) {
      needUsers();
      requireOpen();
      if (!ring) return texts.notStarted;
      if (user === loggedUser) return texts.cannotRemoveSelf;
      if (!ring.entries.some((e) => e.user === user)) return texts.unknownUser;
      if (ring.entries.length <= 1) return texts.lastUser;
      return writeRing(ring.entries.filter((e) => e.user !== user));
    },

    async changeUserPassphrase(user, current, next, rounds) {
      needUsers();
      requireOpen();
      if (!ring) return texts.notStarted;
      if (user !== loggedUser) return texts.unknownUser;
      const weak = checkPassword(next, next, texts);
      if (weak) return weak;
      const own = ring.entries.find((e) => e.user === user);
      const data = own && (await openUserEntry(prefix, own, current, true));
      if (!data) return texts.wrongCurrentPassword;
      const fresh = await createUserEntry(prefix, user, next, data, rounds);
      return writeRing(ring.entries.map((e) => (e.user === user ? fresh : e)));
    },

    userEntry(user) {
      needUsers();
      const entry = ring?.entries.find((e) => e.user === user);
      return entry ? userEntryToText(prefix, entry) : undefined;
    },

    async joinWithEntry(text, passphrase) {
      needUsers();
      if (ring) return { kind: 'error', error: texts.alreadySetUp };
      if (damaged) return { kind: 'error', error: texts.keyDamaged };
      const entry = userEntryFromText(prefix, text);
      if (!entry) return { kind: 'error', error: texts.entryUnreadable };
      const data = await openUserEntry(prefix, entry, passphrase);
      if (!data) return false;
      const problem = await writeRing([entry]);
      return problem ? { kind: 'error', error: problem } : openUsers(data, entry.user);
    },
  };
}
