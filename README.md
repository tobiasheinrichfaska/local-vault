# local-vault

Encrypted local storage for web apps: everything the device stores is AES-GCM encrypted under a
random data key; the data key is wrapped by a non-extractable device key (kept in IndexedDB) and,
if the user turns the app lock on, also by a key from a password (PBKDF2). A React gate opens the
vault before the app shows anything and locks again after a few minutes in the background. The
package holds no app data and no app texts: the app passes a name prefix, its slots and, if it
wants another language, its texts.

**Status:** early (0.1.0), not published to npm. Web only (IndexedDB, localStorage, Web Crypto).

## Install and test

```bash
npm install
npm test
npm run typecheck
```

## Usage

```tsx
import { createVault, VaultGate, LockSettings } from 'local-vault';

// One vault per app. Every store name starts with the prefix: `app-vault` (IndexedDB),
// `app-data` (localStorage, encrypted).
export const vault = createVault({ prefix: 'app', slots: ['data'] });

// Before the app shows anything:
<VaultGate vault={vault}>
  <App />
</VaultGate>;

// Inside the open vault:
vault.writeSlot('data', JSON.stringify(state)); // in memory at once, encrypted write follows
const raw = vault.readSlot('data'); // string | null; throws while closed or unreadable
vault.onError((message) => showToast(message)); // storage errors after the fact

// An optional settings card for the app lock:
<LockSettings vault={vault} />;
```

Big or many pieces (documents, the blocks of a large state) do not belong in slots: a slot is one
text in localStorage, held in memory. **Blobs** are encrypted bytes under free names in IndexedDB, bound
to their name, each call going to the storage:

```ts
await vault.putBytes('file:ab12', bytes); // resolves when stored, rejects with the reason
const back = await vault.getBytes('file:ab12'); // Uint8Array | undefined; throws if it cannot be opened
await vault.listBytes('file:'); // sorted names, optionally those starting so
await vault.removeBytes('file:ab12');
```

Names: lower case, digits and `. _ : / -`, up to 200 characters (`isBlobName`). `saved()` waits for
blobs on their way too; "start anew" removes them with the slots. An existing version 1 database is
upgraded in place (the key bundle and the device key stay).

### Users mode (several people on one device)

`createVault({ prefix, slots, mode: 'users' })` swaps the device lock for a **key ring**: the data key is
stored only wrapped by a key from each user's passphrase (PBKDF2, 600 000 rounds), one entry per user.
Nothing opens without a login; the device key plays no part. The gate shows a set-up (first user) and a
login (user + passphrase); `LockSettings` renders nothing in this mode.

```ts
await vault.startVault(); // { kind: 'setup' } | { kind: 'locked' } | { kind: 'error', … }
await vault.setupFirstUser('anna', 'a long passphrase');
await vault.loginUser('anna', 'a long passphrase'); // StartResult | false
await vault.addUser('bernd', 'his passphrase', { user: 'anna', passphrase: 'a long passphrase' });
await vault.removeUser('bernd'); // never yourself
await vault.changeUserPassphrase('anna', 'old', 'new');
vault.users(); // known also while locked
```

Adding a user needs the logged-in user's passphrase once more (the data key stays non-extractable in
use). For an app that keeps a user's entry on a **server** (so a wiped or new device can fill itself
again): `vault.userEntry('anna')` is the entry as text (the server cannot unwrap it without the
passphrase) and a fresh device takes it back with `vault.joinWithEntry(text, passphrase)`. The login
secret the server checks must be derived apart from this key (the app's part). A stored bundle that
cannot be read (or is of the other mode) is never replaced except by "start anew".

Texts in another language: `createVault({ prefix, slots, texts: { opening: '…', ... } })` or the
`texts` prop of the components; every field of `VaultTexts` has an English default
(`DEFAULT_TEXTS`). For tests use `createVault(config, memoryEnvironment())`.

Rules the vault keeps: a plain value in a slot is never read; an unreadable slot is never
overwritten; reading or writing while closed throws; turning the lock on/off or a new password
only wraps the data key anew. Names of the original API and their equivalents:
[docs/api-mapping.md](docs/api-mapping.md). What only a device can check: see `manual_tests/`.

Bug reports and ideas: [GitHub Issues](https://github.com/tobiasheinrichfaska/local-vault/issues).

## License

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

This project is licensed under the **GNU Affero General Public License v3.0** (AGPLv3).
You are free to use, modify, and distribute this software under the terms of the AGPLv3.
If you use this software to provide a network service, you must make the full source code
of your modifications available to users of that service.

**Commercial License:** If you wish to use this software in a closed-source or proprietary
product, a commercial license is available. Contact: tobias.a.w.heinrich@gmail.com

See [LICENSE](LICENSE) for the full AGPLv3 text.
See [LICENSE_COMMERCIAL.md](LICENSE_COMMERCIAL.md) for commercial licensing terms.
