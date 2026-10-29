import {
  type AgentModel,
  type CommandPayload,
  type Conversation,
  type InspectResult,
  PROVIDER_LABELS,
  type Workspace,
} from "@workbench/contracts";
import { useEffect, useState } from "react";
import { sendCommand } from "../lib/api.ts";
import { navigate } from "../lib/router.ts";
import { useStore } from "../lib/store.ts";
import { ThemeSelect } from "./ThemeSelect.tsx";
import { Button, Dialog, ErrorText, Field, inputClass } from "./ui.tsx";

export type SlashPanel =
  | "model"
  | "reasoning"
  | "fast"
  | "permissions"
  | "rename"
  | "review"
  | "resume"
  | "mention"
  | "theme"
  | Exclude<CommandPayload<"conversation.inspect">["view"], "commands">;

export function SlashCommandDialog({
  panel,
  conversation,
  workspace,
  onClose,
  onDraft,
}: {
  panel: SlashPanel;
  conversation: Conversation;
  workspace: Workspace;
  onClose: () => void;
  onDraft: (text: string) => void;
}) {
  const [data, setData] = useState<InspectResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const conversations = useStore((s) => s.conversations);
  const inspect = [
    "model",
    "reasoning",
    "fast",
    "models",
    "status",
    "usage",
    "skills",
    "apps",
    "mcp",
    "plugins",
    "hooks",
  ].includes(panel);
  useEffect(() => {
    if (!inspect) return;
    let stopped = false;
    const view = ["model", "reasoning", "fast"].includes(panel) ? "models" : panel;
    sendCommand("conversation.inspect", { conversationId: conversation.id, view }).then(
      (result) => {
        if (!stopped) setData(result as InspectResult);
      },
      (e) => {
        if (!stopped) setError((e as Error).message);
      },
    );
    return () => {
      stopped = true;
    };
  }, [inspect, panel, conversation.id]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const configure = (patch: Omit<CommandPayload<"conversation.configure">, "conversationId">) =>
    act(() => sendCommand("conversation.configure", { conversationId: conversation.id, ...patch }));
  const title =
    panel === "model" || panel === "models"
      ? "Model and reasoning"
      : panel === "fast"
        ? "Response speed"
        : data && "title" in data
          ? data.title
          : panel === "permissions"
            ? "Approval policy"
            : panel === "theme"
              ? "Appearance"
              : panel.charAt(0).toUpperCase() + panel.slice(1);
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="space-y-4">
        <ErrorText>{error}</ErrorText>
        {inspect && !data && !error && (
          <p className="text-[13px] text-neutral-500">Loading from {PROVIDER_LABELS[conversation.provider]}…</p>
        )}
        {data?.kind === "models" && (
          <ModelPicker panel={panel} conversation={conversation} models={data.models} busy={busy} onApply={configure} />
        )}
        {data?.kind === "info" &&
          (data.rows.length ? (
            <dl className="space-y-3 text-[13px]">
              {data.rows.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: one immutable inspection result; rows have no component state.
                <div key={index}>
                  <dt className="text-neutral-500">{row.label}</dt>
                  <dd className="whitespace-pre-wrap break-words text-neutral-200">{row.value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-[13px] text-neutral-500">None configured.</p>
          ))}
        {data?.kind === "choices" &&
          (data.choices.length ? (
            <div className="space-y-2">
              {data.choices.map((choice) => (
                <button
                  key={choice.text}
                  type="button"
                  className="w-full rounded-md border border-wb-border p-3 text-left hover:bg-neutral-900"
                  onClick={() => {
                    onDraft(choice.text);
                    onClose();
                  }}
                >
                  <span className="block text-sm text-neutral-200">{choice.label}</span>
                  <span className="block text-[12px] text-neutral-500">{choice.description}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="text-[13px] text-neutral-500">None available in this workspace.</p>
          ))}
        {panel === "permissions" && <ApprovalPicker conversation={conversation} busy={busy} onApply={configure} />}
        {panel === "rename" && (
          <TextAction
            label="Conversation title"
            initial={conversation.title}
            button="Rename"
            busy={busy}
            onSubmit={(title) =>
              act(() => sendCommand("conversation.rename", { conversationId: conversation.id, title }))
            }
          />
        )}
        {panel === "mention" && (
          <TextAction
            label="File path"
            initial=""
            button="Insert path"
            busy={busy}
            onSubmit={async (path) => {
              onDraft(`Please inspect ${path} `);
              onClose();
            }}
          />
        )}
        {panel === "review" && (
          <ReviewPicker
            baseRef={workspace.baseRef}
            busy={busy}
            onReview={(reviewTarget) =>
              act(() =>
                sendCommand("turn.start", {
                  conversationId: conversation.id,
                  mode: "review",
                  reviewTarget,
                  text:
                    reviewTarget.type === "baseBranch"
                      ? `Review changes against ${reviewTarget.branch}`
                      : "Review uncommitted changes",
                }),
              )
            }
          />
        )}
        {panel === "resume" && (
          <div className="space-y-2">
            {Object.values(conversations)
              .filter((c) => c.workspaceId === workspace.id)
              .map((c) => (
                <button
                  type="button"
                  key={c.id}
                  className="block w-full rounded border border-wb-border p-3 text-left text-sm hover:bg-neutral-900"
                  onClick={() => {
                    navigate({
                      name: "workspace",
                      workspaceId: workspace.id,
                      conversationId: c.id,
                      pane: "conversation",
                    });
                    onClose();
                  }}
                >
                  {c.title}
                </button>
              ))}
          </div>
        )}
        {panel === "theme" && <ThemeSelect />}
      </div>
    </Dialog>
  );
}

function ModelPicker({
  panel,
  models,
  conversation,
  busy,
  onApply,
}: {
  panel: SlashPanel;
  models: AgentModel[];
  conversation: Conversation;
  busy: boolean;
  onApply: (patch: Omit<CommandPayload<"conversation.configure">, "conversationId">) => Promise<void>;
}) {
  const current =
    models.find((m) => m.model === conversation.model) ??
    (conversation.model == null ? models.find((m) => m.isDefault) : undefined);
  const [modelId, setModelId] = useState(current?.model ?? "");
  const model = models.find((m) => m.model === modelId);
  const fast = model?.serviceTiers.find((t) => /^fast$/i.test(t.name) || t.id === "fast");
  const [effort, setEffort] = useState(
    current?.efforts.some((e) => e.effort === conversation.reasoningEffort)
      ? conversation.reasoningEffort!
      : (current?.defaultEffort ?? ""),
  );
  const [tier, setTier] = useState(fast?.id === conversation.serviceTier ? fast.id : "");
  if (models.length === 0)
    return (
      <p className="text-[13px] text-neutral-500">
        {PROVIDER_LABELS[conversation.provider]} returned no available models.
      </p>
    );
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void onApply(
          panel === "fast"
            ? { serviceTier: tier || null }
            : { model: modelId, reasoningEffort: model?.efforts.length && effort ? effort : null },
        );
      }}
    >
      {panel !== "fast" && panel !== "reasoning" ? (
        <Field label="Model">
          <select
            className={inputClass}
            value={modelId}
            onChange={(e) => {
              setModelId(e.target.value);
              setEffort(models.find((m) => m.model === e.target.value)!.defaultEffort);
            }}
            required
          >
            {!model && <option value="">Choose an available model</option>}
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.name}
              </option>
            ))}
          </select>
        </Field>
      ) : (
        <p className="text-sm text-neutral-300">
          {model?.name ?? "The current model is no longer listed. Choose an available model with /model."}
        </p>
      )}
      {panel !== "fast" && model && model.efforts.length > 0 && (
        <Field label="Reasoning effort" hint={model.efforts.find((e) => e.effort === effort)?.description}>
          <select
            aria-label="Reasoning effort"
            className={inputClass}
            value={effort}
            onChange={(e) => setEffort(e.target.value)}
          >
            {!model.defaultEffort && <option value="">Model default</option>}
            {model.efforts.map((e) => (
              <option key={e.effort} value={e.effort}>
                {e.effort}
              </option>
            ))}
          </select>
        </Field>
      )}
      {panel === "fast" && (
        <Field
          label="Speed"
          hint={tier ? model?.serviceTiers.find((t) => t.id === tier)?.description : "Standard response speed."}
        >
          <select aria-label="Speed" className={inputClass} value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="">Standard</option>
            {fast && <option value={fast.id}>{fast.name}</option>}
          </select>
          {!fast && (
            <span className="block text-[12px] text-neutral-500">
              This model does not offer a Fast tier in your account.
            </span>
          )}
        </Field>
      )}
      {panel !== "fast" && model && <p className="text-[12px] text-neutral-500">{model.description}</p>}
      <p className="text-[12px] text-neutral-500">Saved for subsequent turns in this conversation.</p>
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          disabled={
            busy || !model || (panel !== "fast" && model.efforts.length > 0 && model.defaultEffort !== "" && !effort)
          }
        >
          Apply
        </Button>
      </div>
    </form>
  );
}

