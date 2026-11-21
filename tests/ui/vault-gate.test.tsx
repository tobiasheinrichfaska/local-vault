import { renderToString } from 'react-dom/server';
import { memoryEnvironment } from '../../src/io/environment.ts';
import { createVault } from '../../src/io/vault.ts';
import { LockSettings } from '../../src/ui/LockSettings.tsx';
import { VaultGate } from '../../src/ui/VaultGate.tsx';

const vault = () => createVault({ prefix: 'app', slots: ['data'] }, memoryEnvironment());

describe('VaultGate', () => {
  it('shows only the opening message until the vault is started, never the app', () => {
    const html = renderToString(
      <VaultGate vault={vault()}>
        <p>SECRET-CONTENT</p>
      </VaultGate>,
    );
    expect(html).toContain('Opening the data');
    expect(html).not.toContain('SECRET-CONTENT');
  });

  it('uses the texts of the app, in any language', () => {
    const html = renderToString(
      <VaultGate vault={vault()} texts={{ opening: 'Öffne die Daten …', title: 'Meine App' }}>
        <p>x</p>
      </VaultGate>,
    );
    expect(html).toContain('Öffne die Daten');
    expect(html).toContain('Meine App');
    expect(html).not.toContain('Opening the data');
  });

  it('texts given to the vault reach the gate too', () => {
    const v = createVault(
      { prefix: 'app', slots: ['data'], texts: { opening: 'Un instant …' } },
      memoryEnvironment(),
    );
    const html = renderToString(
      <VaultGate vault={v}>
        <p>x</p>
      </VaultGate>,
    );
    expect(html).toContain('Un instant');
  });

  it('shows no heading without a title', () => {
    const html = renderToString(
      <VaultGate vault={vault()}>
        <p>x</p>
      </VaultGate>,
    );
    expect(html).not.toContain('<h1');
  });
});

describe('LockSettings', () => {
  it('offers to turn the lock on while it is off', () => {
    const html = renderToString(<LockSettings vault={vault()} />);
    expect(html).toContain('Turn lock on');
    expect(html).not.toContain('Lock now');
  });

  it('uses the texts of the app', () => {
    const html = renderToString(
      <LockSettings vault={vault()} texts={{ turnOnButton: 'Sperre einschalten' }} />,
    );
    expect(html).toContain('Sperre einschalten');
  });
});
