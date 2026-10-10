import { useState } from "react";
import { api, type Thread } from "../api";
import { go } from "../route";
import { ChevronLeft } from "../icons";
import { Composer } from "./Composer";

export function NewThread() {
  const [temporary, setTemporary] = useState(false);
  const send = async (text: string, files: File[]) => {
    const { thread } = await api.post<{ thread: Thread }>("/api/threads", { temporary, text: files.length ? undefined : text });
    if (files.length) {
      const up = await api.upload(thread.id, files);
      await api.post(`/api/threads/${thread.id}/messages`, { text, fileIds: up.files.map((f) => f.id) });
    }
    go(`thread/${thread.id}`);
  };
  return (
    <div className="thread-view">
      <header className="topbar">
        <a href="#" className="back" aria-label="Back">
          <ChevronLeft />
        </a>
        <span className="crumbs">
          <span className="crumb-root">Threads</span>
          <span className="crumb-sep">/</span>
          <span className="crumb-here">New thread</span>
        </span>
      </header>
      <div className="new-thread-body">
        <h1 className="page-title">What's the matter?</h1>
        <p className="muted">One matter per thread. Describe it in your own words — Vireo names the thread and gets going.</p>
        <label className="check">
          <input type="checkbox" checked={temporary} onChange={(e) => setTemporary(e.target.checked)} data-testid="temporary-toggle" />
          Temporary — keep this conversation out of memory
        </label>
      </div>
      <Composer onSend={send} autoFocus placeholder="e.g. Find a free hour with anna@example.com next week" />
    </div>
  );
}
