import { Bell } from "lucide-react";
import { useEffect, useState } from "react";
import {
  disablePush,
  enablePush,
  playCompletionSound,
  pushEnabled,
  pushSupportReason,
  SOUND_KEY,
  testPush,
} from "../lib/notifications.ts";
import { Button, Dialog, IconButton } from "./ui.tsx";

export function NotificationSettings() {
  const [open, setOpen] = useState(false);
  const [sound, setSound] = useState(() => localStorage.getItem(SOUND_KEY) === "1");
  const [push, setPush] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reason = pushSupportReason();
  useEffect(() => {
    void pushEnabled()
      .then(setPush)
      .catch((e: Error) => setError(e.message));
  }, []);
  const action = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <IconButton
        label="Turn notifications"
        onClick={() => {
          setSound(localStorage.getItem(SOUND_KEY) === "1");
          setOpen(true);
          void pushEnabled()
            .then(setPush)
            .catch((e: Error) => setError(e.message));
        }}
      >
        <Bell size={16} />
      </IconButton>
      {open && (
        <Dialog title="Turn notifications" onClose={() => setOpen(false)}>
          <div className="space-y-4 text-[13px] text-neutral-300">
            <p>
              Get an alert when any Codex conversation finishes a turn. Settings apply to this browser or installed app.
            </p>
            <div className="space-y-2">
              <label className="flex min-h-10 items-center gap-2">
                <input
                  type="checkbox"
                  checked={sound}
                  onChange={(e) => {
                    const enabled = e.target.checked;
                    localStorage.setItem(SOUND_KEY, enabled ? "1" : "0");
                    setSound(enabled);
                    if (enabled) void action(playCompletionSound);
                  }}
                />
                Completion sound while Workbench is open
              </label>
              <Button size="xs" onClick={() => void action(playCompletionSound)} disabled={busy}>
                Test sound
              </Button>
            </div>
            <div className="space-y-2 border-t border-wb-border pt-3">
              <p>Device notifications work even when the app is closed. Tap a notification to open its conversation.</p>
              {reason && <p className="text-neutral-400">{reason}</p>}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy || !!reason}
                  onClick={() =>
                    void action(async () => {
                      if (push) {
                        await disablePush();
                        setPush(false);
                      } else {
                        await enablePush();
                        setPush(true);
                        setNotice("Notifications enabled on this device.");
                      }
                    })
                  }
                >
                  {push ? "Disable device notifications" : "Enable device notifications"}
                </Button>
                {push && (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void action(async () => {
                        await testPush();
                        setNotice("Test notification sent to this device.");
                      })
                    }
                  >
                    Send test notification
                  </Button>
                )}
              </div>
            </div>
            {error && (
              <p role="alert" className="text-red-300">
                {error}
              </p>
            )}
            {notice && (
              <p role="status" className="text-emerald-300">
                {notice}
              </p>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
