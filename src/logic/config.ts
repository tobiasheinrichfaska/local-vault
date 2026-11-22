// The app's configuration of its vault: the name prefix and the slots. Every storage name the
// package uses (localStorage key, IndexedDB database, stored markers) starts with `<prefix>-`.
import type { VaultTexts } from './texts.ts';

export interface VaultConfig {
  /** Prefix of every browser store name, e.g. `app` gives `app-vault` and `app-<slot>`. */
  readonly prefix: string;
  /** Names of the slots that hold app data; each is encrypted on its own. */
  readonly slots: readonly string[];
  /** Replaces any of the English default texts. */
  readonly texts?: Partial<VaultTexts>;
}

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Throws for a prefix or slot name that is not lower-case words joined by hyphens, or for no/duplicate slots. */
export function validateConfig(config: VaultConfig): void {
  if (!NAME.test(config.prefix)) throw new Error(`Invalid vault prefix: "${config.prefix}"`);
  if (config.slots.length === 0) throw new Error('A vault needs at least one slot');
  const seen = new Set<string>();
  for (const slot of config.slots) {
    if (!NAME.test(slot)) throw new Error(`Invalid slot name: "${slot}"`);
    if (seen.has(slot)) throw new Error(`Duplicate slot name: "${slot}"`);
    seen.add(slot);
  }
}

/** The browser store name of a slot: `<prefix>-<slot>`. */
export const storageName = (prefix: string, slot: string): string => `${prefix}-${slot}`;

/** The name of the IndexedDB database. */
export const databaseName = (prefix: string): string => `${prefix}-vault`;

/** Whether a store name belongs to this vault. */
export const hasPrefix = (prefix: string, name: string): boolean => name.startsWith(`${prefix}-`);

const BLOB_NAME = /^[a-z0-9][a-z0-9._:/-]{0,199}$/;

/** Whether a name is allowed for a blob: lower case, digits and `. _ : / -`, up to 200 characters. */
export const isBlobName = (name: string): boolean => BLOB_NAME.test(name);
