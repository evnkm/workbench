// B=http://127.0.0.1:5180 node e2e/slash-commands.e2e.mjs
// Disposable API fixtures; no real Codex calls or user-session mutations.
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";

const base = process.env.B ?? "http://127.0.0.1:4310";
const now = new Date().toISOString();
const models = [
  {
    model: "account-model",
    name: "Account model",
    description: "From the connected account",
    isDefault: true,
    defaultEffort: "medium",
    efforts: [
      { effort: "medium", description: "Balanced" },
      { effort: "high", description: "More reasoning" },
    ],
    serviceTiers: [{ id: "priority", name: "Fast", description: "Faster execution with additional usage" }],
  },
  {
    model: "other-model",
    name: "Other model",
    description: "No Fast tier",
    isDefault: false,
    defaultEffort: "low",
    efforts: [{ effort: "low", description: "Less reasoning" }],
    serviceTiers: [],
  },
];
const browser = await chromium.launch();
try {
  for (const [name, options] of [
    ["desktop", { viewport: { width: 1440, height: 1000 } }],
    ["mobile", devices["iPhone 13"]],
  ]) {
    let conversation = {
      id: "conversation",
      workspaceId: "workspace",
      provider: "codex",
      title: "Slash commands",
      model: "account-model",
      reasoningEffort: null,
      serviceTier: null,
      approvalPolicy: "never",
      createdAt: now,
      lastActivityAt: now,
    };
    const other = { ...conversation, id: "other", title: "Other conversation" };
    let seq = 100;
    let activeRuns = [];
    let fail = false;
    const commands = [];
    const context = await browser.newContext({ ...options, colorScheme: "light" });
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
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const event = (body) =>
      page.evaluate((e) => window.testEvents.dispatchEvent(new MessageEvent("event", { data: JSON.stringify(e) })), {
        ...body,
        seq: ++seq,
        createdAt: now,
        conversationId: conversation.id,
      });
    await context.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/state")
        return route.fulfill({
          json: {
            cursor: seq,
            projects: [],
            conversations: [conversation, other],
            workspaces: [
              {
                id: "workspace",
                name: "Slash fixture",
                state: "ready",
                baseRef: "main",
                worktreePath: "/fixture",
                createdAt: now,
              },
            ],
            activeRuns,
            openInputs: [],
            processes: [],
            jobs: [],
            worker: { heartbeatAt: now, codex: { state: "ready" } },
          },
        });
      if (path.endsWith("/snapshot"))
        return route.fulfill({
          json: {
            cursor: seq,
            conversation: path.includes("/other/") ? other : conversation,
            items: [
              {
                id: "response",
                conversationId: conversation.id,
                kind: "agent_message",
                status: "completed",
                position: 1,
                data: { text: "Completed response" },
                createdAt: now,
              },
            ],
            runs: activeRuns,
            inputs: [],
            hasMore: false,
          },
        });
      if (path === "/api/commands") {
        const { type, payload } = route.request().postDataJSON();
        commands.push({ type, payload });
        if (fail)
          return route.fulfill({ json: { command: { state: "failed", error: "Codex rejected that setting." } } });
        let result = {};
        if (type === "conversation.inspect")
          result =
            payload.view === "models"
              ? { kind: "models", models }
              : payload.view === "skills"
                ? {
                    kind: "choices",
                    title: "Skills",
                    choices: [{ label: "test-skill", description: "Skill description", text: "$test-skill " }],
                  }
                : { kind: "info", title: "Session status", rows: [{ label: "Model", value: conversation.model }] };
        if (type === "conversation.configure") {
          const { conversationId: _id, ...patch } = payload;
          if (patch.model && patch.model !== conversation.model) patch.serviceTier = null;
          conversation = { ...conversation, ...patch };
          await event({ type: "conversation.upserted", conversation });
        }
        return route.fulfill({ json: { command: { state: "succeeded", result } } });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto(`${base}/w/workspace/c/conversation`);
    const message = page.getByRole("combobox", { name: "Message", exact: true });
    const menu = page.getByRole("listbox", { name: "Slash commands" });
    const option = (command) =>
      menu.getByRole("option").filter({ has: page.getByText(`/${command}`, { exact: true }) });
    const open = async (command) => {
      await message.fill(`/${command}`);
      await message.focus();
      await option(command).click();
    };
    const close = () => page.getByRole("dialog").getByRole("button", { name: "Close", exact: true }).click();
    const submit = async (text) => {
      await message.fill(text);
      await page.getByRole("button", { name: "Send", exact: true }).click();
    };
    await message.fill("/");
    await message.focus();
    await menu.waitFor();
    assert.equal(commands.length, 0, "The slash menu opens immediately without a server request");
    assert.ok((await menu.getByRole("option").count()) >= 50);
    for (const cmd of ["model", "fast", "plan", "review", "status", "compact", "skills"])
      assert.equal(await option(cmd).count(), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: `/tmp/workbench-slash-${name}.png` });
    await message.press("Escape");
    await menu.waitFor({ state: "detached" });
    await message.fill("/mo");
    await menu.waitFor();
    assert.equal(await menu.getByRole("option").count(), 1);
    await message.press("Tab");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("combobox", { name: "Model", exact: true }).waitFor();
    await dialog.getByRole("combobox", { name: "Reasoning effort", exact: true }).selectOption("high");
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(conversation.reasoningEffort, "high");
    assert.ok(
      commands.some(
        (c) =>
          c.type === "conversation.configure" &&
          c.payload.model === "account-model" &&
          c.payload.reasoningEffort === "high",
      ),
    );

    await open("fast");
    await dialog.getByRole("combobox", { name: "Speed", exact: true }).selectOption("priority");
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(conversation.serviceTier, "priority");
    await page.reload();
    await open("model");
    await dialog.getByRole("combobox", { name: "Reasoning effort", exact: true }).waitFor();
    assert.equal(await dialog.getByRole("combobox", { name: "Reasoning effort", exact: true }).inputValue(), "high");
    await close();
    await open("fast");
    await dialog.getByRole("combobox", { name: "Speed", exact: true }).waitFor();
    assert.equal(await dialog.getByRole("combobox", { name: "Speed", exact: true }).inputValue(), "priority");
    await close();
    await submit("/fast off");
    await page.getByRole("status").filter({ hasText: "Standard" }).waitFor();
    assert.equal(conversation.serviceTier, null);

    activeRuns = [{ id: "active", conversationId: conversation.id, state: "running" }];
    await event({ type: "run.upserted", run: activeRuns[0] });
    await page.getByRole("button", { name: "Interrupt turn", exact: true }).waitFor();
    await open("model");
    await dialog.getByRole("combobox", { name: "Model", exact: true }).selectOption("other-model");
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.equal(conversation.model, "other-model");
    assert.equal(await page.getByRole("button", { name: "Interrupt turn", exact: true }).count(), 1);
    await message.fill("/plan");
    await message.press("Enter");
    await page.getByRole("alert").filter({ hasText: "current turn" }).waitFor();
    await event({ type: "run.upserted", run: { ...activeRuns[0], state: "succeeded" } });
    activeRuns = [];
    await page.getByRole("button", { name: "Send", exact: true }).waitFor();
    await open("fast");
    await dialog.getByText("This model does not offer a Fast tier in your account.").waitFor();
    assert.equal(await dialog.getByRole("combobox", { name: "Speed", exact: true }).locator("option").count(), 1);
    await close();

    const turnsBefore = commands.filter((c) => c.type === "turn.start").length;
    await submit("/nonsense");
    await page.getByRole("alert").filter({ hasText: "Unknown command" }).waitFor();
    assert.equal(commands.filter((c) => c.type === "turn.start").length, turnsBefore);
    await open("vim");
    await dialog.getByText("Vim editing is a Codex terminal feature.").waitFor();
    await close();
    assert.equal(commands.filter((c) => c.type === "turn.start").length, turnsBefore);
    await open("skills");
    await dialog.getByRole("button", { name: /test-skill/ }).click();
    assert.equal(await message.inputValue(), "$test-skill ");
    await open("compact");
    await page.getByRole("status").filter({ hasText: "compaction started" }).waitFor();
    assert.ok(commands.some((c) => c.type === "conversation.action" && c.payload.action === "compact"));
    await open("review");
    await dialog.getByRole("button", { name: "Review uncommitted changes", exact: true }).click();
    await dialog.waitFor({ state: "detached" });
    assert.ok(
      commands.some(
        (c) =>
          c.type === "turn.start" &&
          c.payload.mode === "review" &&
          c.payload.reviewTarget.type === "uncommittedChanges",
      ),
    );
    await submit("/plan Propose the migration");
    await page.waitForFunction(() => document.querySelector('[aria-label="Message"]').value === "");
    assert.ok(
      commands.some(
        (c) => c.type === "turn.start" && c.payload.text === "Propose the migration" && c.payload.mode === "plan",
      ),
    );
    await page.getByRole("checkbox", { name: "Plan mode" }).uncheck();
    await submit("/home/ubuntu/project has a problem");
    await page.waitForFunction(() => document.querySelector('[aria-label="Message"]').value === "");
    assert.ok(
      commands.some(
        (c) =>
          c.type === "turn.start" &&
          c.payload.text === "/home/ubuntu/project has a problem" &&
          c.payload.mode === "default",
      ),
    );
    fail = true;
    await submit("/model invalid-model");
    await page.getByRole("alert").filter({ hasText: "Codex rejected" }).waitFor();
    assert.equal(await message.inputValue(), "/model invalid-model");
    fail = false;
    await message.fill("Draft for the original conversation");
    await page.getByRole("tab", { name: "Other conversation", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="Message"]').value === "");
    await page.getByRole("tab", { name: "Slash commands", exact: true }).click();
    await page.waitForFunction(
      () => document.querySelector('[aria-label="Message"]').value === "Draft for the original conversation",
    );
    await message.fill("/");
    await message.focus();
    await message.press("ArrowDown");
    assert.equal(await option("fast").getAttribute("aria-selected"), "true");
    await message.press("ArrowUp");
    assert.equal(await option("model").getAttribute("aria-selected"), "true");
    await message.press("Enter");
    await dialog.getByRole("combobox", { name: "Model", exact: true }).waitFor();
    await close();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${name}: instant menu, filtering, keyboard and touch selection, model/effort/Fast persistence, active-turn controls, native action payloads, unsupported commands, paths, errors, and per-conversation drafts`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}
