# CLAUDE.md — local-vault

> Workspace-wide conventions (language, git, build, architecture, testing, collaboration):
> [`c:\skripte\private\general stuff\CLAUDE.md`](../../private/general%20stuff/CLAUDE.md)

---

## Project overview

Shared encrypted local storage for Tobias' React web apps: AES-GCM under a random data key, the
data key wrapped by a non-extractable device key and optionally by a password (PBKDF2), a React gate
that opens the vault before the app and locks again after 5 minutes in the background, a settings
card for the app lock. Extracted 2026-11-21 from the web app where it originated, so that several
apps can share one implementation. **Status (2026-11-21): ported with an English API and an instance
API (`createVault`), users mode (key ring) and blobs on `main`, review fixes 2026-11-22 (concurrent
tabs, PBKDF2 round limits, quota errors), 219 tests, blobs in blocks (W4); consumed by no app from a Git tag yet, not published to npm.** Old →
new names: [`docs/api-mapping.md`](docs/api-mapping.md).

**Platform:** web (IndexedDB, localStorage, Web Crypto; not for React Native native builds)
**Language:** TypeScript + React (React as peer dependency)
**Architecture:** UI-free logic (`src/logic/`: crypto pieces, config, texts), the vault instance and
its environments (`src/io/`) and React components (`src/ui/`). The **app passes in** the name prefix,
the slots and any texts (`VaultConfig`, `VaultTexts`, English defaults); the package holds no app
data and no app words. Public entry: `src/index.ts`.

## Key rules

- **Public repo (AGPLv3 + commercial)**: no app data, no real names, no private project names, in
  files and in git history.
- **Nothing is published to npm or tagged without Tobias' OK.**
- Apps take it by Git tag (planned); a change here is a change in several apps, so semantic
  versioning, and each app switches over on its own. Do not change other apps' code from here.
- **Every browser store name starts with `<prefix>-`** (checked at runtime by `guardEnvironment`
  and in `tests/io/config.test.ts`). The stored markers and the authenticated data carry the
  prefix, so a changed prefix makes existing data unreadable: never change it in a released app.
- Every rule keeps its test: a plain value in a slot is not read; an unreadable slot is never
  overwritten; a closed vault throws on read/write; write errors reach `onError`; lock on/off/new
  password leave the data untouched; wrong password refused; the 5-minute re-lock rule; the device
  key is non-extractable; "start anew" leaves empty data under a new key (blobs removed); a blob is bound to its name and to the data key; a failed blob write rejects, never silently. A blob is cut into blocks, each bound to name, write, index and block count; a failed or interrupted write leaves the old content (blocks first, then one head write, then the old blocks go); an old one-piece blob stays readable.

---

## Project Directory

