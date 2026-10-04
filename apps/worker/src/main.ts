// Workbench execution worker: owns provider sessions, Git mutations, shells,
// application processes, jobs, and schedules. Runs independently of the API.
import { mkdirSync } from "node:fs";
import { nowIso, uuidv7, type WorkerStatus } from "@workbench/contracts";
import { createLogger, Database, loadConfig, pruneEvents, saveWorkerStatus } from "@workbench/db";
import { CodexProvider } from "./codex/provider.ts";
import { CommandLoop } from "./commands.ts";
import { WorkerContext } from "./context.ts";
import { HealthMonitor } from "./health.ts";
import { IpcServer } from "./ipc.ts";
import { Jobs } from "./jobs.ts";
import { Processes } from "./processes.ts";
import { Workspaces } from "./workspaces.ts";

const config = loadConfig();
const log = createLogger("worker", config.logLevel);
for (const dir of [config.stateDir, config.reposDir, config.worktreesDir, config.runsDir]) {
  mkdirSync(dir, { recursive: true });
}
const db = new Database(config.dbPath);
const version = db.migrate();
const instanceId = uuidv7();
const startedAt = nowIso();
const ctx = new WorkerContext(config, db, log, instanceId);
log.info("worker starting", { instanceId, schemaVersion: version, pid: process.pid });

const loop = new CommandLoop(ctx);
const ipc = new IpcServer(config.workerSocket, instanceId, () => loop.wake(), log);
ctx.attachIpc(ipc);

const workspaces = new Workspaces(ctx);
const codex = new CodexProvider(ctx);
const processes = new Processes(ctx);
workspaces.addArchiveGuard(processes.archiveBlocker);
loop.register(workspaces.handlers());
loop.register(codex.handlers());
loop.register(processes.handlers());
const jobs = new Jobs(ctx, workspaces, codex);
loop.register(jobs.handlers());

const health = new HealthMonitor(ctx);
let lastWarnings = "";

function status(): WorkerStatus {
  return {
    instanceId,
    pid: process.pid,
    startedAt,
    heartbeatAt: nowIso(),
    codex: codex.status,
    claude: { state: "unavailable", reason: "Claude integration is deferred until an API key is configured." },
    health: health.sample(codex.restarts),
  };
}
const publishStatus = () => {
  saveWorkerStatus(db, status(), true);
  ctx.published();
};
codex.onStatusChange = publishStatus;

await ipc.listen();
workspaces.reconcile();
publishStatus();
loop.start();
void codex.start();
void processes.start();
jobs.start();

// Heartbeats are silent; a change in health warnings is published as an event.
const heartbeat = setInterval(() => {
  const s = status();
  const warnings = s.health.warnings.join("|");
  saveWorkerStatus(db, s, warnings !== lastWarnings);
  if (warnings !== lastWarnings) {
    if (warnings) log.warn("health warnings", { warnings: s.health.warnings });
    lastWarnings = warnings;
    ctx.published();
  }
}, 5000);
const maintenance = setInterval(
  () => {
    const cutoff = new Date(Date.now() - config.eventRetentionDays * 86_400_000).toISOString();
    const removed = pruneEvents(db, cutoff);
    if (removed) log.info("pruned events", { removed });
  },
  60 * 60 * 1000,
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("worker stopping", { signal });
  clearInterval(heartbeat);
  clearInterval(maintenance);
  jobs.stop();
  await loop.stop();
  workspaces.stop();
  processes.shutdown();
  await codex.stop();
  await ipc.close();
  db.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
