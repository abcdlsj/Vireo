import type { CloudInfo, LinkRequest, NodeSummary } from "@vireo/protocol";
import { useEffect, useState, type ReactNode } from "react";
import { cloud, devSignIn, resumePendingLink, signInWithGitHub } from "../cloud";
import { loadNodes, nodes, switchNode } from "../nodes";
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
        <p className="muted">
          {linked.mode === "tailscale"
            ? `${linked.name} is now yours. Next, put it on your tailnet; the next page walks you through it.`
            : `${linked.name} is now yours. It finishes setting up on its own in a moment.`}
        </p>
        <button className="btn primary" onClick={() => switchNode(linked.id)} data-testid="open-node">
          {linked.mode === "tailscale" ? "Continue" : "Open Vireo"}
        </button>
      </Page>
    );
  }
  if (denied) {
    return (
      <Page title="Not linked">
        <p className="muted">The node was turned away. Run <code>npx @abcdlsj/vireo-node</code> again if that was a mistake.</p>
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

const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";

/**
 * A node reached over Tailscale that isn't on the tailnet yet: what it waits
 * for, one step at a time, from what the node tells the cloud. Moves on by
 * itself once the node has its tailnet address.
 */
export function TailnetSetup({ node: first, onReady }: { node: NodeSummary; onReady: () => void }) {
  const [node, setNode] = useState(first);
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      const n = (await loadNodes().catch(() => undefined))?.find((x) => x.id === first.id);
      if (stopped || !n) return;
      setNode(n);
      if (n.directUrl) onReady();
    };
    const timer = window.setInterval(() => void tick(), 3000);
    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [first.id, onReady]);

  const setup = node.setup;
  // Which step the node is on: 1 getting Tailscale running, 2 signing in, 3 allowing HTTPS.
  const at = !node.online ? 1 : setup?.step === "signin" || setup?.step === "approve" ? 2 : setup?.step === "https" ? 3 : 1;
  const mark = (i: number) => (i < at ? "done" : i === at ? (setup?.step === "error" && i === 1 ? "error" : "now") : "todo");
  const others = nodes().filter((n) => n.id !== node.id);

  return (
    <Page title={`Put ${node.name} on your tailnet`}>
      <p className="muted">The app reaches this node straight over Tailscale, so it needs to join your tailnet first. This page moves on by itself.</p>
      <ol className="setup-steps" data-testid="tailnet-setup">
        <li className="done">
          <b>Linked to your account</b>
        </li>
        <li className={mark(1)} data-testid="setup-step-tailscale">
          <b>Tailscale running on {node.name}</b>
          {at === 1 ? (
            !node.online ? (
              <span className="muted small">
                Waiting for {node.name} to come online. Keep <code>npx @abcdlsj/vireo-node</code> running there.
              </span>
            ) : setup?.step === "error" ? (
              <span className="error small">{setup.message}</span>
            ) : (
              <span className="muted small">{setup?.message || "Starting Tailscale…"}</span>
            )
          ) : null}
        </li>
        <li className={mark(2)} data-testid="setup-step-signin">
          <b>Sign in to Tailscale</b>
          {at === 2 && setup ? (
            <>
              <span className="muted small">
                {setup.message}
                {setup.step === "signin" ? " No account yet? The same page creates one for free. Press Connect when it asks about this machine." : ""}
              </span>
              {setup.link ? (
                <a className="btn primary" href={setup.link} target="_blank" rel="noreferrer" data-testid="setup-link">
                  {setup.step === "approve" ? "Open the admin console" : "Sign in to Tailscale"}
                </a>
              ) : null}
            </>
          ) : null}
        </li>
        <li className={mark(3)} data-testid="setup-step-https">
          <b>Allow HTTPS on your tailnet</b>
          {at === 3 && setup ? (
            <>
              <span className="muted small">{setup.message} It's one switch, once per tailnet.</span>
              {setup.link ? (
                <a className="btn primary" href={setup.link} target="_blank" rel="noreferrer" data-testid="setup-link">
                  Allow HTTPS
                </a>
              ) : null}
            </>
          ) : null}
        </li>
        <li className="todo">
          <b>This device on the same tailnet</b>
          <span className="muted small">
            Install <a href={TAILSCALE_DOWNLOAD} target="_blank" rel="noreferrer">Tailscale</a> on this phone or computer too, and sign in with the same account.
          </span>
        </li>
      </ol>
      {others.length ? (
        <div className="row-buttons center">
          {others.map((n) => (
            <button key={n.id} className="btn" onClick={() => switchNode(n.id)}>
              Use {n.name} meanwhile
            </button>
          ))}
        </div>
      ) : null}
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
        {node.mode === "tailscale" ? (
          <>
            This node is reached over Tailscale{node.directUrl ? ` at ${node.directUrl}` : ""}. Check that it is running, and that this device has{" "}
            <a href={TAILSCALE_DOWNLOAD} target="_blank" rel="noreferrer">
              Tailscale
            </a>{" "}
            on and is signed in to the same tailnet.
          </>
        ) : (
          "Check that it is running (npx @abcdlsj/vireo-node) and online."
        )}
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
