// Small pieces shared by the gate and the lock settings.
import type { CSSProperties, ReactNode } from 'react';

export const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const ui = {
  page: { maxWidth: 480, margin: '0 auto', padding: 16, fontFamily: 'system-ui, sans-serif' },
  card: { border: '1px solid #8886', borderRadius: 8, padding: 12, margin: '12px 0' },
  small: { fontSize: 14, opacity: 0.8 },
  error: { color: '#b00020', margin: '8px 0' },
  button: { fontSize: 16, padding: '8px 12px', margin: '4px 8px 4px 0' },
  input: { display: 'block', width: '100%', fontSize: 18, padding: 8, marginTop: 4 },
} satisfies Record<string, CSSProperties>;

export function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={ui.card}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>{title}</h2>
      {children}
    </section>
  );
}

export function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" style={ui.error}>
      {children}
    </p>
  );
}

export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'current-password' | 'new-password';
  autoFocus?: boolean;
}) {
  return (
    <label style={{ display: 'block', margin: '6px 0' }}>
      {label}
      <input
        type="password"
        autoComplete={autoComplete}
        autoFocus={autoFocus === true}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={ui.input}
      />
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  autoComplete,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: 'username';
  autoFocus?: boolean;
}) {
  return (
    <label style={{ display: 'block', margin: '6px 0' }}>
      {label}
      <input
        type="text"
        autoComplete={autoComplete}
        autoFocus={autoFocus === true}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={ui.input}
      />
    </label>
  );
}
