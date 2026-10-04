import { useSyncExternalStore } from "react";

const desktop = window.matchMedia("(min-width: 768px)");

/** True at the md breakpoint and above. Panels that hold connections render only in one layout. */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    (l) => {
      desktop.addEventListener("change", l);
      return () => desktop.removeEventListener("change", l);
    },
    () => desktop.matches,
  );
}
