import type { CloudInfo, LinkRequest, NodeSummary } from "@vireo/protocol";
import { useEffect, useState, type ReactNode } from "react";
import { cloud, devSignIn, resumePendingLink, signInWithGitHub } from "../cloud";
import { nodes, switchNode } from "../nodes";
import { NodeSwitcher, StartNode } from "./Nodes";

function Page({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="login">
      <div className="login-card">
        <img src="/icon.svg" alt="" width={56} height={56} />
        <h1>{title}</h1>
        {children}
      </div>
    </div>
  );
}

/** Signing in to Vireo with GitHub (or by name, on a development cloud). */
export function SignIn({ error, onDone }: { error?: string; onDone: () => void }) {
  const [info, setInfo] = useState<CloudInfo | null>(null);
  const [unreachable, setUnreachable] = useState("");
  const [login, setLogin] = useState("");
  const [failed, setFailed] = useState(error ?? "");
  useEffect(() => {
    cloud
      .info()
      .then(setInfo)
      .catch((err: Error) => setUnreachable(err.message));
  }, []);
  const linking = /[#&]link=/.test(location.hash) || Boolean(localStorage.getItem("vireo.link"));
  return (
    <Page title="Welcome to Vireo">
      <p className="muted">
        {linking ? "Sign in to approve the node that is asking to join your account." : "Your own assistant, running on your own machine. Sign in to reach your nodes."}
      </p>
      {unreachable ? <p className="error">{unreachable}</p> : null}
      {info?.github !== false ? (
        <button className="btn primary" onClick={signInWithGitHub} disabled={!info} data-testid="sign-in-github">
          Continue with GitHub
        </button>
      ) : null}
      {info?.devLogin ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setFailed("");
            devSignIn(login)
              .then(() => {
                resumePendingLink();
                onDone();
              })
              .catch((err: Error) => setFailed(err.message));
          }}
        >
          <label>
            Development sign-in
            <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="A name, e.g. alice" spellCheck={false} required data-testid="dev-login" />
          </label>
          <button className="btn">Sign in</button>
        </form>
      ) : null}
      {failed ? <p className="error">{failed}</p> : null}
    </Page>
  );
}

/** The page a node's link opens: approve it joining this account. */
export function ApproveNode({ code }: { code: string }) {
  const [req, setReq] = useState<LinkRequest | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [linked, setLinked] = useState<NodeSummary | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    cloud
      .linkRequest(code)
      .then((r) => {
        setReq(r);
        setName(r.name);
      })
      .catch((err: Error) => setError(err.message));
  }, [code]);

  if (linked) {
    return (
      <Page title="Node linked">
        <p className="muted">{linked.name} is now yours. It finishes setting up on its own in a moment.</p>
        <button className="btn primary" onClick={() => switchNode(linked.id)} data-testid="open-node">
          Open Vireo
        </button>
      </Page>
    );
  }
  if (denied) {
    return (
      <Page title="Not linked">
        <p className="muted">The node was turned away. Run <code>npx vireo-node</code> again if that was a mistake.</p>
        <a className="btn" href="#">
          Back
        </a>
      </Page>
    );
  }
  return (
    <Page title="Link a node">
      {error ? (
        <>
          <p className="error">{error}</p>
          <a className="btn" href="#">
            Back
          </a>
        </>
      ) : !req ? (
        <p className="muted">Checking the code…</p>
      ) : (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            cloud
              .approve(code, name.trim() || req.name)
              .then(setLinked)
              .catch((err: Error) => setError(err.message))
              .finally(() => setBusy(false));
          }}
        >
          <p className="muted">
            A Vireo node on <b>{req.platform}</b> is asking to join your account{req.mode === "tailscale" ? ", reached over your tailnet" : ""}. Check that its
            terminal shows this code:
          </p>
          <div className="link-code" data-testid="link-request">
            <span className="code">{req.userCode}</span>
          </div>
          <label>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} data-testid="link-name" />
          </label>
          <button className="btn primary" disabled={busy} data-testid="approve-node">
            Link this node
          </button>
          <button
            type="button"
            className="link-btn"
            onClick={() => void cloud.deny(code).then(() => setDenied(true))}
          >
            This isn't mine
          </button>
        </form>
      )}
    </Page>
  );
}

/** Signed in, with no node yet. */
export function NoNodes() {
  return (
    <Page title="Start your node">
      <StartNode />
    </Page>
  );
}

/** The current node can't be reached. */
export function Unreachable({ node, message, onRetry }: { node: NodeSummary; message: string; onRetry: () => void }) {
  const others = nodes().filter((n) => n.id !== node.id);
  return (
    <Page title={`${node.name} is unreachable`}>
      <div className="login-node">
        <NodeSwitcher />
      </div>
      <p className="muted">{message}</p>
      <p className="muted small">
        {node.mode === "tailscale"
          ? `This node is reached over Tailscale${node.directUrl ? ` at ${node.directUrl}` : ""}. Check that it is running and that this device is on the same tailnet.`
          : "Check that it is running (npx vireo-node) and online."}
      </p>
      <div className="row-buttons center">
        <button className="btn primary" onClick={onRetry}>
          Try again
        </button>
        {others.map((n) => (
          <button key={n.id} className="btn" onClick={() => switchNode(n.id)}>
            Use {n.name}
          </button>
        ))}
      </div>
    </Page>
  );
}
