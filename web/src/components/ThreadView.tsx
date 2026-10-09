import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, onEvent, type Action, type Message, type ThreadDetail } from "../api";
import { dateTime, prettyDates, shortTime, stepOutcome, stepSubject, toolLabel } from "../format";
import { Markdown } from "../markdown";
import { go } from "../route";
import { ActionCard } from "./ActionCard";
import { Composer } from "./Composer";
import { ProcedureCard } from "./ProcedureCard";
import { SidePanel } from "./SidePanel";
import { CardSlot } from "../cards/CardSlot";
import { AlertIcon, ArrowUpRightIcon, BellIcon, CheckIcon, ChevronLeft, ChevronRight, ClockIcon, PanelIcon, StatusIcon, BriefIcon } from "../icons";

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

interface Live {
  streamId: string;
  text: string;
  thinking: string;
}

export function ThreadView({ id }: { id: string }) {
  const [detail, setDetail] = useState<ThreadDetail | null>(null);
  const [error, setError] = useState("");
  const [live, setLive] = useState<Live | null>(null);
  const [liveSteps, setLiveSteps] = useState<{ tool: string; status: string }[]>([]); // only to notice browsing
  const [panel, setPanelState] = useState(panelDefault);
  const [editingTitle, setEditingTitle] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const reloadTimer = useRef<number | undefined>(undefined);

  // While the agent works in the browser, show the live view (without changing the saved panel choice).
  const browsing = Boolean(detail?.thread.running) && liveSteps.some((s) => s.tool.startsWith("browser_"));
  useEffect(() => {
    if (browsing) setPanelState(true);
  }, [browsing]);

  const setPanel = (open: boolean) => {
    setPanelState(open);
    localStorage.setItem(PANEL_KEY, open ? "open" : "closed");
  };

  const load = useCallback(async () => {
    try {
      const d = await api.get<ThreadDetail>(`/api/threads/${id}`);
      setDetail(d);
      setError("");
      if (!d.thread.running) setLiveSteps([]);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? "This thread no longer exists." : String(err));
    }
  }, [id]);

  useEffect(() => {
    void load();
    return onEvent((e) => {
      if ("threadId" in e && e.threadId !== id && e.threadId !== "*") return;
      switch (e.type) {
        case "message.stream_start":
          setLive({ streamId: e.streamId, text: "", thinking: "" });
          break;
        case "message.delta":
          setLive((l) =>
            l && l.streamId === e.streamId
              ? { ...l, text: e.kind === "text" ? l.text + e.delta : l.text, thinking: e.kind === "thinking" ? l.thinking + e.delta : l.thinking }
              : l,
          );
          break;
        case "message.stream_end":
          window.setTimeout(() => setLive((l) => (l?.streamId === e.streamId ? null : l)), 50);
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
  }, [id, load]);

  const items = useMemo(() => (detail ? buildItems(detail.messages) : []), [detail]);
  // The steps of the turn in progress live in the "now" line instead of their own row.
  const lastItem = items.at(-1);
  const trailing = lastItem?.kind === "steps" ? lastItem.steps : [];
  const shown = lastItem?.kind === "steps" ? items.slice(0, -1) : items;
  const actions = useMemo(() => new Map<string, Action>((detail?.actions ?? []).map((a) => [a.id, a])), [detail]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items, live, liveSteps]);

  if (error) {
    return (
      <div className="thread-view">
        <div className="empty">{error}</div>
      </div>
    );
  }
  if (!detail) return <div className="thread-view" />;
  const t = detail.thread;
  const isOverview = t.id === "overview";

  const send = async (text: string, files: File[]) => {
    stick.current = true;
    let fileIds: string[] = [];
    if (files.length) fileIds = (await api.upload(t.id, files)).files.map((f) => f.id);
    await api.post(`/api/threads/${t.id}/messages`, { text, fileIds });
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
          {isOverview ? (
            <button className="btn ghost small" onClick={() => void api.post("/api/brief")} aria-label="Brief me now" title="Brief me now" data-testid="brief-now">
              <BriefIcon />
            </button>
          ) : t.state === "done" ? (
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
                  <p className="page-sub">Quick questions and your morning brief.</p>
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
              {detail.cards?.length ? (
                <div className="thread-cards" data-testid="thread-cards">
                  {detail.cards.map((c) => (
                    <CardSlot key={c.id} card={c} expanded refresh={load} />
                  ))}
                </div>
              ) : null}
              {items.length === 0 && !live ? (
                <div className="empty">{isOverview ? "Ask anything. Your morning brief lands here too." : "No messages yet."}</div>
              ) : null}
              {(t.running || live ? shown : items).map((it) => (
                <ItemView key={it.kind === "steps" ? it.key : `${it.kind}${it.m.id}`} item={it} actions={actions} onChange={load} />
              ))}
              {t.running || live ? (
                <div className="msg assistant live" data-testid="live">
                  {/* While working: one line saying what is happening now; when done it becomes the folded summary. */}
                  <Steps steps={trailing} now={live?.text ? undefined : t.statusLine || "Working…"} />
                  {live?.text ? <Markdown text={live.text} /> : null}
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
        {panel ? <SidePanel detail={detail} running={t.running} browsing={browsing} onClose={() => setPanel(false)} /> : null}
      </div>
    </div>
  );
}

const PANEL_KEY = "vireo.panel";

/** The details panel starts open on wide screens unless the owner closed it; on phones it is a sheet and starts closed. */
function panelDefault(): boolean {
  if (window.matchMedia("(max-width: 760px)").matches) return false;
  return localStorage.getItem(PANEL_KEY) !== "closed";
}

function StatusTag({ t }: { t: ThreadDetail["thread"] }) {
  if (t.state === "done") return <span className="tag green">Done</span>;
  if (t.running) return <span className="tag blue">Working</span>;
  if (t.needsYou) return <span className="tag orange">Needs you</span>;
  return <span className="tag">In progress</span>;
}

function ItemView({ item, actions, onChange }: { item: Item; actions: Map<string, Action>; onChange: () => void }) {
  switch (item.kind) {
    case "user":
      return item.m.fromVireo ? (
        <div className="msg vireo-task" data-testid="vireo-task">
          <span className="label">Vireo picked this up</span>
          <Markdown text={item.m.text} />
        </div>
      ) : (
        <div className="msg user" data-testid="msg-user">
          {item.m.images.map((src, i) => (
            <img key={i} src={src} alt="" className="msg-image" />
          ))}
          <div className="bubble">{item.m.text}</div>
        </div>
      );
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
      if (n.kind === "action_result") {
        const short = n.text.replace(/\. Result:[\s\S]*$/, "").replace(/\. Do not retry[\s\S]*$/, "");
        return <div className="notice">{prettyDates(short.replace(/^The owner /, "You "))}</div>;
      }
      return (
        <div className={`notice ${n.kind}`} data-testid={`notice-${n.kind}`}>
          {n.kind === "reminder" ? <BellIcon /> : n.kind === "error" ? <AlertIcon /> : null}
          <span>{n.text}</span>
        </div>
      );
    }
  }
}

/**
 * What the agent did between messages, folded to one quiet line: the process
 * is not what the owner came for. Opening it lists each step with its
 * subject and outcome; a step opens to its full arguments and result.
 */
function Steps({ steps, now }: { steps: { name: string; args: Record<string, unknown>; result?: Extract<Message, { role: "tool" }> }[]; now?: string }) {
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
          <span className="now-dot" aria-hidden="true" />
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
            <Fields value={s.args} />
          </div>
          {s.result ? (
            <div className="step-result">
              <Fields value={parseJson(s.result.text)} />
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
