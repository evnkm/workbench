import { Monitor, Moon, Sun } from "lucide-react";
import { setThemeMode, type ThemeMode, useTheme } from "../lib/theme.ts";

export function ThemeSelect() {
  const { mode } = useTheme();
  const Icon = mode === "system" ? Monitor : mode === "dark" ? Moon : Sun;
  return (
    <label className="relative inline-flex shrink-0 items-center">
      <span className="sr-only">Theme</span>
      <Icon size={15} aria-hidden="true" className="pointer-events-none absolute left-2.5 text-neutral-400" />
      <select
        value={mode}
        onChange={(event) => setThemeMode(event.target.value as ThemeMode)}
        className="h-11 rounded-md border border-wb-border-strong bg-wb-bg pl-8 pr-2 text-base text-neutral-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wb-accent md:h-9 md:text-[13px]"
      >
        <option value="system">System</option>
        <option value="dark">Dark</option>
        <option value="light">Light</option>
      </select>
    </label>
  );
}
