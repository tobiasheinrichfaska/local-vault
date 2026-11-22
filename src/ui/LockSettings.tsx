// Settings for the app lock: turn it on, lock now, change the password, turn it off. Render it
// inside the open vault only (inside `VaultGate`).
import { useState } from 'react';
import type { VaultTexts } from '../logic/texts.ts';
import { LOCK_AFTER_MINUTES, checkPassword } from '../logic/vault.ts';
import type { Vault } from '../io/vault.ts';
import { Card, ErrorLine, PasswordField, errorText, ui } from './parts.tsx';

export interface LockSettingsProps {
  readonly vault: Vault;
  readonly texts?: Partial<VaultTexts>;
}

/** The app lock of the device mode; in users mode the lock is the login, so there is nothing to set. */
export function LockSettings(props: LockSettingsProps) {
  return props.vault.config.mode === 'users' ? null : <DeviceLockSettings {...props} />;
}

function DeviceLockSettings({ vault, texts: override }: LockSettingsProps) {
  const texts = override ? { ...vault.texts, ...override } : vault.texts;
  const [, refresh] = useState(0);
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [repeated, setRepeated] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [info, setInfo] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const lockOn = vault.isLockOn();

  const run = (action: () => Promise<string | undefined>, done: string) => {
    setError(undefined);
    setInfo(undefined);
    setBusy(true);
    action()
      .then((problem) => {
        if (problem) setError(problem);
        else {
          setInfo(done);
          setCurrent('');
          setPassword('');
          setRepeated('');
          refresh((n) => n + 1);
        }
      })
      .catch((e: unknown) => setError(errorText(e)))
      .finally(() => setBusy(false));
  };

  const setNewPassword = () => {
    const problem = checkPassword(password, repeated, texts);
    if (problem) return setError(problem);
    run(
      () => vault.setLock(password, lockOn ? current : undefined),
      lockOn ? texts.passwordChanged : texts.lockTurnedOn,
    );
  };

  return (
    <Card title={texts.lockTitle}>
      <p style={ui.small}>{lockOn ? texts.lockOnInfo(LOCK_AFTER_MINUTES) : texts.lockOffInfo}</p>
      {lockOn && (
        <PasswordField
          label={texts.currentPassword}
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
        />
      )}
      <PasswordField
        label={lockOn ? texts.newPassword : texts.passwordLabel}
        value={password}
        onChange={setPassword}
        autoComplete="new-password"
      />
      <PasswordField
        label={texts.repeatPassword}
        value={repeated}
        onChange={setRepeated}
        autoComplete="new-password"
      />
      <button type="button" style={ui.button} disabled={busy} onClick={setNewPassword}>
        {lockOn ? texts.changePasswordButton : texts.turnOnButton}
      </button>
      {lockOn && (
        <>
          <button
            type="button"
            style={ui.button}
            disabled={busy || current === ''}
            onClick={() => run(() => vault.removeLock(current), texts.lockTurnedOff)}
          >
            {texts.turnOffButton}
          </button>
          <button type="button" style={ui.button} onClick={() => vault.lockNow()}>
            {texts.lockNowButton}
          </button>
        </>
      )}
      {busy && <p style={ui.small}>{texts.busy}</p>}
      {error && <ErrorLine>{error}</ErrorLine>}
      {info && <p role="status">{info}</p>}
    </Card>
  );
}
