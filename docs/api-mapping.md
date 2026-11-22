# API mapping: original app vault to the package

Source of the old names: the vault of the web app it was extracted from (`src/logic/vault.ts`,
`src/logic/base64url.ts`, `src/io/vault.ts`, `src/ui/VaultGate.tsx`). New names: `local-vault`,
public entry `src/index.ts`. Behaviour is identical; the structural changes are:

- **Instance instead of module state.** `createVault(config, env?)` returns an object; two vaults
  (or two tests) share nothing.
- **The app decides the names.** `config.prefix` and `config.slots` replace the hard-coded
  prefix and the `SLOTS` table. The browser store name of a slot is `<prefix>-<slot>`, the
  IndexedDB database is `<prefix>-vault`, the stored markers are `<prefix>-vault:1` and
  `<prefix>-vault-bundle:1`; with the prefix of the original app, data stored before the
  extraction opens unchanged. `guardEnvironment` refuses any store name outside `<prefix>-`.
- **The app passes the texts.** Every German string became a field of `VaultTexts` (English
  defaults in `DEFAULT_TEXTS`).
- **The crypto functions take the prefix as first argument** (it is part of the stored markers
  and of the authenticated data).

## Logic (`src/logic/`)

| Old (file)                  | New                                               | File                 | Meaning                                                                |
| --------------------------- | ------------------------------------------------- | -------------------- | ---------------------------------------------------------------------- |
| `base64url` (logic/)        | `base64url`                                       | `logic/base64url.ts` | Unpadded base64url encoding                                            |
| `fromBase64url`             | `fromBase64url`                                   | `logic/base64url.ts` | Decoding; throws outside the alphabet                                  |
| `ROUNDS`                    | `ROUNDS`                                          | `logic/vault.ts`     | PBKDF2 rounds (600 000)                                                |
| (new)                       | `DEFAULT_MIN_ROUNDS`, `MAX_ROUNDS`, `checkRounds` | `logic/vault.ts`     | Lowest (100 000) and highest (3 000 000) rounds taken, written or read |
| `MIN_PASSWORD`              | `MIN_PASSWORD`                                    | `logic/vault.ts`     | Shortest password (6 characters)                                       |
| `createDeviceKey()`         | `createDeviceKey()`                               | `logic/vault.ts`     | Non-extractable device key                                             |
| `createDataKey()`           | `createDataKey()`                                 | `logic/vault.ts`     | Data key, extractable until wrapped                                    |
| `Piece`                     | `Piece`                                           | `logic/vault.ts`     | `{iv, ct}`                                                             |
| `seal(key, slot, plain)`    | `seal(prefix, key, slot, plain)`                  | `logic/vault.ts`     | Encrypt bound to a slot                                                |
| `open(key, slot, piece)`    | `open(prefix, key, slot, piece)`                  | `logic/vault.ts`     | Decrypt; undefined for other key/slot/changed piece                    |
| `sealText(key, slot, text)` | `sealText(prefix, key, slot, text)`               | `logic/vault.ts`     | A stored text, encrypted                                               |
| `isSealed(raw)`             | `isSealed(prefix, raw)`                           | `logic/vault.ts`     | Whether a stored text is encrypted                                     |
| `openText(key, slot, raw)`  | `openText(prefix, key, slot, raw)`                | `logic/vault.ts`     | Decrypted text or undefined                                            |
| `Bundle`                    | `Bundle`                                          | `logic/vault.ts`     | The wrapped data key as stored (`m` is now `string`)                   |
| `bundleWithoutLock(d, k)`   | `bundleWithoutLock(prefix, device, data)`         | `logic/vault.ts`     | Data key wrapped by the device key only                                |
| `bundleWithLock(d, k, ...)` | `bundleWithLock(prefix, device, data, ...)`       | `logic/vault.ts`     | Data key wrapped by password key and device key                        |
| `parseBundle(raw)`          | `parseBundle(prefix, raw)`                        | `logic/vault.ts`     | Validates a stored bundle                                              |
| `openBundle(d, b, ...)`     | `openBundle(prefix, device, bundle, ...)`         | `logic/vault.ts`     | The data key from its bundle                                           |
| `checkPassword(a, b)`       | `checkPassword(a, b, texts?)`                     | `logic/vault.ts`     | Reason a password is refused; messages from `texts`, English default   |
| `LOCK_AFTER_MINUTES`        | `LOCK_AFTER_MINUTES`                              | `logic/vault.ts`     | Minutes in the background before locking again (5)                     |
| `shouldRelock`              | `shouldRelock`                                    | `logic/vault.ts`     | Whether to lock after the time in the background                       |
| (new)                       | `VaultConfig`, `validateConfig`                   | `logic/config.ts`    | The app's prefix and slots (may be `[]`); validation                   |
| (new)                       | `storageName`, `databaseName`, `hasPrefix`        | `logic/config.ts`    | Store names from the prefix                                            |
| (new)                       | `VaultTexts`, `DEFAULT_TEXTS`, `resolveTexts`     | `logic/texts.ts`     | All texts, English defaults                                            |

