import { api, type ThreadDetail } from "./api";

/** How many threads stay at hand, newest first. */
const KEEP = 24;
/** A prefetch skips a thread loaded this recently. */
const FRESH = 10_000;

const cache = new Map<string, { detail: ThreadDetail; at: number }>();
const inflight = new Map<string, Promise<void>>();

/**
 * The last loaded state of recently seen threads, so opening one again (or
 * one the pointer rested on) shows it at once while a fresh copy loads.
 */
export function cachedThread(id: string): ThreadDetail | null {
  return cache.get(id)?.detail ?? null;
}

export function rememberThread(detail: ThreadDetail): void {
  const id = detail.thread.id;
  cache.delete(id);
  cache.set(id, { detail, at: Date.now() });
  while (cache.size > KEEP) cache.delete(cache.keys().next().value!);
}

export function forgetThread(id: string): void {
  cache.delete(id);
}

/** Loads a thread ahead of being opened, at most once at a time and not when it is fresh. */
export function prefetchThread(id: string): void {
  const hit = cache.get(id);
  if ((hit && Date.now() - hit.at < FRESH) || inflight.has(id)) return;
  const p = api
    .get<ThreadDetail>(`/api/threads/${id}`)
    .then(rememberThread, () => undefined)
    .finally(() => inflight.delete(id));
  inflight.set(id, p);
}

export function clearThreadCache(): void {
  cache.clear();
}
