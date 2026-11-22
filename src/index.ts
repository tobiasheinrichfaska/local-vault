// Public entry of local-vault: the vault, its environments, the React gate and the pure logic.

// The vault
export { createVault, type ExternalChange, type StartResult, type Vault } from './io/vault.ts';
export {
  browserEnvironment,
  guardEnvironment,
  memoryEnvironment,
  type BundleUpdate,
  type StoredBlob,
  type VaultEnvironment,
  type VaultSignal,
} from './io/environment.ts';
export {
  isQuotaError,
  requestPersistence,
  storageEstimate,
  type StorageEstimate,
  type StorageNavigator,
} from './io/storage.ts';

// Components
export { VaultGate, type VaultGateProps } from './ui/VaultGate.tsx';
export { LockSettings, type LockSettingsProps } from './ui/LockSettings.tsx';

// Configuration and texts
export {
  databaseName,
  hasPrefix,
  isBlobName,
  storageName,
  validateConfig,
  type VaultConfig,
} from './logic/config.ts';
export { DEFAULT_TEXTS, resolveTexts, type VaultTexts } from './logic/texts.ts';

export { DEFAULT_BLOB_CHUNK, MAX_BLOB_CHUNK, checkChunkSize } from './logic/blobs.ts';

// Logic: crypto pieces (the prefix is the app's)
export {
  DEFAULT_MIN_ROUNDS,
  LOCK_AFTER_MINUTES,
  MAX_ROUNDS,
  MIN_PASSWORD,
  ROUNDS,
  bundleWithLock,
  bundleWithoutLock,
  checkPassword,
  checkRounds,
  createDataKey,
  createDeviceKey,
  createUserEntry,
  isSealed,
  isUserName,
  open,
  openBundle,
  openText,
  openUserEntry,
  parseBundle,
  parseUsersBundle,
  sameUser,
  seal,
  sealText,
  shouldRelock,
  userEntryFromText,
  userEntryToText,
  usersBundle,
  type Bundle,
  type Piece,
  type UserEntry,
  type UsersBundle,
} from './logic/vault.ts';
export { base64url, fromBase64url } from './logic/base64url.ts';
