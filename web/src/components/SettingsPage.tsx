import { useEffect, useState } from "react";
import { api, type Me, type ModelStatus, type OwnerSettings } from "../api";

export function SettingsPage({ me, reload, onSignedOut }: { me: Me | null; reload: () => Promise<void>; onSignedOut: () => void }) {
  if (!me) return <div className="page" />;
  return (
    <div className="page" data-testid="settings-page">
      <header className="thread-head">
        <a href="#" className="back" aria-label="Back">
          ‹
        </a>
        <h2>Settings</h2>
      </header>
      <div className="page-body settings">
        <Models reload={reload} />
        <Google me={me} reload={reload} />
        <Notifications me={me} reload={reload} />
        <Preferences settings={me.settings} reload={reload} />
        <SignIns />
        <Usage />
        <section className="card">
          <h3>Install</h3>
          <p className="muted">
            On iPhone: open Vireo in Safari, tap Share, then <b>Add to Home Screen</b>. On Mac: in Safari choose File → <b>Add to Dock</b>, or use the install
            button in Chrome's address bar. Notifications on iPhone work once Vireo is installed to the home screen and served over HTTPS.
          </p>
        </section>
        <section className="card">
          <h3>Session</h3>
          <button
            className="btn"
            onClick={() =>
              void api.post("/api/auth/logout").then(() => {
                onSignedOut();
              })
            }
          >
            Sign out of this device
          </button>
        </section>
      </div>
    </div>
  );
}

