import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, onEvent, type Action, type FileInfo, type Message, type ThreadDetail } from "../api";
import { BROWSER_HIDDEN_ARGS, browserPage, dateTime, isBrowserTool, prettyDates, shortTime, stepOutcome, stepSubject, toolLabel, unframe } from "../format";
import { cjkLang, Markdown, StreamingMarkdown } from "../markdown";
import { go } from "../route";
import { ActionCard } from "./ActionCard";
import { Attachments, FileViewer } from "./Attachments";
import { Composer } from "./Composer";
import { Eyes, nowLine } from "./Eyes";
import { ProcedureCard } from "./ProcedureCard";
import { BrowserAsk } from "./BrowserAsk";
import { BrowserView, SHEET_QUERY, SidePanel } from "./SidePanel";
import { CardSlot } from "../cards/CardSlot";
import { cachedThread, fetchThread, forgetThread, rememberThread } from "../thread-cache";
import { Status } from "../cards/Frame";
import type { Card } from "@vireo/protocol";
import { AlertIcon, ArrowUpRightIcon, BellIcon, CheckIcon, ChevronLeft, ChevronRight, ClockIcon, MemoryIcon, PanelIcon, StatusIcon } from "../icons";

type Item =
  | { kind: "user"; m: Extract<Message, { role: "user" }> }
  | { kind: "assistant"; m: Extract<Message, { role: "assistant" }> }
  | { kind: "steps"; key: string; steps: { name: string; args: Record<string, unknown>; result?: Extract<Message, { role: "tool" }> }[] }
  | { kind: "notice"; m: Extract<Message, { role: "notice" }> };

function buildItems(messages: Message[]): Item[] {
  const items: Item[] = [];
  const results = new Map<string, Extract<Message, { role: "tool" }>>();
  for (const m of messages) if (m.role === "tool") results.set(m.toolCallId, m);
  let steps: Extract<Item, { kind: "steps" }> | null = null;
  for (const m of messages) {
    if (m.role === "tool") continue;
    if (m.role === "assistant") {
      if (m.text.trim()) {
        steps = null;
        items.push({ kind: "assistant", m });
      }
      if (m.toolCalls.length) {
        if (!steps) {
          steps = { kind: "steps", key: `s${m.id}`, steps: [] };
          items.push(steps);
        }
        for (const c of m.toolCalls) steps.steps.push({ name: c.name, args: c.args, result: results.get(c.id) });
      }
      continue;
    }
    steps = null;
    if (m.role === "user") items.push({ kind: "user", m });
    else items.push({ kind: "notice", m });
  }
  return items;
}

type Placed = Item | { card: Card } | { files: FileInfo[] };

/**
 * Puts each card in the conversation at the end of the turn that last
 * changed it, so the latest state of the matter stays next to the talk about
 * it instead of at the top of the page. Files Vireo made in a turn go there
 * too, under its reply.
 */
function placeCards(items: Item[], cards: Card[], files: FileInfo[]): Placed[] {
  const out: Placed[] = [];
  const pending = [
    ...cards.map((card) => ({ at: card.updatedAt, card })),
    ...files.map((file) => ({ at: file.createdAt, file })),
  ].sort((a, b) => a.at - b.at);
  const flush = (before: number) => {
    while (pending.length && pending[0]!.at < before) {
      const next = pending.shift()!;
      if ("card" in next) out.push({ card: next.card });
      else {
        const last = out.at(-1);
        if (last && "files" in last) last.files.push(next.file);
        else out.push({ files: [next.file] });
      }
    }
  };
  for (const it of items) {
    if (it.kind === "user") flush(it.m.createdAt);
    out.push(it);
  }
  flush(Infinity);
  return out;
}

/**
 * A slim bar pinned to the top of the conversation while a card is out of
 * view: its name and status, and a tap brings it back.
 */