| File/Folder | Purpose |
|---|---|
| `CLAUDE.md` | Project documentation and conventions |
| `README.md` | Short description, install, usage, license section |
| `FEATURES_REQUIRED.md` | Critical user paths |
| `docs/api-mapping.md` | Every exported name: old name → new name → file (for migrating apps) |
| `manual_tests/` | Human-tester instructions (README only so far) |
| `src/index.ts` | Public entry: `createVault`, environments, components, config, texts, crypto pieces |
| `src/logic/vault.ts`, `base64url.ts` | Crypto pieces: keys, sealed text, bundles, password check, re-lock rule (prefix is the first argument); rounds limits `DEFAULT_MIN_ROUNDS` (100 000) / `MAX_ROUNDS` (3 000 000) / `checkRounds` (written and read alike); users mode: `createUserEntry`, `openUserEntry`, `parseUsersBundle`, `userEntryToText`/`FromText`, `sameUser` (NFC) |
| `src/logic/config.ts`, `texts.ts` | `VaultConfig` + validation + store names; `VaultTexts` + English `DEFAULT_TEXTS` |
| `src/io/vault.ts` | `createVault(config, env?)`: the vault instance (`Vault`): slots (text, in memory) and blobs (`putBytes`/`getBytes`/`getBytesChunks`/`removeBytes`/`listBytes`/`listBytesInfo`, bytes in IndexedDB, in blocks of `config.blobChunkSize`); `mode: 'users'` = key ring per user (`setupFirstUser`, `loginUser`, `addUser`, `removeUser`, `changeUserPassphrase`, `userEntry`, `joinWithEntry`) |
| `src/logic/blobs.ts` | Blobs in blocks, pure: `DEFAULT_BLOB_CHUNK` (2 MiB), `MAX_BLOB_CHUNK`, `checkChunkSize`, block keys (`~<name>#<gen>#<i>`, `CHUNK_MARK`), the authenticated data (`chunkSlot`, `headSlot`, `legacySlot`), the head (`BlobHead`, `headToBytes`/`headFromBytes`) |
| `src/io/environment.ts` | `VaultEnvironment` (slots in localStorage; keys and blobs in IndexedDB `<prefix>-vault`, version 2; blob records `readBlob`/`writeBlob`/`removeBlob(s)`/`listBlobKeys`/`listBlobHeads`/`clearBlobs`), `browserEnvironment(prefix)`, `memoryEnvironment()`, `guardEnvironment` |
| `src/ui/VaultGate.tsx`, `LockSettings.tsx`, `parts.tsx` | The gate, the lock settings card, shared pieces |
| `tests/logic/`, `tests/io/`, `tests/ui/` | Unit tests (crypto, vault rules, config/prefix, two instances), `renderToString` smoke tests, coupling guard (no app words, no foreign imports) |
| `scripts/fix-declarations.mjs` | Rewrites `.ts`/`.tsx` imports in the emitted `.d.ts` files |
| `package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.ts`, `.prettierrc.json`, `.prettierignore` | Toolchain (`"private": true` against an accidental npm publish; `prepare` builds `dist/` for Git installs) |
| `.github/workflows/tests.yml` | Check "Tests": typecheck, format, tests, build, declaration check |
| `.gitattributes`, `.gitignore` | LF line endings; ignore rules |
| `LICENSE`, `LICENSE_COMMERCIAL.md`, `CONTRIBUTING.md` | AGPLv3 + commercial |

---

## Data Model

No persisted data of its own beyond what the app puts into its slots; the stored shapes are the
sealed text `{"m":"<prefix>-vault:1","iv":…,"ct":…}`, the key ring of users mode (`{"m":"<prefix>-vault-users:1","kind":"users","entries":[{user,rounds,salt,iv,ct}]}`, the user name is authenticated data of his entry) and the key bundle (`Bundle` in
`src/logic/vault.ts`, in IndexedDB store `vault`). Blobs (since W4, 2026-11-22): in the IndexedDB store `blobs`, records `{iv, ct}` (Uint8Array, structured
clone). A blob is a **head** under its name — `{v: 2, iv, ct}`, sealed JSON `{gen, count, size, chunk}` with
additional data `blobhead:<name>` — and `count` **blocks** under the keys `~<name>#<gen>#<index>` (`gen` = 16 hex
digits, new per write; the key starts with `~`, which no blob name may, so a block key is never a name and
sorts after all names). Each block has its own IV and the additional data
`blobchunk:<name>|<gen>|<index>|<count>`. Earlier one-piece blobs: `{iv, ct}` under the name, no `v`, additional
data `blob:<name>` — still read, replaced by the new format on the next `putBytes`. (A slot name has no colon,
so none collides.) IndexedDB version 2 added `blobs`; version 1 databases are upgraded in place. No factory
defaults.

## Tests

```bash
npm install
npm run typecheck
npm test            # 219 tests on 2026-11-22 (logic 19, io 190, ui 10); io includes fake-indexeddb
npm run format:check
npm run build
```

## Known Limitations

- **Browser-only checks are not covered by the tests** (they run on Node with an in-memory
  environment): that IndexedDB and the device key survive a reload, that a `CryptoKey` can be stored
  in IndexedDB on iOS Safari and as a home-screen app, that Safari clears the storage after 7 days
  without use (data and key are then gone together; "start anew" or a new install), the real PBKDF2
  time on a phone (about a second), the `visibilitychange` re-lock, and the `confirm()` and reload
  behaviour of "start anew". Each consuming app repeats the device tests.
- **Blobs (2026-11-21):** tested against `fake-indexeddb` and in memory, not in a real browser (quota
  errors on iOS Safari, the upgrade with a second tab still open on version 1, large writes on a phone).
  They are not held in memory and have no overwrite guard: a blob under an unopenable piece is replaced
  by a `putBytes` of the same name (the app owns its names). Slots still live in localStorage (about 5 MB
  and synchronous): large state belongs in blobs.
