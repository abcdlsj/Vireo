import type { NodeSummary, User } from "@vireo/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, closeEvents, onEvent, type Me, type Thread } from "./api";
import { cloud, SIGNED_OUT, signedIn } from "./cloud";
import { NodeSwitcher } from "./components/Nodes";
import { ApproveNode, NoNodes, SignIn, Unreachable } from "./components/SignIn";
import { currentNode, loadNodes, nodeAccess } from "./nodes";
import { Home } from "./components/Home";
import { MemoryPage } from "./components/MemoryPage";
import { NewThread } from "./components/NewThread";
import { SettingsPage } from "./components/SettingsPage";
import { ThreadList } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";
import { HomeIcon, MemoryIcon, PlusIcon, SearchIcon, SettingsIcon } from "./icons";
import { QuickJump } from "./components/QuickJump";
import { go, useRoute } from "./route";
import { useGlide } from "./glide";

type State =
  | { name: "loading" }
  | { name: "signed-out" }
  | { name: "no-nodes" }
  | { name: "unreachable"; node: NodeSummary; message: string }
  | { name: "ready"; node: NodeSummary };

/**
 * Signed in to the cloud, then on to the current node: it must answer its
 * health check and accept a token before the shell opens.
 */
export function App({ signInError }: { signInError?: string }) {
  const route = useRoute();
  const [state, setState] = useState<State>(() => (signedIn() ? { name: "loading" } : { name: "signed-out" }));
  const [user, setUser] = useState<User | null>(null);

  const connect = useCallback(async () => {
    if (!signedIn()) return setState({ name: "signed-out" });
    setState({ name: "loading" });
    try {
      const [me] = await Promise.all([cloud.me(), loadNodes()]);
      setUser(me);
    } catch (err) {
      if (!signedIn()) return setState({ name: "signed-out" });
      throw err;
    }
    const node = currentNode();
    if (!node) return setState({ name: "no-nodes" });
    try {
      await nodeAccess(true);
      await api.get("/api/me");
      setState({ name: "ready", node });
    } catch (err) {
      setState({ name: "unreachable", node, message: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  useEffect(() => {
    void connect();
    const out = () => {
      closeEvents();
      setState({ name: "signed-out" });
    };
    window.addEventListener(SIGNED_OUT, out);
    return () => window.removeEventListener(SIGNED_OUT, out);
  }, [connect]);

  if (state.name === "signed-out") return <SignIn error={signInError} onDone={() => void connect()} />;
  if (route.name === "link") return <ApproveNode code={route.code} />;
  if (state.name === "loading") return <div className="splash">Vireo</div>;
  if (state.name === "no-nodes") return <NoNodes />;
  if (state.name === "unreachable") return <Unreachable node={state.node} message={state.message} onRetry={() => void connect()} />;
  return <Shell user={user} />;
}

function Shell({ user }: { user: User | null }) {
  const route = useRoute();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [jump, setJump] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const sidebar = useRef<HTMLElement>(null);
  useGlide(sidebar, { hover: ".nav-item, .thread-row", active: ".nav-item.active, .thread-row.active", clip: ".thread-list" });

  const loadThreads = useCallback(async () => {
    try {
      const r = await api.get<{ threads: Thread[] }>("/api/threads");
      setThreads(r.threads);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
    }
  }, []);

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
  const showList = route.name === "threads";
  const needsYou = threads.filter((t) => t.group === "needs_you").length;

  useEffect(() => {
    document.title = needsYou ? `(${needsYou}) Vireo` : "Vireo";
    const nav = navigator as Navigator & { setAppBadge?: (n: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (needsYou) void nav.setAppBadge?.(needsYou).catch(() => undefined);
    else void nav.clearAppBadge?.().catch(() => undefined);
  }, [needsYou]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setJump((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <div className={`shell ${showList ? "show-list" : "show-main"} ${route.name === "home" ? "at-home" : ""}`}>
      <aside className="sidebar" ref={sidebar}>
        <header className="sidebar-head">
          <div className="brand">
            <a href="#" aria-label="Vireo home">
              <img src="/icon.svg" alt="" width={24} height={24} />
            </a>
            <NodeSwitcher />
          </div>
          <button className="icon-btn" onClick={() => go("new")} aria-label="New thread" title="New thread" data-testid="new-thread">
            <PlusIcon />
          </button>
        </header>
        <nav className="sidebar-nav">
          <button className="nav-item search" onClick={() => setJump(true)} data-testid="open-quick-jump">
            <SearchIcon />
            <span>Search</span>
            <kbd>{mac ? "⌘K" : "Ctrl K"}</kbd>
          </button>
          <a href="#" className={`nav-item ${route.name === "home" ? "active" : ""}`} data-testid="nav-home">
            <HomeIcon />
            <span>Home</span>
            {needsYou ? <span className="nav-count">{needsYou}</span> : null}
          </a>
        </nav>
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
        {route.name === "home" ? (
          <Home me={me} onSearch={() => setJump(true)} />
        ) : route.name === "thread" ? (
          <ThreadView key={route.id} id={route.id} />
        ) : route.name === "new" ? (
          <NewThread />
        ) : route.name === "memory" ? (
          <MemoryPage />
        ) : route.name === "settings" ? (
          <SettingsPage section={route.section} me={me} user={user} reload={loadMe} />
        ) : (
          <Home me={me} onSearch={() => setJump(true)} />
        )}
      </main>
      {jump ? <QuickJump threads={threads} onClose={() => setJump(false)} /> : null}
    </div>
  );
}
