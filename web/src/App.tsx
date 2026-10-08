import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, closeEvents, onEvent, type Me, type Thread } from "./api";
import { Login } from "./components/Login";
import { MemoryPage } from "./components/MemoryPage";
import { NewThread } from "./components/NewThread";
import { SettingsPage } from "./components/SettingsPage";
import { ThreadList } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";
import { go, useRoute } from "./route";

type AuthState = { loading: true } | { loading: false; hasOwner: boolean; authenticated: boolean; setupNeedsCode: boolean };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ loading: true });
  const refreshAuth = useCallback(async () => {
    try {
      const s = await api.get<{ hasOwner: boolean; authenticated: boolean; setupNeedsCode: boolean }>("/api/auth/status");
      setAuth({ loading: false, ...s });
    } catch {
      setAuth({ loading: false, hasOwner: true, authenticated: false, setupNeedsCode: true });
    }
  }, []);
  useEffect(() => {
    void refreshAuth();
  }, [refreshAuth]);

  if (auth.loading) return <div className="splash">Vireo</div>;
  if (!auth.authenticated) return <Login hasOwner={auth.hasOwner} needsCode={auth.setupNeedsCode} onDone={refreshAuth} />;
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

  const current = route.name === "thread" ? route.id : null;
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
          <div className="brand" onClick={() => go("thread/overview")}>
            <img src="/icon.svg" alt="" width={26} height={26} />
            <span>Vireo</span>
          </div>
          <button className="btn primary small" onClick={() => go("new")} aria-label="New thread" data-testid="new-thread">
            + New
          </button>
        </header>
        <ThreadList threads={threads} current={current} />
        <nav className="sidebar-foot">
          <a href="#memory" className={route.name === "memory" ? "active" : ""}>
            Memory
          </a>
          <a href="#settings" className={route.name === "settings" ? "active" : ""}>
            Settings
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
          <SettingsPage me={me} reload={loadMe} onSignedOut={onSignedOut} />
        ) : (
          <div className="empty-main">
            <ThreadView id="overview" />
          </div>
        )}
      </main>
    </div>
  );
}
