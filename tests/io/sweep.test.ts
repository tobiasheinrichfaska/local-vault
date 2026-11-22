// `sweepBlobs`: blocks that belong to no head (an interrupted write) are removed; blocks of a valid
// head and of a write in progress never are. Against memory and against IndexedDB.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  browserEnvironment,
  memoryEnvironment,
  type VaultEnvironment,
} from '../../src/io/environment.ts';
import { createVault, type Vault } from '../../src/io/vault.ts';
import { HEAD_VERSION, chunkKey, chunkPrefix } from '../../src/logic/blobs.ts';

const ls = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => void ls.set(k, v),
    removeItem: (k: string) => void ls.delete(k),
  },
});

const CHUNK = 16;
let n = 0;
interface Case {
  readonly prefix: string;
  readonly env: VaultEnvironment;
}
const cases: [string, () => Case][] = [
  ['memory', () => ({ prefix: 'app', env: memoryEnvironment() })],
  [
    'indexeddb',
    () => {
      const prefix = `sw${++n}`;
      return { prefix, env: browserEnvironment(prefix) };
    },
  ],
];
const data = (size: number, seed = 1) => new Uint8Array(size).map((_, i) => (i * 7 + seed) % 251);
const same = (a: Uint8Array | undefined, b: Uint8Array) =>
  a !== undefined && Buffer.from(a).equals(Buffer.from(b));
const junk = { iv: new Uint8Array(12), ct: new Uint8Array(20) };
const GEN_OLD = '0123456789abcdef';
const GEN_OTHER = 'fedcba9876543210';

