import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, onEvent, type Action, type Message, type ThreadDetail } from "../api";
import { dateTime, prettyDates, toolLabel } from "../format";
import { Markdown } from "../markdown";
import { go } from "../route";
import { ActionCard } from "./ActionCard";
import { Composer } from "./Composer";
import { ProcedureCard } from "./ProcedureCard";
import { SidePanel } from "./SidePanel";

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
  const [liveSteps, setLiveSteps] = useState<{ tool: string; status: string }[]>([]);
  const [panel, setPanel] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const reloadTimer = useRef<number | undefined>(undefined);

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
      <header className="thread-head">
        <a href="#" className="back" aria-label="Back to threads">
          ‹
        </a>
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
          <h2 onClick={() => !isOverview && setEditingTitle(true)} title={isOverview ? undefined : "Rename"} data-testid="thread-title">
            {t.title}
            {t.temporary ? <span className="tag">temporary</span> : null}
            {t.state === "done" ? <span className="tag done">done</span> : null}
          </h2>
        )}
        <div className="head-actions">
          {isOverview ? (
            <button className="btn small" onClick={() => void api.post("/api/brief")} data-testid="brief-now">
              Brief me
            </button>
          ) : t.state === "done" ? (
            <button className="btn small" onClick={() => void api.post(`/api/threads/${t.id}/reopen`).then(load)}>
              Reopen
            </button>
          ) : (
            <button className="btn small" onClick={() => void api.post(`/api/threads/${t.id}/done`).then(load)} data-testid="mark-done">
              Done
            </button>
          )}
          <button className={`btn small ghost ${panel ? "on" : ""}`} onClick={() => setPanel(!panel)} aria-label="Details" data-testid="toggle-panel">
            Details
          </button>
        </div>
      </header>

      <div className="thread-body">
        <div
          className="conversation"
          ref={scroller}
          onScroll={(e) => {
            const el = e.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
        >
          <div className="conversation-inner">
            {items.length === 0 && !live ? (
              <div className="empty">{isOverview ? "Ask anything. Your morning brief lands here too." : "No messages yet."}</div>
            ) : null}
            {items.map((it) => (
              <ItemView key={it.kind === "steps" ? it.key : `${it.kind}${it.m.id}`} item={it} actions={actions} onChange={load} />
            ))}
            {t.running || live ? (
              <div className="msg assistant live" data-testid="live">
                {liveSteps.length ? (
                  <div className="live-steps">
                    {liveSteps.slice(-4).map((s, i) => (
                      <span key={i} className={`live-step ${s.status}`}>
                        {s.status === "running" ? "◌" : s.status === "error" ? "✕" : "✓"} {toolLabel(s.tool)}
                      </span>
                    ))}
                  </div>
                ) : null}
                {live?.text ? <Markdown text={live.text} /> : <div className="typing">{t.statusLine || "Working…"}</div>}
              </div>
            ) : null}
          </div>
        </div>
        {panel ? <SidePanel detail={detail} onClose={() => setPanel(false)} /> : null}
      </div>

      <Composer
        onSend={send}
        running={t.running}
        onStop={() => void api.post(`/api/threads/${t.id}/stop`)}
        placeholder={t.state === "done" ? "Message to reopen this thread" : isOverview ? "Ask Vireo anything" : "Message Vireo"}
      />
    </div>
  );
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
          <span className="meta">{dateTime(item.m.createdAt)}</span>
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
            ↗ <a href={`#thread/${String(n.data?.threadId)}`}>{n.text}</a>
          </div>
        );
      }
      if (n.kind === "action_result") {
        const short = n.text.replace(/\. Result:[\s\S]*$/, "").replace(/\. Do not retry[\s\S]*$/, "");
        return <div className="notice">{prettyDates(short.replace(/^The owner /, "You "))}</div>;
      }
      return (
        <div className={`notice ${n.kind}`} data-testid={`notice-${n.kind}`}>
          {n.kind === "reminder" ? "⏰ " : n.kind === "error" ? "⚠︎ " : ""}
          {n.text}
        </div>
      );
    }
  }
}

function Steps({ steps }: { steps: { name: string; args: Record<string, unknown>; result?: Extract<Message, { role: "tool" }> }[] }) {
  const [open, setOpen] = useState(false);
  const visible = steps.filter((s) => !s.name.startsWith("transfer_to_"));
  if (visible.length === 0) return null;
  const labels = [...new Set(visible.map((s) => toolLabel(s.name)))];
  return (
    <div className="steps" data-testid="steps">
      <button className="steps-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="chev">{open ? "▾" : "▸"}</span>
        {labels.slice(0, 3).join(" · ")}
        {labels.length > 3 ? ` · +${labels.length - 3}` : ""}
        <span className="muted"> ({visible.length} step{visible.length > 1 ? "s" : ""})</span>
      </button>
      {open ? (
        <ol className="step-list">
          {visible.map((s, i) => (
            <li key={i} className={s.result?.isError ? "error" : s.result?.awaitingConfirmation ? "pending" : ""}>
              <div className="step-name">
                {toolLabel(s.name)} <code>{s.name}</code>
              </div>
              <pre className="step-args">{JSON.stringify(s.args, null, 2)}</pre>
              {s.result ? <pre className="step-result">{s.result.text}</pre> : <div className="muted">Running…</div>}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}
