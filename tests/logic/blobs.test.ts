import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLOB_CHUNK,
  MAX_BLOB_CHUNK,
  blocksFor,
  checkChunkSize,
  chunkLength,
  chunkSlot,
  headFromBytes,
  headToBytes,
  isChunkKey,
  chunkKey,
} from '../../src/logic/blobs.ts';
import { isBlobName } from '../../src/logic/config.ts';

describe('blob blocks (pure)', () => {
  it('block sizes: whole numbers from 1 to the maximum', () => {
    expect(checkChunkSize(DEFAULT_BLOB_CHUNK)).toBe(true);
    expect(checkChunkSize(1)).toBe(true);
    expect(checkChunkSize(MAX_BLOB_CHUNK)).toBe(true);
    for (const bad of [0, -5, 1.5, MAX_BLOB_CHUNK + 1, '16', undefined, Infinity])
      expect(checkChunkSize(bad), String(bad)).toBe(false);
  });

  it('the authenticated data differs in name, write, index and count', () => {
    const base = chunkSlot('a', 'g', 1, 3);
    for (const other of [
      chunkSlot('b', 'g', 1, 3),
      chunkSlot('a', 'h', 1, 3),
      chunkSlot('a', 'g', 2, 3),
      chunkSlot('a', 'g', 1, 4),
    ])
      expect(other).not.toBe(base);
    expect(base.startsWith('blob:')).toBe(false); // never the data of an earlier one-piece blob
  });

  it('a block key is never a blob name', () => {
    expect(isChunkKey(chunkKey('a', '0123456789abcdef', 0))).toBe(true);
    expect(isBlobName(chunkKey('a', '0123456789abcdef', 0))).toBe(false);
  });

  it('block counts and lengths', () => {
    expect(blocksFor(0, 16)).toBe(0);
    expect(blocksFor(16, 16)).toBe(1);
    expect(blocksFor(17, 16)).toBe(2);
    const head = { gen: '0123456789abcdef', count: 2, size: 17, chunk: 16 };
    expect([chunkLength(head, 0), chunkLength(head, 1)]).toEqual([16, 1]);
  });

  it('a head reads back; anything inconsistent is refused', () => {
    const head = { gen: '0123456789abcdef', count: 2, size: 17, chunk: 16 };
    expect(headFromBytes(headToBytes(head))).toEqual(head);
    const text = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
    for (const bad of [
      { ...head, count: 3 },
      { ...head, gen: 'XYZ' },
      { ...head, size: -1, count: 0 },
      { ...head, chunk: 0 },
      { ...head, size: 1.5 },
      null,
      [],
      'x',
    ])
      expect(headFromBytes(text(bad)), JSON.stringify(bad)).toBeUndefined();
    expect(headFromBytes(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
    expect(headFromBytes(new TextEncoder().encode('not json'))).toBeUndefined();
  });
});
