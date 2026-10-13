import { useEffect, useRef, useState } from "react";
import { useGlide } from "../glide";
import { ChevronLeft } from "../icons";
import type { Credential, UsageByPurpose, User } from "@vireo/protocol";
import { AccountSettings, NodesSettings } from "./Nodes";
import { Models } from "./ModelSettings";
import { PluginsCard } from "./PluginsCard";
import { api, type Me, type OwnerSettings } from "../api";
import { setThemeChoice, themeChoice, type ThemeChoice } from "../theme";

const SECTIONS = [
  { id: "general", label: "General" },
  { id: "model", label: "Model" },
  { id: "plugins", label: "Plugins" },
  { id: "nodes", label: "Nodes" },
  { id: "notifications", label: "Notifications" },
  { id: "sign-ins", label: "Website sign-ins" },
  { id: "usage", label: "Usage" },
  { id: "account", label: "Account" },
];

/** The section list; the selected section's highlight slides between entries. */
function SettingsNav({ cur, modelMissing }: { cur: string; modelMissing: boolean }) {
  const ref = useRef<HTMLElement>(null);
  useGlide(ref, { hover: ".settings-nav-item", active: ".settings-nav-item.active" });
  return (
    <nav className="settings-nav" ref={ref} aria-label="Settings sections">
      {SECTIONS.map((s) => (
        <a key={s.id} href={`#settings/${s.id}`} className={`settings-nav-item ${s.id === cur ? "active" : ""}`} aria-current={s.id === cur ? "page" : undefined} data-testid={`settings-nav-${s.id}`}>
          {s.label}
          {s.id === "model" && modelMissing ? <span className="dot warn" title="No model configured" /> : null}
        </a>
      ))}
    </nav>
  );
}

export function SettingsPage({ section, me, user, reload }: { section: string; me: Me | null; user: User | null; reload: () => Promise<void> }) {
  if (!me) return <div className="page" />;
  // A section can name one item in it, e.g. plugins/google.
  const [base, item] = section.split("/");
  const cur = SECTIONS.find((s) => s.id === base) ?? SECTIONS[0]!;
  return (
    <div className="page" data-testid="settings-page">
      <header className="topbar">
        <a href="#" className="back" aria-label="Back">
          <ChevronLeft />
        </a>
        <span className="crumbs">
          <span className="crumb-root">Settings</span>
          <span className="crumb-sep">/</span>
          <span className="crumb-here">{cur.label}</span>
        </span>
      </header>
      <div className="settings-layout">
        <SettingsNav cur={cur.id} modelMissing={!me.models.ready} />
        <div className="page-body settings">
          <h1 className="page-title">{cur.label}</h1>
          {cur.id === "general" ? (
            <>
              <Preferences settings={me.settings} reload={reload} />
              <Appearance />
            </>
          ) : cur.id === "model" ? (
            <Models reload={reload} />
          ) : cur.id === "plugins" ? (
            <PluginsCard reload={reload} focus={item} />
          ) : cur.id === "nodes" ? (
            <NodesSettings />
          ) : cur.id === "notifications" ? (
            <>
              <Notifications me={me} reload={reload} />
              <Install />
            </>
          ) : cur.id === "sign-ins" ? (
            <SignIns />
          ) : cur.id === "usage" ? (
            <Usage />
          ) : (
            <AccountSettings user={user} />
          )}
        </div>
      </div>
    </div>
  );
}

function Install() {
  return (
    <section className="card">
      <h3>Install</h3>
      <p className="muted">
        On iPhone: open Vireo in Safari, tap Share, then <b>Add to Home Screen</b>. On Mac: in Safari choose File → <b>Add to Dock</b>, or use the install
        button in Chrome's address bar. Notifications on iPhone work once Vireo is installed to the home screen and served over HTTPS.
      </p>
    </section>
  );
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function Notifications({ me, reload }: { me: Me; reload: () => Promise<void> }) {
  const [msg, setMsg] = useState("");
  const supported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const enable = async () => {
    setMsg("");
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        setMsg("Notifications were not allowed.");
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(me.push.publicKey) as BufferSource });
      await api.post("/api/push/subscribe", sub.toJSON());
      setMsg("Notifications are on for this device.");
      await reload();
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <section className="card">
      <p className="muted small">Vireo notifies you when something needs you: confirmations, emails that need a reply, reminders, and once a day what needs you.</p>
      {supported ? (
        <div className="row-buttons">
          <button className="btn" onClick={() => void enable()}>
            Enable on this device
          </button>
          <button className="btn ghost" onClick={() => void api.post("/api/push/test")}>
            Send a test
          </button>
          <span className="muted small">{me.push.subscriptions} device(s) subscribed</span>
        </div>
      ) : (
        <p className="muted">This browser doesn't support push here. On iPhone, install Vireo to the home screen first.</p>
      )}
      {msg ? <p className="small">{msg}</p> : null}
    </section>
  );
}

