import { useCallback, useEffect, useState } from "react";
import { api, onEvent, type PluginField, type PluginView } from "../api";

/** Settings → Plugins: installed plugins with their settings, plus the community catalog. */
export function PluginsCard({ reload }: { reload: () => Promise<void> }) {
  const [plugins, setPlugins] = useState<PluginView[] | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(() => api.get<{ plugins: PluginView[] }>("/api/plugins").then((r) => setPlugins(r.plugins)), []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => onEvent((e) => (e.type === "plugins.updated" ? void load() : undefined)), [load]);

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

  const installed = plugins?.filter((p) => p.installed) ?? [];
  const available = plugins?.filter((p) => !p.installed) ?? [];
  return (
    <section className="card" data-testid="plugins-card">
      <div className="card-head">
        <p className="muted small">{browsing ? "Plugins that ship with Vireo. Each stays off until you add it." : `${installed.length} added on this host.`}</p>
        <button className="btn small" onClick={() => setBrowsing((b) => !b)} aria-expanded={browsing} data-testid="community-plugins">
          {browsing ? "Done" : "Community plugins"}
        </button>
      </div>
      {error ? <p className="error small">{error}</p> : null}
      {browsing ? (
        <div className="plugin-catalog" data-testid="plugin-catalog">
          {available.length === 0 ? <p className="muted small">Every community plugin is added.</p> : null}
          {available.map((p) => (
            <div key={p.id} className="plugin-row">
              <div>
                <b>{p.name}</b> <span className="muted small">by {p.author}</span>
                <p className="muted small">{p.description}</p>
              </div>
              <button className="btn small primary" data-testid={`add-plugin-${p.id}`} onClick={() => void run(() => api.post(`/api/plugins/${p.id}`, {}))}>
                Add
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {plugins && installed.length === 0 && !browsing ? <p className="muted small">No plugins yet. Add Google, Tailscale and more from Community plugins.</p> : null}
      {installed.map((p) => (
        <Plugin key={p.id} plugin={p} run={run} />
      ))}
    </section>
  );
}

const STATE_LABEL: Record<string, string> = { ready: "Ready", setup: "Needs setup", login: "Sign in needed", starting: "Starting", error: "Error" };

function Plugin({ plugin: p, run }: { plugin: PluginView; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(p.status?.state === "setup");
  const [form, setForm] = useState<Record<string, unknown>>({});
  const [note, setNote] = useState("");
  const value = (f: PluginField) => (f.key in form ? form[f.key] : f.type === "secret" ? "" : (p.config[f.key] ?? f.default ?? ""));
  const set = (k: string, v: unknown) => setForm((s) => ({ ...s, [k]: v }));
  const st = p.status;

  return (
    <div className="plugin" data-testid={`plugin-${p.id}`}>
      <div className="plugin-row">
        <div>
          <b>{p.name}</b> {st ? <span className={`plugin-state ${st.state}`}>{STATE_LABEL[st.state] ?? st.state}</span> : null}
          {st ? <p className="small" data-testid={`plugin-${p.id}-status`}>{st.message}</p> : null}
        </div>
      </div>
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
      <div className="row-buttons">
        {p.actions.map((a) => (
          <button
            key={a.id}
            className={`btn small${a.primary ? " primary" : " ghost"}`}
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
        <button className="btn small ghost" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? "Hide settings" : "Settings"}
        </button>
        <button
          className="btn small ghost"
          onClick={() => {
            if (confirm(`Remove the ${p.name} plugin? Its settings are deleted.`)) void run(() => api.del(`/api/plugins/${p.id}`));
          }}
        >
          Remove
        </button>
        {note ? <span className="muted small">{note}</span> : null}
      </div>
      {open ? (
        <form
          className="stack"
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
            <Field key={f.key} field={f} value={value(f)} onChange={(v) => set(f.key, v)} />
          ))}
          <div className="row-buttons">
            <button className="btn primary small" disabled={Object.keys(form).length === 0}>
              Save
            </button>
            {p.homepage ? (
              <a className="muted small" href={p.homepage} target="_blank" rel="noreferrer">
                Open {p.name} console
              </a>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}

function Field({ field: f, value, onChange }: { field: PluginField; value: unknown; onChange: (v: unknown) => void }) {
  const id = `pf-${f.key}`;
  const help = f.help ? <span className="muted small">{f.help}</span> : null;
  if (f.type === "boolean") {
    return (
      <label className="check">
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} /> {f.label}
        {help}
      </label>
    );
  }
  const placeholder = f.type === "secret" && f.set ? "•••••• saved — type to replace" : f.placeholder;
  return (
    <label htmlFor={id}>
      <span>{f.label}</span>
      {f.type === "select" ? (
        <select id={id} value={String(value)} onChange={(e) => onChange(e.target.value)}>
          {f.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      ) : f.multiline ? (
        <textarea id={id} rows={4} spellCheck={false} placeholder={placeholder} value={String(value)} onChange={(e) => onChange(e.target.value)} />
      ) : (
        <input
          id={id}
          type={f.type === "secret" ? "password" : "text"}
          autoComplete="off"
          placeholder={placeholder}
          value={String(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {help}
    </label>
  );
}
