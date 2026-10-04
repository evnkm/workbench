// Resource and queue health, reported with the worker heartbeat and surfaced
// in the app when a threshold is crossed.
import { statfsSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { WorkerHealth } from "@workbench/contracts";
import type { WorkerContext } from "./context.ts";

const MIN_FREE_DISK = Number(process.env.WORKBENCH_MIN_FREE_DISK_GB ?? 5) * 1024 ** 3;
const MAX_QUEUE_AGE_S = Number(process.env.WORKBENCH_MAX_QUEUE_AGE_MINUTES ?? 15) * 60;

export class HealthMonitor {
  private readonly ctx: WorkerContext;
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });

  constructor(ctx: WorkerContext) {
    this.ctx = ctx;
    this.loop.enable();
  }

  sample(codexRestarts: number): WorkerHealth {
    const fs = statfsSync(this.ctx.config.stateDir);
    const diskFree = fs.bavail * fs.bsize;
    const p99 = this.loop.percentile(99) / 1e6;
    this.loop.reset();
    const oldest = this.ctx.db.get<{ created_at: string | null }>(
      "SELECT min(created_at) created_at FROM runs WHERE kind = 'job' AND state = 'queued'",
    )!.created_at;
    const queueAge = oldest ? Math.round((Date.now() - Date.parse(oldest)) / 1000) : null;
    const activeJobs = this.ctx.db.get<{ n: number }>(
      "SELECT count(*) n FROM runs WHERE kind = 'job' AND state IN ('starting','running','stopping','waiting_for_input')",
    )!.n;
    const warnings: string[] = [];
    if (diskFree < MIN_FREE_DISK) warnings.push(`Low disk space: ${(diskFree / 1024 ** 3).toFixed(1)} GB free.`);
    if (freemem() < 0.05 * totalmem()) warnings.push(`Low memory: ${Math.round(freemem() / 1024 ** 2)} MB free.`);
    if (p99 > 500) warnings.push(`The worker is overloaded (event-loop delay ${Math.round(p99)} ms).`);
    if (queueAge != null && queueAge > MAX_QUEUE_AGE_S) {
      warnings.push(`A queued job has waited ${Math.round(queueAge / 60)} minutes.`);
    }
    if (codexRestarts >= 3) warnings.push(`Codex has restarted ${codexRestarts} times since the worker started.`);
    return {
      diskFreeBytes: diskFree,
      diskTotalBytes: fs.blocks * fs.bsize,
      memFreeBytes: freemem(),
      memTotalBytes: totalmem(),
      rssBytes: process.memoryUsage.rss(),
      eventLoopP99Ms: Math.round(p99 * 10) / 10,
      oldestQueuedJobSeconds: queueAge,
      activeJobs,
      codexRestarts,
      warnings,
    };
  }
}
