/** Light/dark appearance, chosen per device; "system" follows the OS setting. */

export type ThemeChoice = "system" | "light" | "dark";

const KEY = "vireo.theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function themeChoice(): ThemeChoice {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

function apply(): void {
  const choice = themeChoice();
  const theme = choice === "system" ? (media.matches ? "dark" : "light") : choice;
  document.documentElement.dataset.theme = theme;
  const color = theme === "dark" ? "#191919" : "#ffffff";
  for (const m of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) m.content = color;
}

export function setThemeChoice(choice: ThemeChoice): void {
  if (choice === "system") localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, choice);
  apply();
}

export function initTheme(): void {
  apply();
  media.addEventListener("change", apply);
}
