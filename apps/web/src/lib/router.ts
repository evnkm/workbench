// Minimal path router on the History API.
import { useSyncExternalStore } from "react";

export type Route =
  | { name: "home" }
  | { name: "workspace"; workspaceId: string; conversationId: string | null; pane: Pane }
  | { name: "jobs"; runId: string | null }
  | { name: "settings" };

export type Pane = "conversation" | "changes" | "shell" | "run";
const PANES: Pane[] = ["conversation", "changes", "shell", "run"];

export function parse(path: string): Route {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "w" && parts[1]) {
    const conversationId = parts[2] === "c" && parts[3] ? parts[3] : null;
    const rest = conversationId ? parts[4] : parts[2];
    const pane = PANES.includes(rest as Pane) ? (rest as Pane) : "conversation";
    return { name: "workspace", workspaceId: parts[1], conversationId, pane };
  }
  if (parts[0] === "jobs") return { name: "jobs", runId: parts[1] ?? null };
  if (parts[0] === "settings") return { name: "settings" };
  return { name: "home" };
}

export function href(r: Route): string {
  switch (r.name) {
    case "home":
      return "/";
    case "jobs":
      return r.runId ? `/jobs/${r.runId}` : "/jobs";
    case "settings":
      return "/settings";
    case "workspace": {
      let p = `/w/${r.workspaceId}`;
      if (r.conversationId) p += `/c/${r.conversationId}`;
      if (r.pane !== "conversation") p += `/${r.pane}`;
      return p;
    }
  }
}

const listeners = new Set<() => void>();
window.addEventListener("popstate", () => {
  for (const l of listeners) l();
});

export function navigate(r: Route | string, replace = false) {
  const url = typeof r === "string" ? r : href(r);
  if (url === location.pathname) return;
  if (replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  for (const l of listeners) l();
}

export function useRoute(): Route {
  const path = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => location.pathname,
  );
  return parse(path);
}
