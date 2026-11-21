// Public entry of local-vault: the vault, its environments, the React gate and the pure logic.

// The vault
export { createVault, type StartResult, type Vault } from './io/vault.ts';
export {
  browserEnvironment,
  guardEnvironment,
  memoryEnvironment,
  type VaultEnvironment,
} from './io/environment.ts';

// Components
export { VaultGate, type VaultGateProps } from './ui/VaultGate.tsx';
export { LockSettings, type LockSettingsProps } from './ui/LockSettings.tsx';

// Configuration and texts
export {
  databaseName,
  hasPrefix,
  storageName,
  validateConfig,
  type VaultConfig,
} from './logic/config.ts';
export { DEFAULT_TEXTS, resolveTexts, type VaultTexts } from './logic/texts.ts';

// Logic: crypto pieces (the prefix is the app's)
export {
  LOCK_AFTER_MINUTES,
  MIN_PASSWORD,
  ROUNDS,
  bundleWithLock,
  bundleWithoutLock,
  checkPassword,
  createDataKey,
  createDeviceKey,
  isSealed,
  open,
  openBundle,
  openText,
  parseBundle,
  seal,
  sealText,
  shouldRelock,
  type Bundle,
  type Piece,
} from './logic/vault.ts';
export { base64url, fromBase64url } from './logic/base64url.ts';
