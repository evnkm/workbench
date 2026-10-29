import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Local host credential, shared by Workbench's proxy and the mini-app process. */
export function miniAppHostToken(stateDir: string) {
  const dir = join(stateDir, "miniapps");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "host-token");
  try {
    writeFileSync(path, randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const token = readFileSync(path, "utf8").trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid mini-app host credential");
  return token;
}
