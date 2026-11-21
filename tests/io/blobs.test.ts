// Blobs: encrypted bytes under free names (documents, blocks of a big state), next to the slots.
import { describe, expect, it } from 'vitest';
import { memoryEnvironment } from '../../src/io/environment.ts';
import { createVault } from '../../src/io/vault.ts';
import { isBlobName } from '../../src/logic/config.ts';

const P = 'app';
const make = (env = memoryEnvironment()) => createVault({ prefix: P, slots: ['data'] }, env);
const bytes = (...n: number[]) => new Uint8Array(n);

describe('blob names', () => {
  it('lower case, digits and . _ : / - only; no empty, upper case, spaces, too long', () => {
    for (const ok of ['a', 'datei:ab12', 'state:b:7', 'docs/2026/x.pdf', '0-1_2.3'])
      expect(isBlobName(ok), ok).toBe(true);
    for (const bad of ['', 'A', ' a', 'a b', '-a', ':a', 'a?b', 'ä', 'a'.repeat(201)])
      expect(isBlobName(bad), bad).toBe(false);
  });
});

describe('putBytes / getBytes', () => {
  it('what is put comes back after a restart, and is not stored in plain', async () => {
    const env = memoryEnvironment();
    const vault = make(env);
    await vault.startVault();
    const plain = new TextEncoder().encode('secret document body');
    await vault.putBytes('datei:abc', plain);
    const stored = env.blobs.get('datei:abc');
    expect(stored).toBeDefined();
    expect(new TextDecoder().decode(stored!.ct)).not.toContain('secret');
    const again = make(env);
    await again.startVault();
    expect(await again.getBytes('datei:abc')).toEqual(plain);
  });

  it('a missing blob is undefined; a replaced one gives the new bytes', async () => {
    const vault = make();
    await vault.startVault();
    expect(await vault.getBytes('nothing')).toBeUndefined();
    await vault.putBytes('x', bytes(1));
    await vault.putBytes('x', bytes(2, 3));
    expect(await vault.getBytes('x')).toEqual(bytes(2, 3));
  });

  it('big values and the empty value are kept exactly', async () => {
    const vault = make();
    await vault.startVault();
    const big = new Uint8Array(3_000_000).map((_, i) => i % 251);
    await vault.putBytes('big', big);
    await vault.putBytes('empty', new Uint8Array(0));
    // (not toEqual: a deep compare of millions of numbers is slow)
    expect(Buffer.from((await vault.getBytes('big'))!).equals(Buffer.from(big))).toBe(true);
    expect(await vault.getBytes('empty')).toEqual(new Uint8Array(0));
  });

  it('a piece swapped to another name does not open (bound to its name)', async () => {
    const env = memoryEnvironment();
    const vault = make(env);
    await vault.startVault();
    await vault.putBytes('a', bytes(1));
    await vault.putBytes('b', bytes(2));
    env.blobs.set('b', env.blobs.get('a')!);
    await expect(vault.getBytes('b')).rejects.toThrow(/could not be opened/);
  });

  it('a piece under another data key does not open and is not read as empty', async () => {
    const env = memoryEnvironment();
    const vault = make(env);
    await vault.startVault();
    await vault.putBytes('a', bytes(1));
    // another vault (its own device and data key) holding the same piece
    const envOther = memoryEnvironment();
    envOther.blobs.set('a', env.blobs.get('a')!);
    const foreign = make(envOther);
    await foreign.startVault();
    await expect(foreign.getBytes('a')).rejects.toThrow(/could not be opened/);
  });

  it('a slot and a blob of the same word are two things', async () => {
    const vault = make();
    await vault.startVault();
    vault.writeSlot('data', 'slot value');
    await vault.putBytes('data', bytes(9));
    await vault.saved();
    expect(vault.readSlot('data')).toBe('slot value');
    expect(await vault.getBytes('data')).toEqual(bytes(9));
  });

  it('refuses invalid names and, while closed, every call', async () => {
    const vault = make();
    await vault.startVault();
    await expect(vault.putBytes('Bad Name', bytes(1))).rejects.toThrow(/Invalid blob name/);
    const closed = make();
    await expect(closed.putBytes('a', bytes(1))).rejects.toThrow(/not open/);
    await expect(closed.getBytes('a')).rejects.toThrow(/not open/);
    await expect(closed.removeBytes('a')).rejects.toThrow(/not open/);
    await expect(closed.listBytes()).rejects.toThrow(/not open/);
  });

  it('a failing storage rejects with the reason (never silently lost)', async () => {
    const env = memoryEnvironment();
    env.writeBlob = async () => {
      throw new Error('quota');
    };
    const vault = make(env);
    await vault.startVault();
    await expect(vault.putBytes('a', bytes(1))).rejects.toThrow(/Not saved: quota/);
  });
});

describe('listBytes / removeBytes / saved / startAnew', () => {
  it('lists sorted, filters by start, and removes', async () => {
    const vault = make();
    await vault.startVault();
    await Promise.all(['datei:2', 'datei:1', 'state:b:1'].map((n) => vault.putBytes(n, bytes(1))));
    expect(await vault.listBytes()).toEqual(['datei:1', 'datei:2', 'state:b:1']);
    expect(await vault.listBytes('datei:')).toEqual(['datei:1', 'datei:2']);
    await vault.removeBytes('datei:1');
    expect(await vault.listBytes('datei:')).toEqual(['datei:2']);
    expect(await vault.getBytes('datei:1')).toBeUndefined();
  });

  it('saved() waits for blobs on their way', async () => {
    const env = memoryEnvironment();
    const slow = env.writeBlob;
    let done = false;
    env.writeBlob = async (n, p) => {
      await new Promise((r) => setTimeout(r, 20));
      await slow(n, p);
      done = true;
    };
    const vault = make(env);
    await vault.startVault();
    void vault.putBytes('a', bytes(1));
    await vault.saved();
    expect(done).toBe(true);
  });

  it('start anew removes the blobs (they would be unreadable under the new data key)', async () => {
    const env = memoryEnvironment();
    const vault = make(env);
    await vault.startVault();
    await vault.putBytes('a', bytes(1));
    await vault.startAnew();
    expect(env.blobs.size).toBe(0);
    expect(await vault.startVault()).toEqual({ kind: 'open' });
    expect(await vault.getBytes('a')).toBeUndefined();
  });

  it('lock on/off and a new password leave the blobs readable', async () => {
    const env = memoryEnvironment();
    const vault = make(env);
    await vault.startVault();
    await vault.putBytes('a', bytes(7));
    expect(await vault.setLock('Secret-2026', undefined, 1000)).toBeUndefined();
    const again = make(env);
    expect(await again.startVault()).toEqual({ kind: 'locked' });
    expect(await again.unlock('Secret-2026')).toEqual({ kind: 'open' });
    expect(await again.getBytes('a')).toEqual(bytes(7));
  });
});
