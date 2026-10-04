import { useEffect, useState } from "react";
import { api } from "./api.ts";
import { useStore } from "./store.ts";

/** Finished or waiting job runs the user has not opened yet. */
export function useUnreadCount() {
  const version = useStore((s) => s.jobsVersion);
  const signedIn = useStore((s) => s.auth === "signedIn");
  const [n, setN] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when job runs change.
  useEffect(() => {
    if (signedIn)
      api<{ unread: number }>("/api/job-runs?limit=0").then(
        (r) => setN(r.unread),
        () => {},
      );
  }, [version, signedIn]);
  return n;
}
