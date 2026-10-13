import { useEffect, useState } from "react";
import { api, type CliId, type LocalCli, type ModelProviderChoice, type ModelStatus } from "../api";

type TestResult = { ok: boolean; message: string };

const SOURCES: { id: ModelProviderChoice; label: string; hint: string }[] = [
  { id: "auto", label: "Automatic", hint: "Your API endpoint when one is set up, otherwise a CLI found on this machine." },
  { id: "cli", label: "A CLI on this machine", hint: "Claude Code, Codex or pi, with the account it is signed in to. No API key needed." },
  { id: "endpoint", label: "An API endpoint", hint: "OpenAI, a LiteLLM proxy, OpenRouter, Ollama or any OpenAI-compatible server." },
];

const DEFAULT = "default";
const modelLabel = (m: string | undefined) => (!m || m === DEFAULT ? "the CLI's default" : m);

/**
 * Settings → Model: where Vireo's thinking comes from. A CLI on this machine
 * is set up as a short guided flow (pick, install, sign in, models, test);
 * an endpoint as the usual form.
 */
export function Models({ reload }: { reload: () => Promise<void> }) {
  const [st, setSt] = useState<ModelStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<ModelStatus>("/api/models").then(setSt);
  useEffect(() => {
    void load();
  }, []);
  if (!st) return null;

  const saved = async (next: ModelStatus) => {
    setSt(next);
    await reload();
  };
  const setSource = async (provider: ModelProviderChoice) => {
    setBusy(true);
    try {
      await saved(await api.put<ModelStatus>("/api/models", { provider }));
    } finally {
      setBusy(false);
    }
  };
  // Automatic shows whichever it is using now.
  const view = st.provider === "auto" ? st.using : st.provider;
  const found = st.clis.filter((c) => c.found);

  return (
    <>
      <Current st={st} />
      <section className="card" data-testid="model-source">
        <h3>Where Vireo's thinking comes from</h3>
        <div className="source-list" role="radiogroup" aria-label="Model source">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={st.provider === s.id}
              className={`source-option ${st.provider === s.id ? "on" : ""}`}
              disabled={busy || st.fake}
              onClick={() => void setSource(s.id)}
              data-testid={`model-source-${s.id}`}
            >
              <span className="radio-mark" aria-hidden />
              <span className="source-text">
                <span className="source-label">
                  {s.label}
                  {s.id === "auto" ? <span className="tag">Recommended</span> : null}
                  {s.id === "cli" && found.length ? <span className="tag green">{found.map((c) => c.name).join(", ")} found</span> : null}
                </span>
                <span className="muted small">{s.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </section>
      {view === "cli" ? (
        <CliGuide st={st} onSaved={saved} />
      ) : (
        <EndpointForm st={st} onSaved={saved} reload={load} />
      )}
      {st.provider === "auto" && st.using === "endpoint" && found.length ? (
        <p className="muted small">
          {found.map((c) => c.name).join(", ")} {found.length > 1 ? "are" : "is"} on this machine too.{" "}
          <button className="link" onClick={() => void setSource("cli")}>
            Use {found.length > 1 ? "a CLI" : found[0]!.name} instead
          </button>
        </p>
      ) : null}
    </>
  );
}

/** One line on what Vireo is using right now. */
function Current({ st }: { st: ModelStatus }) {
  const cli = st.using === "cli" ? st.clis.find((c) => c.id === st.cli) : undefined;
  return (
    <section className="card model-now" data-testid="models-card">
      {st.fake ? <p className="tag">Demo mode: a scripted model is answering.</p> : null}
      {st.ready ? (
        <p>
          <span className="dot online" /> Using <b>{cli && st.main === DEFAULT ? `${cli.name}'s default model` : st.main}</b>
          {cli ? (
            <>
              {" "}
              through <b>{cli.name}</b>
            </>
          ) : null}
          {st.fast && st.fast !== st.main ? (
            <>
              ; routine work on <b>{modelLabel(st.fast)}</b>
            </>
          ) : null}
          .{" "}
          <span className="muted small">
            {cli ? `${cli.path}${st.provider === "auto" ? " · picked automatically" : ""}` : st.baseUrl}
          </span>
        </p>
      ) : (
        <p className="error">No model yet. Pick a CLI on this machine or enter an API endpoint below.</p>
      )}
      {st.error ? <p className="error small">{st.error}</p> : null}
    </section>
  );
}

function statusTag(c: LocalCli) {
  if (c.found) return <span className="tag green">Found{c.version ? ` · ${c.version}` : ""}</span>;
  if (c.error) return <span className="tag orange">Not working</span>;
  return <span className="tag">Not installed</span>;
}

/** The guided setup for a CLI: pick one, install, sign in, models, then save and test. */
function CliGuide({ st, onSaved }: { st: ModelStatus; onSaved: (s: ModelStatus) => Promise<void> }) {
  const first = st.clis.find((c) => c.found)?.id ?? "claude";
  const [pick, setPick] = useState<CliId>(st.cli && st.clis.some((c) => c.id === st.cli) ? st.cli : first);
  const cli = st.clis.find((c) => c.id === pick)!;
  const chosen = st.cliModels[pick] ?? {};
  const [main, setMain] = useState(chosen.main ?? "");
  const [fast, setFast] = useState(chosen.fast ?? "");
  const [path, setPath] = useState(st.cliPaths[pick] ?? "");
  const [showPath, setShowPath] = useState(Boolean(st.cliPaths[pick]) || Boolean(cli?.error));
  const [busy, setBusy] = useState<"" | "detect" | "test">("");
  const [test, setTest] = useState<TestResult | null>(null);

  // Each CLI keeps its own choices.
  useEffect(() => {
    const c = st.cliModels[pick] ?? {};
    setMain(c.main ?? "");
    setFast(c.fast ?? "");
    setPath(st.cliPaths[pick] ?? "");
    setShowPath(Boolean(st.cliPaths[pick]) || Boolean(st.clis.find((x) => x.id === pick)?.error));
    setTest(null);
  }, [pick]);

  if (!cli) return null;
  const inUse = st.using === "cli" && st.cli === pick;
  const lookAgain = async () => {
    setBusy("detect");
    try {
      if (path !== (st.cliPaths[pick] ?? "")) await onSaved(await api.put<ModelStatus>("/api/models", { cli: pick, cliPath: path }));
      else await onSaved(await api.post<ModelStatus>("/api/models/detect"));
    } finally {
      setBusy("");
    }
  };
  const use = async () => {
    setBusy("test");
    setTest(null);
    try {
      await onSaved(await api.put<ModelStatus>("/api/models", { provider: "cli", cli: pick, cliMain: main, cliFast: fast, cliPath: path }));
      setTest(await api.post<TestResult>("/api/models/test"));
    } catch (err) {
      setTest({ ok: false, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy("");
    }
  };
  const listId = `cli-models-${pick}`;

  return (
    <section className="card" data-testid="cli-guide">
      <div className="card-head">
        <h3>Use a CLI on this machine</h3>
        <button className="btn small ghost" disabled={busy !== ""} onClick={() => void lookAgain()} data-testid="cli-detect">
          {busy === "detect" ? "Looking…" : "Look again"}
        </button>
      </div>
      <p className="muted small">Vireo asks the CLI for each reply with its own tools switched off, so Vireo's tools, memory and confirmations work as usual. That is separate from Coding agents, which hand whole tasks to an agent.</p>

      <ol className="guide">
        <li className="guide-step done">
          <span className="guide-num" aria-hidden>
            1
          </span>
          <div className="guide-body">
            <h4>Pick a CLI</h4>
            <div className="cli-list" role="radiogroup" aria-label="CLI">
              {st.clis.map((c) => (
                <button key={c.id} type="button" role="radio" aria-checked={c.id === pick} className={`cli-option ${c.id === pick ? "on" : ""}`} onClick={() => setPick(c.id)} data-testid={`cli-${c.id}`}>
                  <span className="radio-mark" aria-hidden />
                  <span className="cli-name">{c.name}</span>
                  {statusTag(c)}
                  {st.using === "cli" && st.cli === c.id ? <span className="tag blue">In use</span> : null}
                </button>
              ))}
            </div>
          </div>
        </li>

        <li className={`guide-step ${cli.found ? "done" : "todo"}`}>
          <span className="guide-num" aria-hidden>
            {cli.found ? "✓" : "2"}
          </span>
          <div className="guide-body">
            <h4>{cli.found ? `${cli.name} is installed` : `Install ${cli.name}`}</h4>
            {cli.found ? (
              <p className="muted small mono-line">{cli.path}</p>
            ) : (
              <>
                {cli.error ? <p className="error small">{cli.error}</p> : <p className="muted small">Not found on the machine this node runs on. Install it there, then look again:</p>}
                <pre className="command">{cli.install}</pre>
              </>
            )}
            {showPath ? (
              <label className="cli-path">
                <span className="small">Its location, if Vireo can't find it</span>
                <span className="inline-form">
                  <input value={path} placeholder={`/path/to/${cli.id}`} onChange={(e) => setPath(e.target.value)} spellCheck={false} data-testid="cli-path" />
                  <button className="btn small" disabled={busy !== ""} onClick={() => void lookAgain()}>
                    Check
                  </button>
                </span>
              </label>
            ) : (
              <button className="link small" onClick={() => setShowPath(true)}>
                {cli.found ? "Use a different copy" : "It's installed somewhere else"}
              </button>
            )}
          </div>
        </li>

        <li className="guide-step">
          <span className="guide-num" aria-hidden>
            3
          </span>
          <div className="guide-body">
            <h4>Sign in once</h4>
            <p className="muted small">Vireo uses the account {cli.name} is signed in to on that machine: your subscription or its own API key. If you haven't signed in there yet, run this in a terminal and follow its steps:</p>
            <pre className="command">{cli.signIn}</pre>
          </div>
        </li>

        <li className="guide-step">
          <span className="guide-num" aria-hidden>
            4
          </span>
          <div className="guide-body">
            <h4>Choose models</h4>
            <div className="grid2">
              <label>
                <span className="small">Conversations</span>
                <input list={listId} value={main} placeholder={`${modelLabel(cli.defaults.main)} (automatic)`} onChange={(e) => setMain(e.target.value)} spellCheck={false} data-testid="cli-main" />
              </label>
              <label>
                <span className="small">Routine work (titles, memory)</span>
                <input list={listId} value={fast} placeholder={`${modelLabel(cli.defaults.fast)} (automatic)`} onChange={(e) => setFast(e.target.value)} spellCheck={false} data-testid="cli-fast" />
              </label>
            </div>
            <datalist id={listId}>
              {cli.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {cli.models.length ? null : <p className="muted small">Leave these empty to use the model {cli.name} is set to.</p>}
          </div>
        </li>
      </ol>

      <div className="row-buttons">
        <button className="btn primary small" disabled={!cli.found || busy !== ""} onClick={() => void use()} data-testid="cli-use">
          {busy === "test" ? "Testing…" : inUse ? "Save and test" : `Use ${cli.name}`}
        </button>
        {!cli.found ? <span className="muted small">Install it first, then press Look again.</span> : null}
      </div>
      {test ? (
        <p className={test.ok ? "ok small" : "error small"} data-testid="llm-test-result">
          {test.message}
          {!test.ok ? ` If ${cli.name} isn't signed in, run "${cli.signIn}" on that machine and try again.` : ""}
        </p>
      ) : null}
    </section>
  );
}

/** Any OpenAI-compatible endpoint. */
function EndpointForm({ st, onSaved, reload }: { st: ModelStatus; onSaved: (s: ModelStatus) => Promise<void>; reload: () => Promise<void> }) {
  const endpointChoice = st.using === "endpoint" ? st.choice : { main: undefined, fast: undefined };
  const [form, setForm] = useState({ baseUrl: st.source.baseUrl === "settings" ? st.baseUrl : "", apiKey: "", model: endpointChoice.main ?? "", fastModel: endpointChoice.fast ?? "", api: st.api });
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const save = async () => {
    setBusy(true);
    setTest(null);
    try {
      await onSaved(await api.put<ModelStatus>("/api/models", { ...form, apiKey: form.apiKey || undefined }));
      setForm((f) => ({ ...f, apiKey: "" }));
    } finally {
      setBusy(false);
    }
  };
  const runTest = async () => {
    setBusy(true);
    try {
      setTest(await api.post<TestResult>("/api/models/test"));
    } finally {
      setBusy(false);
    }
  };
  const live = st.using === "endpoint";
  return (
    <section className="card" data-testid="endpoint-form">
      <h3>API endpoint</h3>
      <p className="muted small">Any OpenAI-compatible endpoint works: OpenAI, a LiteLLM proxy (for Anthropic, Gemini, Bedrock and more), OpenRouter, or a local server such as Ollama.</p>
      <form
        className="stack"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label>
          Base URL
          <input
            value={form.baseUrl}
            placeholder={st.source.baseUrl === "settings" ? "" : `${st.baseUrl}${st.source.baseUrl === "env" ? " (from environment)" : " (default)"}`}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
            data-testid="llm-base-url"
          />
        </label>
        <label>
          API key
          <input
            type="password"
            value={form.apiKey}
            placeholder={st.hasKey ? `Saved${st.source.apiKey === "env" ? " (from environment)" : ""}; type to replace` : "sk-…"}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            data-testid="llm-api-key"
          />
        </label>
        <div className="grid2">
          <label>
            Main model
            <input list="llm-models" value={form.model} placeholder={live && st.main ? `${st.main} (automatic)` : "e.g. gpt-5"} onChange={(e) => setForm({ ...form, model: e.target.value })} data-testid="llm-model" />
          </label>
          <label>
            Routine work
            <input list="llm-models" value={form.fastModel} placeholder={live && st.fast ? `${st.fast} (automatic)` : "a cheaper model"} onChange={(e) => setForm({ ...form, fastModel: e.target.value })} />
          </label>
        </div>
        <datalist id="llm-models">
          {(live ? st.available : []).map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <label>
          API
          <select value={form.api} onChange={(e) => setForm({ ...form, api: e.target.value as "chat" | "responses" })}>
            <option value="chat">Chat Completions (works with every compatible endpoint)</option>
            <option value="responses">Responses (OpenAI only)</option>
          </select>
        </label>
        <div className="row-buttons">
          <button className="btn small" disabled={busy}>
            Save
          </button>
          <button type="button" className="btn small ghost" disabled={busy || !live} onClick={() => void runTest()} data-testid="llm-test">
            Test connection
          </button>
          {st.hasKey && st.source.apiKey === "settings" ? (
            <button type="button" className="btn small ghost" disabled={busy} onClick={() => void api.put("/api/models", { apiKey: "" }).then(reload)}>
              Remove saved key
            </button>
          ) : null}
        </div>
        {test ? (
          <p className={test.ok ? "ok small" : "error small"} data-testid="llm-test-result">
            {test.message}
          </p>
        ) : null}
      </form>
    </section>
  );
}
