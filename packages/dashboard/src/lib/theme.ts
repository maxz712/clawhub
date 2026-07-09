export type Theme = "light" | "dark";

const STORAGE_KEY = "clawhub_theme";

// Dark is the historical/default look — only switch to light when the user
// explicitly stored a preference.
export function getTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return window.localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
}

export function setTheme(theme: Theme) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, theme);
  document.documentElement.classList.toggle("dark", theme === "dark");
}

// Inlined into <head> so the correct class is applied before first paint —
// otherwise a light-mode user would see a flash of the dark theme (or vice
// versa) while React hydrates.
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${STORAGE_KEY}');document.documentElement.classList.toggle('dark', t!=='light');}catch(e){document.documentElement.classList.add('dark');}})();`;
