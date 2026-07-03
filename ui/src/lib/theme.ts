import { useState } from "react";

/**
 * Theme plumbing. Both token sets exist: `dark` is the `@theme` default and
 * `light` is the `[data-theme="light"]` override block (both in `styles.css`,
 * added in M5). This wires persistence + applies a `data-theme` attribute (and a
 * `dark` class) on <html>. `system` resolves via `matchMedia`.
 */
export type Theme = "system" | "dark" | "light";

const KEY = "autodev.theme";
const THEMES: readonly Theme[] = ["system", "dark", "light"];

export function getTheme(): Theme {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw && (THEMES as readonly string[]).includes(raw)) return raw as Theme;
  } catch {
    /* localStorage unavailable (private mode / SSR) — fall through to default */
  }
  return "dark";
}

/** Resolve `system` to a concrete `dark`/`light` and apply it to <html>. */
export function applyTheme(theme: Theme): void {
  const resolved =
    theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : theme;
  const el = document.documentElement;
  el.setAttribute("data-theme", resolved);
  el.classList.toggle("dark", resolved === "dark");
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* persistence best-effort — still apply for this session */
  }
  applyTheme(theme);
}

/** Tiny hook so the segmented control re-renders on change. */
export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, set] = useState<Theme>(getTheme);
  const update = (t: Theme) => {
    setTheme(t);
    set(t);
  };
  return [theme, update];
}