describe.each(cases)('sweepBlobs (%s)', (_label, makeCase) => {
  let c: Case;
  let vault: Vault;
  const make = (env: VaultEnvironment = c.env) =>
    createVault({ prefix: c.prefix, slots: [], minRounds: 1000, blobChunkSize: CHUNK }, env);
  const blockKeys = () => c.env.listBlobKeys('~');
  beforeEach(async () => {
    c = makeCase();
    vault = make();
    await vault.startVault();
  });

  it('removes blocks that have no head, and says how many', async () => {
    await c.env.writeBlob(chunkKey('lost', GEN_OLD, 0), junk);
    await c.env.writeBlob(chunkKey('lost', GEN_OLD, 1), junk);
    await c.env.writeBlob(chunkKey('other', GEN_OTHER, 0), junk);
    expect(await vault.sweepBlobs()).toEqual({ removed: 3 });
    expect(await blockKeys()).toEqual([]);
    expect(await vault.sweepBlobs()).toEqual({ removed: 0 });
  });

  it('keeps the blocks of every valid head, removes leftovers of other generations of the same name', async () => {
    const a = data(3 * CHUNK + 2, 1);
    const b = data(CHUNK, 2);
    await vault.putBytes('a', a);
    await vault.putBytes('b', b);
    const good = await blockKeys();
    await c.env.writeBlob(chunkKey('a', GEN_OLD, 0), junk);
    await c.env.writeBlob(chunkKey('b', GEN_OTHER, 3), junk);
    expect(await vault.sweepBlobs()).toEqual({ removed: 2 });
    expect(await blockKeys()).toEqual(good);
    expect(same(await vault.getBytes('a'), a)).toBe(true);
    expect(same(await vault.getBytes('b'), b)).toBe(true);
  });

  it('blocks of a name whose blob is of the earlier one-piece format are leftovers; the blob stays', async () => {
    await c.env.writeBlob('old', junk);
    await c.env.writeBlob(chunkKey('old', GEN_OLD, 0), junk);
    expect(await vault.sweepBlobs()).toEqual({ removed: 1 });
    expect(await c.env.readBlob('old')).toEqual(junk);
  });

  it('a head that cannot be opened keeps its blocks (never guess against what could be data)', async () => {
    await c.env.writeBlob('odd', { v: HEAD_VERSION, ...junk });
    await c.env.writeBlob(chunkKey('odd', GEN_OLD, 0), junk);
    await c.env.writeBlob('future', { v: 99, ...junk });
    await c.env.writeBlob(chunkKey('future', GEN_OLD, 0), junk);
    expect(await vault.sweepBlobs()).toEqual({ removed: 0 });
    expect((await blockKeys()).length).toBe(2);
  });

  it('keys it does not know the shape of are left alone', async () => {
    await c.env.writeBlob('~x', junk);
    await c.env.writeBlob('~y#nothex#0', junk);
    await c.env.writeBlob(chunkKey('lost', GEN_OLD, 0), junk);
    expect(await vault.sweepBlobs()).toEqual({ removed: 1 });
    expect(await blockKeys()).toEqual(['~x', '~y#nothex#0']);
  });

  it('cleans up after a write that was cut off (blocks written, no head, no clean-up)', async () => {
    const old = data(2 * CHUNK, 3);
    await vault.putBytes('x', old);
    const cut = Object.create(c.env) as VaultEnvironment;
    let writes = 0;
    cut.writeBlob = async (k, r) => {
      if (++writes === 4) throw new Error('tab closed'); // the head of a 3-block write
      return c.env.writeBlob(k, r);
    };
    cut.removeBlobs = async () => {
      throw new Error('tab closed');
    };
    const dying = make(cut);
    await dying.startVault();
    await expect(dying.putBytes('x', data(3 * CHUNK, 9))).rejects.toThrow();
    await expect(dying.putBytes('fresh', data(CHUNK, 5))).resolves.toBeUndefined(); // writes 5, 6 …
    expect((await c.env.listBlobKeys(chunkPrefix('x'))).length).toBe(5); // 2 old + 3 cut off
    expect(await vault.sweepBlobs()).toEqual({ removed: 3 });
    expect((await c.env.listBlobKeys(chunkPrefix('x'))).length).toBe(2);
    expect(same(await vault.getBytes('x'), old)).toBe(true);
    expect(same(await vault.getBytes('fresh'), data(CHUNK, 5))).toBe(true);
  });

  it('never damages a write in progress of this instance (the sweep waits for it)', async () => {
    const big = data(6 * CHUNK + 3, 4);
    let sweep: Promise<{ removed: number }> | undefined;
    const env = Object.create(c.env) as VaultEnvironment;
    let writes = 0;
    env.writeBlob = async (k, r) => {
      if (++writes === 3) {
        sweep = vault.sweepBlobs(); // in the middle: blocks written, no head yet
        await new Promise((r) => setTimeout(r, 20));
      }
      return c.env.writeBlob(k, r);
    };
    const w = make(env);
    await w.startVault();
    await w.putBytes('big', big);
    expect(await sweep).toEqual({ removed: 0 });
    expect(same(await vault.getBytes('big'), big)).toBe(true);
    expect((await blockKeys()).length).toBe(7);
  });

  it('never damages a write in progress of another instance on the same storage', async () => {
    const big = data(5 * CHUNK, 6);
    let sweep: Promise<{ removed: number }> | undefined;
    const other = make();
    await other.startVault();
    const env = Object.create(c.env) as VaultEnvironment;
    let writes = 0;
    env.writeBlob = async (k, r) => {
      if (++writes === 3) {
        sweep = other.sweepBlobs();
        await new Promise((r) => setTimeout(r, 20));
      }
      return c.env.writeBlob(k, r);
    };
    const w = make(env);
    await w.startVault();
    await w.putBytes('big', big);
    expect(await sweep).toEqual({ removed: 0 });
    expect(same(await other.getBytes('big'), big)).toBe(true);
  });

  it('a write started while the sweep runs waits for it and is whole afterwards', async () => {
    await c.env.writeBlob(chunkKey('lost', GEN_OLD, 0), junk);
    const sweep = vault.sweepBlobs();
    const put = vault.putBytes('late', data(3 * CHUNK, 7));
    expect(await sweep).toEqual({ removed: 1 });
    await put;
    expect(same(await vault.getBytes('late'), data(3 * CHUNK, 7))).toBe(true);
  });

  it('close waits for a sweep on its way', async () => {
    await c.env.writeBlob(chunkKey('lost', GEN_OLD, 0), junk);
    const sweep = vault.sweepBlobs();
    await vault.close();
    expect(await sweep).toEqual({ removed: 1 });
    expect(await blockKeys()).toEqual([]);
  });

  it('is refused while the vault is closed', async () => {
    await vault.close();
    await expect(vault.sweepBlobs()).rejects.toThrow(/not open/i);
  });

  it('works for a vault without slots in users mode', async () => {
    const fresh = makeCase(); // a storage of its own: a vault of the other mode would leave its bundle
    const users = createVault(
      { prefix: fresh.prefix, slots: [], mode: 'users', minRounds: 1000, blobChunkSize: CHUNK },
      fresh.env,
    );
    await users.startVault();
    await users.setupFirstUser('anna', 'Annas Passphrase', 1000);
    await users.putBytes('d', data(2 * CHUNK));
    await fresh.env.writeBlob(chunkKey('d', GEN_OLD, 0), junk);
    expect(await users.sweepBlobs()).toEqual({ removed: 1 });
    expect(same(await users.getBytes('d'), data(2 * CHUNK))).toBe(true);
  });
});

describe('the lock around blob writes in the browser environment', () => {
  it('uses the Web Lock of the prefix when the browser has one: shared for writes, exclusive for the sweep', async () => {
    const calls: { name: string; mode: string }[] = [];
    const locks = {
      request: async (name: string, options: { mode: string }, work: () => Promise<unknown>) => {
        calls.push({ name, mode: options.mode });
        return work();
      },
    };
    Object.defineProperty(globalThis.navigator, 'locks', { value: locks, configurable: true });
    try {
      const prefix = `sw${++n}`;
      const v = createVault({ prefix, slots: [], minRounds: 1000 }, browserEnvironment(prefix));
      await v.startVault();
      await v.putBytes('a', data(4));
      await v.sweepBlobs();
      expect(calls).toEqual([
        { name: `${prefix}-vault-blobs`, mode: 'shared' },
        { name: `${prefix}-vault-blobs`, mode: 'exclusive' },
      ]);
    } finally {
      Reflect.deleteProperty(globalThis.navigator, 'locks');
    }
  });
});