function ApprovalPicker({
  conversation,
  busy,
  onApply,
}: {
  conversation: Conversation;
  busy: boolean;
  onApply: (patch: Omit<CommandPayload<"conversation.configure">, "conversationId">) => Promise<void>;
}) {
  const [policy, setPolicy] = useState(conversation.approvalPolicy);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void onApply({ approvalPolicy: policy });
      }}
    >
      <Field
        label="Approvals"
        hint={`Commands run with full access in this devbox. This controls when ${PROVIDER_LABELS[conversation.provider]} asks first on subsequent turns.`}
      >
        <select className={inputClass} value={policy} onChange={(e) => setPolicy(e.target.value as typeof policy)}>
          <option value="never">Never ask</option>
          <option value="on-request">Ask when the agent needs approval</option>
          <option value="untrusted">Ask before untrusted commands and edits</option>
        </select>
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={busy}>
          Apply
        </Button>
      </div>
    </form>
  );
}

function TextAction({
  label,
  initial,
  button,
  busy,
  onSubmit,
}: {
  label: string;
  initial: string;
  button: string;
  busy: boolean;
  onSubmit: (text: string) => Promise<void>;
}) {
  const [text, setText] = useState(initial);
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        void onSubmit(text.trim());
      }}
    >
      <Field label={label}>
        <input
          className={inputClass}
          value={text}
          onChange={(e) => setText(e.target.value)}
          required
          maxLength={label === "Conversation title" ? 120 : 4096}
        />
      </Field>
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={busy || !text.trim()}>
          {button}
        </Button>
      </div>
    </form>
  );
}

function ReviewPicker({
  baseRef,
  busy,
  onReview,
}: {
  baseRef: string;
  busy: boolean;
  onReview: (target: NonNullable<CommandPayload<"turn.start">["reviewTarget"]>) => Promise<void>;
}) {
  const [branch, setBranch] = useState(baseRef);
  return (
    <div className="space-y-4">
      <Button disabled={busy} onClick={() => void onReview({ type: "uncommittedChanges" })}>
        Review uncommitted changes
      </Button>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void onReview({ type: "baseBranch", branch: branch.trim() });
        }}
      >
        <Field label="Base branch">
          <input
            className={inputClass}
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            required
            maxLength={200}
          />
        </Field>
        <Button type="submit" disabled={busy || !branch.trim()}>
          Review against branch
        </Button>
      </form>
    </div>
  );
}
