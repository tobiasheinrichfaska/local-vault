// Two tabs (or two parts of one tab) on one storage: a stale view never undoes another's change,
// a first start with two tabs makes one key, and "start anew" leaves nothing of the old state behind.
import { describe, expect, it } from 'vitest';
import { memoryEnvironment, type VaultEnvironment } from '../../src/io/environment.ts';
import { createVault } from '../../src/io/vault.ts';

const P = 'app';
const ANNA = 'Annas Passphrase';
const BERND = 'Bernds Passphrase';
const R = 1000;
const by = { user: 'anna', passphrase: ANNA };
const users = (env: VaultEnvironment) =>
  createVault({ prefix: P, slots: ['data', 'other'], mode: 'users', minRounds: R }, env);
const device = (env: VaultEnvironment) =>
  createVault({ prefix: P, slots: ['data', 'other'], minRounds: R }, env);

async function loggedIn(env: VaultEnvironment) {
  const v = users(env);
  await v.startVault();
  expect(await v.loginUser('anna', ANNA)).toEqual({ kind: 'open' });
  return v;
}

async function ringWithBernd() {
  const env = memoryEnvironment();
  const first = users(env);
  await first.startVault();
  await first.setupFirstUser('anna', ANNA, R);
  expect(await first.addUser('bernd', BERND, by, R)).toBeUndefined();
  return { env, first };
}

describe('users: a stale tab does not undo another tab', () => {
  it('a removed user does not come back when the stale tab adds another', async () => {
    const { env, first } = await ringWithBernd();
    const stale = await loggedIn(env); // sees anna and bernd
    expect(stale.users()).toEqual(['anna', 'bernd']);
    expect(await first.removeUser('bernd')).toBeUndefined();
    expect(await stale.addUser('carl', 'Carls Passphrase', by, R)).toBeUndefined();
    expect(stale.users()).toEqual(['anna', 'carl']); // refreshed from what is stored
    const late = users(env);
    await late.startVault();
    expect(late.users()).toEqual(['anna', 'carl']);
    expect(await late.loginUser('bernd', BERND)).toBe(false);
  });

  it('the stale tab does not remove a user another tab already removed, nor the last one', async () => {
    const { env, first } = await ringWithBernd();
    const stale = await loggedIn(env);
    expect(await first.removeUser('bernd')).toBeUndefined();
    expect(await stale.removeUser('bernd')).toMatch(/unknown|no such/i);
    expect(stale.users()).toEqual(['anna']);
  });

  it('a passphrase set in another tab is not overwritten by a stale change', async () => {
    const { env, first } = await ringWithBernd();
    const stale = await loggedIn(env);
    expect(await first.changeUserPassphrase('anna', ANNA, 'Neue Passphrase 1', R)).toBeUndefined();
    expect(await stale.changeUserPassphrase('anna', ANNA, 'Neue Passphrase 2', R)).toMatch(
      /elsewhere|reload/i,
    );
    const late = users(env);
    await late.startVault();
    expect(await late.loginUser('anna', 'Neue Passphrase 1')).toEqual({ kind: 'open' });
  });

  it('a user added by someone since removed is refused', async () => {
    const { env, first } = await ringWithBernd();
    const bernd = users(env);
    await bernd.startVault();
    await bernd.loginUser('bernd', BERND);
    await first.removeUser('bernd');
    expect(
      await bernd.addUser('carl', 'Carls Passphrase', { user: 'bernd', passphrase: BERND }, R),
    ).toMatch(/elsewhere|reload/i);
    expect(first.users()).toEqual(['anna']);
  });
});

describe('users: changes inside one instance', () => {
  it('two parallel addUser keep both users', async () => {
    const env = memoryEnvironment();
    const v = users(env);
    await v.startVault();
    await v.setupFirstUser('anna', ANNA, R);
    const results = await Promise.all([
      v.addUser('bernd', BERND, by, R),
      v.addUser('carl', 'Carls Passphrase', by, R),
    ]);
    expect(results).toEqual([undefined, undefined]);
    expect(v.users()).toEqual(['anna', 'bernd', 'carl']);
    const late = users(env);
    await late.startVault();
    expect(late.users()).toEqual(['anna', 'bernd', 'carl']);
  });

  it('two parallel addUser of the same name: one wins', async () => {
    const env = memoryEnvironment();
    const v = users(env);
    await v.startVault();
    await v.setupFirstUser('anna', ANNA, R);
    const results = await Promise.all([
      v.addUser('bernd', BERND, by, R),
      v.addUser('bernd', 'Andere Passphrase', by, R),
    ]);
    expect(results.filter((r) => r === undefined)).toHaveLength(1);
    expect(v.users()).toEqual(['anna', 'bernd']);
  });

  it('parallel add and remove both take effect', async () => {
    const { first } = await ringWithBernd();
    const results = await Promise.all([
      first.addUser('carl', 'Carls Passphrase', by, R),
      first.removeUser('bernd'),
    ]);
    expect(results).toEqual([undefined, undefined]);
    expect(first.users()).toEqual(['anna', 'carl']);
  });
});

