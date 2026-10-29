import type { PokerBot } from "@workbench/contracts";
import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import { Button } from "./ui.tsx";

// Layout: one column per generation (longest path from a root), parents on the left.
const W = 212;
const H = 58;
const GAP_X = 56;
const GAP_Y = 12;
const PAD = 16;

/** The latest evaluation note a variant carries, e.g. "vs adaptive-v2: better +312 ± 200 mbb/hand". */
function verdict(bot: PokerBot) {
  const m = bot.notes.match(/^vs (\S+): (better|worse|unclear) ([+−-]?\d+) ± (\d+)/m);
  return m ? { against: m[1]!, verdict: m[2]!, score: m[3]!.replace("-", "−"), ci: m[4]! } : null;
}

export function Lineage({ bots, onEdit }: { bots: PokerBot[]; onEdit: (id: string) => void }) {
  const byId = new Map(bots.map((b) => [b.id, b]));
  const linked = new Set<string>();
  for (const b of bots)
    if (b.parents.length) {
      linked.add(b.id);
      for (const p of b.parents) linked.add(p.botId);
    }
  const nodes = bots.filter((b) => linked.has(b.id));
  const champion = nodes.find((b) => b.status === "ready");
  const [selected, setSelected] = useState<string | null>(null);
  const focus = byId.get(selected ?? "") ?? champion ?? nodes.at(-1);

  const depths = new Map<string, number>();
  const depth = (b: PokerBot): number => {
    const known = depths.get(b.id);
    if (known !== undefined) return known;
    depths.set(b.id, 0); // the store rejects cycles; this only guards the recursion
    const d = b.parents.reduce((m, p) => Math.max(m, 1 + depth(byId.get(p.botId) ?? b)), 0);
    depths.set(b.id, d);
    return d;
  };
  const columns: PokerBot[][] = [];
  for (const b of nodes) {
    const d = depth(b);
    columns[d] = [...(columns[d] ?? []), b];
  }
  const pos = new Map<string, { x: number; y: number }>();
  columns.forEach((col, d) => {
    col.forEach((b, i) => {
      pos.set(b.id, { x: PAD + d * (W + GAP_X), y: PAD + i * (H + GAP_Y) });
    });
  });
  const width = PAD * 2 + columns.length * W + Math.max(columns.length - 1, 0) * GAP_X;
  const height = PAD * 2 + Math.max(...columns.map((c) => c.length), 0) * (H + GAP_Y) - GAP_Y;
  // Narrow screens show part of the tree: keep the focused variant in view.
  const scroller = useRef<HTMLDivElement>(null);
  const focusX = focus ? pos.get(focus.id)?.x : undefined;
  useEffect(() => {
    if (scroller.current && focusX !== undefined) scroller.current.scrollLeft = Math.max(0, focusX - PAD);
  }, [focusX]);
  const lit = (child: string, parent: string) => focus && (focus.id === child || focus.id === parent);

  return (
    <section aria-label="Lineage" className="mb-4 min-w-0 rounded-lg border border-wb-border bg-wb-panel">
      <div className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 px-4 py-2">
        <h3 className="text-[13px] font-medium text-neutral-100">Lineage</h3>
        <div className="text-[12px] text-neutral-500">
          {nodes.length
            ? `${nodes.length} variants over ${columns.length} ${columns.length === 1 ? "generation" : "generations"}${champion ? `; champion ${champion.name}` : ""}`
            : "Parents and children"}
        </div>
      </div>
      {!nodes.length ? (
        <p className="mx-4 mb-4 rounded-md border border-dashed border-wb-border-strong px-3 py-2.5 text-[13px] text-neutral-500">
          No lineage yet. Bots with parents appear here as a tree of what each generation kept.
        </p>
      ) : (
        <>
          <div ref={scroller} className="overflow-x-auto">
            <div className="relative" style={{ width, height }}>
              <svg width={width} height={height} className="absolute inset-0" aria-hidden="true">
                {nodes.flatMap((b) =>
                  b.parents.map((p) => {
                    const from = pos.get(p.botId);
                    const to = pos.get(b.id);
                    if (!from || !to) return null;
                    const x1 = from.x + W;
                    const y1 = from.y + H / 2;
                    const x2 = to.x;
                    const y2 = to.y + H / 2;
                    return (
                      <path
                        key={`${p.botId}-${b.id}`}
                        d={`M${x1} ${y1} C${x1 + GAP_X / 2} ${y1} ${x2 - GAP_X / 2} ${y2} ${x2} ${y2}`}
                        fill="none"
                        strokeWidth={lit(b.id, p.botId) ? 1.5 : 1}
                        className={lit(b.id, p.botId) ? "stroke-neutral-300" : "stroke-neutral-700"}
                      >
                        <title>{`${byId.get(p.botId)?.name ?? p.botId} → ${b.name}: kept ${p.kept || "—"}`}</title>
                      </path>
                    );
                  }),
                )}
              </svg>
              {nodes.map((b) => {
                const at = pos.get(b.id)!;
                const v = verdict(b);
                const isChampion = b.id === champion?.id;
                return (
                  <button
                    key={b.id}
                    type="button"
                    aria-pressed={focus?.id === b.id}
                    onClick={() => setSelected(b.id)}
                    style={{ left: at.x, top: at.y, width: W, height: H }}
                    className={clsx(
                      "absolute flex flex-col justify-center rounded-md border bg-wb-panel px-3 text-left transition-colors",
                      focus?.id === b.id ? "border-neutral-400" : "border-wb-border-strong hover:border-neutral-600",
                      b.status === "retired" && "opacity-60",
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-[13px] text-neutral-100">{b.name}</span>
                      {isChampion && (
                        <span className="flex-none text-[11px] font-medium text-neutral-300">Champion</span>
                      )}
                    </span>
                    <span className="truncate text-[11px] tabular-nums text-neutral-500">
                      {v ? `${v.verdict} ${v.score} ± ${v.ci} vs ${v.against}` : b.id}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
          {focus && (
            <div className="border-t border-wb-border px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-[13px] font-medium text-neutral-100">{focus.name}</span>
                  <span className="ml-2 font-mono text-[12px] text-neutral-500">{focus.id}</span>
                </div>
                <Button variant="bare" size="xs" className="-mr-2" onClick={() => onEdit(focus.id)}>
                  Edit bot
                </Button>
              </div>
              {focus.approach && <p className="mt-1 max-w-3xl text-[13px] text-neutral-300">{focus.approach}</p>}
              {focus.notes && (
                <p className="mt-1 text-[12px] tabular-nums text-neutral-500">{focus.notes.split("\n")[0]}</p>
              )}
              {focus.parents.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {focus.parents.map((p) => (
                    <li key={p.botId} className="text-[12px] text-neutral-400">
                      <span className="text-neutral-500">Kept from </span>
                      <button
                        type="button"
                        onClick={() => setSelected(p.botId)}
                        className="text-neutral-200 hover:text-neutral-100 hover:underline"
                      >
                        {byId.get(p.botId)?.name ?? p.botId}
                      </button>
                      <span className="text-neutral-500">: </span>
                      {p.kept || "—"}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
