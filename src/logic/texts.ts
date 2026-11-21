// Every text the package shows or returns. The app passes its own (any language); the English
// defaults fill whatever it leaves out.

export interface VaultTexts {
  /** Heading above the gate (empty: no heading). */
  title: string;

  // Gate
  opening: string;
  lockedTitle: string;
  passwordLabel: string;
  unlockButton: string;
  unlocking: string;
  wrongPassword: string;
  forgottenHint: string;
  startAnewButton: string;
  startAnewConfirmLocked: string;
  errorTitle: string;
  errorHint: string;
  startAnewConfirmError: string;
  dismissErrors: string;

  // Lock settings
  lockTitle: string;
  lockOnInfo: (minutes: number) => string;
  lockOffInfo: string;
  currentPassword: string;
  newPassword: string;
  repeatPassword: string;
  turnOnButton: string;
  changePasswordButton: string;
  turnOffButton: string;
  lockNowButton: string;
  busy: string;
  lockTurnedOn: string;
  passwordChanged: string;
  lockTurnedOff: string;

  // Messages returned by the vault
  notStarted: string;
  notOpen: string;
  slotUnreadable: string;
  notSavedUnreadable: string;
  notSaved: (reason: string) => string;
  dataUnreadable: string;
  keyDamaged: string;
  keyMismatch: string;
  storageUnreachable: (reason: string) => string;
  wrongCurrentPassword: string;
  passwordTooShort: (min: number) => string;
  passwordsDiffer: string;
  indexedDbUnavailable: string;
  vaultUnreachable: string;
  vaultNotStored: string;
}

export const DEFAULT_TEXTS: VaultTexts = {
  title: '',

  opening: 'Opening the data …',
  lockedTitle: 'Locked',
  passwordLabel: 'Password',
  unlockButton: 'Unlock',
  unlocking: 'Opening …',
  wrongPassword: 'Wrong password.',
  forgottenHint:
    'Forgotten the password? Without it the data on this device cannot be opened. "Start anew" ' +
    'discards it and sets the device up again. Whatever was only on this device is lost.',
  startAnewButton: 'Start anew',
  startAnewConfirmLocked: 'Discard all data on this device and set it up again?',
  errorTitle: 'Data not opened',
  errorHint:
    'The data stays as it is. Only once it is given up: "Start anew" discards it and sets the ' +
    'device up again.',
  startAnewConfirmError: 'Discard the data on this device for good and set it up again?',
  dismissErrors: 'Read',

  lockTitle: 'App lock',
  lockOnInfo: (minutes) =>
    `The lock is on: the app asks for the password at start and after ${minutes} minutes in the background.`,
  lockOffInfo:
    'The lock is off: the data is encrypted on this device, but the app opens without a password.',
  currentPassword: 'Current password',
  newPassword: 'New password',
  repeatPassword: 'Repeat password',
  turnOnButton: 'Turn lock on',
  changePasswordButton: 'Change password',
  turnOffButton: 'Turn lock off',
  lockNowButton: 'Lock now',
  busy: 'One moment …',
  lockTurnedOn: 'The lock is on.',
  passwordChanged: 'The password was changed.',
  lockTurnedOff: 'The lock is off.',

  notStarted: 'The vault was not started.',
  notOpen: 'The data is not open yet.',
  slotUnreadable: 'The stored data could not be opened.',
  notSavedUnreadable: 'Not saved: the existing data could not be opened.',
  notSaved: (reason) => `Not saved: ${reason}`,
  dataUnreadable:
    'The stored data cannot be opened with the key of this device (key missing or data damaged). ' +
    'Nothing was overwritten.',
  keyDamaged: 'The key of the data is damaged.',
  keyMismatch: 'The key of the data does not match this device.',
  storageUnreachable: (reason) => `Storage not reachable: ${reason}`,
  wrongCurrentPassword: 'The current password is wrong.',
  passwordTooShort: (min) =>
    `At least ${min} characters - a longer password protects better than a short PIN.`,
  passwordsDiffer: 'The two entries differ.',
  indexedDbUnavailable: 'IndexedDB is not available',
  vaultUnreachable: 'Vault not reachable',
  vaultNotStored: 'Vault: not stored',
};

export function resolveTexts(texts?: Partial<VaultTexts>): VaultTexts {
  return { ...DEFAULT_TEXTS, ...texts };
}
