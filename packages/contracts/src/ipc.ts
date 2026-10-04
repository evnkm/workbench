// Local IPC between the API server and the worker: newline-delimited JSON over
// a Unix socket. Messages are wake-ups and notifications only; durable state
// lives in SQLite, so a lost message never loses a command or event.

export type ServerToWorker = { type: "wake" } | { type: "ping"; id: number };

export type WorkerToServer =
  | { type: "pong"; id: number; instanceId: string }
  /** Events up to and including `seq` are committed. */
  | { type: "events"; seq: number };