function Models({ reload }: { reload: () => Promise<void> }) {
  const [st, setSt] = useState<ModelStatus | null>(null);
  const [login, setLogin] = useState<string | null>(null);
  const [keyProvider, setKeyProvider] = useState("anthropic");
  const [key, setKey] = useState("");
  const load = () => api.get<ModelStatus>("/api/models").then(setSt);
  useEffect(() => {
    void load();
  }, []);
  if (!st) return null;
  const choose = async (field: "main" | "fast", value: string) => {
    await api.put("/api/models", { ...st.choice, [field]: value || undefined });
    await load();
    await reload();
  };
  return (
    <section className="card" data-testid="models-card">
      <h3>Model</h3>
      {st.fake ? <p className="tag">Demo mode: a scripted model is answering.</p> : null}
      {st.ready ? (
        <p>
          Using <b>{st.main?.name}</b> <span className="muted">({st.main?.provider})</span>; routine work on <b>{st.fast?.name}</b>.
        </p>
      ) : (
        <p className="error">No model yet. Sign in with a subscription below, add an API key, or run <code>pi</code> and use <code>/login</code> on this machine.</p>
      )}
      <p className="muted small">
        Vireo uses pi's credentials at <code>{st.piAgentDir}</code>, so anything you've signed in to with pi works here, on your own quota.
      </p>
      {st.available.length ? (
        <div className="grid2">
          <label>
            Main model
            <select value={st.choice?.main ?? ""} onChange={(e) => void choose("main", e.target.value)}>
              <option value="">Automatic</option>
              {st.available.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.provider} · {m.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Routine work
            <select value={st.choice?.fast ?? ""} onChange={(e) => void choose("fast", e.target.value)}>
              <option value="">Automatic (cheaper model)</option>
              {st.available.map((m) => (
                <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>
                  {m.provider} · {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      <h4>Providers</h4>
      <div className="provider-list">
        {(st.oauth ?? []).map((p) => {
          const configured = st.providers.find((x) => x.id === p.id)?.configured;
          return (
            <div key={p.id} className="provider">
              <span>
                {p.name} {configured ? <span className="tag ok">signed in</span> : null}
              </span>
              {configured ? (
                <button className="btn small ghost" onClick={() => void api.del(`/api/models/providers/${p.id}`).then(load).then(reload)}>
                  Sign out
                </button>
              ) : (
                <button
                  className="btn small"
                  onClick={() => void api.post<{ id: string }>("/api/models/login", { provider: p.id }).then((r) => setLogin(r.id))}
                >
                  Sign in
                </button>
              )}
            </div>
          );
        })}
      </div>
      {login ? (
        <LoginFlow
          id={login}
          onDone={() => {
            setLogin(null);
            void load().then(reload);
          }}
        />
      ) : null}
      <form
        className="inline-form"
        onSubmit={(e) => {
          e.preventDefault();
          void api.post("/api/models/apikey", { provider: keyProvider, key }).then(() => {
            setKey("");
            void load().then(reload);
          });
        }}
      >
        <select value={keyProvider} onChange={(e) => setKeyProvider(e.target.value)}>
          {st.providers
            .filter((p) => !p.oauth || p.id === "anthropic")
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </select>
        <input type="password" placeholder="API key" value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn small" disabled={!key}>
          Save key
        </button>
      </form>
    </section>
  );
}

interface LoginState {
  status: "running" | "done" | "error";
  authUrl?: string;
  instructions?: string;
  progress: string[];
  prompt?: { kind: "text" | "select"; message: string; placeholder?: string; options?: { id: string; label: string }[] };
  error?: string;
}

function LoginFlow({ id, onDone }: { id: string; onDone: () => void }) {
  const [s, setS] = useState<LoginState | null>(null);
  const [answer, setAnswer] = useState("");
  useEffect(() => {
    const t = window.setInterval(() => {
      void api.get<LoginState>(`/api/models/login/${id}`).then((r) => {
        setS(r);
        if (r.status === "done") {
          window.clearInterval(t);
          onDone();
        }
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [id]);
  if (!s) return <p className="muted">Starting sign-in…</p>;
  return (
    <div className="login-flow">
      {s.authUrl ? (
        <p>
          1. <a href={s.authUrl} target="_blank" rel="noreferrer">Open the sign-in page</a> and approve access.
          {s.instructions ? <span className="muted"> {s.instructions}</span> : null}
        </p>
      ) : null}
      {s.prompt ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void api.post(`/api/models/login/${id}/answer`, { value: answer }).then(() => setAnswer(""));
          }}
        >
          <p>2. {s.prompt.message}</p>
          {s.prompt.kind === "select" ? (
            <select value={answer} onChange={(e) => setAnswer(e.target.value)}>
              <option value="">Choose…</option>
              {s.prompt.options?.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input value={answer} placeholder={s.prompt.placeholder} onChange={(e) => setAnswer(e.target.value)} />
          )}
          <button className="btn small">Continue</button>
        </form>
      ) : null}
      {s.progress.length ? <p className="muted small">{s.progress.at(-1)}</p> : null}
      {s.status === "error" ? <p className="error">{s.error}</p> : null}
    </div>
  );
}

function Google({ me, reload }: { me: Me; reload: () => Promise<void> }) {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const g = me.integrations.google;
  const redirect = `${location.origin}/api/google/callback`;
  return (
    <section className="card">
      <h3>Google Calendar & Gmail</h3>
      <p>
        Calendar: <b>{me.integrations.calendar}</b> · Email: <b>{me.integrations.mail ?? "not connected"}</b>
      </p>
      {g.connected ? (
        <>
          <p>
            Connected{g.email ? ` as ${g.email}` : ""}.{" "}
            <button className="btn small ghost" onClick={() => void api.del("/api/google").then(reload)}>
              Disconnect
            </button>
          </p>
        </>
      ) : (
        <>
          <p className="muted small">
            Until Google is connected, Vireo keeps events in its own calendar. To connect: create an OAuth client (type “Web application”) in Google Cloud
            Console, enable the Calendar and Gmail APIs, and add this redirect URI: <code>{redirect}</code>
          </p>
          {!g.configured ? (
            <form
              className="inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                void api.put("/api/google/client", { clientId, clientSecret: secret }).then(reload);
              }}
            >
              <input placeholder="Client ID" value={clientId} onChange={(e) => setClientId(e.target.value)} />
              <input type="password" placeholder="Client secret" value={secret} onChange={(e) => setSecret(e.target.value)} />
              <button className="btn small" disabled={!clientId || !secret}>
                Save
              </button>
            </form>
          ) : (
            <button className="btn primary" onClick={() => void api.post<{ url: string }>("/api/google/connect").then((r) => (location.href = r.url))}>
              Connect Google
            </button>
          )}
        </>
      )}
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
      <h3>Notifications</h3>
      <p className="muted small">Vireo notifies you when something needs you: confirmations, emails that need a reply, reminders and the morning brief.</p>
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
          Morning brief at
          <input type="time" value={s.briefTime} onChange={(e) => setS({ ...s, briefTime: e.target.value })} />
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
          Mention quiet threads after (days)
          <input type="number" min={1} value={s.staleDays} onChange={(e) => setS({ ...s, staleDays: Number(e.target.value) })} />
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

function SignIns() {
  const [list, setList] = useState<{ id: string; domain: string; username: string }[]>([]);
  const [domain, setDomain] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const load = () => api.get<{ credentials: { id: string; domain: string; username: string }[] }>("/api/credentials").then((r) => setList(r.credentials));
  useEffect(() => {
    void load();
  }, []);
  return (
    <section className="card">
      <h3>Sign-ins for websites</h3>
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
  const [u, setU] = useState<{ byPurpose: { purpose: string; provider: string; model: string; calls: number; input: number; output: number; cost: number; avg_ms: number }[] } | null>(null);
  useEffect(() => {
    void api.get<typeof u>("/api/usage").then(setU);
  }, []);
  if (!u || u.byPurpose.length === 0) return null;
  return (
    <section className="card">
      <h3>Usage</h3>
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