describe('a first start with two tabs makes one key', () => {
  it('device mode: both tabs read each other’s data', async () => {
    const env = memoryEnvironment();
    const a = device(env);
    const b = device(env);
    const [ra, rb] = await Promise.all([a.startVault(), b.startVault()]);
    expect(ra).toEqual({ kind: 'open' });
    expect(rb).toEqual({ kind: 'open' });
    a.writeSlot('data', 'from a');
    b.writeSlot('other', 'from b');
    await Promise.all([a.saved(), b.saved()]);
    const c = device(env);
    expect(await c.startVault()).toEqual({ kind: 'open' }); // not "unreadable": one key
    expect(c.readSlot('data')).toBe('from a');
    expect(c.readSlot('other')).toBe('from b');
  });

  it('users mode: the second set-up finds the ring of the first and does not replace it', async () => {
    const env = memoryEnvironment();
    const a = users(env);
    const b = users(env);
    await Promise.all([a.startVault(), b.startVault()]);
    const [ra, rb] = await Promise.all([
      a.setupFirstUser('anna', ANNA, R),
      b.setupFirstUser('bernd', BERND, R),
    ]);
    expect([ra.kind, rb.kind].sort()).toEqual(['error', 'open']);
    const winner = ra.kind === 'open' ? 'anna' : 'bernd';
    const late = users(env);
    await late.startVault();
    expect(late.users()).toEqual([winner]);
  });

  it('users mode: joining with an entry does not replace a ring made meanwhile', async () => {
    const { env: source, first } = await ringWithBernd();
    void source;
    const text = first.userEntry('bernd') ?? '';
    const env = memoryEnvironment();
    const a = users(env);
    const b = users(env);
    await Promise.all([a.startVault(), b.startVault()]);
    expect((await a.setupFirstUser('carl', 'Carls Passphrase', R)).kind).toBe('open');
    expect((await b.joinWithEntry(text, BERND)) as { kind: string }).toMatchObject({
      kind: 'error',
    });
    const late = users(env);
    await late.startVault();
    expect(late.users()).toEqual(['carl']);
  });
});

describe('start anew leaves nothing of the old state', () => {
  // the write may be queued, or already sealing, when "start anew" comes
  for (const ticks of [0, 1, 2, 4, 8]) {
    it(`device mode: a write ${ticks} ticks before does not come back`, async () => {
      const env = memoryEnvironment();
      const v = device(env);
      await v.startVault();
      v.writeSlot('data', 'old');
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      await v.startAnew();
      expect(env.raw.has('app-data')).toBe(false);
      const again = device(env);
      expect(await again.startVault()).toEqual({ kind: 'open' }); // not dataUnreadable
      expect(again.readSlot('data')).toBeNull();
    });

    it(`users mode: a write ${ticks} ticks before does not come back`, async () => {
      const env = memoryEnvironment();
      const v = users(env);
      await v.startVault();
      await v.setupFirstUser('anna', ANNA, R);
      v.writeSlot('data', 'old');
      for (let i = 0; i < ticks; i++) await Promise.resolve();
      await v.startAnew();
      expect(env.raw.has('app-data')).toBe(false);
      const again = users(env);
      expect(await again.startVault()).toEqual({ kind: 'setup' });
      expect(await again.setupFirstUser('anna', ANNA, R)).toEqual({ kind: 'open' });
      expect(again.readSlot('data')).toBeNull();
    });
  }

  it('writing after start anew is refused until the vault is opened again', async () => {
    const v = device(memoryEnvironment());
    await v.startVault();
    await v.startAnew();
    expect(() => v.writeSlot('data', 'x')).toThrow(/not open/);
  });
});
