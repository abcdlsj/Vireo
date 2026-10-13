import { useCallback, useEffect, useState } from "react";
import { api, onEvent, type ModelStatus, type PluginRow, type PluginView } from "../api";
import { Plugin } from "./PluginsCard";

/**
 * Settings → Coding agents: part of Vireo, not a plugin. Vireo hands work in a
 * repository on this machine to Claude Code, Codex, pi or another ACP agent.
 * What is installed here is listed first, each one a click from a setup.
 */
export function CodingAgents({ reload }: { reload: () => Promise<void> }) {
  const [plugin, setPlugin] = useState<PluginView | null>(null);
  const [models, setModels] = useState<ModelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const [{ plugins }, m] = await Promise.all([api.get<{ plugins: PluginView[] }>("/api/plugins"), api.get<ModelStatus>("/api/models")]);
    setPlugin(plugins.find((p) => p.id === "agents") ?? null);
    setModels(m);
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => onEvent((e) => (e.type === "plugins.updated" ? void load() : undefined)), [load]);

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    await load();
    await reload();
  };
  if (!plugin || !models) return null;

  const rows = (Array.isArray(plugin.config.agents) ? plugin.config.agents : []) as PluginRow[];
  const used = new Set(rows.map((r) => String(r.command ?? "").trim().split(/\s+/)[0]));
  const lookAgain = async () => {
    setBusy(true);
    try {
      setModels(await api.post<ModelStatus>("/api/models/detect"));
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="card" data-testid="agents-found">
        <div className="card-head">
          <h3>On this machine</h3>
          <button className="btn small ghost" disabled={busy} onClick={() => void lookAgain()} data-testid="agents-detect">
            {busy ? "Looking…" : "Look again"}
          </button>
        </div>
        <p className="muted small">
          Ask Vireo to fix a bug, make a change or explain some code, and it hands the work to a coding agent here, in the repository of a setup below. Every run waits for
          your confirmation and reports what the agent did.
        </p>
        <div className="cli-list">
          {models.clis.map((c) => (
            <div key={c.id} className="cli-option static" data-testid={`agent-found-${c.id}`}>
              <span className="cli-name">{c.name}</span>
              {c.found ? <span className="tag green">Found{c.version ? ` · ${c.version}` : ""}</span> : <span className="tag">Not installed</span>}
              {c.found && used.has(c.id) ? <span className="tag blue">Set up</span> : null}
              {c.found && !used.has(c.id) ? (
                <button
                  className="btn small"
                  onClick={() => void run(() => api.patch("/api/plugins/agents", { agents: [...rows, { name: c.id, command: c.id, directory: rows[0]?.directory ?? "", mode: "edits", timeout: "1800" }] }))}
                  data-testid={`agent-add-${c.id}`}
                >
                  Add
                </button>
              ) : null}
              {!c.found ? <code className="small">{c.install}</code> : null}
            </div>
          ))}
        </div>
        <p className="muted small">opencode, gemini and other ACP agents work too: add a setup and type its name as the agent.</p>
      </section>
      {error ? <p className="error small">{error}</p> : null}
      <Plugin plugin={plugin} run={run} focused={false} autoOpen />
    </>
  );
}