function CardDock({ cards, scroller }: { cards: Card[]; scroller: React.RefObject<HTMLDivElement | null> }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) =>
        setHidden((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const id = (e.target as HTMLElement).dataset.cardId!;
            if (e.isIntersecting) next.delete(id);
            else next.add(id);
          }
          // Re-observing reports every card again; keep the same set when nothing moved.
          return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
        }),
      { root, rootMargin: "-48px 0px 0px 0px" },
    );
    for (const el of root.querySelectorAll<HTMLElement>("[data-card-id]")) io.observe(el);
    return () => io.disconnect();
  }, [cards, scroller]);
  const away = cards.filter((c) => hidden.has(c.id) && c.status !== "done").sort((a, b) => b.updatedAt - a.updatedAt);
  if (!away.length) return null;
  const go = (id: string) => scroller.current?.querySelector(`[data-card-id="${id}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  return (
    <div className="card-dock" data-testid="card-dock">
      {away.slice(0, 2).map((c) => (
        <button key={c.id} className={`card-dock-item ${c.status}`} onClick={() => go(c.id)}>
          <span className="card-dock-title">{c.title}</span>
          {c.status === "needs_you" ? <Eyes state="needs" /> : <Status card={c} />}
        </button>
      ))}
    </div>
  );
}

interface Live {
  streamId: string;
  text: string;
  thinking: string;
  /** The model has finished; the text stays on screen until a load brings the saved message. */
  ended?: boolean;
}

/**
 * Whether a finished stream can leave the page: its message is in what was
 * loaded (the node saves it only after the stream ends, so the first reload
 * can miss it), it streamed no text, or the run is over. Dropping it any
 * sooner blanks the answer until the next reload.
 */
function settled(l: Live, d: ThreadDetail): boolean {
  const text = l.text.trim();
  if (!text || !d.thread.running) return true;
  return d.messages.some((m) => m.role === "assistant" && m.text.trim() === text);
}

export function ThreadView({ id }: { id: string }) {
  // A thread seen lately shows at once from what was loaded then, while a fresh copy loads.
  const [detail, setDetail] = useState<ThreadDetail | null>(() => cachedThread(id));
  const [error, setError] = useState("");
  const [live, setLive] = useState<Live | null>(null);
  const [liveSteps, setLiveSteps] = useState<{ tool: string; status: string }[]>([]); // only to notice browsing
  // The owner's own open/close for this thread; until they choose, the panel follows its content.
  const [panelChoice, setPanelChoice] = useState<boolean | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [viewing, setViewing] = useState<FileInfo | null>(null);
  // The browser full size over the thread, for doing what Vireo asked there.
  const [browserOpen, setBrowserOpen] = useState(false);
  // What the owner just sent, shown before the node has it.
  const [sending, setSending] = useState<{ text: string; files: string[]; after: number } | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const reloadTimer = useRef<number | undefined>(undefined);
  // Loads can finish out of order on a slow connection; only the newest one counts.
  const loadSeq = useRef(0);
  // What the last load brought, so the next asks only for what changed after it.
  const latest = useRef(detail);

  const browsing = Boolean(detail?.thread.running) && liveSteps.some((s) => s.tool.startsWith("browser_"));
  useEffect(() => setPanelChoice(null), [id]);
  // When the agent starts working in the browser the live view opens, whatever was chosen
  // before; closing it then keeps it closed. On a phone it would cover the conversation, so it waits to be asked for.
  useEffect(() => {
    if (browsing && !window.matchMedia(SHEET_QUERY).matches) setPanelChoice(true);
  }, [browsing]);
  const panel = panelChoice ?? panelAuto(detail);

  // What Vireo is paused on for the owner to do in its browser, if anything.
  const asking = useMemo(() => {
    if (!detail?.thread.running) return undefined;
    const n = detail.messages.findLast((m) => m.role === "notice" && m.kind === "browser_request");
    return n?.role === "notice" && n.data?.state === "waiting" ? { id: n.id, request: n.text } : undefined;
  }, [detail]);
  // A new ask opens the browser full size where there is room for it (or when the owner came from
  // a notification or the board to do it); it closes once the ask is settled.
  const fromLink = useRef(false);
  const [linked, setLinked] = useState(0);
  useEffect(() => {
    const check = () => {
      if (!location.hash.includes("?browser")) return;
      fromLink.current = true;
      history.replaceState(null, "", `#thread/${encodeURIComponent(id)}`);
      setLinked((n) => n + 1);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, [id]);
  useEffect(() => {
    if (!asking) return setBrowserOpen(false);
    if (fromLink.current || (!window.matchMedia(SHEET_QUERY).matches && document.visibilityState === "visible")) setBrowserOpen(true);
    fromLink.current = false;
  }, [id, asking?.id, linked]);

  const setPanel = useCallback((open: boolean) => {
    setPanelChoice(open);
    localStorage.setItem(PANEL_KEY, open ? "open" : "closed");
  }, []);
  const closePanel = useCallback(() => setPanel(false), [setPanel]);
  const openBrowser = useCallback(() => setBrowserOpen(true), []);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const d = await fetchThread(id, latest.current);
      if (seq !== loadSeq.current) return;
      latest.current = d;
      // In the same render as the new detail, so the answer never blinks out between the two.
      setDetail(d);
      rememberThread(d);
      setLive((l) => (l?.ended && settled(l, d) ? null : l));
      setError("");
      if (!d.thread.running) setLiveSteps([]);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) forgetThread(id);
      setError(err instanceof ApiError && err.status === 404 ? "This thread no longer exists." : String(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
    // Text arrives a token at a time; it is drawn once a frame, not once a token.
    let pending: { streamId: string; text: string; thinking: string } | null = null;
    let frame = 0;
    const flush = () => {
      frame = 0;
      const p = pending;
      pending = null;
      if (p) setLive((l) => (l && l.streamId === p.streamId ? { ...l, text: l.text + p.text, thinking: l.thinking + p.thinking } : l));
    };
    const off = onEvent((e) => {
      if ("threadId" in e && e.threadId !== id && e.threadId !== "*") return;
      switch (e.type) {
        case "message.stream_start":
          flush();
          setLive({ streamId: e.streamId, text: "", thinking: "" });
          break;
        case "message.delta":
          if (pending && pending.streamId !== e.streamId) flush();
          pending ??= { streamId: e.streamId, text: "", thinking: "" };
          if (e.kind === "text") pending.text += e.delta;
          else pending.thinking += e.delta;
          frame ||= requestAnimationFrame(flush);
          break;
        case "message.stream_end":
          cancelAnimationFrame(frame);
          flush();
          setLive((l) => (l?.streamId === e.streamId ? { ...l, ended: true } : l));
          void load();
          break;
        case "step":
          setLiveSteps((s) => {
            const i = s.findIndex((x) => x.tool === e.step.tool && x.status === "running");
            if (e.step.status === "running") return [...s, { tool: e.step.tool, status: "running" }];
            if (i === -1) return s;
            const copy = [...s];
            copy[i] = { tool: e.step.tool, status: e.step.status };
            return copy;
          });
          break;
        case "thread.deleted":
          go("");
          break;
        default:
          window.clearTimeout(reloadTimer.current);
          reloadTimer.current = window.setTimeout(() => void load(), 80);
      }
    });
    return () => {
      off();
      cancelAnimationFrame(frame);
    };
  }, [id, load]);

  const items = useMemo(() => (detail ? buildItems(detail.messages) : []), [detail]);
  // The steps of the turn in progress live in the "now" line instead of their own row.
  const lastItem = items.at(-1);
  const trailing = lastItem?.kind === "steps" ? lastItem.steps : [];
  const shown = useMemo(() => (items.at(-1)?.kind === "steps" ? items.slice(0, -1) : items), [items]);
  const actions = useMemo(() => new Map<string, Action>((detail?.actions ?? []).map((a) => [a.id, a])), [detail]);
  const filesById = useMemo(() => new Map<string, FileInfo>((detail?.files ?? []).map((f) => [f.id, f])), [detail]);
  // Files Vireo made for the owner, not screenshots taken along the way or files a card already shows.
  const made = useMemo(() => {
    if (!detail) return [];
    const kinds = new Map(detail.related.filter((r) => r.ref).map((r) => [r.ref!, r.kind]));
    const onCards = new Set(detail.cards.map((c) => String(c.data.file_id ?? "")));
    return detail.files.filter((f) => f.origin === "produced" && kinds.get(f.id) === "file" && !onCards.has(f.id));
  }, [detail]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, live, liveSteps, sending]);

  // The sent message stays until a load brings the node's copy of it.
  const userCount = useMemo(() => (detail?.messages ?? []).filter((m) => m.role === "user").length, [detail]);
  useEffect(() => {
    if (sending && userCount > sending.after) setSending(null);
  }, [sending, userCount]);
  const retry = useCallback(() => void api.post(`/api/threads/${id}/retry`).then(load), [id, load]);

  if (error) {
    return (
      <div className="thread-view">
        <div className="empty">{error}</div>
      </div>
    );
  }
  if (!detail) return <ThreadSkeleton />;
  const t = detail.thread;
  const isOverview = t.id === "overview";

  const send = async (text: string, files: File[]) => {
    stick.current = true;
    setSending({ text, files: files.map((f) => f.name), after: userCount });
    try {
      let fileIds: string[] = [];
      if (files.length) fileIds = (await api.upload(t.id, files)).files.map((f) => f.id);
      await api.post(`/api/threads/${t.id}/messages`, { text, fileIds });
    } catch (err) {
      setSending(null);
      throw err;
    }
    void load();
  };

  const rename = async (title: string) => {
    setEditingTitle(false);
    if (title.trim() && title !== t.title) {
      await api.patch(`/api/threads/${t.id}`, { title: title.trim() });
      void load();
    }
  };

  return (
    <div className={`thread-view ${panel ? "with-panel" : ""}`} data-testid="thread-view" data-thread-id={t.id}>
      <header className="topbar">
        <a href="#" className="back" aria-label="Back to threads">
          <ChevronLeft />
        </a>
        <span className="crumbs">
          <span className="crumb-root">{isOverview ? "Vireo" : "Threads"}</span>
          <span className="crumb-sep">/</span>
          <span className="crumb-here">{t.title}</span>
        </span>
        <div className="head-actions">
          {isOverview ? null : t.state === "done" ? (
            <button className="btn ghost small" onClick={() => void api.post(`/api/threads/${t.id}/reopen`).then(load)}>
              Reopen
            </button>
          ) : (
            <button className="btn ghost small" onClick={() => void api.post(`/api/threads/${t.id}/done`).then(load)} data-testid="mark-done">
              <CheckIcon />
              Done
            </button>
          )}
          <button className={`btn ghost small ${panel ? "on" : ""}`} onClick={() => setPanel(!panel)} aria-label="Details" title="Details" data-testid="toggle-panel">
            <PanelIcon />
          </button>
        </div>
      </header>

      <div className="thread-body">
        <div className="thread-main">
          <div
            className="conversation"
            ref={scroller}
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            <div className="conversation-inner">
              <div className="page-head">
                {editingTitle ? (
                  <input
                    className="title-input"
                    defaultValue={t.title}
                    autoFocus
                    onBlur={(e) => void rename(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void rename((e.target as HTMLInputElement).value);
                      if (e.key === "Escape") setEditingTitle(false);
                    }}
                  />
                ) : (
                  <h1 onClick={() => !isOverview && setEditingTitle(true)} title={isOverview ? undefined : "Rename"} data-testid="thread-title">
                    {t.title}
                  </h1>
                )}
                {isOverview ? (
                  <p className="page-sub">Quick questions, answered here.</p>
                ) : (
                  <dl className="props">
                    <div>
                      <dt>
                        <StatusIcon />
                        Status
                      </dt>
                      <dd>
                        <StatusTag t={t} />
                        {t.temporary ? <span className="tag">Temporary</span> : null}
                      </dd>
                    </div>
                    <div>
                      <dt>
                        <ClockIcon />
                        Started
                      </dt>
                      <dd>{dateTime(t.createdAt)}</dd>
                    </div>
                  </dl>
                )}
              </div>
              <CardDock cards={detail.cards ?? []} scroller={scroller} />
              {items.length === 0 && !live ? (
                <div className="empty">{isOverview ? "Ask anything." : "No messages yet."}</div>
              ) : null}
              <History
                items={t.running || live ? shown : items}
                last={items.at(-1)}
                cards={detail.cards ?? NO_CARDS}
                made={made}
                actions={actions}
                files={filesById}
                onOpen={setViewing}
                onOpenBrowser={openBrowser}
                threadId={t.id}
                running={t.running}
                onChange={load}
                retry={!t.running && !live ? retry : undefined}
              />
              {sending ? (
                <div className="msg user sending" data-testid="msg-user">
                  {sending.files.length ? <div className="sending-files">{sending.files.join(", ")}</div> : null}
                  {sending.text ? <div className="bubble" lang={cjkLang(sending.text)}>{sending.text}</div> : null}
                </div>
              ) : null}
              {t.running || live || sending ? (
                <div className="msg assistant live" data-testid="live">
                  {/* While working: one line saying what is happening now; when done it becomes the folded summary. */}
                  <Steps steps={trailing} now={live?.text ? undefined : asking || t.pendingActions > 0 ? "Waiting for you" : nowLine(t.statusLine) || "Working"} waiting={Boolean(asking) || t.pendingActions > 0} />
                  {live?.text ? <StreamingMarkdown text={live.text} /> : null}
                </div>
              ) : null}
            </div>
          </div>
          <Composer
            onSend={send}
            running={t.running}
            onStop={() => void api.post(`/api/threads/${t.id}/stop`)}
            placeholder={t.state === "done" ? "Message to reopen this thread" : isOverview ? "Ask Vireo anything" : "Message Vireo"}
          />
        </div>
        {panel ? <Panel detail={detail} running={t.running} browsing={browsing} asking={asking?.request} onClose={closePanel} onOpenFile={setViewing} /> : null}
      </div>
      {browserOpen ? <BrowserView threadId={t.id} running={t.running} asking={asking?.request} overlay onClose={() => setBrowserOpen(false)} /> : null}
      {viewing ? <FileViewer file={viewing} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

const PANEL_KEY = "vireo.panel";
const NO_CARDS: Card[] = [];

// The panel only changes with the thread, not with each frame of a streamed answer.
const Panel = memo(SidePanel);

/** Where a thread will be while its first load is on the way. */
function ThreadSkeleton() {
  return (
    <div className="thread-view loading" aria-busy="true">
      <div className="conversation">
        <div className="conversation-inner">
          <div className="skeleton title" />
          <div className="skeleton line" />
          <div className="skeleton line short" />
        </div>
      </div>
    </div>
  );
}

/**
 * The conversation so far. Kept apart from the answer being streamed, so a
 * new token redraws only that answer, not every message above it.
 */
const History = memo(function History({
  items,
  last,
  cards,
  made,
  actions,
  files,
  onOpen,
  onOpenBrowser,
  threadId,
  running,
  onChange,
  retry,
}: {
  items: Item[];
  last: Item | undefined;
  cards: Card[];
  made: FileInfo[];
  actions: Map<string, Action>;
  files: Map<string, FileInfo>;
  onOpen: (f: FileInfo) => void;
  onOpenBrowser: () => void;
  threadId: string;
  running: boolean;
  onChange: () => void;
  retry?: () => void;
}) {
  return (
    <>
      {placeCards(items, cards, made).map((it) =>
        "files" in it ? (
          <Attachments key={`files${it.files[0]!.id}`} files={it.files} onOpen={onOpen} produced />
        ) : "card" in it ? (
          <div key={`card${it.card.id}`} className="thread-cards" data-testid="thread-cards" data-card-id={it.card.id}>
            <CardSlot card={it.card} expanded refresh={onChange} />
          </div>
        ) : (
          <ItemView
            key={it.kind === "steps" ? it.key : `${it.kind}${it.m.id}`}
            item={it}
            actions={actions}
            files={files}
            onOpen={onOpen}
            onOpenBrowser={onOpenBrowser}
            threadId={threadId}
            running={running}
            onChange={onChange}
            // A run that ended in an error can be tried again, as long as nothing came after it.
            retry={it === last ? retry : undefined}
          />
        ),
      )}
    </>
  );
});

/**
 * The details panel opens by itself only when it has something to show (pages
 * read, files, emails, events) and the owner hasn't closed it before; an empty
 * panel would only take room from the conversation. On phones it is a sheet
 * and stays closed until asked for.
 */
function panelAuto(detail: ThreadDetail | null): boolean {
  if (!detail || window.matchMedia(SHEET_QUERY).matches) return false;
  if (localStorage.getItem(PANEL_KEY) === "closed") return false;
  return detail.related.length > 0 || detail.files.length > 0;
}

function StatusTag({ t }: { t: ThreadDetail["thread"] }) {
  if (t.state === "done") return <span className="tag green">Done</span>;
  // While it runs, the live line at the foot of the conversation is the one place that says so.
  if (!t.running && (t.needsYou || t.pendingActions > 0)) return <span className="tag orange">Needs you</span>;
  return <span className="tag">In hand</span>;
}

function ItemView({
  item,
  actions,
  files,
  onOpen,
  onOpenBrowser,
  threadId,
  running,
  onChange,
  retry,
}: {
  item: Item;
  actions: Map<string, Action>;
  files: Map<string, FileInfo>;
  onOpen: (f: FileInfo) => void;
  onOpenBrowser: () => void;
  threadId: string;
  running: boolean;
  onChange: () => void;
  retry?: () => void;
}) {
  switch (item.kind) {
    case "user": {
      const attached = (item.m.fileIds ?? []).map((id) => files.get(id)).filter((f): f is FileInfo => Boolean(f));
      // Attached images are shown from their files; inline copies remain for messages from chat apps.
      const inline = attached.some((f) => f.mime.startsWith("image/")) ? [] : item.m.images;
      return item.m.fromVireo ? (
        <div className="msg vireo-task" data-testid="vireo-task">
          <span className="label">Vireo picked this up</span>
          <Markdown text={item.m.text} />
        </div>
      ) : (
        <div className="msg user" data-testid="msg-user">
          {inline.map((src, i) => (
            <img key={i} src={src} alt="" className="msg-image" />
          ))}
          <Attachments files={attached} onOpen={onOpen} />
          {item.m.text ? <div className="bubble" lang={cjkLang(item.m.text)}>{item.m.text}</div> : null}
        </div>
      );
    }
    case "assistant":
      return (
        <div className="msg assistant" data-testid="msg-assistant">
          <Markdown text={item.m.text} />
          <span className="meta" title={dateTime(item.m.createdAt)}>
            {shortTime(item.m.createdAt)}
          </span>
        </div>
      );
    case "steps":
      return <Steps steps={item.steps} />;
    case "notice": {
      const n = item.m;
      if (n.kind === "action") {
        const a = actions.get(String(n.data?.actionId));
        return a ? <ActionCard action={a} onChange={onChange} /> : null;
      }
      if (n.kind === "browser_request") {
        // An ask still marked waiting in a thread that no longer runs was cut off (a restart).
        const state = String(n.data?.state ?? "");
        return <BrowserAsk threadId={threadId} request={n.text} state={state === "waiting" && !running ? "stopped" : state} since={n.createdAt} onOpen={onOpenBrowser} />;
      }
      if (n.kind === "procedure") return <ProcedureCard id={String(n.data?.procedureId)} text={n.text} onChange={onChange} />;
      if (n.kind === "thread_link") {
        return (
          <div className="notice">
            <a href={`#thread/${String(n.data?.threadId)}`}>
              {n.text}
              <ArrowUpRightIcon />
            </a>
          </div>
        );
      }
      if (n.kind === "remembered") return <Remembered facts={(n.data?.facts as Learned[] | undefined) ?? []} onChange={onChange} />;
      if (n.kind === "action_result") {
        const short = n.text.replace(/\. Result:[\s\S]*$/, "").replace(/\. Do not retry[\s\S]*$/, "");
        return <div className="notice">{prettyDates(short.replace(/^The owner /, "You "))}</div>;
      }
      return (
        <div className={`notice ${n.kind}`} data-testid={`notice-${n.kind}`}>
          {n.kind === "reminder" ? <BellIcon /> : n.kind === "error" ? <AlertIcon /> : null}
          <span>{n.text}</span>
          {n.kind === "error" && retry ? (
            n.text.startsWith("No model is configured") ? (
              <a className="btn ghost small" href="#settings/model">
                Open settings
              </a>
            ) : (
              <button className="btn ghost small" onClick={retry} data-testid="retry">
                Try again
              </button>
            )
          ) : null}
        </div>
      );
    }
  }
}

type Learned = { id: string; statement: string; forgotten?: boolean };

/** What Vireo now remembers from this thread, each fact one tap from being taken back. */
function Remembered({ facts, onChange }: { facts: Learned[]; onChange: () => void }) {
  if (facts.length === 0) return null;
  return (
    <div className="remembered" data-testid="remembered">
      <span className="remembered-head">
        <MemoryIcon />
        Remembered
      </span>
      <ul>
        {facts.map((f) => (
          <li key={f.id} className={f.forgotten ? "forgotten" : ""}>
            <span className="statement">{f.statement}</span>
            {f.forgotten ? (
              <span className="state">Forgotten</span>
            ) : (
              <button className="link" onClick={() => void api.del(`/api/memory/facts/${f.id}`).then(onChange)} data-testid="forget-fact">
                Forget
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the agent did between messages, folded to one quiet line: the process
 * is not what the owner came for. Opening it lists each step with its
 * subject and outcome; a step opens to its full arguments and result.
 */
function Steps({ steps, now, waiting }: { steps: { name: string; args: Record<string, unknown>; result?: Extract<Message, { role: "tool" }> }[]; now?: string; waiting?: boolean }) {
  const [open, setOpen] = useState(false);
  // Handoffs are plumbing, and a shown card is already on the page above.
  const visible = steps.filter((s) => !s.name.startsWith("transfer_to_") && s.name !== "show_card");
  if (visible.length === 0 && !now) return null;
  const labels = [...new Set(visible.map((s) => toolLabel(s.name)))];
  const failed = visible.some((s) => s.result?.isError);
  return (
    <div className={`steps ${now ? "now" : ""}`} data-testid="steps">
      <button className="steps-toggle" onClick={() => visible.length && setOpen(!open)} aria-expanded={open}>
        {now ? (
          <Eyes state={waiting ? "needs" : "working"} />
        ) : (
          <span className={`chev ${open ? "open" : ""}`}>
            <ChevronRight />
          </span>
        )}
        <span className="steps-label">{now ?? `${labels.slice(0, 3).join(" · ")}${labels.length > 3 ? ` · +${labels.length - 3}` : ""}`}</span>
        {visible.length ? <span className={`count ${failed ? "error" : ""}`}>{now ? `${visible.length} done` : visible.length}</span> : null}
      </button>
      {open ? (
        <ol className="step-list">
          {visible.map((s, i) => (
            <Step key={i} step={s} />
          ))}
        </ol>
      ) : null}
    </div>
  );
}

function Step({ step: s }: { step: { name: string; args: Record<string, unknown>; result?: Extract<Message, { role: "tool" }> } }) {
  const [open, setOpen] = useState(false);
  const state = !s.result ? "running" : s.result.isError ? "error" : s.result.awaitingConfirmation ? "pending" : "ok";
  const subject = stepSubject(s.args);
  const outcome = s.result ? stepOutcome(s.result.text) : "Running…";
  // A browser step's result is the page tree the model acts on; the owner gets where it landed.
  const browser = isBrowserTool(s.name);
  const page = browser && !s.result?.isError ? browserPage(s.result?.text) : null;
  const args = browser ? Object.fromEntries(Object.entries(s.args).filter(([k]) => !BROWSER_HIDDEN_ARGS.has(k))) : s.args;
  return (
    <li className={`step ${state}`}>
      <button className="step-line" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="step-mark" aria-label={state}>
          {state === "running" ? "◌" : state === "error" ? "✕" : state === "pending" ? "•" : "✓"}
        </span>
        <span className="step-text">
          <span className="step-name">{toolLabel(s.name)}</span>
          {subject ? <span className="step-subject">{subject}</span> : null}
          {outcome ? <span className="step-outcome">{outcome}</span> : null}
        </span>
      </button>
      {open ? (
        <div className="step-detail">
          <div className="step-args">
            <Fields value={args} />
          </div>
          {page ? (
            <div className="step-result">
              <Fields value={page.title ? { page: page.title, url: page.url } : { url: page.url }} />
            </div>
          ) : s.result ? (
            <div className="step-result">
              <Fields value={parseJson(unframe(s.result.text))} />
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function parseJson(text: string): unknown {
  const t = text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return text;
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}

/** Renders tool arguments and JSON results as readable label/value lines instead of raw JSON. */
function Fields({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span className="muted">—</span>;
  if (typeof value !== "object") return <span className="field-text">{String(value)}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="muted">None</span>;
    if (value.every((v) => v === null || typeof v !== "object")) return <span className="field-text">{value.join(", ")}</span>;
    return (
      <ul className="field-list">
        {value.map((v, i) => (
          <li key={i}>
            <Fields value={v} />
          </li>
        ))}
      </ul>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className="muted">No details</span>;
  return (
    <dl className="fields">
      {entries.map(([k, v]) => (
        <div key={k}>
          <dt>{k.replace(/_/g, " ")}</dt>
          <dd>
            <Fields value={v} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
