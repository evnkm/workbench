// Set the Workbench login password: writes WORKBENCH_PASSWORD_HASH into the
// environment file (default ~/.config/workbench/env, mode 600).
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { hashPassword } from "../apps/server/src/auth.ts";

const file = process.env.WORKBENCH_ENV_FILE ?? join(homedir(), ".config/workbench/env");

async function readPassword(): Promise<string> {
  if (process.env.WORKBENCH_NEW_PASSWORD) return process.env.WORKBENCH_NEW_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Hide typed characters.
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  const prompt = "New Workbench password: ";
  out._writeToOutput = (s: string) => out.output.write(s.startsWith(prompt) ? prompt : "");
  const pw = await rl.question(prompt);
  rl.close();
  process.stdout.write("\n");
  return pw;
}

const password = await readPassword();
if (password.length < 12) {
  console.error("Use at least 12 characters.");
  process.exit(1);
}
const line = `WORKBENCH_PASSWORD_HASH=${hashPassword(password)}`;
mkdirSync(dirname(file), { recursive: true });
const lines = existsSync(file)
  ? readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("WORKBENCH_PASSWORD_HASH="))
  : [];
writeFileSync(file, `${[...lines, line].join("\n")}\n`, { mode: 0o600 });
chmodSync(file, 0o600);
console.log(`Saved password hash to ${file}. Restart workbench-server to apply it.`);
