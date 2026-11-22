// Blobs in blocks: round trips, manipulation, atomic writes, the old one-piece format, cleaning up —
// against the memory environment and against an IndexedDB (fake-indexeddb).
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  browserEnvironment,
  memoryEnvironment,
  type VaultEnvironment,
} from '../../src/io/environment.ts';
import { createVault, type Vault } from '../../src/io/vault.ts';
import { isBlobName } from '../../src/logic/config.ts';
import {
  DEFAULT_BLOB_CHUNK,
  HEAD_VERSION,
  chunkKey,
  chunkPrefix,
  chunkSlot,
  headSlot,
  headToBytes,
} from '../../src/logic/blobs.ts';
import { openBundle, open as openPiece, seal as sealPiece } from '../../src/logic/vault.ts';
import { isQuotaError } from '../../src/io/storage.ts';

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
      const prefix = `cb${++n}`;
      return { prefix, env: browserEnvironment(prefix) };
    },
  ],
];

const data = (size: number, seed = 1) => new Uint8Array(size).map((_, i) => (i * 7 + seed) % 251);
const same = (a: Uint8Array | undefined, b: Uint8Array) =>
  a !== undefined && Buffer.from(a).equals(Buffer.from(b));
const kinds = 'x'; // blob name used throughout

describe.each(cases)('blocks (%s)', (_label, makeCase) => {
  let c: Case;
  let vault: Vault;
  const make = (env = c.env, blobChunkSize: number | undefined = CHUNK) =>
    createVault({ prefix: c.prefix, slots: ['data'], minRounds: 1000, blobChunkSize }, env);
  const keys = (prefix = '') => c.env.listBlobKeys(prefix);
  const chunkKeys = (name = kinds) => keys(chunkPrefix(name));
  const snapshot = async () => {
    const out: string[] = [];
    for (const k of await keys()) {
      const r = (await c.env.readBlob(k))!;
      out.push(
        `${k}|${Buffer.from(r.iv).toString('hex')}|${Buffer.from(r.ct).toString('hex')}|${r.v}`,
      );
    }
    return out;
  };
  beforeEach(async () => {
    c = makeCase();
    vault = make();
    await vault.startVault();
  });

  describe('round trip', () => {
    const sizes = [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 2 * CHUNK, 3 * CHUNK + 5, 1000];
    it.each(sizes)('size %i comes back exactly, also after a restart', async (size) => {
      const plain = data(size);
      await vault.putBytes(kinds, plain);
      expect(same(await vault.getBytes(kinds), plain)).toBe(true);
      const again = make();
      await again.startVault();
      expect(same(await again.getBytes(kinds), plain)).toBe(true);
      expect(await again.listBytesInfo()).toEqual([{ name: kinds, size }]);
      expect(await again.listBytes()).toEqual([kinds]);
      expect((await chunkKeys()).length).toBe(Math.ceil(size / CHUNK));
    });

    it('stores no record bigger than a block (plus IV is separate, plus tag) and nothing in plain', async () => {
      const plain = new TextEncoder().encode('secret document body '.repeat(10));
      await vault.putBytes(kinds, plain);
      for (const k of await keys()) {
        const r = (await c.env.readBlob(k))!;
        expect(r.ct.byteLength).toBeLessThanOrEqual(k === kinds ? 128 : CHUNK + 16); // the head is a small JSON
        expect(new TextDecoder().decode(r.ct)).not.toContain('secret');
      }
    });

    it('every block has its own IV', async () => {
      await vault.putBytes(kinds, data(5 * CHUNK));
      const ivs = new Set<string>();
      for (const k of await keys())
        ivs.add(Buffer.from((await c.env.readBlob(k))!.iv).toString('hex'));
      expect(ivs.size).toBe(6); // head + five blocks
    });

    it('the default block size is 2 MiB and a block size outside 1 … 64 MiB is refused', () => {
      expect(DEFAULT_BLOB_CHUNK).toBe(2 * 1024 * 1024);
      for (const bad of [0, -1, 1.5, 65 * 1024 * 1024, NaN])
        expect(() => make(c.env, bad), String(bad)).toThrow(/blobChunkSize/);
      expect(() => make(c.env, undefined)).not.toThrow();
    });

    it('a blob written with other block size reads under any configuration', async () => {
      const plain = data(100);
      await vault.putBytes(kinds, plain);
      const other = make(c.env, 7);
      await other.startVault();
      expect(same(await other.getBytes(kinds), plain)).toBe(true);
    });
  });

  describe('names', () => {
    it('block keys are no blob names; blocks and heads of orphans never show as blobs', async () => {
      await vault.putBytes(kinds, data(40));
      for (const k of await chunkKeys()) expect(isBlobName(k), k).toBe(false);
      await c.env.writeBlob('~y#0123456789abcdef#0', {
        iv: new Uint8Array(12),
        ct: new Uint8Array(20),
      });
      expect(await vault.listBytes()).toEqual([kinds]);
      expect(await vault.listBytesInfo()).toEqual([{ name: kinds, size: 40 }]);
      expect(isBlobName('~a#b#0')).toBe(false);
    });

    it('removeBytes removes head and blocks, also blocks of an earlier crashed write', async () => {
      await vault.putBytes(kinds, data(40));
      await c.env.writeBlob(`~${kinds}#aaaaaaaaaaaaaaaa#0`, {
        iv: new Uint8Array(12),
        ct: new Uint8Array(20),
      });
      await c.env.writeBlob('~xy#aaaaaaaaaaaaaaaa#0', {
        iv: new Uint8Array(12),
        ct: new Uint8Array(20),
      });
      await vault.removeBytes(kinds);
      expect(await vault.getBytes(kinds)).toBeUndefined();
      expect(await keys()).toEqual(['~xy#aaaaaaaaaaaaaaaa#0']); // the other blob's key is not touched
    });
  });

  describe('manipulation: nothing opens, nothing is overwritten', () => {
    const put4 = async () => {
      const plain = data(4 * CHUNK - 3);
      await vault.putBytes(kinds, plain);
      return plain;
    };
    const rejects = async (label: string) => {
      const before = await snapshot();
      await expect(vault.getBytes(kinds), label).rejects.toThrow(/could not be opened/);
      expect(await snapshot(), `${label}: nothing changed`).toEqual(before);
      await expect(
        (async () => {
          for await (const _ of vault.getBytesChunks(kinds));
        })(),
        label + ' (chunks)',
      ).rejects.toThrow(/could not be opened/);
    };

    it('a block left out', async () => {
      await put4();
      const ks = await chunkKeys();
      await c.env.removeBlob(ks[1]!);
      await rejects('left out');
    });

    it('the last block cut off', async () => {
      await put4();
      const ks = await chunkKeys();
      await c.env.removeBlob(ks[3]!);
      await rejects('cut off');
    });

    it('two blocks swapped', async () => {
      await put4();
      const [k0, k1] = await chunkKeys();
      const r0 = (await c.env.readBlob(k0!))!;
      const r1 = (await c.env.readBlob(k1!))!;
      await c.env.writeBlob(k0!, r1);
      await c.env.writeBlob(k1!, r0);
      await rejects('swapped');
    });

    it('a block of another blob (same size, same position) put in', async () => {
      await put4();
      await vault.putBytes('y', data(4 * CHUNK - 3, 9));
      const [kx] = await chunkKeys();
      const [ky] = await chunkKeys('y');
      await c.env.writeBlob(kx!, (await c.env.readBlob(ky!))!);
      await rejects('other blob');
    });

    it('a block of an earlier write of the same name (same size) put in', async () => {
      await put4();
      const old = new Map<string, Awaited<ReturnType<typeof c.env.readBlob>>>();
      for (const k of await chunkKeys()) old.set(k, await c.env.readBlob(k));
      await vault.putBytes(kinds, data(4 * CHUNK - 3, 5)); // new generation, same count
      const fresh = await chunkKeys();
      expect(fresh.some((k) => old.has(k))).toBe(false);
      await c.env.writeBlob(fresh[2]!, [...old.values()][2]!);
      await rejects('earlier write');
    });

    it('a block of an earlier write with another number of blocks (3 → 2) put in', async () => {
      await vault.putBytes(kinds, data(3 * CHUNK));
      const old = (await c.env.readBlob((await chunkKeys())[0]!))!;
      await vault.putBytes(kinds, data(2 * CHUNK, 4));
      await c.env.writeBlob((await chunkKeys())[1]!, old);
      await rejects('3 to 2');
    });

    it('a head of another blob under this name', async () => {
      await put4();
      await vault.putBytes('y', data(4 * CHUNK - 3));
      await c.env.writeBlob(kinds, (await c.env.readBlob('y'))!);
      await rejects('other head');
    });

    it('a changed byte in a block or in the head', async () => {
      await put4();
      for (const k of [(await chunkKeys())[2]!, kinds]) {
        const r = (await c.env.readBlob(k))!;
        const ct = new Uint8Array(r.ct);
        ct[0] = ct[0]! ^ 1;
        await c.env.writeBlob(k, { ...r, ct });
        await rejects(`changed ${k}`);
        await c.env.writeBlob(k, r);
      }
      expect(same(await vault.getBytes(kinds), data(4 * CHUNK - 3))).toBe(true);
    });

    it('leftovers of an old write (other generation, any index) never take part in a read', async () => {
      const plain = await put4();
      const some = (await c.env.readBlob((await chunkKeys())[0]!))!;
      await c.env.writeBlob(`~${kinds}#bbbbbbbbbbbbbbbb#0`, some);
      await c.env.writeBlob(`~${kinds}#bbbbbbbbbbbbbbbb#9`, some);
      expect(same(await vault.getBytes(kinds), plain)).toBe(true);
      await vault.putBytes(kinds, data(10)); // the next write sweeps them
      expect((await chunkKeys()).length).toBe(1);
    });

    it('a blob of another vault (other data key) does not open', async () => {
      await put4();
      const other = Object.assign(memoryEnvironment(), {});
      for (const k of await keys()) await other.writeBlob(k, (await c.env.readBlob(k))!);
      const foreign = createVault({ prefix: c.prefix, slots: ['data'], minRounds: 1000 }, other);
      await foreign.startVault();
      await expect(foreign.getBytes(kinds)).rejects.toThrow(/could not be opened/);
    });

    it('the head is no valid one-piece blob for the old code: it does not open as `blob:<name>`', async () => {
      await put4();
      const head = (await c.env.readBlob(kinds))!;
      const key = await openBundle(
        c.prefix,
        await c.env.deviceKey(),
        (await c.env.readBundle()) as never,
      );
      expect(await openPiece(c.prefix, key as CryptoKey, `blob:${kinds}`, head)).toBeUndefined();
    });
  });

  describe('forged by a holder of the data key: every binding stands on its own', () => {
    // Honest writes never meet these cases (a fresh random write id per write); they prove that the
    // name, the count, the length and the format version are each checked and not only implied.
    const dataKey = async () =>
      (await openBundle(
        c.prefix,
        await c.env.deviceKey(),
        (await c.env.readBundle()) as never,
      )) as CryptoKey;
    const sealHead = async (
      name: string,
      gen: string,
      count: number,
      size: number,
      v = HEAD_VERSION,
    ) => {
      const sealed = await sealPiece(
        c.prefix,
        await dataKey(),
        headSlot(name),
        headToBytes({ gen, count, size, chunk: CHUNK }),
      );
      await c.env.writeBlob(name, { v, iv: sealed.iv, ct: sealed.ct });
    };
    const gen = 'abcdef0123456789';

    it('a head claiming fewer blocks over genuine blocks (count is bound)', async () => {
      await vault.putBytes(kinds, data(4 * CHUNK));
      const real = await chunkKeys();
      const oldGen = real[0]!.split('#')[1]!;
      await sealHead(kinds, oldGen, 2, 2 * CHUNK); // truncation by a forged head
      await expect(vault.getBytes(kinds)).rejects.toThrow(/could not be opened/);
    });

    it('blocks and head of one blob copied under another name (name is bound)', async () => {
      await vault.putBytes(kinds, data(2 * CHUNK));
      const real = await chunkKeys();
      const g = real[0]!.split('#')[1]!;
      for (const [i, k] of real.entries())
        await c.env.writeBlob(chunkKey('y', g, i), (await c.env.readBlob(k))!);
      await sealHead('y', g, 2, 2 * CHUNK);
      await expect(vault.getBytes('y')).rejects.toThrow(/could not be opened/);
      await expect(vault.getBytes(kinds)).resolves.toBeDefined();
    });

    it('the head of an empty blob under another name (the head is bound to its name)', async () => {
      await vault.putBytes(kinds, new Uint8Array(0));
      await c.env.writeBlob('y', (await c.env.readBlob(kinds))!);
      await expect(vault.getBytes('y')).rejects.toThrow(/could not be opened/);
    });

    it('a block of the wrong length, sealed correctly', async () => {
      await vault.putBytes(kinds, data(2 * CHUNK));
      const g = (await chunkKeys())[0]!.split('#')[1]!;
      const short = await sealPiece(
        c.prefix,
        await dataKey(),
        chunkSlot(kinds, g, 1, 2),
        data(CHUNK - 1),
      );
      await c.env.writeBlob(chunkKey(kinds, g, 1), short);
      await expect(vault.getBytes(kinds)).rejects.toThrow(/could not be opened/);
    });

    it('a head of an unknown format version does not open', async () => {
      await vault.putBytes(kinds, data(CHUNK));
      const g = (await chunkKeys())[0]!.split('#')[1]!;
      await sealHead(kinds, g, 1, CHUNK, 3);
      await expect(vault.getBytes(kinds)).rejects.toThrow(/could not be opened/);
    });

    it('a head with inconsistent numbers (count does not fit the size) does not open', async () => {
      await sealHead(kinds, gen, 5, CHUNK);
      await expect(vault.getBytes(kinds)).rejects.toThrow(/could not be opened/);
    });
  });

  describe('atomic write', () => {
    const failOn = (nth: number, what: 'chunk' | 'any' = 'any'): VaultEnvironment => {
      let count = 0;
      const env = Object.create(c.env) as VaultEnvironment;
      env.writeBlob = async (k, r) => {
        count++;
        if (count === nth) throw new DOMException('full', 'QuotaExceededError');
        return c.env.writeBlob(k, r);
      };
      void what;
      return env;
    };

    it.each([1, 2, 3, 4, 5])(
      'a failure at write %i leaves the old blob readable and no blocks behind',
      async (nth) => {
        const old = data(3 * CHUNK + 1, 2); // 4 blocks + head = 5 writes in the new one below
        await vault.putBytes(kinds, old);
        const before = await snapshot();
        const failing = make(failOn(nth));
        await failing.startVault();
        const error = await failing.putBytes(kinds, data(4 * CHUNK, 8)).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(error, 'rejected').toBeDefined();
        expect(isQuotaError(error)).toBe(true);
        expect(await snapshot()).toEqual(before);
        expect(same(await vault.getBytes(kinds), old)).toBe(true);
      },
    );

    it('a failure of a first write leaves nothing: no head, no blocks', async () => {
      const failing = make(failOn(3));
      await failing.startVault();
      await expect(failing.putBytes(kinds, data(5 * CHUNK))).rejects.toThrow(/Not saved/);
      expect(await keys()).toEqual([]);
      expect(await vault.listBytes()).toEqual([]);
      expect(await vault.getBytes(kinds)).toBeUndefined();
    });

    it('while writing, the old content stays readable until the head is switched', async () => {
      const old = data(3 * CHUNK);
      await vault.putBytes(kinds, old);
      let seen: Uint8Array | undefined;
      const env = Object.create(c.env) as VaultEnvironment;
      let writes = 0;
      env.writeBlob = async (k, r) => {
        if (++writes === 3) seen = await vault.getBytes(kinds); // in the middle of the new write
        return c.env.writeBlob(k, r);
      };
      const w = make(env);
      await w.startVault();
      await w.putBytes(kinds, data(4 * CHUNK, 3));
      expect(same(seen, old)).toBe(true);
      expect(same(await vault.getBytes(kinds), data(4 * CHUNK, 3))).toBe(true);
    });

    it('overwriting 3 blocks by 2 leaves exactly 2 blocks and the new content', async () => {
      await vault.putBytes(kinds, data(3 * CHUNK));
      await vault.putBytes(kinds, data(2 * CHUNK, 6));
      expect((await chunkKeys()).length).toBe(2);
      expect(same(await vault.getBytes(kinds), data(2 * CHUNK, 6))).toBe(true);
    });

    it('a failing clean-up of the old blocks does not fail the write; the next write sweeps', async () => {
      await vault.putBytes(kinds, data(3 * CHUNK));
      const env = Object.create(c.env) as VaultEnvironment;
      env.removeBlobs = async () => {
        throw new Error('nope');
      };
      const w = make(env);
      await w.startVault();
      await w.putBytes(kinds, data(CHUNK + 1, 3));
      expect(same(await vault.getBytes(kinds), data(CHUNK + 1, 3))).toBe(true);
      expect((await chunkKeys()).length).toBe(5); // 3 old + 2 new
      await vault.putBytes(kinds, data(5, 1));
      expect((await chunkKeys()).length).toBe(1);
    });

    it('two writes to one name at once: one of them wins whole, no mixture, no leftovers', async () => {
      const a = data(3 * CHUNK, 1);
      const b = data(5 * CHUNK + 2, 2);
      await Promise.all([vault.putBytes(kinds, a), vault.putBytes(kinds, b)]);
      const got = await vault.getBytes(kinds);
      expect(same(got, a) || same(got, b)).toBe(true);
      expect((await chunkKeys()).length).toBe(Math.ceil(got!.length / CHUNK));
    });

    it('saved() waits for a write in blocks', async () => {
      void vault.putBytes(kinds, data(5 * CHUNK));
      await vault.saved();
      expect((await chunkKeys()).length).toBe(5);
    });
  });

  describe('one-piece blobs of the earlier format', () => {
    const putLegacy = async (name: string, plain: Uint8Array) => {
      const key = (await openBundle(
        c.prefix,
        await c.env.deviceKey(),
        (await c.env.readBundle()) as never,
      )) as CryptoKey;
      const piece = await sealPiece(c.prefix, key, `blob:${name}`, plain);
      await c.env.writeBlob(name, { iv: piece.iv, ct: piece.ct });
    };

    it('reads, lists with the plain size, streams as one block, and is replaced by the new format', async () => {
      await vault.putBytes('other', data(3));
      const plain = data(100, 4);
      await putLegacy(kinds, plain);
      expect(same(await vault.getBytes(kinds), plain)).toBe(true);
      expect(await vault.listBytesInfo()).toEqual([
        { name: 'other', size: 3 },
        { name: kinds, size: 100 },
      ]);
      const parts: Uint8Array[] = [];
      for await (const p of vault.getBytesChunks(kinds)) parts.push(p);
      expect(parts.length).toBe(1);
      expect(same(parts[0], plain)).toBe(true);
      await vault.putBytes(kinds, data(50, 7));
      expect((await c.env.readBlob(kinds))!.v).toBe(2);
      expect((await chunkKeys()).length).toBe(4);
      expect(same(await vault.getBytes(kinds), data(50, 7))).toBe(true);
    });

    it('a changed legacy piece still does not open; removing and start anew clear it', async () => {
      await putLegacy(kinds, data(10));
      await vault.removeBytes(kinds);
      expect(await keys()).toEqual([]);
      await putLegacy(kinds, data(10));
      await vault.startAnew();
      expect(await keys()).toEqual([]);
    });
  });

  describe('reading in blocks', () => {
    it('getBytesChunks gives the blocks in order, each at most a block, together the blob', async () => {
      const plain = data(3 * CHUNK + 4);
      await vault.putBytes(kinds, plain);
      const parts: Uint8Array[] = [];
      for await (const p of vault.getBytesChunks(kinds)) parts.push(p);
      expect(parts.map((p) => p.length)).toEqual([CHUNK, CHUNK, CHUNK, 4]);
      expect(same(Buffer.concat(parts) as unknown as Uint8Array, plain)).toBe(true);
    });

    it('an empty blob gives no block; a missing blob gives none either', async () => {
      await vault.putBytes(kinds, new Uint8Array(0));
      const parts: Uint8Array[] = [];
      for await (const p of vault.getBytesChunks(kinds)) parts.push(p);
      for await (const p of vault.getBytesChunks('missing')) parts.push(p);
      expect(parts).toEqual([]);
    });
  });

  describe('start anew', () => {
    it('removes every block, orphans included', async () => {
      await vault.putBytes(kinds, data(5 * CHUNK));
      await vault.putBytes('y', data(40));
      await c.env.writeBlob('~z#aaaaaaaaaaaaaaaa#3', {
        iv: new Uint8Array(12),
        ct: new Uint8Array(20),
      });
      await vault.startAnew();
      expect(await keys()).toEqual([]);
      expect(await vault.startVault()).toEqual({ kind: 'open' });
      expect(await vault.getBytes(kinds)).toBeUndefined();
    });
  });
});
