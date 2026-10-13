/**
 * The cloud API: accounts (GitHub sign-in), the nodes each account owns,
 * linking a new node, and the short-lived tokens the app uses to reach one.
 */

export interface User {
  id: string;
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

/**
 * How the app reaches a node. "relay": through the cloud, over the socket the
 * node keeps open (works anywhere, nothing to open on the node). "tailscale":
 * straight to the node's tailnet address; the cloud only signs the owner in.
 */
export type NodeMode = "relay" | "tailscale";

/**
 * What a node reached over Tailscale still needs before the app can reach
 * it, so the app can walk the owner through it. The node reports it over
 * its socket to the cloud, which only the owner's own app sees.
 */
export interface NodeSetup {
  step: "installing" | "starting" | "signin" | "approve" | "https" | "error";
  message: string;
  /** The page the owner opens for this step: Tailscale's sign-in, or allowing HTTPS on the tailnet. */
  link?: string;
}

export interface NodeSummary {
  id: string;
  name: string;
  mode: NodeMode;
  /** The node has its socket to the cloud open right now. */
  online: boolean;
  /** The node's own address in tailscale mode, e.g. https://box.tailnet.ts.net. */
  directUrl: string | null;
  /** In tailscale mode, until the node is on the tailnet: what it is waiting for. */
  setup?: NodeSetup | null;
  version: string | null;
  platform: string | null;
  createdAt: number;
  lastSeenAt: number | null;
}

/** POST /api/nodes/:id/token: a token for one node, and where to use it. */
export interface NodeAccess {
  token: string;
  expiresAt: number;
  /** Base URL of the node's API: the cloud relay, or the node's direct address. */
  baseUrl: string;
  mode: NodeMode;
}

/**
 * What a node access token says (a JWT signed by the cloud with Ed25519).
 * The node checks the signature against the cloud key it saved when it was
 * linked, that it is the audience, and that the subject is its owner.
 */
export interface NodeClaims {
  iss: string;
  /** The user's id. */
  sub: string;
  /** The node's id. */
  aud: string;
  login: string;
  role: "owner";
  /** Set when the owner's other node asks on their behalf: that node's id. */
  via?: string;
  iat: number;
  exp: number;
}

/** POST /api/node/peers, by a linked node: the owner's other nodes, each with a token for this node to use. */
export interface NodePeers {
  /** The node that asked, as the account sees it. */
  self?: NodeSummary;
  peers: { node: NodeSummary; access: NodeAccess }[];
}

/** POST /api/link/start, by a node that is not linked yet. */
export interface LinkStartRequest {
  name: string;
  platform: string;
  version: string;
  mode: NodeMode;
}

export interface LinkStart {
  /** Shown to the owner and typed or opened in the app, e.g. "WDJB-MJHT". */
  userCode: string;
  /** Secret the node polls with; never shown. */
  deviceCode: string;
  /** Opens the app on the page that approves this node. */
  verifyUrl: string;
  /** Seconds between polls. */
  interval: number;
  expiresAt: number;
}

/** POST /api/link/poll */
export type LinkPoll =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "denied" }
  | {
      status: "approved";
      nodeId: string;
      /** The node's own secret for the relay socket; stored on the node only. */
      nodeSecret: string;
      owner: User;
      /** The cloud's Ed25519 public key (SPKI, PEM) the node verifies tokens with. */
      publicKey: string;
    };

/** GET /api/link/:code, for the app's approval page. */
export interface LinkRequest {
  userCode: string;
  name: string;
  platform: string;
  mode: NodeMode;
  expiresAt: number;
}

/** GET /.well-known/vireo.json */
export interface CloudInfo {
  name: string;
  publicKey: string;
  webUrl: string;
  github: boolean;
  devLogin: boolean;
}
