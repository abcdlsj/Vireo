import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { currentHost, hosts, HOSTS_CHANGED, LOCAL_DEFAULT_NAME, LOCAL_ID, pairHost, pendingPairing, removeHost, renameHost, switchHost, type Host } from "../hosts";
import { ChevronDown, PlusIcon } from "../icons";

/** Sidebar control showing the current host; switches between paired hosts. */
export function HostSwitcher() {
  const [open, setOpen] = useState(false);
  const [, bump] = useState(0);
  useEffect(() => {
    const on = () => bump((n) => n + 1);
    window.addEventListener(HOSTS_CHANGED, on);
    return () => window.removeEventListener(HOSTS_CHANGED, on);
  }, []);
  const [adding, setAdding] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = currentHost();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
        setAdding(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="host-switch" ref={ref}>
      <button className="host-switch-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" data-testid="host-switch" title="Switch host">
        <span className="host-name">{cur?.name ?? "No host"}</span>
        <ChevronDown />
      </button>
      {open ? (
        <div className="menu host-menu" role="menu">
          {adding ? (
            <AddHostForm onCancel={() => setAdding(false)} />
          ) : (
            <>
              {hosts().map((h) => (
                <button key={h.id} role="menuitemradio" aria-checked={h.id === cur?.id} className={`menu-item ${h.id === cur?.id ? "active" : ""}`} onClick={() => (h.id === cur?.id ? setOpen(false) : switchHost(h.id))}>
                  <span>{h.name}</span>
                  <span className="muted small">{h.url ? new URL(h.url).host : "local"}</span>
                </button>
              ))}
              <div className="menu-sep" />
              <button className="menu-item" onClick={() => setAdding(true)} data-testid="add-host">
                <span className="with-icon">
                  <PlusIcon /> Add host
                </span>
              </button>
              <a className="menu-item" href="#settings/hosts" onClick={() => setOpen(false)}>
                <span>Manage hosts</span>
              </a>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Address (or pairing link) plus code; on success the app reloads into the new host. */
export function AddHostForm({ onCancel, host }: { onCancel?: () => void; host?: Host }) {
  const pending = host ? undefined : pendingPairing;
  const [address, setAddress] = useState(host?.url ?? pending?.url ?? "");
  const [code, setCode] = useState(pending?.code ?? "");
  const [error, setError] = useState(pending?.error ?? "");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack add-host"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        pairHost(address, code, host?.id)
          .then((h) => switchHost(h.id))
          .catch((err: Error) => setError(err.message))
          .finally(() => setBusy(false));
      }}
    >
      {host ? null : (
        <label>
          Host address
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="203.0.113.5:8787 or a pairing link" spellCheck={false} autoFocus required data-testid="host-address" />
        </label>
      )}
      <label>
        Pairing code
        <input
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder={address.includes("#pair=") ? "Included in the link" : "K7QM-2XPA"}
          autoComplete="one-time-code"
          spellCheck={false}
          autoFocus={Boolean(host)}
          data-testid="host-code"
        />
      </label>
      <p className="muted small">
        The host prints a code when it starts. For a new one, run <code>npm run pair</code> on the host, or use <b>Pair a device</b> on a device already paired with it.
      </p>
      {error ? <p className="error small">{error}</p> : null}
      <div className="row-buttons">
        <button className="btn small primary" disabled={busy} data-testid="pair-host">
          {busy ? "Pairing…" : "Pair"}
        </button>
        {onCancel ? (
          <button type="button" className="btn small ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}

/** Settings → Hosts: the paired hosts, and a code to pair another device with this one. */
export function HostsSettings() {
  const [, bump] = useState(0);
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [code, setCode] = useState<{ code: string; expiresAt: number; urls: string[]; name: string } | null>(null);
  const cur = currentHost();
  return (
    <>
      <section className="card">
        <p className="muted small">
          Each host runs its own Vireo, with its own threads, memory and plugins: this machine, a VPS, a home server. This app talks to one at a time.
        </p>
        <ul className="rows">
          {hosts().map((h) => (
            <li key={h.id} className="row" data-testid="host-row">
              <div className="row-main">
                {renaming === h.id ? (
                  <RenameHost
                    host={h}
                    onDone={() => {
                      setRenaming(null);
                      bump((n) => n + 1);
                    }}
                  />
                ) : (
                  <span className="row-title">
                    {h.name} {h.id === cur?.id ? <span className="tag">current</span> : null}
                  </span>
                )}
                <span className="muted small">{h.url || "Proxied by this app (same machine)"}</span>
              </div>
              <div className="row-buttons">
                {h.id !== cur?.id ? (
                  <button className="btn small" onClick={() => switchHost(h.id)}>
                    Switch
                  </button>
                ) : null}
                {renaming !== h.id ? (
                  <button className="btn small ghost" onClick={() => setRenaming(h.id)} data-testid="rename-host">
                    Rename
                  </button>
                ) : null}
                {h.id !== LOCAL_ID ? (
                  <button
                    className="btn small ghost"
                    onClick={() => {
                      if (!confirm(`Remove ${h.name}? This device signs out of it; the host and its data stay.`)) return;
                      removeHost(h.id);
                      if (h.id === cur?.id) switchHost(LOCAL_ID);
                      else bump((n) => n + 1);
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
        {adding ? <AddHostForm onCancel={() => setAdding(false)} /> : <button className="btn small" onClick={() => setAdding(true)}>Add host</button>}
      </section>
      <section className="card">
        <h3>Pair a device with {cur?.name ?? "this host"}</h3>
        <p className="muted small">Gives a one-time code, valid for 15 minutes. Enter it in Vireo on the other device under Add host.</p>
        {code ? (
          <div className="pair-code" data-testid="pairing-code">
            <span className="code">{code.code}</span>
            <span className="muted small">
              Address: {code.urls.join(" or ")} · expires {new Date(code.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        ) : null}
        <button className="btn small" onClick={() => void api.post<typeof code>("/api/pairing").then(setCode)} data-testid="new-pairing-code">
          {code ? "New code" : "Get a pairing code"}
        </button>
      </section>
    </>
  );
}

/** Inline rename; names live on this device, like the list of hosts itself. */
function RenameHost({ host, onDone }: { host: Host; onDone: () => void }) {
  const [name, setName] = useState(host.name);
  return (
    <form
      className="rename-host"
      onSubmit={(e) => {
        e.preventDefault();
        renameHost(host.id, name);
        onDone();
      }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onDone()}
        placeholder={host.id === LOCAL_ID ? LOCAL_DEFAULT_NAME : "Host name"}
        maxLength={60}
        aria-label="Host name"
        autoFocus
        data-testid="host-name-input"
      />
      <button className="btn small primary">Save</button>
      <button type="button" className="btn small ghost" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}
