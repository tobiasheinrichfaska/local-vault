// Blobs in blocks: pure pieces (names of the stored records, the authenticated data of each, the head).
// A blob is one small *head* under its name plus `count` *blocks* under reserved keys. The head says
// which write (generation), how many blocks, how long and how big a block; the blocks hold the bytes.
//
// Every block is bound (AES-GCM additional data) to the blob name, the generation of its write, its
// index and the number of blocks — so a block left out, moved, cut off, taken from another blob or from
// an earlier write of the same name never opens. The head is bound to the name and sealed too.

/** 2 MiB: a few blocks in memory at a time, about 100 storage steps for 200 MB, far below the limits of one WebCrypto call. */
export const DEFAULT_BLOB_CHUNK = 2 * 1024 * 1024;
/** The largest block size a vault takes (a single WebCrypto call on a phone must stay well inside its limit). */
export const MAX_BLOB_CHUNK = 64 * 1024 * 1024;

/** Whether `size` is a block size the configuration takes: a whole number of bytes, 1 … `MAX_BLOB_CHUNK`. */
export const checkChunkSize = (size: unknown): size is number =>
  typeof size === 'number' && Number.isInteger(size) && size >= 1 && size <= MAX_BLOB_CHUNK;

/**
 * Block keys start with this character, which no blob name may start with (`isBlobName`), so a block
 * key never equals a blob name and sorts after every name.
 */
export const CHUNK_MARK = '~';

/** `v` of a head record: the stored format with blocks (a record without it is the old one-piece blob). */
export const HEAD_VERSION = 2;

/** The storage key of a block. */
export const chunkKey = (name: string, gen: string, index: number): string =>
  `${CHUNK_MARK}${name}#${gen}#${index}`;

/** What every block key of a blob starts with (any generation). */
export const chunkPrefix = (name: string): string => `${CHUNK_MARK}${name}#`;

/** Whether a storage key is a block key, not a blob name. */
export const isChunkKey = (key: string): boolean => key.startsWith(CHUNK_MARK);

/** Authenticated data of the old one-piece blob (still readable). */
export const legacySlot = (name: string): string => `blob:${name}`;
/** Authenticated data of a head. */
export const headSlot = (name: string): string => `blobhead:${name}`;
/** Authenticated data of a block: name, generation, index and number of blocks. */
export const chunkSlot = (name: string, gen: string, index: number, count: number): string =>
  `blobchunk:${name}|${gen}|${index}|${count}`;

/** What a head says (sealed): `size` is the plain length of the whole blob. */
export interface BlobHead {
  readonly gen: string;
  readonly count: number;
  readonly size: number;
  readonly chunk: number;
}

export const blocksFor = (size: number, chunk: number): number => Math.ceil(size / chunk);

export const newGeneration = (): string =>
  [...crypto.getRandomValues(new Uint8Array(8))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

export const headToBytes = (head: BlobHead): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({ gen: head.gen, count: head.count, size: head.size, chunk: head.chunk }),
  );

/** The head from its plain bytes; undefined for anything that is not a consistent head. */
export function headFromBytes(bytes: Uint8Array): BlobHead | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const { gen, count, size, chunk } = value as Record<string, unknown>;
  if (typeof gen !== 'string' || !/^[0-9a-f]{16}$/.test(gen)) return undefined;
  if (!Number.isSafeInteger(size) || (size as number) < 0) return undefined;
  if (!checkChunkSize(chunk)) return undefined;
  if (count !== blocksFor(size as number, chunk)) return undefined;
  return { gen, count: count as number, size: size as number, chunk };
}

/** The plain length block `index` must have. */
export const chunkLength = (head: BlobHead, index: number): number =>
  Math.min(head.chunk, head.size - index * head.chunk);
