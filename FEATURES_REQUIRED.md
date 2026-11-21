# Critical User Paths — local-vault

**Purpose:** Core workflows that must not break. Audit validates these end-to-end.
Status 2026-11-21: the logic and the first render are covered by tests; the browser parts only on a device.

- [ ] **First start opens without a password** — keys are made, the app shows, no error
- [ ] **Data is stored only encrypted** — nothing readable in localStorage, a plain value is never read
- [ ] **Data survives a restart** — written, reloaded, there again
- [ ] **Turn the app lock on, change the password, turn it off** — the data stays untouched
- [ ] **A wrong password is refused, the right one opens**
- [ ] **The app locks again after 5 minutes in the background** — by reloading
- [ ] **An unreadable slot is never overwritten** — the gate shows the reason, "start anew" is the only way out
- [ ] **A storage error reaches the user** — through `onError`, never silent
- [ ] **No app words and no app data inside the package** — guard test

| Path | Impact | Audit Check |
|---|---|---|
| Closed vault throws on read/write | an empty value would be saved over real data | `tests/io/vault.test.ts` |
| Store names start with the prefix | collisions with other apps on the same origin | `tests/io/config.test.ts` |
| Config and texts passed in | the package is useless to a second app otherwise | `tests/ui/coupling.test.ts` |
| Key survives a reload on a phone | data lost without warning | device test (`manual_tests/`) |
