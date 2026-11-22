import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { memoryEnvironment } from '../../src/io/environment.ts';
import { createVault } from '../../src/io/vault.ts';
import { LockSettings } from '../../src/ui/LockSettings.tsx';

describe('users mode in the interface', () => {
  it('has no device lock card (the lock is the login)', () => {
    const vault = createVault(
      { prefix: 'app', slots: ['data'], mode: 'users' },
      memoryEnvironment(),
    );
    expect(renderToString(<LockSettings vault={vault} />)).toBe('');
    const device = createVault({ prefix: 'app', slots: ['data'] }, memoryEnvironment());
    expect(renderToString(<LockSettings vault={device} />)).toContain('App lock');
  });
});
