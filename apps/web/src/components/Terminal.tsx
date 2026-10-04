// xterm.js view of a tmux-backed session over the authenticated WebSocket.
// Unmounting detaches; the session keeps running on the server.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { useTheme } from "../lib/theme.ts";

export type TerminalHandle = { send: (data: string) => void; focus: () => void };

function theme() {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return { background: v("--color-wb-bg"), foreground: v("--color-neutral-200"), cursor: v("--color-wb-accent") };
}

export function Terminal({ processId, ref }: { processId: string; ref?: React.Ref<TerminalHandle> }) {
  const { effective } = useTheme();
  const host = useRef<HTMLDivElement>(null);
  const ws = useRef<WebSocket | null>(null);
  const term = useRef<XTerm | null>(null);
  const [status, setStatus] = useState<"connecting" | "open" | "closed">("connecting");
  const [attempt, setAttempt] = useState(0);

  useImperativeHandle(ref, () => ({
    send: (d) => ws.current?.readyState === WebSocket.OPEN && ws.current.send(JSON.stringify({ t: "i", d })),
    focus: () => term.current?.focus(),
  }));

  // biome-ignore lint/correctness/useExhaustiveDependencies: reconnect on attempt change.
  useEffect(() => {
    const el = host.current!;
    const t = new XTerm({
      fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace',
      fontSize: window.matchMedia("(max-width: 767px)").matches ? 12 : 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: theme(),
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(el);
    term.current = t;
    fit.fit();
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(
      `${proto}://${location.host}/api/processes/${processId}/terminal?cols=${t.cols}&rows=${t.rows}`,
    );
    ws.current = socket;
    socket.onopen = () => setStatus("open");
    socket.onmessage = (e) => t.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
    socket.onclose = () => setStatus("closed");
    const input = t.onData((d) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ t: "i", d })));
    const resize = () => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: "r", c: t.cols, r: t.rows }));
    };
    const ro = new ResizeObserver(() => requestAnimationFrame(resize));
    ro.observe(el);
    return () => {
      ro.disconnect();
      input.dispose();
      socket.close();
      t.dispose();
      term.current = null;
    };
  }, [processId, attempt]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reread CSS colors on theme changes without reattaching the terminal.
  useEffect(() => {
    if (term.current) term.current.options.theme = theme();
  }, [effective]);

  return (
    <div className="relative h-full min-h-0 w-full">
      <div ref={host} className="h-full w-full px-1 pt-1" />
      {status !== "open" && (
        <div className="absolute inset-x-0 top-2 flex justify-center">
          <span className="rounded-full border border-wb-border bg-wb-panel-2 px-3 py-1 text-[12px] text-neutral-300">
            {status === "connecting" ? (
              "Attaching…"
            ) : (
              <button type="button" className="underline" onClick={() => setAttempt((a) => a + 1)}>
                Detached — reattach
              </button>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
