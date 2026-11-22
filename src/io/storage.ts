// The browser's storage as a whole: how much room is left, whether it may be cleared, and whether a
// failed write was a full storage. All of it works without `navigator.storage` (older browsers,
// insecure pages, tests): the answers are then "unknown" / false, never a throw.

/** What `navigator.storage.estimate()` says, in bytes (either may be unknown). */
export interface StorageEstimate {
  readonly usage?: number | undefined;
  readonly quota?: number | undefined;
}

/** The part of `navigator` the helpers use; tests pass a stand-in. */
export interface StorageNavigator {
  readonly storage?: {
    estimate?: () => Promise<StorageEstimate>;
    persist?: () => Promise<boolean>;
  };
}

const defaultNavigator = (): StorageNavigator | undefined =>
  typeof navigator === 'undefined' ? undefined : (navigator as StorageNavigator);

/** Used and available bytes of the whole origin (all apps of this site together); undefined when the browser cannot say. */
export async function storageEstimate(
  nav: StorageNavigator | undefined = defaultNavigator(),
): Promise<StorageEstimate | undefined> {
  const estimate = nav?.storage?.estimate;
  if (typeof estimate !== 'function') return undefined;
  try {
    const { usage, quota } = await estimate.call(nav?.storage);
    return { usage, quota };
  } catch {
    return undefined;
  }
}

/**
 * Asks the browser to keep this site's data (not to clear it under storage pressure; Safari's
 * 7-days rule is another matter). `true` when it is granted, `false` when refused or not available.
 */
export async function requestPersistence(
  nav: StorageNavigator | undefined = defaultNavigator(),
): Promise<boolean> {
  const persist = nav?.storage?.persist;
  if (typeof persist !== 'function') return false;
  try {
    return (await persist.call(nav?.storage)) === true;
  } catch {
    return false;
  }
}

/** Whether a failed write (an error from `putBytes`, or the browser's own) means the storage is full. */
export function isQuotaError(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && depth < 5; depth++) {
    const named = e as { name?: unknown; cause?: unknown };
    if (named.name === 'QuotaExceededError') return true;
    e = named.cause;
  }
  return false;
}
