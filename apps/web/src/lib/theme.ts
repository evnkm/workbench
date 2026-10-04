import { useSyncExternalStore } from "react";

export type ThemeMode = "system" | "dark" | "light";

const storageKey = "wb:theme";
const systemTheme = window.matchMedia("(prefers-color-scheme: light)");
const listeners = new Set<() => void>();

function readMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(storageKey);
    if (stored === "dark" || stored === "light") return stored;
  } catch {
    // Browsers can disable storage; theme switching still works for this tab.
  }
  return "system";
}

function resolveTheme(mode: ThemeMode): "light" | "dark" {
  return mode === "system" ? (systemTheme.matches ? "light" : "dark") : mode;
}

let state = { mode: readMode(), effective: "dark" as "light" | "dark" };

function applyTheme(mode: ThemeMode) {
  const effective = resolveTheme(mode);
  document.documentElement.classList.toggle("light", effective === "light");
  if (state.mode === mode && state.effective === effective) return;
  state = { mode, effective };
  for (const listener of listeners) listener();
}

// Apply before React mounts, then follow system appearance changes live.
applyTheme(state.mode);
systemTheme.addEventListener("change", () => applyTheme(state.mode));

export function setThemeMode(mode: ThemeMode) {
  try {
    localStorage.setItem(storageKey, mode);
  } catch {
    // Keep the current tab usable when browser storage is unavailable.
  }
  applyTheme(mode);
}

export function useTheme() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}
