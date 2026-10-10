// `npm start`: the host (agent + API on :8787) and the app (UI on :8780)
// together, for running Vireo on one machine. On a VPS that only serves as a
// host, use `npm run host`.
import { spawn } from "node:child_process";

const node = [process.execPath, "--env-file-if-exists=.env", "--disable-warning=ExperimentalWarning"];
const children = [
  spawn(node[0], [...node.slice(1), "apps/host/dist/index.js"], { stdio: "inherit" }),
  spawn(node[0], [...node.slice(1), "apps/web/serve.mjs"], { stdio: "inherit" }),
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
