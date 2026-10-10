/** Small helpers shared by card kinds. */

import type { Card } from "@vireo/protocol";

/** Parses a date the model wrote; undefined when it isn't one. */
export function parseDate(s: unknown): Date | undefined {
  if (typeof s !== "string" && typeof s !== "number") return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export function weekday(d: Date): string {
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

export function monthShort(d: Date): string {
  return d.toLocaleDateString(undefined, { month: "short" });
}

export function clock(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "Sat, Nov 14" from an ISO date; the text itself when it doesn't parse. */
export function dayLabel(s: string): string {
  const d = parseDate(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00` : s);
  return d ? d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" }) : s;
}

/** Minutes between two dates as "1 h 30 m". */
export function span(a: Date, b: Date): string {
  const m = Math.round((b.getTime() - a.getTime()) / 60000);
  if (m <= 0) return "";
  if (m < 60) return `${m} min`;
  return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} m` : `${m / 60} h`;
}

export function isHttp(url: unknown): url is string {
  return typeof url === "string" && /^https?:\/\//.test(url);
}

/** "in 25 min", "in 3 h", for a time ahead. */
export function until(d: Date): string {
  const m = Math.round((d.getTime() - Date.now()) / 60000);
  if (m <= 0) return "now";
  if (m < 60) return `in ${m} min`;
  if (m < 48 * 60) return `in ${Math.round(m / 60)} h`;
  return `in ${Math.round(m / 1440)} days`;
}

/** Reads a field of a card's data with a fallback, since the data comes from the model. */
export function field<T>(card: Card, key: string, fallback: T): T {
  const v = card.data[key];
  if (v === undefined || v === null) return fallback;
  if (Array.isArray(fallback) && !Array.isArray(v)) return fallback;
  if (typeof fallback === "string" && typeof v !== "string") return String(v) as T;
  if (typeof fallback === "number" && typeof v !== "number") return (Number(v) || fallback) as T;
  return v as T;
}
