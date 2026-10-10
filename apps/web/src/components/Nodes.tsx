import type { NodeSummary, User } from "@vireo/protocol";
import { useEffect, useRef, useState } from "react";
import { cloud, signOut } from "../cloud";
import { ChevronDown } from "../icons";
import { currentNode, loadNodes, nodes, switchNode } from "../nodes";

/** Where a node is reached, for a menu or a row. */
function reach(n: NodeSummary): string {
  if (n.mode === "tailscale") return n.directUrl ? new URL(n.directUrl).host : "Tailscale";
  return n.online ? "Online" : "Offline";
}

export function NodeDot({ node }: { node: NodeSummary }) {
  return <span className={`dot ${node.online ? "online" : "offline"}`} title={node.online ? "Online" : "Offline"} />;
}

/** Sidebar control showing the current node; switches between the owner's nodes. */
export function NodeSwitcher() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = currentNode();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className="node-switch" ref={ref}>
      <button className="node-switch-btn" onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="menu" data-testid="node-switch" title="Switch node">
        <span className="node-name">{cur?.name ?? "No node"}</span>
        <ChevronDown />
      </button>
      {open ? (
        <div className="menu node-menu" role="menu">
          {nodes().map((n) => (
            <button key={n.id} role="menuitemradio" aria-checked={n.id === cur?.id} className={`menu-item ${n.id === cur?.id ? "active" : ""}`} onClick={() => (n.id === cur?.id ? setOpen(false) : switchNode(n.id))}>
              <span className="with-icon">
                <NodeDot node={n} /> {n.name}
              </span>
              <span className="muted small">{reach(n)}</span>
            </button>
          ))}
          <div className="menu-sep" />
          <a className="menu-item" href="#settings/nodes" onClick={() => setOpen(false)}>
            <span>Manage nodes</span>
          </a>
        </div>
      ) : null}
    </div>
  );
}

/** How to start a node and link it to this account. */
export function StartNode() {
  return (
    <div className="stack">
      <p className="muted small">On the machine Vireo should run on (your laptop, a home server, a VPS), run:</p>
      <pre className="command">npx vireo-node</pre>
      <p className="muted small">
        It asks whether to connect through the Vireo cloud or over Tailscale, then shows a code and opens this app to approve it. Each node keeps its own threads,
        memory and plugins on that machine.
      </p>
      <LinkCodeForm />
    </div>
  );
}

/** Typing the code a node printed, when its link didn't open this app. */
function LinkCodeForm() {
  const [code, setCode] = useState("");
  return (
    <form
      className="inline-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (code.trim()) location.hash = `link=${code.trim().toUpperCase()}`;
      }}
    >
      <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Code, e.g. WDJB-MJHT" spellCheck={false} autoComplete="one-time-code" aria-label="Link code" data-testid="link-code-input" />
      <button className="btn small">Continue</button>
    </form>
  );
}

/** Settings → Nodes: the owner's nodes, renamed or removed here. */
export function NodesSettings() {
  const [list, setList] = useState(nodes());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const cur = currentNode();
  const reload = () => void loadNodes().then(setList);
  // A node may have been linked or renamed elsewhere since the app opened.
  useEffect(reload, []);
  return (
    <>
      <section className="card">
        <p className="muted small">Each node runs its own Vireo, with its own threads, memory and plugins. This app talks to one at a time.</p>
        <ul className="rows">
          {list.map((n) => (
            <li key={n.id} className="row" data-testid="node-row">
              <div className="row-main">
                {renaming === n.id ? (
                  <RenameNode
                    node={n}
                    onDone={() => {
                      setRenaming(null);
                      reload();
                    }}
                  />
                ) : (
                  <span className="row-title">
                    <NodeDot node={n} /> {n.name} {n.id === cur?.id ? <span className="tag">current</span> : null}
                  </span>
                )}
                <span className="muted small">
                  {n.mode === "tailscale" ? `Over Tailscale${n.directUrl ? ` at ${n.directUrl}` : ""}` : "Through the Vireo cloud"}
                  {n.platform ? ` · ${n.platform}` : ""}
                  {n.version ? ` · v${n.version}` : ""}
                  {!n.online && n.lastSeenAt ? ` · last seen ${new Date(n.lastSeenAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}` : ""}
                </span>
              </div>
              <div className="row-buttons">
                {n.id !== cur?.id ? (
                  <button className="btn small" onClick={() => switchNode(n.id)}>
                    Switch
                  </button>
                ) : null}
                {renaming !== n.id ? (
                  <button className="btn small ghost" onClick={() => setRenaming(n.id)} data-testid="rename-node">
                    Rename
                  </button>
                ) : null}
                <button
                  className="btn small ghost"
                  onClick={() => {
                    if (!confirm(`Remove ${n.name}? It stops accepting this account; its data stays on that machine until you delete it there.`)) return;
                    void cloud.removeNode(n.id).then(() => (n.id === cur?.id ? location.reload() : reload()));
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
        {adding ? <StartNode /> : <button className="btn small" onClick={() => setAdding(true)} data-testid="add-node">Add a node</button>}
      </section>
    </>
  );
}

function RenameNode({ node, onDone }: { node: NodeSummary; onDone: () => void }) {
  const [name, setName] = useState(node.name);
  return (
    <form
      className="rename-node"
      onSubmit={(e) => {
        e.preventDefault();
        void cloud.renameNode(node.id, name.trim() || node.name).then(onDone);
      }}
    >
      <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onDone()} maxLength={60} aria-label="Node name" autoFocus data-testid="node-name-input" />
      <button className="btn small primary">Save</button>
      <button type="button" className="btn small ghost" onClick={onDone}>
        Cancel
      </button>
    </form>
  );
}

/** Settings → Account: who is signed in, and signing out. */
export function AccountSettings({ user }: { user: User | null }) {
  return (
    <section className="card">
      <h3>Signed in</h3>
      {user ? (
        <p className="account">
          {user.avatarUrl ? <img src={user.avatarUrl} alt="" width={28} height={28} /> : null}
          <span>
            <b>{user.name ?? user.login}</b> <span className="muted">@{user.login}</span>
          </span>
        </p>
      ) : null}
      <p className="muted small">Signing out ends this device's session. Your nodes keep running and keep their data.</p>
      <button className="btn" onClick={() => void signOut()} data-testid="sign-out">
        Sign out
      </button>
    </section>
  );
}