- **Blobs in blocks (W4, 2026-11-22):** default block 2 MiB (`blobChunkSize`, 1 byte … 64 MiB, new writes only;
  a stored blob keeps its own). Memory, besides the given bytes: `putBytes` about 3 blocks, `getBytes` the
  result plus about 3 blocks — but the result is assembled whole, so a 300 MB file still needs 300 MB (use
  `getBytesChunks` to take it block by block; it checks each block and throws at the first bad or missing
  one, so the consumer must drop what it took before; it is not serialised with a write to the same name).
  `putBytes` still needs the whole input as one `Uint8Array` (no streaming write: the block count is part of
  the authenticated data and the head is written last). While writing, old and new content are in the storage
  at once (up to 2× the blob). A write is atomic, an interrupted one (tab closed) leaves orphan blocks without
  a head: invisible, swept by the next `putBytes`/`removeBytes` of that name or by "start anew", but until
  then they take room. Calls on one name are serialised per vault instance, not across tabs (see "One tab
  per app"). Each block is its own IndexedDB transaction on a freshly opened connection (about 100 for
  200 MB): slower than one big put, not measured. Old one-piece blobs are listed by reading them whole
  (`listBytesInfo`) until they are replaced. A rollback to an older complete state (old head + its blocks
  put back) is not detected; the data key is the only authenticity anchor. New-format heads read as unopenable
  in the code of before W4 (never silently wrong), and that code must not be mixed with this one on the same
  database. Not tried in a real browser (iOS Safari quotas, memory of a phone).
- **Users mode (2026-11-21):** tested in memory only; adding or changing a user unwraps the data key as
  extractable for a moment (the logged-in user's passphrase is asked again); the passphrase rules are the
  app's (the package only refuses under 6 characters); no limit of failed logins (the app or a server
  does that); an entry swapped to another user name does not open (the name is authenticated data).
- **Removing a user does not rotate the data key (2026-11-22):** `removeUser` only drops his entry from the ring; the data key stays the same, so a copy of his entry (for example one kept on a server) still opens the data with his passphrase. Treat a removed user as having had access, or "start anew".
- **One tab per app in device mode (2026-11-22):** the device mode keeps the data key's bundle and the slots in this tab's memory; a second tab of the same app can write the slots it opened earlier over the other's newer state (slots are whole values, last write wins). The key bundle itself is made safely (put-if-absent in one IndexedDB step), and in users mode every ring change is made on the stored ring (never on an older copy), but slot data is not merged between tabs: apps open one tab at a time (Web Locks in the app) or accept last-write-wins.
- **IndexedDB version 2 is not backwards compatible (2026-11-22):** the first start of this version upgrades the database `<prefix>-vault` in place; a page still running an older version of the package (version 1 code) is blocked by the upgrade (`vaultBlocked` text instead of waiting for ever) and cannot open version 2 afterwards. Roll all tabs forward together.
- **Prefixes must not overlap (2026-11-22):** a prefix must not be the word-start of another prefix of the same site (`app` and `app-admin`): the guard only checks `<prefix>-`, so `app-admin-data` also belongs to `app` as far as the guard can tell, and a slot `admin-data` of `app` collides with the slot `data` of `app-admin`.
- **PBKDF2 rounds (2026-11-22):** a stored entry or bundle with fewer than `minRounds` (default 100 000) or more than 3 000 000 rounds is refused as damaged. Entries made by an earlier version of this package with a custom lower count (tests) become unreadable unless the app sets `minRounds`; the standard 600 000 stays readable.
- **User names (2026-11-22):** new names are stored NFC-normalised and compared normalised; an entry already stored under a non-NFC spelling keeps it (the name is authenticated data of the entry, so it cannot be rewritten) and is found by either spelling.
- **Quota (2026-11-22):** a full storage reaches the app as `error.cause` of a rejected `putBytes` (`isQuotaError`); slot writes still report through `onError` as a text only. Large blobs are cut into blocks (W4, closed 2026-11-22, see Blobs).
- **Not consumed by any app from a Git tag yet**; not published to npm; no tag.
- The prefix is part of the encrypted data: changing it makes old data unreadable.
- The re-lock after 5 minutes (`LOCK_AFTER_MINUTES`) is fixed, not configurable.
- Forgotten password: no recovery; "start anew" discards the device's data.
- The coupling guard forbids app words in `src/`.

*Last updated: 2026-11-22 — review fixes (concurrent tabs, rounds limits, quota helpers); before: users mode (key ring)*
