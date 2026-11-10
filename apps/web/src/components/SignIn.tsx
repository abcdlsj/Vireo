import type { CloudInfo, LinkRequest, NodeSummary } from "@vireo/protocol";
import { useEffect, useState, type ReactNode } from "react";
import { cloud, devSignIn, resumePendingLink, signInWithGitHub } from "../cloud";
import { nodes, switchNode } from "../nodes";
import { NodeSwitcher, StartNode } from "./Nodes";

const INSTALL = "curl -fsSL https://askvireo.com/install.sh | sh";

/** Copies the one command that sets up a node; the browser's clipboard may refuse on http. */
function CopyCommand({ command }: { command: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="login-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(command).then(
          () => {
            setDone(true);
            window.setTimeout(() => setDone(false), 1600);
          },
          () => undefined,
        );
      }}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

/**
 * Every screen before the app opens: signing in, linking a node, a node that
 * will not answer. The action sits on the page's ground; the panel beside it
 * is the app's own cover, so the front door says what Vireo is.
 */
function Page({ title, children, lede }: { title: string; children: ReactNode; lede?: string }) {
  return (
    <div className="login">
      <div className="login-shell">
        <div className="login-main">
          <a className="login-brand" href="#" aria-label="Vireo">
            <img src="/icon.svg" alt="" width={26} height={26} />
            <span>Vireo</span>
          </a>
          <h1>{title}</h1>
          {lede ? <p className="login-lede">{lede}</p> : null}
          <div className="login-actions">{children}</div>
        </div>
        <aside className="login-side" aria-hidden="true">
          <div className="login-side-top">
            <img src="/icon.svg" alt="" width={34} height={34} />
            <p className="login-side-title">Your agent, on your machine.</p>
            <dl className="login-facts">
              <div>
                <dt>One matter, one thread</dt>
                <dd>Each thing you ask about keeps its own conversation and its own card.</dd>
              </div>
              <div>
                <dt>Nothing goes out on its own</dt>
                <dd>An email, an invitation, a form: all wait for your yes.</dd>
              </div>
              <div>
                <dt>It remembers you</dt>
                <dd>What one matter teaches it, the next one already knows.</dd>
              </div>
            </dl>
          </div>
          <div className="login-install">
            <span className="login-install-label">Run your own node</span>
            {/* The address reads short enough to fit on one line; the button copies the whole command. */}
            <code>{INSTALL.replace("https://", "")}</code>
            <CopyCommand command={INSTALL} />
          </div>
        </aside>
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
    <Page
      title={linking ? "One step to link your node" : "Sign in"}
      lede={linking ? "Approving it lets this node join your account; nothing is sent to it until you do." : "Sign in to reach the nodes running on your own machines."}
    >
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
          <button className={`btn${info.github === false ? " primary" : ""}`}>Sign in</button>
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
        <p className="muted">The node was turned away. Run <code>npx askvireo</code> again if that was a mistake.</p>
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
/** The cloud didn't answer while starting up, and nothing was kept on this device to open on. */
export function CloudUnreachable({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Page title="Can't reach Vireo">
      <p className="muted">{message}</p>
      <div className="row-buttons center">
        <button className="btn primary" onClick={onRetry}>
          Try again
        </button>
      </div>
    </Page>
  );
}

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
          : "Check that it is running (npx askvireo) and online."}
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
