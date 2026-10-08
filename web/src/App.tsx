import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, closeEvents, onEvent, type Me, type Thread } from "./api";
import { AddHostForm, HostSwitcher } from "./components/Hosts";
import { Login } from "./components/Login";
import { currentHost, hosts, switchHost } from "./hosts";
import { MemoryPage } from "./components/MemoryPage";
import { NewThread } from "./components/NewThread";
import { SettingsPage } from "./components/SettingsPage";
import { ThreadList } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";
import { MemoryIcon, PlusIcon, SettingsIcon } from "./icons";
import { go, useRoute } from "./route";

type AuthState =
  | { loading: true }
  | { loading: false; unreachable: string }
  | { loading: false; hasOwner: boolean; authenticated: boolean; setupNeedsCode: boolean };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ loading: true });
  const host = currentHost();
  const refreshAuth = useCallback(async () => {
    try {
      const s = await api.get<{ hasOwner: boolean; authenticated: boolean; setupNeedsCode: boolean }>("/api/auth/status");
      setAuth({ loading: false, ...s });
    } catch (err) {
      setAuth({ loading: false, unreachable: err instanceof Error ? err.message : String(err) });
    }
  }, []);
  useEffect(() => {
    if (host) void refreshAuth();
  }, [refreshAuth, host]);

  if (!host) {
    return (
      <div className="login">
        <div className="login-card">
          <img src="/icon.svg" alt="" width={56} height={56} />
          <h1>Add a host</h1>
          <p className="muted">Vireo runs on a host: a VPS or a machine of yours. Pair this app with it using the code the host printed.</p>
          <AddHostForm />
        </div>
      </div>
    );
  }
  if (auth.loading) return <div className="splash">Vireo</div>;
  if ("unreachable" in auth && auth.unreachable) {
    return (
      <div className="login">
        <div className="login-card">
          <img src="/icon.svg" alt="" width={56} height={56} />
          <h1>{host.name} is unreachable</h1>
          <p className="muted">{auth.unreachable} Check that it is running and that its address{host.url ? ` (${host.url})` : ""} is reachable from here.</p>
          <div className="row-buttons center">
            <button className="btn primary" onClick={() => void refreshAuth()}>
              Try again
            </button>
            {hosts()
              .filter((h) => h.id !== host.id)
              .map((h) => (
                <button key={h.id} className="btn" onClick={() => switchHost(h.id)}>
                  Use {h.name}
                </button>
              ))}
          </div>
        </div>
      </div>
    );
  }
  if ("unreachable" in auth) return null;
  if (!auth.authenticated) return <Login host={host} hasOwner={auth.hasOwner} needsCode={auth.setupNeedsCode} onDone={refreshAuth} />;
  return (
    <Shell
      onSignedOut={() => {
        closeEvents();
        void refreshAuth();
      }}
    />
  );
}

function Shell({ onSignedOut }: { onSignedOut: () => void }) {
  const route = useRoute();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const loadThreads = useCallback(async () => {
    try {
      const r = await api.get<{ threads: Thread[] }>("/api/threads");
      setThreads(r.threads);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) onSignedOut();
    }
  }, [onSignedOut]);

  const loadMe = useCallback(async () => {
    setMe(await api.get<Me>("/api/me"));
  }, []);

  useEffect(() => {
    void loadThreads();
    void loadMe();
    // Keep the owner's time zone current so schedules and briefs use local time.
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    api
      .get<Me>("/api/me")
      .then((m) => {
        if (tz && m.settings.timezone !== tz && !localStorage.getItem("vireo.tz.pinned")) void api.patch("/api/settings", { timezone: tz });
      })
      .catch(() => undefined);
    return onEvent((e) => {
      if (e.type === "thread.updated" || e.type === "thread.deleted" || e.type === "action.updated") {
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => void loadThreads(), 120);
      }
    });
  }, [loadThreads, loadMe]);

  const current = route.name === "thread" ? route.id : route.name === "home" ? "overview" : null;
  const showList = route.name === "home";
  const needsYou = threads.filter((t) => t.group === "needs_you").length;

  useEffect(() => {
    document.title = needsYou ? `(${needsYou}) Vireo` : "Vireo";
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (needsYou) void nav.setAppBadge?.(needsYou).catch(() => undefined);
    else void nav.clearAppBadge?.().catch(() => undefined);
  }, [needsYou]);

  return (
    <div className={`shell ${showList ? "show-list" : "show-main"}`}>
      <aside className="sidebar">
        <header className="sidebar-head">
          <div className="brand">
            <a href="#thread/overview" aria-label="Vireo overview">
              <img src="/icon.svg" alt="" width={24} height={24} />
            </a>
            <HostSwitcher />
          </div>
          <button className="icon-btn" onClick={() => go("new")} aria-label="New thread" title="New thread" data-testid="new-thread">
            <PlusIcon />
          </button>
        </header>
        <ThreadList threads={threads} current={current} />
        <nav className="sidebar-foot">
          <a href="#memory" className={`nav-item ${route.name === "memory" ? "active" : ""}`}>
            <MemoryIcon />
            <span>Memory</span>
          </a>
          <a href="#settings" className={`nav-item ${route.name === "settings" ? "active" : ""}`}>
            <SettingsIcon />
            <span>Settings</span>
            {me && !me.models.ready ? <span className="dot warn" title="No model configured" /> : null}
          </a>
        </nav>
      </aside>
      <main className="main">
        {route.name === "thread" ? (
          <ThreadView key={route.id} id={route.id} />
        ) : route.name === "new" ? (
          <NewThread />
        ) : route.name === "memory" ? (
          <MemoryPage />
        ) : route.name === "settings" ? (
          <SettingsPage section={route.section} me={me} reload={loadMe} onSignedOut={onSignedOut} />
        ) : (
          <div className="empty-main">
            <ThreadView id="overview" />
          </div>
        )}
      </main>
    </div>
  );
}
