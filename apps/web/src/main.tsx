import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/inter/opsz.css";
import "@fontsource-variable/manrope/wght.css";
import "./styles.css";
import "./cards/cards.css";
import "./shell.css";
import { takeSignIn } from "./cloud";
import { initTheme } from "./theme";
import { ErrorBoundary, reloadForUpdate } from "./components/ErrorBoundary";

initTheme();

/*
 * iPhone and iPad: focusing a field must not zoom the page (it stays zoomed,
 * and then slides sideways), and once installed the app doesn't pinch-zoom
 * either. maximum-scale only stops the focus zoom on iOS; Safari still lets
 * people pinch in a browser tab.
 */
const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
if (ios) {
  const viewport = document.querySelector('meta[name="viewport"]');
  viewport?.setAttribute("content", `${viewport.getAttribute("content")}, maximum-scale=1`);
  if (matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone) {
    document.addEventListener("gesturestart", (e) => e.preventDefault());
  }
}

if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "navigate" && typeof e.data.url === "string") {
      const hash = e.data.url.split("#")[1];
      if (hash) location.hash = hash;
    }
  });
}

// A page's file that is gone after a deploy: load the new version rather than break.
window.addEventListener("vite:preloadError", (e) => {
  if (reloadForUpdate()) e.preventDefault();
});

const signInError = await takeSignIn();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary full>
      <App signInError={signInError} />
    </ErrorBoundary>
  </StrictMode>,
);
