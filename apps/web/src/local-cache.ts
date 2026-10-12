/**
 * What the app last saw (the owner's nodes, a token for the current one, its
 * threads and board), kept on this device so the next start shows it at once
 * and refreshes it behind. Cleared on sign-out.
 */

const PREFIX = "vireo.cache.";

export function cacheGet<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch {
    return undefined;
  }
}

export function cacheSet(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // Storage blocked or full: the next start loads everything again.
  }
}

export function cacheClear(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch {
    // Storage blocked: nothing was kept.
  }
}
