import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/inter/wght.css";
import "./styles.css";
import { initHosts } from "./hosts";
import { initTheme } from "./theme";

initTheme();

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "navigate" && typeof e.data.url === "string") {
      const hash = e.data.url.split("#")[1];
      if (hash) location.hash = hash;
    }
  });
}

await initHosts();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
