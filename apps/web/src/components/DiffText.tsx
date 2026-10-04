import clsx from "clsx";
import { memo } from "react";

const MAX_LINES = 4000;

type Row = { kind: "add" | "del" | "ctx" | "hunk" | "meta"; text: string; oldNo: number | null; newNo: number | null };

function parse(diff: string): { rows: Row[]; clipped: boolean } {
  const lines = diff.split("\n");
  const rows: Row[] = [];
  let o = 0;
  let n = 0;
  for (const line of lines.slice(0, MAX_LINES)) {
    if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (m) [o, n] = [Number(m[1]), Number(m[2])];
      rows.push({ kind: "hunk", text: line, oldNo: null, newNo: null });
    } else if (
      /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary)/.test(line)
    ) {
      rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    } else if (line.startsWith("+")) rows.push({ kind: "add", text: line.slice(1), oldNo: null, newNo: n++ });
    else if (line.startsWith("-")) rows.push({ kind: "del", text: line.slice(1), oldNo: o++, newNo: null });
    else if (line.startsWith("\\")) rows.push({ kind: "meta", text: line, oldNo: null, newNo: null });
    else rows.push({ kind: "ctx", text: line.slice(1), oldNo: o++, newNo: n++ });
  }
  return { rows, clipped: lines.length > MAX_LINES };
}

const rowClass = {
  add: "bg-emerald-500/10 text-emerald-200",
  del: "bg-red-500/10 text-red-200",
  ctx: "text-neutral-300",
  hunk: "bg-sky-500/10 text-sky-300",
  meta: "text-neutral-500",
};

/** Unified (stacked) diff, or split side-by-side on wide screens. */
export const DiffText = memo(function DiffText({ diff, split = false }: { diff: string; split?: boolean }) {
  const { rows, clipped } = parse(diff);
  if (!diff.trim()) return <p className="p-3 text-[12px] text-neutral-500">No textual changes.</p>;
  if (split) return <SplitDiff rows={rows} clipped={clipped} />;
  return (
    <div className="overflow-x-auto font-mono text-[12px] leading-[1.55]">
      <table className="min-w-full border-collapse">
        <tbody>
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional.
            <tr key={i} className={rowClass[r.kind]}>
              <td className="select-none px-1.5 text-right align-top text-neutral-600">{r.oldNo ?? ""}</td>
              <td className="select-none px-1.5 text-right align-top text-neutral-600">{r.newNo ?? ""}</td>
              <td className="whitespace-pre px-2">
                {r.kind === "add" ? "+" : r.kind === "del" ? "-" : r.kind === "ctx" ? " " : ""}
                {r.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {clipped && <p className="p-2 text-[12px] text-amber-300">Diff clipped to {MAX_LINES} lines.</p>}
    </div>
  );
});

function SplitDiff({ rows, clipped }: { rows: Row[]; clipped: boolean }) {
  // Pair deletions with following additions within each change block.
  const pairs: [Row | null, Row | null][] = [];
  let dels: Row[] = [];
  let adds: Row[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) pairs.push([dels[i] ?? null, adds[i] ?? null]);
    dels = [];
    adds = [];
  };
  for (const r of rows) {
    if (r.kind === "del") dels.push(r);
    else if (r.kind === "add") adds.push(r);
    else {
      flush();
      pairs.push([r, r]);
    }
  }
  flush();
  const cell = (r: Row | null, side: "old" | "new") => (
    <>
      <td className="w-10 select-none px-1.5 text-right align-top text-neutral-600">
        {r ? (side === "old" ? r.oldNo : r.newNo) : ""}
      </td>
      <td className={clsx("w-1/2 whitespace-pre-wrap break-all px-2", r ? rowClass[r.kind] : "bg-neutral-900/40")}>
        {r?.text ?? ""}
      </td>
    </>
  );
  return (
    <div className="font-mono text-[12px] leading-[1.55]">
      <table className="w-full table-fixed border-collapse">
        <tbody>
          {pairs.map(([l, r], i) =>
            l && (l.kind === "hunk" || l.kind === "meta") ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional.
              <tr key={i} className={rowClass[l.kind]}>
                <td colSpan={4} className="whitespace-pre-wrap px-2">
                  {l.text}
                </td>
              </tr>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional.
              <tr key={i}>
                {cell(l, "old")}
                {cell(r, "new")}
              </tr>
            ),
          )}
        </tbody>
      </table>
      {clipped && <p className="p-2 text-[12px] text-amber-300">Diff clipped to {MAX_LINES} lines.</p>}
    </div>
  );
}
