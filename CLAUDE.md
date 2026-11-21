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
API (`createVault`), 50 tests; consumed by no app from a Git tag yet, not published to npm.** Old →
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
  key is non-extractable; "start anew" leaves empty data under a new key.

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
| `src/logic/vault.ts`, `base64url.ts` | Crypto pieces: keys, sealed text, bundles, password check, re-lock rule (prefix is the first argument) |
| `src/logic/config.ts`, `texts.ts` | `VaultConfig` + validation + store names; `VaultTexts` + English `DEFAULT_TEXTS` |
| `src/io/vault.ts` | `createVault(config, env?)`: the vault instance (`Vault`) |
| `src/io/environment.ts` | `VaultEnvironment`, `browserEnvironment(prefix)`, `memoryEnvironment()`, `guardEnvironment` |
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
sealed text `{"m":"<prefix>-vault:1","iv":…,"ct":…}` and the key bundle (`Bundle` in
`src/logic/vault.ts`, in IndexedDB). No factory defaults.

## Tests

```bash
npm install
npm run typecheck
npm test            # 50 tests on 2026-11-21 (logic 14, io 27, ui 9)
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
- **Not consumed by any app from a Git tag yet**; not published to npm; no tag.
- The prefix is part of the encrypted data: changing it makes old data unreadable.
- The re-lock after 5 minutes (`LOCK_AFTER_MINUTES`) is fixed, not configurable.
- Forgotten password: no recovery; "start anew" discards the device's data.
- The coupling guard forbids app words in `src/`.

*Last updated: 2026-11-21*
