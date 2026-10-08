import { useState } from "react";
import { api } from "../api";

export function Login({ hasOwner, needsCode, onDone }: { hasOwner: boolean; needsCode: boolean; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    if (!hasOwner && password !== confirm) {
      setError("The passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      if (hasOwner) await api.post("/api/auth/login", { password, label: navigator.userAgent });
      else await api.post("/api/auth/setup", { password, code, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>{hasOwner ? "Welcome back" : "Welcome to Vireo"}</h1>
        <p className="muted">
          {hasOwner ? "Sign in to continue." : "Vireo works for one person — you. Choose a password to protect it on every device."}
        </p>
        {!hasOwner && needsCode ? (
          <label>
            Setup code
            <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Printed in the server log" required />
          </label>
        ) : null}
        <label>
          Password
          <input
            type="password"
            autoComplete={hasOwner ? "current-password" : "new-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={hasOwner ? undefined : 6}
            autoFocus
          />
        </label>
        {!hasOwner ? (
          <label>
            Confirm password
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
          </label>
        ) : null}
        {error ? <p className="error">{error}</p> : null}
        <button className="btn primary" disabled={busy}>
          {hasOwner ? "Sign in" : "Get started"}
        </button>
      </form>
    </div>
  );
}
