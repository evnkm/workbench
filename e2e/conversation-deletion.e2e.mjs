// B=http://127.0.0.1:5180 node e2e/conversation-deletion.e2e.mjs
// Uses disposable API fixtures, never deleting real conversation history.
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";

const base = process.env.B ?? "http://127.0.0.1:4310";
const now = new Date().toISOString();
const browser = await chromium.launch();
try {
  for (const [name, options] of [
    ["desktop", { viewport: { width: 1440, height: 1000 } }],
    ["mobile", devices["iPhone 13"]],
  ]) {
    const context = await browser.newContext(options);
    await context.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() {
          super();
          window.testEvents = this;
          setTimeout(() => this.dispatchEvent(new Event("ready")), 10);
        }
        close() {}
      };
    });
    let conversations = ["First", "Second", "Running", "Queued"].map((title, index) => ({
      id: `c${index}`,
      workspaceId: "workspace",
      provider: "codex",
      title,
      createdAt: now,
      lastActivityAt: now,
    }));
    let activeRuns = [
      { id: "running", conversationId: "c2", state: "running" },
      { id: "queued", conversationId: "c3", state: "queued" },
    ];
    let seq = 100;
    let fail = false;
    let holdSnapshot = false;
    let heldSnapshot;
    const page = await context.newPage();
    const errors = [];
    const commands = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const event = async (body, conversationId) => {
      await page.evaluate(
        (e) =>
          window.testEvents.dispatchEvent(
            new MessageEvent("event", {
              data: JSON.stringify(e),
            }),
          ),
        { ...body, conversationId, seq: ++seq, createdAt: now },
      );
    };
    const remove = async (id) => {
      conversations = conversations.filter((c) => c.id !== id);
      await event({ type: "conversation.deleted" }, id);
    };
    const snapshot = (conversation) => ({
      cursor: seq,
      conversation,
      hasMore: false,
      runs: [],
      inputs: [],
      items: [
        {
          id: conversation.id,
          conversationId: conversation.id,
          kind: "agent_message",
          status: "completed",
          position: 1,
          data: { text: `History for ${conversation.title}` },
          createdAt: now,
        },
      ],
    });
    await context.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/state")
        return route.fulfill({
          json: {
            cursor: seq,
            projects: [],
            conversations,
            activeRuns,
            openInputs: [],
            processes: [],
            jobs: [],
            workspaces: [{ id: "workspace", name: "Deletion fixture", state: "ready", createdAt: now, updatedAt: now }],
            worker: { heartbeatAt: now, codex: { state: "ready" } },
          },
        });
      if (path.endsWith("/snapshot")) {
        const conversation = conversations.find((c) => c.id === path.split("/")[3]);
        if (!conversation) return route.fulfill({ status: 404, json: { error: "Conversation not found" } });
        const response = snapshot(conversation);
        if (holdSnapshot && conversation.id === "c1") {
          heldSnapshot = () => route.fulfill({ json: response });
          return;
        }
        return route.fulfill({ json: response });
      }
      if (path === "/api/commands") {
        const command = route.request().postDataJSON();
        commands.push(command);
        assert.equal(command.type, "conversation.delete");
        if (fail)
          return route.fulfill({ json: { command: { state: "failed", error: "Deletion failed. Try again." } } });
        await remove(command.payload.conversationId);
        return route.fulfill({ json: { command: { state: "succeeded", result: {} } } });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto(`${base}/w/workspace/c/c0`);
    const tab = (title) => page.getByRole("tab", { name: title });
    const close = (title) => page.getByRole("button", { name: `Delete conversation: ${title}`, exact: true });
    await tab("First").waitFor();
    await page.getByText("History for First", { exact: true }).waitFor();
    assert.equal(await close("Running").isDisabled(), true);
    assert.equal(await close("Queued").isDisabled(), true);
    await close("Second").scrollIntoViewIfNeeded();
    assert.equal(await close("Second").isVisible(), true);
    page.once("dialog", (dialog) => dialog.dismiss());
    await close("Second").click();
    assert.equal(commands.length, 0);
    assert.equal(await tab("First").getAttribute("aria-selected"), "true");
    assert.equal(await tab("Second").count(), 1);

    fail = true;
    page.once("dialog", (dialog) => dialog.accept());
    await close("Second").click();
    await page.getByRole("alert").filter({ hasText: "Deletion failed. Try again." }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[aria-label="Delete conversation: Second"]').disabled);
    assert.equal(await tab("Second").count(), 1);
    assert.equal(await tab("First").getAttribute("aria-selected"), "true");
    fail = false;
    page.once("dialog", (dialog) => dialog.accept());
    await close("Second").click();
    await tab("Second").waitFor({ state: "detached" });
    assert.equal(await tab("First").getAttribute("aria-selected"), "true");
    assert.equal(await page.getByRole("alert").count(), 0);
    await page.reload();
    await page.getByText("History for First", { exact: true }).waitFor();
    assert.equal(await tab("Second").count(), 0);

    // Another browser deletes the selected conversation while its snapshot is in flight.
    const second = {
      id: "c1",
      workspaceId: "workspace",
      provider: "codex",
      title: "Second",
      createdAt: now,
      lastActivityAt: now,
    };
    conversations.push(second);
    await event({ type: "conversation.upserted", conversation: second }, "c1");
    holdSnapshot = true;
    await tab("Second").click();
    await page.waitForURL("**/w/workspace/c/c1");
    const deadline = Date.now() + 5000;
    while (!heldSnapshot && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(heldSnapshot, "The delayed snapshot request must start before remote deletion");
    await remove("c1");
    await page.waitForURL("**/w/workspace/c/c0");
    await heldSnapshot();
    await page.getByText("History for First", { exact: true }).waitFor();
    assert.equal(await tab("Second").count(), 0);
    assert.equal(await page.getByText("History for Second", { exact: true }).count(), 0);

    page.once("dialog", (dialog) => dialog.accept());
    await close("First").click();
    await page.waitForURL("**/w/workspace/c/c2");
    await tab("First").waitFor({ state: "detached" });
    assert.equal(await tab("Running").getAttribute("aria-selected"), "true");
    await remove("c3");
    activeRuns = [];
    await event({ type: "run.upserted", run: { id: "running", conversationId: "c2", state: "succeeded" } }, "c2");
    page.once("dialog", (dialog) => dialog.accept());
    await close("Running").click();
    await page.waitForURL("**/w/workspace");
    await page.getByText("No conversations in Deletion fixture yet.").waitFor();
    await page.goto(`${base}/w/workspace/c/c0`);
    await page.waitForURL("**/w/workspace");
    await page.getByRole("button", { name: "Start a conversation" }).waitFor();
    assert.equal(await page.getByRole("button", { name: /^Delete conversation:/ }).count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${name}: visible X, cancellation, errors, active protection, selected and unselected deletion, refresh, remote deletion, snapshot race, last tab`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}
