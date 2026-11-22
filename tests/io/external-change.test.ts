// `onExternalChange`: another instance of the same page (another tab) started anew or changed the
// keys (users, passphrase, lock). The instance only hears about it; it does not close itself.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  browserEnvironment,
  memoryEnvironment,
  type VaultEnvironment,
} from '../../src/io/environment.ts';
import { createVault, type ExternalChange } from '../../src/io/vault.ts';

const ls = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k),
  },
});

const R = 1000;
const ANNA = 'Annas Passphrase';
const by = { user: 'anna', passphrase: ANNA };
const tick = () => new Promise((r) => setTimeout(r, 30));
const users = (env: VaultEnvironment, prefix = 'app') =>
  createVault({ prefix, slots: ['data'], mode: 'users', minRounds: R }, env);
const device = (env: VaultEnvironment, prefix = 'app') =>
  createVault({ prefix, slots: ['data'], minRounds: R }, env);

async function pair() {
  const env = memoryEnvironment();
  const a = users(env);
  await a.startVault();
  await a.setupFirstUser('anna', ANNA, R);
  const b = users(env);
  await b.startVault();
  await b.loginUser('anna', ANNA);
  const heardA: ExternalChange[] = [];
  const heardB: ExternalChange[] = [];
  a.onExternalChange((c) => heardA.push(c));
  b.onExternalChange((c) => heardB.push(c));
  return { env, a, b, heardA, heardB };
}

describe('onExternalChange (memory environment, two instances = two tabs)', () => {
  it('start anew in one is heard by the other, not by itself; the other does not close', async () => {
    const { a, b, heardA, heardB } = await pair();
    await a.startAnew();
    await tick();
    expect(heardB).toEqual([{ kind: 'startAnew' }]);
    expect(heardA).toEqual([]);
    expect(b.isVaultOpen()).toBe(true); // the app decides
  });

  it('removing a user, adding one and changing a passphrase are heard as a change of the keys', async () => {
    const { a, b, heardB } = await pair();
    await a.addUser('bernd', 'Bernds Passphrase', by, R);
    await tick();
    expect(heardB).toEqual([{ kind: 'keys' }]);
    await a.changeUserPassphrase('anna', ANNA, 'Annas Neue Passphrase', R);
    await tick();
    expect(heardB).toEqual([{ kind: 'keys' }, { kind: 'keys' }]);
    await b.close();
    await b.startVault(); // reads the stored ring again
    await a.removeUser('bernd');
    await tick();
    expect(heardB.length).toBe(3);
    expect(b.users()).toEqual(['anna', 'bernd']); // the old view, until the app starts again
  });

  it('the very first set-up on a fresh page is heard by a tab that was waiting for it', async () => {
    const env = memoryEnvironment();
    const a = users(env);
    const b = users(env);
    await a.startVault();
    await b.startVault();
    const heard: ExternalChange[] = [];
    b.onExternalChange((c) => heard.push(c));
    await a.setupFirstUser('anna', ANNA, R);
    await tick();
    expect(heard).toEqual([{ kind: 'keys' }]);
  });

  it('device mode: turning the app lock on and off and a new password are heard', async () => {
    const env = memoryEnvironment();
    const a = device(env);
    const b = device(env);
    await a.startVault();
    await b.startVault();
    const heard: ExternalChange[] = [];
    b.onExternalChange((c) => heard.push(c));
    await a.setLock('Secret-2026', undefined, R);
    await a.setLock('Secret-2027', 'Secret-2026', R);
    await a.removeLock('Secret-2027');
    await tick();
    expect(heard).toEqual([{ kind: 'keys' }, { kind: 'keys' }, { kind: 'keys' }]);
  });

  it('a refused change says nothing', async () => {
    const { a, heardB } = await pair();
    expect(await a.removeUser('nobody')).toBeDefined();
    expect(await a.removeUser('anna')).toBeDefined(); // yourself
    expect(
      await a.changeUserPassphrase('anna', 'wrong one', 'Annas Neue Passphrase', R),
    ).toBeDefined();
    await tick();
    expect(heardB).toEqual([]);
  });

  it('an instance with other prefix on its own storage hears nothing; unsubscribe stops it', async () => {
    const { a, b, heardB } = await pair();
    const stranger = users(memoryEnvironment(), 'zzz');
    const heardStranger: ExternalChange[] = [];
    stranger.onExternalChange((c) => heardStranger.push(c));
    const off = b.onExternalChange(() => heardB.push({ kind: 'keys' }));
    off();
    off(); // twice is fine
    await a.startAnew();
    await tick();
    expect(heardStranger).toEqual([]);
    expect(heardB).toEqual([{ kind: 'startAnew' }]); // the first listener only
  });

  it('a listener that throws does not stop the others', async () => {
    const { a, b } = await pair();
    const heard: ExternalChange[] = [];
    b.onExternalChange(() => {
      throw new Error('app bug');
    });
    b.onExternalChange((c) => heard.push(c));
    await a.startAnew();
    await tick();
    expect(heard).toEqual([{ kind: 'startAnew' }]);
  });

  it('messages that are no signal of the vault are ignored', async () => {
    const { env, heardB } = await pair();
    for (const m of [
      'garbage',
      '{}',
      '{"v":1,"from":"x","kind":"other"}',
      '{"v":2,"from":"x","kind":"keys"}',
      '[]',
      'null',
    ]) {
      env.signal!.post(m);
    }
    await tick();
    expect(heardB).toEqual([]);
    env.signal!.post(JSON.stringify({ v: 1, from: 'someone', kind: 'keys' }));
    await tick();
    expect(heardB).toEqual([{ kind: 'keys' }]);
  });

  it('an environment without a signal works as before; the listener is simply never called', async () => {
    const mem = memoryEnvironment();
    const env = Object.create(mem) as VaultEnvironment;
    Object.defineProperty(env, 'signal', { value: undefined });
    const v = users(env);
    await v.startVault();
    await v.setupFirstUser('anna', ANNA, R);
    const off = v.onExternalChange(() => {
      throw new Error('never');
    });
    await v.addUser('bernd', 'Bernds Passphrase', by, R);
    await v.startAnew();
    off();
  });
});

