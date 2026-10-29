/** Account-specific choices read from a conversation's provider. */
export type AgentModel = {
  model: string;
  name: string;
  description: string;
  isDefault: boolean;
  efforts: { effort: string; description: string }[];
  /** Empty when the provider applies its own default effort. */
  defaultEffort: string;
  serviceTiers: { id: string; name: string; description: string }[];
};

/** A provider-native slash command, submitted to the agent as message text. */
export type NativeCommand = { name: string; description: string; argumentHint: string };

export type InspectResult =
  | { kind: "models"; models: AgentModel[] }
  | { kind: "commands"; commands: NativeCommand[] }
  | { kind: "info"; title: string; rows: { label: string; value: string }[] }
  | { kind: "choices"; title: string; choices: { label: string; description: string; text: string }[] };