## IO (`src/io/`)

| Old (io/vault.ts)             | New                                                                                            | File                | Meaning                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `SLOTS`                       | `config.slots` (names without prefix)                                                          | `logic/config.ts`   | The slots that hold app data                                                                                                     |
| `VaultEnvironment`            | `VaultEnvironment`                                                                             | `io/environment.ts` | Where the pieces live; `read/write/remove` take the full name                                                                    |
| `browserEnvironment` (object) | `browserEnvironment(prefix, messages?)`                                                        | `io/environment.ts` | IndexedDB (keys) + localStorage (slots); database `<prefix>-vault`                                                               |
| `memoryEnvironment()`         | `memoryEnvironment()`                                                                          | `io/environment.ts` | In-memory environment for tests                                                                                                  |
| (new)                         | `VaultEnvironment.blobLock?`, `VaultEnvironment.signal?`, `VaultSignal`                        | `io/environment.ts` | Optional: lock around blob writes / sweep (Web Lock or in-process), channel between tabs (`BroadcastChannel` or in memory)       |
| (new)                         | `guardEnvironment(prefix, env)`                                                                | `io/environment.ts` | Refuses store names outside `<prefix>-`                                                                                          |
| (new)                         | `VaultEnvironment.updateBundle(update)`, `BundleUpdate`                                        | `io/environment.ts` | Read and replace the key bundle in one step (one IndexedDB transaction)                                                          |
| (new)                         | `VaultEnvironment.listBlobHeads()`, `listBlobKeys(prefix?)`, `removeBlobs(keys)`, `StoredBlob` | `io/environment.ts` | Records of the blob store (heads / old pieces, any key, many removals); `listBlobInfo`/`listBlobs` of the first version are gone |
| (new)                         | `storageEstimate()`, `requestPersistence()`, `isQuotaError(e)`                                 | `io/storage.ts`     | `navigator.storage` helpers (unknown/false without it); recognise a full storage                                                 |
| (new)                         | `createVault(config, env?)`                                                                    | `io/vault.ts`       | Makes a vault instance                                                                                                           |
| `StartResult`                 | `StartResult`                                                                                  | `io/vault.ts`       | `open`, `locked` or `error`                                                                                                      |
| (new)                         | `Vault`                                                                                        | `io/vault.ts`       | The instance type                                                                                                                |
| `startVault(env)`             | `vault.startVault()`                                                                           | `io/vault.ts`       | Starts; the environment is given to `createVault`                                                                                |
| `unlock(password)`            | `vault.unlock(password)`                                                                       | `io/vault.ts`       | Unlock with the app lock on                                                                                                      |
| `isVaultOpen()`               | `vault.isVaultOpen()`                                                                          | `io/vault.ts`       |                                                                                                                                  |
| `isLockOn()`                  | `vault.isLockOn()`                                                                             | `io/vault.ts`       |                                                                                                                                  |
| `readSlot(name)`              | `vault.readSlot(slot)`                                                                         | `io/vault.ts`       | Slot name without prefix; unknown slot throws                                                                                    |
| `writeSlot(name, value)`      | `vault.writeSlot(slot, value)`                                                                 | `io/vault.ts`       | Returns the refusal reason or undefined                                                                                          |
| `saved()`                     | `vault.saved()`                                                                                | `io/vault.ts`       | Resolves when everything written is stored                                                                                       |
| `onError(listener)`           | `vault.onError(listener)`                                                                      | `io/vault.ts`       | Returns the unsubscribe function                                                                                                 |
| `lockNow()`                   | `vault.lockNow()`                                                                              | `io/vault.ts`       | Closes (see `close()`), then reloads                                                                                             |
| (new)                         | `vault.close()`                                                                                | `io/vault.ts`       | Locks without a reload: stores what is on its way, drops key and opened data; `unlock` / `loginUser` / `startVault` open again   |
| (new)                         | `vault.sweepBlobs()`                                                                           | `io/vault.ts`       | Removes blocks that belong to no head; `{ removed }`                                                                             |
| (new)                         | `vault.onExternalChange(listener)`, `ExternalChange`                                           | `io/vault.ts`       | Another tab started anew / changed the keys (`BroadcastChannel`); returns the unsubscribe function                               |
| `startAnew()`                 | `vault.startAnew()`                                                                            | `io/vault.ts`       | Empty data under a new key                                                                                                       |
| `setLock(pw, current, n)`     | `vault.setLock(pw, current, rounds)`                                                           | `io/vault.ts`       | Lock on / new password                                                                                                           |
| `removeLock(current)`         | `vault.removeLock(current)`                                                                    | `io/vault.ts`       | Lock off                                                                                                                         |
| (new)                         | `vault.storageName(slot)`, `vault.config`, `vault.texts`                                       | `io/vault.ts`       | Store name of a slot, the config, the resolved texts                                                                             |