describe('onExternalChange (BroadcastChannel in the browser environment)', () => {
  const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
  };

  it('a second instance on the same prefix hears start anew; another prefix does not', async () => {
    const prefix = 'bc1';
    const a = createVault(
      { prefix, slots: ['data'], mode: 'users', minRounds: R },
      browserEnvironment(prefix),
    );
    const b = createVault(
      { prefix, slots: ['data'], mode: 'users', minRounds: R },
      browserEnvironment(prefix),
    );
    const c = createVault(
      { prefix: 'bc2', slots: ['data'], mode: 'users', minRounds: R },
      browserEnvironment('bc2'),
    );
    await a.startVault();
    await a.setupFirstUser('anna', ANNA, R);
    await b.startVault();
    const heardB: ExternalChange[] = [];
    const heardC: ExternalChange[] = [];
    const heardA: ExternalChange[] = [];
    const offB = b.onExternalChange((x) => heardB.push(x));
    const offC = c.onExternalChange((x) => heardC.push(x));
    const offA = a.onExternalChange((x) => heardA.push(x));
    await a.addUser('bernd', 'Bernds Passphrase', by, R);
    await waitFor(() => heardB.length >= 1);
    expect(heardB).toEqual([{ kind: 'keys' }]);
    await a.startAnew();
    await waitFor(() => heardB.length >= 2);
    expect(heardB).toEqual([{ kind: 'keys' }, { kind: 'startAnew' }]);
    await tick();
    expect(heardC).toEqual([]);
    expect(heardA).toEqual([]); // not its own message
    offA();
    offB();
    offC();
  });

  it('without BroadcastChannel nothing is announced and nothing fails', async () => {
    const saved = (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel;
    Reflect.deleteProperty(globalThis, 'BroadcastChannel');
    try {
      const prefix = 'bc3';
      const v = createVault({ prefix, slots: ['data'], minRounds: R }, browserEnvironment(prefix));
      await v.startVault();
      const off = v.onExternalChange(() => {});
      await v.startAnew();
      off();
    } finally {
      Object.assign(globalThis, { BroadcastChannel: saved });
    }
  });
});