function Preferences({ settings, reload }: { settings: OwnerSettings; reload: () => Promise<void> }) {
  const [s, setS] = useState(settings);
  const [saved, setSaved] = useState(false);
  const save = async () => {
    await api.patch("/api/settings", s);
    if (s.timezone !== Intl.DateTimeFormat().resolvedOptions().timeZone) localStorage.setItem("vireo.tz.pinned", "1");
    else localStorage.removeItem("vireo.tz.pinned");
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1500);
    await reload();
  };
  return (
    <section className="card">
      <h3>Preferences</h3>
      <div className="grid2">
        <label>
          Time zone
          <input value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} />
        </label>
        <label>
          Daily nudge at
          <input type="time" value={s.nudgeTime} onChange={(e) => setS({ ...s, nudgeTime: e.target.value })} data-testid="nudge-time" />
        </label>
        <label>
          Workday starts
          <input type="time" value={s.workdayStart} onChange={(e) => setS({ ...s, workdayStart: e.target.value })} />
        </label>
        <label>
          Workday ends
          <input type="time" value={s.workdayEnd} onChange={(e) => setS({ ...s, workdayEnd: e.target.value })} />
        </label>
        <label>
          Proxy for the web and browser
          <input
            value={s.proxyUrl ?? ""}
            placeholder="http://127.0.0.1:7890"
            spellCheck={false}
            onChange={(e) => setS({ ...s, proxyUrl: e.target.value })}
            data-testid="proxy-url"
          />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={s.watchInbox} onChange={(e) => setS({ ...s, watchInbox: e.target.checked })} /> Watch my inbox and open threads for
        email that needs a reply
      </label>
      <label className="check">
        <input type="checkbox" checked={s.watchCalendar} onChange={(e) => setS({ ...s, watchCalendar: e.target.checked })} /> Watch my calendar for
        invitations and conflicts
      </label>
      <button className="btn primary" onClick={() => void save()}>
        {saved ? "Saved" : "Save"}
      </button>
    </section>
  );
}

function Appearance() {
  const [choice, setChoice] = useState<ThemeChoice>(themeChoice);
  return (
    <section className="card">
      <h3>Appearance</h3>
      <label>
        Theme
        <select
          value={choice}
          onChange={(e) => {
            const v = e.target.value as ThemeChoice;
            setChoice(v);
            setThemeChoice(v);
          }}
          data-testid="theme-select"
        >
          <option value="system">Match system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      <p className="muted small">Saved on this device.</p>
    </section>
  );
}

function SignIns() {
  const [list, setList] = useState<Credential[]>([]);
  const [domain, setDomain] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const load = () => api.get<{ credentials: Credential[] }>("/api/credentials").then((r) => setList(r.credentials));
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="card">
      <p className="muted small">
        Stored encrypted on your server. Vireo's browser fills them in itself; passwords are never shown to the model or written to logs.
      </p>
      {list.map((c) => (
        <div key={c.id} className="provider">
          <span>
            {c.domain} <span className="muted">· {c.username}</span>
          </span>
          <button className="btn small ghost" onClick={() => void api.del(`/api/credentials/${c.id}`).then(load)}>
            Remove
          </button>
        </div>
      ))}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void api.post("/api/credentials", { domain, username, password }).then(() => {
            setDomain("");
            setUsername("");
            setPassword("");
            void load();
          });
        }}
      >
        <input placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} required />
        <input placeholder="Username" value={username} onChange={(e) => setUsername(e.target.value)} required autoComplete="off" />
        <input type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
        <button className="btn small">Add</button>
      </form>
    </section>
  );
}

function Usage() {
  const [u, setU] = useState<{ byPurpose: UsageByPurpose[] } | null>(null);
  useEffect(() => {
    void api.get<typeof u>("/api/usage").then(setU);
  }, []);
  if (!u) return null;
  if (u.byPurpose.length === 0) return <p className="muted">No model calls yet.</p>;
  return (
    <section className="card">
      <table className="usage">
        <thead>
          <tr>
            <th>Work</th>
            <th>Model</th>
            <th>Calls</th>
            <th>Tokens</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {u.byPurpose.map((r, i) => (
            <tr key={i}>
              <td>{r.purpose}</td>
              <td>{r.model}</td>
              <td>{r.calls}</td>
              <td>{(r.input + r.output).toLocaleString()}</td>
              <td>${(r.cost ?? 0).toFixed(3)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
