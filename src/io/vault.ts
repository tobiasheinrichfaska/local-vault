// A vault (instance): opens once before the app shows anything, holds the data key in memory and
// the opened slots, and writes every change encrypted. A slot that cannot be opened (other key,
// damaged — or plain: no way back to unencrypted) is never overwritten: writing to it is refused
// and the reason shown. Each `createVault` call has its own state.
import {
  DEFAULT_BLOB_CHUNK,
  HEAD_VERSION,
  blocksFor,
  chunkKey,
  chunkLength,
  chunkPrefix,
  chunkSlot,
  headFromBytes,
  headSlot,
  headToBytes,
  legacySlot,
  newGeneration,
  type BlobHead,
} from '../logic/blobs.ts';
import { isBlobName, storageName, validateConfig, type VaultConfig } from '../logic/config.ts';
import { resolveTexts, type VaultTexts } from '../logic/texts.ts';
import {
  DEFAULT_MIN_ROUNDS,
  MAX_ROUNDS,
  ROUNDS,
  bundleWithLock,
  bundleWithoutLock,
  checkPassword,
  checkRounds,
  createDataKey,
  createUserEntry,
  isSealed,
  isUserName,
  sameUser,
  type UserEntry,
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
import {
  browserEnvironment,
  guardEnvironment,
  type StoredBlob,
  type VaultEnvironment,
} from './environment.ts';

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
  // big state). A blob is cut into blocks (`config.blobChunkSize`), each sealed on its own with its own
  // IV and bound to the blob name, the write, its index and the number of blocks; a small sealed head
  // under the name says which blocks belong. A write is atomic: blocks first, then the head is
  // switched in one step, then the old blocks go — a failed or interrupted write leaves the old
  // content. Blobs of the earlier format (one piece) stay readable and are replaced on the next put.
  // Unlike slots they are not held in memory: every call goes to the storage. They stay apart from
  // the slots (a slot name has no `:`), and "start anew" removes them with the slots. All of them
  // throw while the vault is closed. Calls on one name run one after another (per vault instance).
  /**
   * Stores the bytes encrypted; resolves when stored, rejects when the browser does not store them
   * (the old content is then still there). The browser's own error stays as `error.cause`
   * (`isQuotaError(error)` tells a full storage). While writing, the storage holds old and new
   * content; in memory, besides the given bytes, about three blocks.
   */
  putBytes(name: string, bytes: Uint8Array): Promise<void>;
  /**
   * The bytes, undefined when there is no such blob; throws for one that cannot be opened (a block
   * missing, changed, moved or from another write). Peak memory: the result plus about three blocks.
   */
  getBytes(name: string): Promise<Uint8Array | undefined>;
  /**
   * The same blob block by block (an old one-piece blob comes as one piece), for a large file that
   * should not be held whole in memory. Every block is checked before it is given, but whether the
   * blob is complete is only known at the end: the iteration throws at a missing or changed block —
   * discard what was taken before then. Nothing is given for a missing blob. Not serialised with
   * writes to the same name: an overwrite meanwhile makes it throw, never give a mixture.
   */
  getBytesChunks(name: string): AsyncIterable<Uint8Array>;
  /** Removes the blob (head and blocks, also blocks left over by an interrupted write). */
  removeBytes(name: string): Promise<void>;
  /** Names of all blobs, sorted; with `startsWith` only those beginning so. */
  listBytes(startsWith?: string): Promise<string[]>;
  /**
   * Names of all blobs with their size in bytes (the plain bytes, not the encrypted ones), sorted;
   * with `startsWith` only those beginning so. For showing what takes the room. A blob whose head
   * cannot be opened is listed with size 0.
   */
  listBytesInfo(startsWith?: string): Promise<{ name: string; size: number }[]>;
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

/** AES-GCM adds a 16-byte tag to the plain length. */
const GCM_TAG = 16;

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
  const minRounds = config.minRounds ?? DEFAULT_MIN_ROUNDS;
  /** The reason a round count given by the app is refused (undefined: fine or not given). */
  const roundsProblem = (rounds: number | undefined) =>
    rounds === undefined || checkRounds(rounds, minRounds)
      ? undefined
      : texts.invalidRounds(minRounds, MAX_ROUNDS);
  /** Without an explicit count: the standard one, or the configured lowest if that is higher. */
  const roundsOf = (rounds: number | undefined) => rounds ?? Math.max(ROUNDS, minRounds);
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

  // Ring changes of this instance run one after the other (each builds on the stored ring, not on
  // a copy taken before an await) ...
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  // ... and against another tab or instance: the change is made on what is stored at that moment, in
  // one step of the storage (never on this instance's older view, which could bring a removed user back).
  async function changeRing(
    change: (current: UsersBundle) => readonly UserEntry[] | string,
  ): Promise<string | undefined> {
    let refusal: string | undefined;
    let seen: UsersBundle | undefined;
    try {
      const result = await environment.updateBundle((stored) => {
        if (stored === undefined) {
          refusal = texts.notStarted;
          return undefined;
        }
        const current = parseUsersBundle(prefix, stored, minRounds);
        if (!current) {
          refusal = texts.keyDamaged;
          return undefined;
        }
        seen = current;
        const entries = change(current);
        if (typeof entries === 'string') {
          refusal = entries;
          return undefined;
        }
        return usersBundle(prefix, entries);
      });
      if (seen) ring = parseUsersBundle(prefix, result.value, minRounds) ?? seen;
    } catch (error) {
      return texts.notSaved(message(error));
    }
    return refusal;
  }

  /** The very first ring: only where nothing is stored — a tab that was faster keeps its ring. */
  async function createRing(entry: UserEntry): Promise<string | undefined> {
    try {
      const result = await environment.updateBundle((stored) =>
        stored === undefined ? usersBundle(prefix, [entry]) : undefined,
      );
      if (result.written) {
        ring = parseUsersBundle(prefix, result.value, minRounds);
        return undefined;
      }
      const other = parseUsersBundle(prefix, result.value, minRounds);
      if (!other) damaged = true;
      else ring = other;
      return other ? texts.alreadySetUp : texts.keyDamaged;
    } catch (error) {
      return texts.notSaved(message(error));
    }
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
          const sealed = await sealText(prefix, o.data, name(slot), value);
          // started anew (or closed) while sealing: this value belongs to the old key, never write it
          if (opened !== o) return waiting.clear();
          environment.write(name(slot), sealed);
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
  const chunkSize = config.blobChunkSize ?? DEFAULT_BLOB_CHUNK;

  // Calls on one blob name run one after another: a write that sweeps the old blocks must not meet a
  // second write of the same name (whose fresh blocks it would take for old ones) or a reader.
  const queues = new Map<string, Promise<unknown>>();
  function perName<T>(name: string, work: () => Promise<T>): Promise<T> {
    const run = (queues.get(name) ?? Promise.resolve()).then(work, work);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(name, tail);
    void tail.then(() => {
      if (queues.get(name) === tail) queues.delete(name);
    });
    return run;
  }

  const unreadable = () => new Error(texts.slotUnreadable);

  /** The head of a blob in blocks, opened; throws for anything that is not a head of this name. */
  async function openHead(data: CryptoKey, name: string, record: StoredBlob): Promise<BlobHead> {
    if (record.v !== HEAD_VERSION) throw unreadable();
    const plain = await openPiece(prefix, data, headSlot(name), record);
    const head = plain && headFromBytes(plain);
    if (!head) throw unreadable();
    return head;
  }

  /** The blocks of a blob in order, each checked (name, write, index, count, length) before it is given. */
  async function* blocks(
    data: CryptoKey,
    name: string,
    head: BlobHead,
  ): AsyncGenerator<Uint8Array> {
    for (let index = 0; index < head.count; index++) {
      const record = await environment.readBlob(chunkKey(name, head.gen, index));
      const plain =
        record &&
        (await openPiece(prefix, data, chunkSlot(name, head.gen, index, head.count), record));
      if (!plain || plain.length !== chunkLength(head, index)) throw unreadable();
      yield plain;
    }
  }

  async function* readChunks(data: CryptoKey, name: string): AsyncGenerator<Uint8Array> {
    const record = await environment.readBlob(name);
    if (!record) return;
    if (record.v === undefined) {
      // the earlier format: one piece bound to `blob:<name>`
      const plain = await openPiece(prefix, data, legacySlot(name), record);
      if (!plain) throw unreadable();
      yield plain;
      return;
    }
    yield* blocks(data, name, await openHead(data, name, record));
  }

  async function writeBlocks(data: CryptoKey, name: string, bytes: Uint8Array) {
    const gen = newGeneration();
    const count = blocksFor(bytes.length, chunkSize);
    const written: string[] = [];
    try {
      for (let index = 0; index < count; index++) {
        const part = bytes.subarray(index * chunkSize, (index + 1) * chunkSize);
        const { iv, ct } = await sealPiece(prefix, data, chunkSlot(name, gen, index, count), part);
        const key = chunkKey(name, gen, index);
        written.push(key); // before the write: a half-written block is cleaned up too
        await environment.writeBlob(key, { iv, ct });
      }
      const head: BlobHead = { gen, count, size: bytes.length, chunk: chunkSize };
      const sealed = await sealPiece(prefix, data, headSlot(name), headToBytes(head));
      // the one step that switches from the old content to the new
      await environment.writeBlob(name, { v: HEAD_VERSION, iv: sealed.iv, ct: sealed.ct });
    } catch (error) {
      try {
        await environment.removeBlobs(written);
      } catch {
        // left over blocks belong to no head; the next write or remove of this name sweeps them
      }
      throw error;
    }
    // the old content is gone from now on: sweep its blocks (and any leftovers); a failure here is
    // harmless — the blocks belong to no head
    try {
      const keep = `${chunkPrefix(name)}${gen}#`;
      const stale = (await environment.listBlobKeys(chunkPrefix(name))).filter(
        (k) => !k.startsWith(keep),
      );
      await environment.removeBlobs(stale);
    } catch {
      // see above
    }
  }

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
          const read = parseUsersBundle(prefix, stored, minRounds);
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
        const read = parseBundle(prefix, storedBundle, minRounds);
        if (storedBundle !== undefined && !read) return { kind: 'error', error: texts.keyDamaged };
        if (!read) {
          // first start: put-if-absent in one step, so a second tab starting at the same moment
          // takes this key instead of making another one (two keys = one tab's data unreadable)
          const fresh = await bundleWithoutLock(prefix, device, await createDataKey());
          const result = await environment.updateBundle((stored) =>
            stored === undefined ? fresh : undefined,
          );
          const now = parseBundle(prefix, result.value, minRounds);
          if (!now) return { kind: 'error', error: texts.keyDamaged };
          bundle = now;
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
      blobName(name);
      const o = requireOpen();
      await track(
        perName(name, async () => {
          try {
            await writeBlocks(o.data, name, bytes);
          } catch (error) {
            throw new Error(texts.notSaved(message(error)), { cause: error });
          }
        }),
      );
    },

    async getBytes(name) {
      blobName(name);
      const o = requireOpen();
      return perName(name, async () => {
        const record = await environment.readBlob(name);
        if (!record) return undefined;
        if (record.v === undefined) {
          const plain = await openPiece(prefix, o.data, legacySlot(name), record);
          if (!plain) throw unreadable();
          return plain;
        }
        const head = await openHead(o.data, name, record);
        const out = new Uint8Array(head.size);
        let at = 0;
        for await (const part of blocks(o.data, name, head)) {
          out.set(part, at);
          at += part.length;
        }
        return out;
      });
    },

    getBytesChunks(name) {
      blobName(name);
      const o = requireOpen();
      return readChunks(o.data, name);
    },

    async removeBytes(name) {
      blobName(name);
      requireOpen();
      await track(
        perName(name, async () => {
          await environment.removeBlob(name); // the head first: no half blob stays readable
          await environment.removeBlobs(await environment.listBlobKeys(chunkPrefix(name)));
        }),
      );
    },

    async listBytes(startsWith = '') {
      requireOpen();
      return (await environment.listBlobKeys(startsWith)).filter(isBlobName);
    },

    async listBytesInfo(startsWith = '') {
      const o = requireOpen();
      const info: { name: string; size: number }[] = [];
      for (const { name, record } of await environment.listBlobHeads()) {
        if (!name.startsWith(startsWith)) continue;
        let size = 0;
        if (record.v === undefined) size = Math.max(0, record.ct.byteLength - GCM_TAG);
        else {
          try {
            size = (await openHead(o.data, name, record)).size;
          } catch {
            // an unopenable head: listed, size unknown
          }
        }
        info.push({ name, size });
      }
      return info;
    },

    onError(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    lockNow() {
      void saved().finally(() => location.reload());
    },

    async startAnew() {
      // First stop everything that could still write: the pending slot values go, the open state
      // goes (a write that is just being sealed sees it and drops its value), then wait for it.
      waiting.clear();
      opened = undefined;
      loggedUser = undefined;
      await (running ?? Promise.resolve());
      await Promise.all([...writing]);
      for (const slot of config.slots) environment.remove(name(slot));
      await environment.clearBlobs();
      if (usersMode) {
        await environment.clearBundle();
        ring = undefined;
        damaged = false;
        return;
      }
      const d = device ?? (await environment.deviceKey());
      const fresh = await bundleWithoutLock(prefix, d, await createDataKey());
      await environment.writeBundle(fresh);
      device = d;
      bundle = fresh;
    },

    async setLock(password, current, rounds) {
      const o = requireOpen();
      if (usersMode || !o.device) return texts.notDeviceMode;
      const dk = o.device;
      const bad = roundsProblem(rounds);
      if (bad) return bad;
      return rewrap(
        (d) => bundleWithLock(prefix, dk, d, password, roundsOf(rounds), minRounds),
        current,
      );
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
      const bad = roundsProblem(rounds);
      if (bad) return { kind: 'error', error: bad };
      try {
        const entry = await createUserEntry(
          prefix,
          user,
          passphrase,
          await createDataKey(),
          roundsOf(rounds),
          minRounds,
        );
        const problem = await createRing(entry);
        if (problem) return { kind: 'error', error: problem };
        const data = await openUserEntry(prefix, entry, passphrase);
        return data ? openUsers(data, entry.user) : { kind: 'error', error: texts.keyMismatch };
      } catch (error) {
        return { kind: 'error', error: texts.storageUnreachable(message(error)) };
      }
    },

    async loginUser(user, passphrase) {
      needUsers();
      if (!ring) return { kind: 'error', error: texts.notStarted };
      const entry = ring.entries.find((e) => sameUser(e.user, user));
      if (!entry) return false;
      const data = await openUserEntry(prefix, entry, passphrase);
      return data ? openUsers(data, entry.user) : false;
    },

    currentUser: () => (opened ? loggedUser : undefined),
    users: () => ring?.entries.map((e) => e.user) ?? [],

    addUser(user, passphrase, by, rounds) {
      needUsers();
      requireOpen();
      return serial(async () => {
        if (!ring) return texts.notStarted;
        if (!isUserName(user)) return texts.invalidUser;
        if (ring.entries.some((e) => sameUser(e.user, user))) return texts.userExists;
        const weak = checkPassword(passphrase, passphrase, texts);
        if (weak) return weak;
        const bad = roundsProblem(rounds);
        if (bad) return bad;
        const own = ring.entries.find((e) => sameUser(e.user, by.user));
        const data = own && (await openUserEntry(prefix, own, by.passphrase, true));
        if (!own || !data) return texts.wrongCurrentPassword;
        const entry = await createUserEntry(
          prefix,
          user,
          passphrase,
          data,
          roundsOf(rounds),
          minRounds,
        );
        return changeRing((current) => {
          if (current.entries.some((e) => sameUser(e.user, user))) return texts.userExists;
          // the one who vouches must still be there (another tab may have removed him)
          if (!current.entries.some((e) => e.user === own.user)) return texts.ringChanged;
          return [...current.entries, entry];
        });
      });
    },

    removeUser(user) {
      needUsers();
      requireOpen();
      return serial(async () => {
        if (!ring) return texts.notStarted;
        if (loggedUser !== undefined && sameUser(user, loggedUser)) return texts.cannotRemoveSelf;
        return changeRing((current) => {
          if (!current.entries.some((e) => sameUser(e.user, user))) return texts.unknownUser;
          if (current.entries.length <= 1) return texts.lastUser;
          return current.entries.filter((e) => !sameUser(e.user, user));
        });
      });
    },

    changeUserPassphrase(user, current, next, rounds) {
      needUsers();
      requireOpen();
      return serial(async () => {
        if (!ring) return texts.notStarted;
        if (loggedUser === undefined || !sameUser(user, loggedUser)) return texts.unknownUser;
        const weak = checkPassword(next, next, texts);
        if (weak) return weak;
        const bad = roundsProblem(rounds);
        if (bad) return bad;
        const own = ring.entries.find((e) => sameUser(e.user, user));
        const data = own && (await openUserEntry(prefix, own, current, true));
        if (!own || !data) return texts.wrongCurrentPassword;
        const fresh = await createUserEntry(
          prefix,
          own.user,
          next,
          data,
          roundsOf(rounds),
          minRounds,
        );
        return changeRing((stored) => {
          const mine = stored.entries.find((e) => e.user === own.user);
          if (!mine) return texts.unknownUser;
          // changed elsewhere meanwhile (another tab set a passphrase): never overwrite it blindly
          if (mine.iv !== own.iv || mine.ct !== own.ct) return texts.ringChanged;
          return stored.entries.map((e) => (e === mine ? fresh : e));
        });
      });
    },

    userEntry(user) {
      needUsers();
      const entry = ring?.entries.find((e) => sameUser(e.user, user));
      return entry ? userEntryToText(prefix, entry) : undefined;
    },

    async joinWithEntry(text, passphrase) {
      needUsers();
      if (ring) return { kind: 'error', error: texts.alreadySetUp };
      if (damaged) return { kind: 'error', error: texts.keyDamaged };
      const entry = userEntryFromText(prefix, text, minRounds);
      if (!entry) return { kind: 'error', error: texts.entryUnreadable };
      const data = await openUserEntry(prefix, entry, passphrase);
      if (!data) return false;
      const problem = await createRing(entry);
      return problem ? { kind: 'error', error: problem } : openUsers(data, entry.user);
    },
  };
}
