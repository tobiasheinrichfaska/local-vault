// Before the app: the vault opens. With the app lock on, the password first; after some minutes
// in the background the page locks again — by reloading, so nothing opened stays in memory.
import { useEffect, useState, type ReactNode } from 'react';
import type { VaultTexts } from '../logic/texts.ts';
import { checkPassword, shouldRelock } from '../logic/vault.ts';
import type { StartResult, Vault } from '../io/vault.ts';
import { Card, ErrorLine, PasswordField, TextField, errorText, ui } from './parts.tsx';

export interface VaultGateProps {
  readonly vault: Vault;
  /** Replaces texts of the vault's own (any language); the vault's texts are the default. */
  readonly texts?: Partial<VaultTexts>;
  readonly children: ReactNode;
}

/** Drops the data of this device and starts empty — only after a confirmation. */
function StartAnew({
  vault,
  texts,
  question,
  onError,
}: {
  vault: Vault;
  texts: VaultTexts;
  question: string;
  onError: (e: string) => void;
}) {
  return (
    <button
      type="button"
      style={ui.button}
      onClick={() => {
        if (!confirm(question)) return;
        vault
          .startAnew()
          .then(() => location.reload())
          .catch((error: unknown) => onError(errorText(error)));
      }}
    >
      {texts.startAnewButton}
    </button>
  );
}

function Unlock({
  vault,
  texts,
  onResult,
}: {
  vault: Vault;
  texts: VaultTexts;
  onResult: (r: StartResult) => void;
}) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  return (
    <Card title={texts.lockedTitle}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setWrong(false);
          vault
            .unlock(password)
            .then((result) => {
              if (result) onResult(result);
              else {
                setWrong(true);
                setPassword('');
              }
            })
            .catch((error: unknown) => onResult({ kind: 'error', error: errorText(error) }))
            .finally(() => setBusy(false));
        }}
      >
        <PasswordField
          label={texts.passwordLabel}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          autoFocus
        />
        <button type="submit" style={ui.button} disabled={busy || password === ''}>
          {busy ? texts.unlocking : texts.unlockButton}
        </button>
      </form>
      {wrong && <ErrorLine>{texts.wrongPassword}</ErrorLine>}
      <p style={ui.small}>{texts.forgottenHint}</p>
      <StartAnew
        vault={vault}
        texts={texts}
        question={texts.startAnewConfirmLocked}
        onError={(error) => onResult({ kind: 'error', error })}
      />
    </Card>
  );
}

/** Users mode, nothing stored yet: the first user and his passphrase. */
function UserSetup({
  vault,
  texts,
  onResult,
}: {
  vault: Vault;
  texts: VaultTexts;
  onResult: (r: StartResult) => void;
}) {
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [repeated, setRepeated] = useState('');
  const [problem, setProblem] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  return (
    <Card title={texts.setupTitle}>
      <p style={ui.small}>{texts.setupInfo}</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const weak = checkPassword(password, repeated, texts);
          if (weak) return setProblem(weak);
          setBusy(true);
          setProblem(undefined);
          vault
            .setupFirstUser(user, password)
            .then((r) => (r.kind === 'error' ? setProblem(r.error) : onResult(r)))
            .catch((error: unknown) => setProblem(errorText(error)))
            .finally(() => setBusy(false));
        }}
      >
        <TextField
          label={texts.userLabel}
          value={user}
          onChange={setUser}
          autoComplete="username"
          autoFocus
        />
        <PasswordField
          label={texts.passwordLabel}
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
        <button type="submit" style={ui.button} disabled={busy || user === '' || password === ''}>
          {busy ? texts.busy : texts.setupButton}
        </button>
      </form>
      {problem && <ErrorLine>{problem}</ErrorLine>}
    </Card>
  );
}

