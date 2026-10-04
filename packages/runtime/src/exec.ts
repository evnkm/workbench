import { execFile } from "node:child_process";

export type ExecResult = { stdout: string; stderr: string; code: number };

/** Run a program without a shell. Resolves with the exit code instead of throwing. */
export function exec(
  file: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; maxBuffer?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: opts.cwd,
        env: opts.env,
        timeout: opts.timeoutMs ?? 60_000,
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        resolve({ stdout, stderr: stderr || (err && typeof err.code !== "number" ? String(err.message) : ""), code });
      },
    );
  });
}

/** Like exec, but throws with stderr when the exit code is non-zero. */
export async function execOk(file: string, args: string[], opts: Parameters<typeof exec>[2] = {}): Promise<string> {
  const r = await exec(file, args, opts);
  if (r.code !== 0) {
    throw new Error(`${file} ${args.join(" ")} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
  }
  return r.stdout;
}
