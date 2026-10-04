// Regenerate the Codex app-server protocol types from the installed CLI.
// Run after upgrading Codex, then rerun the probes in probes/codex and the
// worker's contract tests before deploying.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = join(import.meta.dirname, "../apps/worker/src/codex/protocol");
rmSync(out, { recursive: true, force: true });
execFileSync("codex", ["app-server", "generate-ts", "--experimental", "--out", out], { stdio: "inherit" });

// The generator emits extensionless relative imports; Node type stripping and
// `moduleResolution: nodenext` need explicit `.ts` extensions.
function walk(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".ts")) {
      const src = readFileSync(p, "utf8").replace(/from "(\.{1,2}\/[^"]+?)(?<!\.ts)"/g, (_m, spec: string) => {
        const target = join(dir, spec);
        const isDir = (() => {
          try {
            return statSync(target).isDirectory();
          } catch {
            return false;
          }
        })();
        return `from "${spec}${isDir ? "/index" : ""}.ts"`;
      });
      writeFileSync(p, src);
    }
  }
}
walk(out);

const version = execFileSync("codex", ["--version"], { encoding: "utf8" })
  .trim()
  .replace(/^codex-cli\s+/, "");
writeFileSync(
  join(out, "version.ts"),
  `// Codex CLI version these types were generated from.\nexport const CODEX_PROTOCOL_VERSION = "${version}";\n`,
);
console.log(`Generated Codex protocol types for ${version} in ${out}`);
