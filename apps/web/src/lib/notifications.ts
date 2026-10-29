import type { Run } from "@workbench/contracts";
import { isTerminalRunState } from "@workbench/contracts";
import { api } from "./api.ts";

export const SOUND_KEY = "wb:completion-sound";
const PUSH_KEY = "wb:completion-push";
let audio: AudioContext | null = null;

export async function playCompletionSound() {
  if (!audio) audio = new AudioContext();
  await audio.resume();
  for (const [delay, frequency] of [
    [0, 660],
    [0.16, 880],
  ]) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const start = audio.currentTime + delay!;
    oscillator.frequency.value = frequency!;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, start + 0.18);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.2);
  }
}

export function initializeSounds() {
  // A gesture after refresh unlocks audio without interrupting the conversation.
  const unlock = () => {
    if (localStorage.getItem(SOUND_KEY) !== "1") return;
    if (!audio) audio = new AudioContext();
    void audio.resume().catch(() => {});
  };
  window.addEventListener("pointerdown", unlock);
  window.addEventListener("keydown", unlock);
  return () => {
    window.removeEventListener("pointerdown", unlock);
    window.removeEventListener("keydown", unlock);
  };
}

export function onTurnCompletion(previous: Run | undefined, run: Run) {
  if (
    !previous ||
    run.kind !== "agent_turn" ||
    isTerminalRunState(previous.state) ||
    !isTerminalRunState(run.state) ||
    previous.state === "queued"
  )
    return;
  // One chime across tabs; old snapshot/replay completions never ring on refresh.
  if (!run.endedAt || Date.now() - Date.parse(run.endedAt) > 30_000 || document.visibilityState !== "visible") return;
  const seen = (localStorage.getItem("wb:alerted-turns") ?? "").split(",");
  if (seen.includes(run.id)) return;
  localStorage.setItem("wb:alerted-turns", [...seen.slice(-99), run.id].join(","));
  if (localStorage.getItem(SOUND_KEY) === "1") void playCompletionSound().catch(() => {});
}

export function pushSupportReason(): string | null {
  const appleMobile =
    /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (appleMobile && !matchMedia("(display-mode: standalone)").matches)
    return "On iPhone or iPad, add Workbench to your Home Screen, open it there, then enable notifications (iOS 16.4 or later).";
  if (!window.isSecureContext) return "Open Workbench over HTTPS to enable device notifications.";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return "This browser doesn't support device notifications. Completion sounds are still available.";
  return null;
}

async function registration() {
  await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  return navigator.serviceWorker.ready;
}
async function saveSubscription(subscription: PushSubscription) {
  await api("/api/notifications/subscriptions", { method: "POST", body: JSON.stringify(subscription.toJSON()) });
}
export async function pushEnabled() {
  if (pushSupportReason() || Notification.permission !== "granted") return false;
  const subscription = await (await registration()).pushManager.getSubscription();
  if (!subscription) {
    localStorage.removeItem(PUSH_KEY);
    return false;
  }
  // Restore association with the current authenticated session after re-login.
  if (localStorage.getItem(PUSH_KEY) === "1") await saveSubscription(subscription);
  return localStorage.getItem(PUSH_KEY) === "1";
}
export async function enablePush() {
  const reason = pushSupportReason();
  if (reason) throw new Error(reason);
  // Must be called directly from the user's click, before awaiting network I/O.
  if ((await Notification.requestPermission()) !== "granted")
    throw new Error("Notifications weren't allowed. Enable them in your browser or device settings, then try again.");
  const reg = await registration();
  const { publicKey } = await api<{ publicKey: string }>("/api/notifications/key");
  const bytes = Uint8Array.from(atob(publicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  let subscription = await reg.pushManager.getSubscription();
  if (
    subscription?.options.applicationServerKey &&
    new Uint8Array(subscription.options.applicationServerKey).some((b, i) => b !== bytes[i])
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
  await saveSubscription(subscription);
  localStorage.setItem(PUSH_KEY, "1");
}
export async function disablePush() {
  const subscription = await (await registration()).pushManager.getSubscription();
  if (subscription) {
    await api("/api/notifications/subscriptions", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe();
  }
  localStorage.removeItem(PUSH_KEY);
}
export async function testPush() {
  const subscription = await (await registration()).pushManager.getSubscription();
  if (!subscription) throw new Error("Enable notifications on this device first.");
  await api("/api/notifications/test", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }) });
}
