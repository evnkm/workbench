// Approvals and questions, placed directly above the composer.
import { type PendingInput, uuidv7 } from "@workbench/contracts";
import { CircleHelp, ShieldQuestion } from "lucide-react";
import { useRef, useState } from "react";
import { sendCommand } from "../lib/api.ts";
import { Button, inputClass } from "./ui.tsx";

export function InputPanel({ inputs }: { inputs: PendingInput[] }) {
  return (
    <div className="shrink-0 border-t border-amber-900/50 bg-amber-950/20 px-3 py-3 md:px-6">
      <div className="mx-auto max-h-[45dvh] max-w-3xl space-y-3 overflow-y-auto">
        {inputs.map((i) =>
          i.kind === "question" ? <QuestionCard key={i.id} input={i} /> : <ApprovalCard key={i.id} input={i} />,
        )}
      </div>
    </div>
  );
}

function useRespond(input: PendingInput) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One request id per answer attempt; network retries reuse it.
  const attempt = useRef(uuidv7());
  const respond = async (response: PendingInput["response"]) => {
    setBusy(true);
    setError(null);
    try {
      await sendCommand("input.respond", { inputId: input.id, response: response! }, attempt.current);
    } catch (e) {
      setError((e as Error).message);
      attempt.current = uuidv7();
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, respond };
}

function ApprovalCard({ input }: { input: PendingInput }) {
  const { busy, error, respond } = useRespond(input);
  const r = input.request;
  return (
    <section aria-label={r.title} className="rounded-lg border border-amber-800/60 bg-wb-panel p-3">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-amber-200">
        <ShieldQuestion size={15} /> {r.title}
      </div>
      {r.command && (
        <pre className="mb-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-wb-bg px-2.5 py-2 font-mono text-[12.5px] text-neutral-100">
          {r.command}
        </pre>
      )}
      {r.cwd && <p className="mb-2 truncate font-mono text-[11px] text-neutral-500">{r.cwd}</p>}
      {r.reason && <p className="mb-2 text-[13px] text-neutral-300">{r.reason}</p>}
      <div className="flex flex-wrap gap-2">
        {(r.decisions ?? []).map((d) => (
          <Button
            key={d.id}
            size="md"
            variant={d.id === "accept" ? "primary" : d.id === "cancel" ? "danger" : "ghost"}
            disabled={busy}
            onClick={() => void respond({ kind: "decision", decision: d.id })}
          >
            {d.label}
          </Button>
        ))}
      </div>
      {error && <p className="mt-2 text-[12px] text-red-300">{error}</p>}
    </section>
  );
}

function QuestionCard({ input }: { input: PendingInput }) {
  const { busy, error, respond } = useRespond(input);
  const questions = input.request.questions ?? [];
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const complete = questions.every((q) => (answers[q.id] === "__other" ? other[q.id]?.trim() : answers[q.id]));
  const submit = () =>
    respond({
      kind: "answers",
      answers: Object.fromEntries(
        questions.map((q) => [
          q.id,
          [answers[q.id] === "__other" ? (other[q.id] ?? "").trim() : (answers[q.id] ?? "")],
        ]),
      ),
    });
  return (
    <section aria-label={input.request.title} className="rounded-lg border border-sky-800/60 bg-wb-panel p-3">
      <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold text-sky-200">
        <CircleHelp size={15} /> {input.request.title}
      </div>
      <div className="space-y-4">
        {questions.map((q) => (
          <fieldset key={q.id} className="space-y-1.5">
            <legend className="mb-1 text-[14px] text-neutral-100">
              {q.header && <span className="mr-1 text-neutral-500">{q.header}:</span>}
              {q.question}
            </legend>
            {(q.options ?? []).map((o) => (
              <label
                key={o.label}
                className="flex min-h-10 cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-neutral-900"
              >
                <input
                  type="radio"
                  className="mt-1"
                  name={`${input.id}-${q.id}`}
                  checked={answers[q.id] === o.label}
                  onChange={() => setAnswers((a) => ({ ...a, [q.id]: o.label }))}
                />
                <span>
                  <span className="block text-[14px] text-neutral-200">{o.label}</span>
                  {o.description && <span className="block text-[12px] text-neutral-500">{o.description}</span>}
                </span>
              </label>
            ))}
            {(q.allowOther || !q.options?.length) && (
              <div className="space-y-1.5 px-2">
                {q.options?.length ? (
                  <label className="flex items-center gap-2 text-[13px] text-neutral-300">
                    <input
                      type="radio"
                      name={`${input.id}-${q.id}`}
                      checked={answers[q.id] === "__other"}
                      onChange={() => setAnswers((a) => ({ ...a, [q.id]: "__other" }))}
                    />
                    Other
                  </label>
                ) : null}
                {(answers[q.id] === "__other" || !q.options?.length) && (
                  <input
                    type={q.secret ? "password" : "text"}
                    className={inputClass}
                    value={other[q.id] ?? ""}
                    onChange={(e) => {
                      setOther((o) => ({ ...o, [q.id]: e.target.value }));
                      setAnswers((a) => ({ ...a, [q.id]: "__other" }));
                    }}
                    aria-label={`Answer to ${q.question}`}
                  />
                )}
              </div>
            )}
          </fieldset>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Button size="md" variant="primary" disabled={busy || !complete} onClick={() => void submit()}>
          Send answer
        </Button>
      </div>
      {error && <p className="mt-2 text-[12px] text-red-300">{error}</p>}
    </section>
  );
}
