import { useState } from "react";
import { api } from "../api";
import { deviceLabel, setToken, type Host } from "../hosts";
import { AddHostForm, HostSwitcher } from "./Hosts";

/**
 * Signing in to the current host: with the owner's password, or with a
 * pairing code from the host. A fresh host is set up here too.
 */
export function Login({ host, hasOwner, needsCode, onDone }: { host: Host; hasOwner: boolean; needsCode: boolean; onDone: () => void }) {
  const remote = Boolean(host.url);
  const [mode, setMode] = useState<"password" | "code">(remote ? "code" : "password");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // A fresh local host can be claimed with a password; remote ones always pair.
  const setup = !hasOwner && !remote && mode === "password";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (setup && password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      if (setup) await api.post("/api/auth/setup", { password, code, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      else {
        const r = await api.post<{ token: string }>("/api/auth/login", { password, label: deviceLabel() });
        if (remote) setToken(host.id, r.token);
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login-card">
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>{hasOwner || remote ? `Sign in to ${host.name}` : "Welcome to Vireo"}</h1>
        <div className="login-host">
          <HostSwitcher />
        </div>
        {mode === "code" ? (
          <>
            <p className="muted">Enter a pairing code from the host. It prints one when it starts; run <code>npm run pair</code> on it for a new one.</p>
            {remote ? <AddHostForm host={host} /> : <LocalPair onDone={onDone} />}
            {hasOwner || !remote ? (
              <button className="link-btn" onClick={() => setMode("password")}>
                {hasOwner ? "Use the password instead" : "Set a password instead"}
              </button>
            ) : null}
          </>
        ) : (
          <form className="stack" onSubmit={submit}>
            <p className="muted">{hasOwner ? "Sign in with the owner's password." : "Vireo works for one person — you. Choose a password to protect this host on every device."}</p>
            {setup && needsCode ? (
              <label>
                Setup code
                <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Printed in the host's log" required />
              </label>
            ) : null}
            <label>
              Password
              <input
                type="password"
                autoComplete={setup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={setup ? 6 : undefined}
                autoFocus
              />
            </label>
            {setup ? (
              <label>
                Confirm password
                <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
              </label>
            ) : null}
            {error ? <p className="error">{error}</p> : null}
            <button className="btn primary" disabled={busy}>
              {setup ? "Get started" : "Sign in"}
            </button>
            <button type="button" className="link-btn" onClick={() => setMode("code")}>
              Use a pairing code
            </button>
          </form>
        )}
      </div>
    </div>
  );
}


/** Pairing with the host on this machine: the session comes back as a cookie. */
function LocalPair({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        api
          .post("/api/auth/pair", { code, label: deviceLabel(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })
          .then(onDone)
          .catch((err: Error) => setError(err.message))
          .finally(() => setBusy(false));
      }}
    >
      <label>
        Pairing code
        <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="K7QM-2XPA" autoComplete="one-time-code" spellCheck={false} autoFocus required data-testid="local-code" />
      </label>
      {error ? <p className="error small">{error}</p> : null}
      <button className="btn primary" disabled={busy}>
        {busy ? "Pairing…" : "Pair"}
      </button>
    </form>
  );
}
