import { type Command, type CommandPayload, type CommandType, uuidv7 } from "@workbench/contracts";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) onUnauthorized();
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? res.statusText);
  return body as T;
}

/**
 * Submit a durable command. The request id is generated once per user action
 * and reused on network retries, so a reconnect cannot duplicate the command.
 * Resolves with the command's result; rejects with its error message.
 */
export async function sendCommand<T extends CommandType>(
  type: T,
  payload: CommandPayload<T> | Record<string, unknown>,
  requestId = uuidv7(),
): Promise<unknown> {
  let delay = 500;
  for (let attempt = 0; ; attempt++) {
    try {
      let { command } = await api<{ command: Command }>("/api/commands", {
        method: "POST",
        body: JSON.stringify({ requestId, type, payload }),
      });
      // Long-running commands: keep polling the same command.
      while (command.state === "accepted" || command.state === "claimed") {
        await new Promise((r) => setTimeout(r, 750));
        ({ command } = await api<{ command: Command }>(`/api/commands/${command.id}`));
      }
      if (command.state === "failed") throw new ApiError(422, command.error ?? "Command failed.");
      return command.result;
    } catch (e) {
      const retriable = !(e instanceof ApiError) || e.status >= 502;
      if (!retriable || attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 5000);
    }
  }
}
