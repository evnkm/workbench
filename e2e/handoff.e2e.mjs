// Desktop-to-phone handoff with real Codex (consumes account usage; run deliberately).
//   B=http://127.0.0.1:4399 PASSWORD=... node e2e/handoff.e2e.mjs <workspaceId> <worktreePath>
// Starts a turn on a desktop viewport, closes that browser mid-turn, then opens
// the conversation on a phone viewport, answers the approval there, and checks
// the outcome, the file the agent created, and that no message is duplicated.
import { existsSync, readFileSync } from "node:fs";
import { chromium, devices } from "playwright";

const B = process.env.B ?? "http://127.0.0.1:4310";
const PASSWORD = process.env.PASSWORD ?? "";
const [WID, worktree] = process.argv.slice(2);
const browser = await chromium.launch();
async function signIn(ctx) {
  const page = await ctx.newPage();
  await page.goto(`${B}/`);
  await page.fill("input[type=password]", PASSWORD);
  await page.click("button[type=submit]");
  await page.waitForSelector("text=Workbench");
  return page;
}
// Desktop: new conversation that asks before commands, send a prompt, then close the browser.
const desk = await browser.newContext({ viewport: { width: 1440, height: 900 } });
let page = await signIn(desk);
await page.goto(`${B}/w/${WID}`);
await page.getByRole("button", { name: "New conversation" }).click();
await page.selectOption("dialog select", "untrusted");
const before = page.url();
await page.getByRole("button", { name: "Start", exact: true }).click();
await page.waitForURL((u) => u.toString() !== before && u.toString().includes("/c/"));
await page.waitForSelector("text=Describe the change you want");
const url = page.url();
await page.fill(
  'textarea[aria-label="Message"]',
  "Using a shell command (printf), create e2e.txt containing the text from-desktop. Then reply with exactly: done",
);
await page.keyboard.press("Enter");
await page.waitForSelector("text=Working…", { timeout: 30000 }).catch(() => {});
await page.waitForTimeout(2000);
await desk.close();
console.log("desktop closed while the turn runs:", url.replace(B, ""));

// Phone: open the same conversation, answer approvals, see the result.
const phone = await browser.newContext({ ...devices["iPhone 13"] });
page = await signIn(phone);
await page.goto(url);
let approvals = 0;
const done = page.locator(".wb-prose").filter({ hasText: /^\s*done\.?\s*$/ });
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  if (await approve.count()) {
    await approve.first().click();
    approvals++;
    await page.waitForTimeout(1500);
    continue;
  }
  const active = await page.locator("text=/Working…|Starting…|Waiting for your answer|Stopping…/").count();
  const doneMsg = await done.count();
  if (!active && doneMsg) break;
  await page.waitForTimeout(1000);
}
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
const userBubbles = await page.locator(".rounded-br-sm", { hasText: "Using a shell command (printf)" }).count();
console.log("approvals answered on phone:", approvals);
console.log("user message shown once:", userBubbles === 1);
console.log("file created:", existsSync(`${worktree}/e2e.txt`) && readFileSync(`${worktree}/e2e.txt`, "utf8"));
const ok = approvals >= 1 && userBubbles === 1 && (await done.count()) === 1 && existsSync(`${worktree}/e2e.txt`);
console.log("final 'done' message shown once:", (await done.count()) === 1);
console.log(ok ? "PASS" : "FAIL");
process.exitCode = ok ? 0 : 1;
await browser.close();
