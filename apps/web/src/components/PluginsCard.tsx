import { useCallback, useEffect, useState } from "react";
import { api, onEvent, type PluginField, type PluginView, type Thread } from "../api";
import { go } from "../route";

/**
 * Settings → Plugins: installed plugins with their settings, plus the
 * community catalog. A link to #settings/plugins/<id> (the assistant sends
 * one when a request needs that plugin) opens straight to it.
 */
export function PluginsCard({ reload, focus }: { reload: () => Promise<void>; focus?: string }) {
  const [plugins, setPlugins] = useState<PluginView[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => api.get<{ plugins: PluginView[] }>("/api/plugins").then((r) => setPlugins(r.plugins)), []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => onEvent((e) => (e.type === "plugins.updated" ? void load() : undefined)), [load]);
  const loaded = plugins !== null;
  useEffect(() => {
    if (!loaded || !focus) return;
    const target = plugins?.find((p) => p.id === focus);
    if (target && !target.installed) setBrowsing(true);
    requestAnimationFrame(() => document.querySelector(`[data-plugin="${focus}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    // Only when the page opens on a plugin, not on every reload of the list.
  }, [loaded, focus]);

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await load();
    await reload();
  };

  // Built-in parts of Vireo (coding agents) have Settings pages of their own.
  const installed = plugins?.filter((p) => p.installed && !p.builtin) ?? [];
  const available = plugins?.filter((p) => !p.installed && !p.builtin) ?? [];
  // One plugin opens its settings by itself: the one a link pointed at, else
  // the first that needs setup or is failing. Opening every such plugin at
  // once buried the rest of the page under forms.
  const attention = (p: PluginView) => p.status?.state === "setup" || p.status?.state === "error";
  const focused = installed.find((p) => p.id === focus && p.status?.state !== "ready");
  const autoOpen = (focused ?? installed.find(attention))?.id;
  return (
    <div className="plugins" data-testid="plugins-card">
      <div className="plugins-bar">
        <p className="muted small">{plugins ? `${installed.length} added on this host` : ""}</p>
        <button className={`btn small${!browsing && plugins?.length && installed.length === 0 ? " primary" : ""}`} onClick={() => setBrowsing((b) => !b)} aria-expanded={browsing} data-testid="community-plugins">
          {browsing ? "Done" : "Community plugins"}
        </button>
      </div>
      {error ? <p className="error small">{error}</p> : null}
      {browsing ? (
        <section className="card plugin-catalog" data-testid="plugin-catalog">
          <h3>Community plugins</h3>
          <p className="muted small">Plugins that ship with Vireo. Each stays off until you add it.</p>
          {available.length === 0 ? <p className="muted small">Every community plugin is added.</p> : null}
          {available.map((p) => (
            <div key={p.id} className={`plugin-row${p.id === focus ? " focused" : ""}`} data-plugin={p.id}>
              <div className="plugin-about">
                <b>{p.name}</b> <span className="muted small">by {p.author}</span>
                <p className="muted small">{p.description}</p>
                {p.browserSetup ? (
                  <p className="small plugin-hint">
                    Or let Vireo set it up: it opens the sign-in page in its browser, you sign in, it creates the keys. <SetUpWithVireo plugin={p} run={run} />
                  </p>
                ) : null}
              </div>
              <button className="btn small primary" data-testid={`add-plugin-${p.id}`} onClick={() => void run(() => api.post(`/api/plugins/${p.id}`, {}))}>
                Add
              </button>
            </div>
          ))}
        </section>
      ) : null}
      {plugins && installed.length === 0 && !browsing ? (
        <section className="card">
          <p className="muted small">No plugins yet. Add Google, Tailscale and more from Community plugins.</p>
        </section>
      ) : null}
      {installed.map((p) => (
        <Plugin key={p.id} plugin={p} run={run} focused={p.id === focus} autoOpen={p.id === autoOpen} />
      ))}
    </div>
  );
}

/**
 * Starts a thread where Vireo sets the plugin up in its own browser: it opens
 * the pages, the owner signs in there, and Vireo saves the keys it creates.
 */
async function setUpWithVireo(p: PluginView): Promise<void> {
  const { thread } = await api.post<{ thread: Thread }>("/api/threads", { text: `Set up the ${p.name} plugin for me in your browser. I'll sign in when you need me to.` });
  go(`#thread/${thread.id}`);
}

function SetUpWithVireo({ plugin, run, primary }: { plugin: PluginView; run: (fn: () => Promise<unknown>) => Promise<void>; primary?: boolean }) {
  if (!plugin.browserSetup) return null;
  return (
    <button
      className={`btn small${primary ? " primary" : " ghost"}`}
      title="Vireo opens the sign-in page in its browser; you sign in, it creates the keys and saves them here"
      onClick={() => void run(() => setUpWithVireo(plugin))}
      data-testid={`setup-with-vireo-${plugin.id}`}
    >
      Set up with Vireo
    </button>
  );
}

const STATE_LABEL: Record<string, string> = { ready: "Ready", setup: "Needs setup", login: "Sign in needed", starting: "Starting", error: "Error" };

export function Plugin({ plugin: p, run, focused, autoOpen }: { plugin: PluginView; run: (fn: () => Promise<unknown>) => Promise<void>; focused: boolean; autoOpen: boolean }) {
  const st = p.status;
  const needsAttention = st?.state === "setup" || st?.state === "error";
  // The plugin that needs setup or is failing opens its settings, so the field
  // that fixes it (e.g. Tailscale's Connection) is the first thing in view.
  const [open, setOpen] = useState(autoOpen);
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [note, setNote] = useState("");
  // The status arrives after the card does (and after a plugin is added), so a
  // plugin that needs attention opens then, not only on first render.
  useEffect(() => {
    if (autoOpen) setOpen(true);
  }, [autoOpen]);
  const value = (f: PluginField) => (f.key in form ? form[f.key] : f.type === "secret" ? "" : (p.config[f.key] ?? f.default ?? ""));
  const set = (k: string, v: unknown) => setForm((s) => ({ ...s, [k]: v }));
  // A plugin whose whole form is one list (Coding agents, say) needs no second heading.
  const solo = p.fields.length === 1 && p.fields[0]!.type === "list";

  return (
    <section className={`card plugin${focused ? " focused" : ""}${open ? " open" : ""}`} data-testid={`plugin-${p.id}`} data-plugin={p.id}>
      <div className="plugin-head">
        <div className="plugin-title">
          <b>{p.name}</b>
          {st ? <span className={`plugin-state is-${st.state}`}>{STATE_LABEL[st.state] ?? st.state}</span> : null}
        </div>
        <div className="row-buttons plugin-actions">
          {st && st.state !== "ready" ? <SetUpWithVireo plugin={p} run={run} primary={!st.link} /> : null}
          {p.actions.map((a) => (
            <button
              key={a.id}
              className={`btn small${a.primary ? " primary" : ""}`}
              onClick={() =>
                void run(async () => {
                  const r = await api.post<{ message?: string; redirect?: string }>(`/api/plugins/${p.id}/actions/${a.id}`);
                  if (r.redirect) location.href = r.redirect;
                  setNote(r.message ?? "");
                })
              }
            >
              {a.label}
            </button>
          ))}
          <button
            className={`btn small${!open && needsAttention ? " primary" : ""}`}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            data-testid={`plugin-${p.id}-settings`}
          >
            {open ? "Hide settings" : "Settings"}
          </button>
        </div>
      </div>
      {st ? (
        <p className={`plugin-status small${st.state === "error" ? " error" : ""}`} data-testid={`plugin-${p.id}-status`}>
          {st.message}
        </p>
      ) : null}
      {note ? <p className="muted small plugin-note">{note}</p> : null}
      {st?.link ? (
        <p>
          <a className="btn small primary" href={st.link.href} target="_blank" rel="noreferrer">
            {st.link.label}
          </a>
        </p>
      ) : null}
      {st?.details?.length ? (
        <dl className="plugin-details">
          {st.details.map((d) => (
            <div key={d.label}>
              <dt>{d.label}</dt>
              <dd>{d.label.includes("URI") ? <code>{d.value}</code> : d.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {open ? (
        <form
          className="stack plugin-settings"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api.patch(`/api/plugins/${p.id}`, form);
              setForm({});
              setNote("Saved.");
            });
          }}
        >
          {p.fields.map((f) => (
            <Field key={f.key} field={f} value={value(f)} onChange={(v) => set(f.key, v)} hideLabel={solo} />
          ))}
          <div className="plugin-foot">
            <button className="btn primary small" disabled={Object.keys(form).length === 0}>
              Save
            </button>
            {p.homepage && !p.builtin ? (
              <a className="muted small" href={p.homepage} target="_blank" rel="noreferrer">
                Open {p.name} console
              </a>
            ) : null}
            {p.builtin ? null : (
              <button
                type="button"
                className="link danger small plugin-remove"
                onClick={() => {
                  if (confirm(`Remove the ${p.name} plugin? Its settings are deleted.`)) void run(() => api.del(`/api/plugins/${p.id}`));
                }}
              >
                Remove plugin
              </button>
            )}
          </div>
        </form>
      ) : null}
    </section>
  );
}

function Field({ field: f, value, onChange, hideLabel }: { field: PluginField; value: unknown; onChange: (v: unknown) => void; hideLabel?: boolean }) {
  const id = `pf-${f.key}`;
  const help = f.help ? <span className="muted small">{f.help}</span> : null;
  if (f.type === "list") {
    const rows = (Array.isArray(value) ? value : []) as Record<string, unknown>[];
    const items = f.items ?? [];
    const change = (i: number, key: string, v: unknown) => onChange(rows.map((r, j) => (j === i ? { ...r, [key]: v } : r)));
    return (
      <div className="pf-list" data-testid={id}>
        {hideLabel ? null : <span className="pf-list-label">{f.label}</span>}
        {help}
        {rows.map((row, i) => (
          <div className="pf-row" key={i} data-testid={`${id}-${i}`}>
            <div className="pf-row-head">
              <b>{typeof row.name === "string" && row.name.trim() ? row.name : `#${i + 1}`}</b>
              <button type="button" className="link danger small" data-testid={`${id}-${i}-remove`} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
            <div className="pf-grid">
              {items.map((item) => (
                <label key={item.key} className={item.multiline ? "wide" : undefined}>
                  <span>{item.label}</span>
                  <Control field={item.type === "secret" ? { ...item, set: Boolean(row[`${item.key}_set`]) } : item} id={`${id}-${i}-${item.key}`} value={row[item.key] ?? item.default ?? ""} onChange={(v) => change(i, item.key, v)} />
                  {/* The same help under every row is noise; the first row carries it. */}
                  {item.help && i === 0 ? <span className="muted small">{item.help}</span> : null}
                </label>
              ))}
            </div>
          </div>
        ))}
        <button type="button" className="btn small pf-add" data-testid={`${id}-add`} onClick={() => onChange([...rows, {}])}>
          + Add another
        </button>
      </div>
    );
  }
  if (f.type === "boolean") {
    return (
      <label className="check">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} /> {f.label}
        {help}
      </label>
    );
  }
  return (
    <label htmlFor={id}>
      <span>{f.label}</span>
      <Control field={f} id={id} value={value} onChange={onChange} />
      {help}
    </label>
  );
}

/** One input of a settings form: a plugin field, or one field of a list row. */
function Control({ field: f, id, value, onChange }: { field: PluginField; id: string; value: unknown; onChange: (v: unknown) => void }) {
  if (f.type === "boolean") {
    return <input id={id} data-testid={id} type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />;
  }
  const placeholder = f.type === "secret" && f.set ? "•••••• saved — type to replace" : f.placeholder;
  if (f.type === "select") {
    return (
      <select id={id} data-testid={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
        {f.options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }
  if (f.multiline) {
    return <textarea id={id} data-testid={id} rows={3} spellCheck={false} placeholder={placeholder} value={String(value)} onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <input
      id={id}
      data-testid={id}
      type={f.type === "secret" ? "password" : "text"}
      autoComplete="off"
      placeholder={placeholder}
      value={String(value)}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