## UI (`src/ui/`)

| Old (ui/VaultGate.tsx)  | New                                    | File                  | Meaning                                                   |
| ----------------------- | -------------------------------------- | --------------------- | --------------------------------------------------------- |
| `VaultGate({children})` | `VaultGate({vault, texts?, children})` | `ui/VaultGate.tsx`    | Opens the vault before the app shows; lock screen, errors |
| (new)                   | `VaultGateProps`                       | `ui/VaultGate.tsx`    |                                                           |
| `LockSettings()`        | `LockSettings({vault, texts?})`        | `ui/LockSettings.tsx` | Turn the lock on/off, change the password, lock now       |
| (new)                   | `LockSettingsProps`                    | `ui/LockSettings.tsx` |                                                           |

## Texts (old German string to `VaultTexts` field)

The German strings of the original now belong to the app (its `VAULT_TEXTS`). Fields: `title`
(app name above the gate), `opening`, `lockedTitle`, `passwordLabel`, `unlockButton`, `unlocking`,
`wrongPassword`, `forgottenHint`, `startAnewButton`, `startAnewConfirmLocked`, `errorTitle`,
`errorHint`, `startAnewConfirmError`, `dismissErrors`, `lockTitle`, `lockOnInfo(minutes)`,
`lockOffInfo`, `currentPassword`, `newPassword`, `repeatPassword`, `turnOnButton`,
`changePasswordButton`, `turnOffButton`, `lockNowButton`, `busy`, `lockTurnedOn`,
`passwordChanged`, `lockTurnedOff`; returned messages: `notStarted`, `notOpen`, `slotUnreadable`,
`notSavedUnreadable`, `notSaved(reason)`, `dataUnreadable`, `keyDamaged`, `keyMismatch`,
`storageUnreachable(reason)`, `wrongCurrentPassword`, `passwordTooShort(min)`, `passwordsDiffer`,
`indexedDbUnavailable`, `vaultUnreachable`, `vaultNotStored`, `vaultBlocked`, `invalidRounds(min, max)`,
`ringChanged`; users mode: `userLabel`, `setupTitle`, `setupInfo`, `setupButton`, `loginButton`, `wrongLogin`
(gate) and `notUsersMode`, `notDeviceMode`, `alreadySetUp`, `invalidUser`, `userExists`, `unknownUser`,
`cannotRemoveSelf`, `lastUser`, `entryUnreadable` (returned messages).

## Additions after the extraction (no old name)

- **Blobs:** `vault.putBytes/getBytes/removeBytes/listBytes/listBytesInfo` (`io/vault.ts`), `isBlobName`
  (`logic/config.ts`), and `readBlob/writeBlob/removeBlob/listBlobs/clearBlobs` on
  `VaultEnvironment` (`io/environment.ts`; IndexedDB store `blobs`, database version 2).
- **Blobs in blocks (W4):** `vault.getBytesChunks(name)` (block-wise read), `VaultConfig.blobChunkSize`,
  `DEFAULT_BLOB_CHUNK`, `MAX_BLOB_CHUNK`, `checkChunkSize` (`logic/blobs.ts`); environment methods
  `readBlob/writeBlob/removeBlob/removeBlobs/listBlobKeys/listBlobHeads/clearBlobs` replace `listBlobs` and
  `listBlobInfo`; `StoredBlob` = `{iv, ct, v?}`. Stored format: CLAUDE.md, section Data Model.
- **Users mode:** `config.mode` (`'device'` default, `'users'`), `StartResult` kind `setup`, and
  on `Vault` `setupFirstUser`, `loginUser`, `currentUser`, `users`, `addUser`, `removeUser`,
  `changeUserPassphrase`, `userEntry`, `joinWithEntry`; crypto pieces `createUserEntry`,
  `openUserEntry`, `parseUsersBundle`, `userEntryToText`/`userEntryFromText` (`logic/vault.ts`).
- **Concurrency and rounds (review fixes):** a ring change is made on what is stored at that moment
  (`VaultEnvironment.updateBundle`, so a custom environment must provide it: compare and replace in one
  step) and a first start puts its key only where none is stored. `config.minRounds` (default 100 000)
  is the lowest PBKDF2 round count written or read; `createUserEntry` and `bundleWithLock` take it as
  last argument (`minRounds`), `parseBundle`, `parseUsersBundle` and `userEntryFromText` too. User names
  are stored NFC-normalised; `sameUser` compares two typed names. `vault.listBytesInfo(prefix?)` gives
  `{ name, size }`, a failed `putBytes` keeps the browser's error as `error.cause`, `isQuotaError`,
  `storageEstimate` and `requestPersistence` live in `io/storage.ts`.
