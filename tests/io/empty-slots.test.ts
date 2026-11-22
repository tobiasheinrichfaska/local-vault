// An app that uses only blobs configures no slots.
import { describe, expect, it } from 'vitest';
import { memoryEnvironment } from '../../src/io/environment.ts';
import { createVault } from '../../src/io/vault.ts';
import { validateConfig } from '../../src/logic/config.ts';

const R = 1000;
const bytes = (...v: number[]) => new Uint8Array(v);

describe('slots: []', () => {
  it('the configuration is valid; slots stay checked for names and duplicates', () => {
    expect(() => validateConfig({ prefix: 'app', slots: [] })).not.toThrow();
    expect(() => validateConfig({ prefix: 'app', slots: ['a', 'a'] })).toThrow(/Duplicate/);
  });

  it('device mode: opens, blobs work, an unknown slot throws, close and start anew', async () => {
    const env = memoryEnvironment();
    const v = createVault({ prefix: 'app', slots: [], minRounds: R }, env);
    expect(await v.startVault()).toEqual({ kind: 'open' });
    expect(() => v.readSlot('data')).toThrow(/Unknown slot/);
    expect(() => v.writeSlot('data', 'x')).toThrow(/Unknown slot/);
    await v.putBytes('doc', bytes(1, 2));
    expect(await v.getBytes('doc')).toEqual(bytes(1, 2));
    await v.setLock('Secret-2026', undefined, R);
    await v.close();
    expect(await v.unlock('Secret-2026')).toEqual({ kind: 'open' });
    expect(await v.getBytes('doc')).toEqual(bytes(1, 2));
    await v.startAnew();
    expect([...env.raw.keys()]).toEqual([]);
    expect(await env.listBlobKeys()).toEqual([]);
    expect(await v.startVault()).toEqual({ kind: 'open' });
    expect(await v.getBytes('doc')).toBeUndefined();
  });

  it('users mode: set-up, login, blobs, close, login again, start anew', async () => {
    const env = memoryEnvironment();
    const v = createVault({ prefix: 'app', slots: [], mode: 'users', minRounds: R }, env);
    expect(await v.startVault()).toEqual({ kind: 'setup' });
    expect(await v.setupFirstUser('anna', 'Annas Passphrase', R)).toEqual({ kind: 'open' });
    await v.putBytes('doc', bytes(3));
    await v.close();
    expect(await v.loginUser('anna', 'Annas Passphrase')).toEqual({ kind: 'open' });
    expect(await v.getBytes('doc')).toEqual(bytes(3));
    await v.startAnew();
    expect(await env.listBlobKeys()).toEqual([]);
    expect(await v.startVault()).toEqual({ kind: 'setup' });
  });

  it('a stored slot of an earlier configuration is untouched by a vault without slots', async () => {
    const env = memoryEnvironment();
    const before = createVault({ prefix: 'app', slots: ['data'], minRounds: R }, env);
    await before.startVault();
    before.writeSlot('data', 'x');
    await before.saved();
    const stored = env.raw.get('app-data');
    const v = createVault({ prefix: 'app', slots: [], minRounds: R }, env);
    expect(await v.startVault()).toEqual({ kind: 'open' });
    expect(env.raw.get('app-data')).toBe(stored);
  });
});
