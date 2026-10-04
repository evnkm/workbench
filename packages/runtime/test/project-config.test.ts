import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Project, Workspace } from "@workbench/contracts";
import { portEnv, portFor, readProjectConfig } from "../src/project-config.ts";

const project = { setupCommand: null, runCommand: null } as Project;
const workspace = { portBase: 10200 } as Workspace;

test("Canopy-style canopy.json maps named ports and CONDUCTOR_PORT onto the workspace block", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-cfg-"));
  writeFileSync(
    join(dir, "canopy.json"),
    JSON.stringify({
      setup: { command: "./setup.sh" },
      dev: { command: "mise run dev", port: "VITE_PORT" },
      ports: ["PORT", "VITE_PORT"],
    }),
  );
  const cfg = readProjectConfig(project, dir);
  assert.equal(cfg.source, "canopy.json");
  assert.equal(cfg.runCommand, "mise run dev");
  assert.deepEqual(portEnv(cfg, workspace), {
    WORKBENCH_PORT_BASE: "10200",
    CONDUCTOR_PORT: "10200",
    PORT: "10200",
    VITE_PORT: "10201",
  });
  // The preview defaults to the dev port, which matches Canopy's VITE_PORT = CONDUCTOR_PORT + 1.
  assert.equal(portFor(cfg, workspace, cfg.previews[0]!.port), 10201);
});
