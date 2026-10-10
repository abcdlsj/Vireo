// `npm start`: a cloud (sign-in, the app, the relay on :8700) and a node
// together, for running all of Vireo on one machine. Sign-in needs a GitHub
// OAuth app (GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET) or VIREO_DEV_LOGIN=1 in
// .env. Open http://localhost:8700, sign in, and approve the node with the
// link it prints.
import { spawn } from "node:child_process";

const node = [process.execPath, "--env-file-if-exists=.env", "--disable-warning=ExperimentalWarning"];
const cloudUrl = process.env.VIREO_CLOUD_URL ?? "http://localhost:8700";
const children = [
  spawn(node[0], [...node.slice(1), "apps/cloud/dist/node/index.js"], { stdio: "inherit", env: { VIREO_WEB_DIR: "apps/web/dist", ...process.env } }),
  spawn(node[0], [...node.slice(1), "apps/node/dist/index.js"], { stdio: "inherit", env: { ...process.env, VIREO_CLOUD_URL: cloudUrl } }),
];
let exiting = false;
const stop = (code) => {
  if (exiting) return;
  exiting = true;
  for (const c of children) c.kill("SIGTERM");
  process.exitCode = code;
};
for (const c of children) c.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
