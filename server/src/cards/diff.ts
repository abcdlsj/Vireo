/** One fact on a card that changed, said the way the owner would read it. */
export interface CardChange {
  label: string;
  from: string;
  to: string;
}

type Json = unknown;

/** Scalar leaves of a card's data, keyed by path, each with the label it is shown under. */
function leaves(data: Json, path = "", context = "", out = new Map<string, { label: string; value: string }>()) {
  if (data === null || data === undefined) return out;
  if (Array.isArray(data)) {
    data.forEach((v, i) => leaves(v, `${path}/${i}`, context, out));
    return out;
  }
  if (typeof data === "object") {
    const o = data as Record<string, Json>;
    // An item names itself by its label, title or name ("Return", "Hotel The Celestine").
    const own = [o.label, o.title, o.name].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    for (const [k, v] of Object.entries(o)) {
      const key = k.replace(/_/g, " ");
      const here = own && !["label", "title", "name"].includes(k) ? own : context ? `${context} ${key}` : key;
      leaves(v, `${path}/${k}`, typeof v === "object" ? (own ?? (context ? `${context} ${key}` : key)) : here, out);
    }
    return out;
  }
  out.set(path, { label: context, value: String(data) });
  return out;
}

const QUIET = /(^|\/)(type|url|file_id|checked_at|trend|values|activity|current|tone|mark|primary)(\/|$)/;

/**
 * What changed between two versions of a card's data, for the line that says
 * so on the card. Only a few facts: when most of the card changed, it is a new
 * stage of the matter rather than an update, and nothing is listed.
 */
export function diffCard(before: Json, after: Json): CardChange[] {
  const a = leaves(before);
  const b = leaves(after);
  const changes: CardChange[] = [];
  for (const [path, now] of b) {
    if (QUIET.test(path)) continue;
    const was = a.get(path);
    if (!was || was.value === now.value) continue;
    if (now.value.length > 40 || was.value.length > 40) continue;
    changes.push({ label: capitalize(now.label), from: was.value, to: now.value });
  }
  return changes.length > 3 ? [] : changes;
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}