/** Users mode: user and passphrase. */
function UserLogin({
  vault,
  texts,
  onResult,
}: {
  vault: Vault;
  texts: VaultTexts;
  onResult: (r: StartResult) => void;
}) {
  const known = vault.users();
  const [user, setUser] = useState(known.length === 1 ? (known[0] ?? '') : '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [wrong, setWrong] = useState(false);
  return (
    <Card title={texts.lockedTitle}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          setWrong(false);
          vault
            .loginUser(user, password)
            .then((result) => {
              if (result) onResult(result);
              else {
                setWrong(true);
                setPassword('');
              }
            })
            .catch((error: unknown) => onResult({ kind: 'error', error: errorText(error) }))
            .finally(() => setBusy(false));
        }}
      >
        <TextField
          label={texts.userLabel}
          value={user}
          onChange={setUser}
          autoComplete="username"
          autoFocus={user === ''}
        />
        <PasswordField
          label={texts.passwordLabel}
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
          autoFocus={user !== ''}
        />
        <button type="submit" style={ui.button} disabled={busy || user === '' || password === ''}>
          {busy ? texts.unlocking : texts.loginButton}
        </button>
      </form>
      {wrong && <ErrorLine>{texts.wrongLogin}</ErrorLine>}
      <p style={ui.small}>{texts.forgottenHint}</p>
      <StartAnew
        vault={vault}
        texts={texts}
        question={texts.startAnewConfirmLocked}
        onError={(error) => onResult({ kind: 'error', error })}
      />
    </Card>
  );
}

export function VaultGate({ vault, texts: override, children }: VaultGateProps) {
  const texts = override ? { ...vault.texts, ...override } : vault.texts;
  const [start, setStart] = useState<StartResult | undefined>();
  const [errors, setErrors] = useState<readonly string[]>([]);

  useEffect(() => {
    let gone = false;
    vault
      .startVault()
      .then((s) => !gone && setStart(s))
      .catch((error: unknown) => !gone && setStart({ kind: 'error', error: errorText(error) }));
    const off = vault.onError((e) => setErrors((old) => [...old.slice(-2), e]));
    return () => {
      gone = true;
      off();
    };
  }, [vault]);

  // With the lock on: back after some minutes in the background → locked again.
  useEffect(() => {
    let hiddenSince: number | undefined;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') hiddenSince = Date.now();
      else if (vault.isLockOn() && shouldRelock(hiddenSince, Date.now())) vault.lockNow();
      else hiddenSince = undefined;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [vault]);

  const frame = (content: ReactNode) => (
    <main style={ui.page}>
      {texts.title !== '' && <h1 style={{ fontSize: 22 }}>{texts.title}</h1>}
      {content}
    </main>
  );

  if (!start) return frame(<p style={ui.small}>{texts.opening}</p>);
  if (start.kind === 'setup') {
    return frame(<UserSetup vault={vault} texts={texts} onResult={setStart} />);
  }
  if (start.kind === 'locked') {
    return frame(
      vault.config.mode === 'users' ? (
        <UserLogin vault={vault} texts={texts} onResult={setStart} />
      ) : (
        <Unlock vault={vault} texts={texts} onResult={setStart} />
      ),
    );
  }
  if (start.kind === 'error') {
    return frame(
      <Card title={texts.errorTitle}>
        <ErrorLine>{start.error}</ErrorLine>
        <p style={ui.small}>{texts.errorHint}</p>
        <StartAnew
          vault={vault}
          texts={texts}
          question={texts.startAnewConfirmError}
          onError={(error) => setStart({ kind: 'error', error })}
        />
      </Card>,
    );
  }
  return (
    <>
      {errors.length > 0 && (
        <div role="alert" style={{ ...ui.page, paddingBottom: 0 }}>
          {errors.map((e, i) => (
            <ErrorLine key={i}>{e}</ErrorLine>
          ))}
          <button type="button" style={ui.button} onClick={() => setErrors([])}>
            {texts.dismissErrors}
          </button>
        </div>
      )}
      {children}
    </>
  );
}
