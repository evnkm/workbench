// Runs against a built Workbench UI; API and provider events are mocked, with no Codex usage.
// B=http://127.0.0.1:5180 node e2e/rich-content.e2e.mjs
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";

const base = process.env.B ?? "http://127.0.0.1:4310";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const now = new Date().toISOString();
const conversation = {
  id: "conversation",
  workspaceId: "workspace",
  provider: "codex",
  title: "Rich conversation",
  lastActivityAt: now,
  createdAt: now,
};
const item = (id, kind, data) => ({
  id,
  kind,
  data,
  status: "completed",
  conversationId: conversation.id,
  runId: null,
  position: 1,
  createdAt: now,
});
const diagram = item("diagram", "agent_message", {
  text: "```mermaid\nflowchart LR\nDB[(Postgres)] --> Electric --> Browser[TanStack DB]\n```",
});
const broken = item("broken", "agent_message", { text: "```mermaid\nflowchart TD\nA[unterminated\n```" });
const stream = item("stream", "agent_message", { text: "```mermaid\nsequenceDiagram\nBrowser->>Control: Read" });
const tool = item("capture", "tool_call", {
  tool: "screenshot",
  images: [{ source: "file:///tmp/screenshot.png", alt: "Captured screenshot" }],
});
const markdown = item("markdown", "agent_message", {
  text: '![Markdown screenshot](/tmp/screenshot.png)\n\n<img src="x" onerror="window.unsafeImage=true"><script>window.unsafeImage=true</script>',
});
const snapshot = {
  cursor: 100,
  conversation,
  items: [diagram, broken, stream, tool, markdown].map((value, index) => ({ ...value, position: index + 1 })),
  runs: [],
  inputs: [],
  hasMore: false,
};
const state = {
  cursor: 100,
  projects: [],
  conversations: [conversation],
  workspaces: [{ id: "workspace", name: "Rich conversation", state: "ready", createdAt: now, updatedAt: now }],
  activeRuns: [],
  openInputs: [],
  processes: [],
  jobs: [],
  worker: { heartbeatAt: now, codex: { state: "ready" } },
};
const browser = await chromium.launch();
try {
  for (const [name, options] of [
    ["desktop", { viewport: { width: 1440, height: 1000 } }],
    ["mobile", devices["iPhone 13"]],
  ]) {
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
    await context.route("**/api/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/image")) return route.fulfill({ contentType: "image/png", body: png });
      return route.fulfill({ json: path === "/api/state" ? state : path.endsWith("/snapshot") ? snapshot : {} });
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}/w/workspace/c/conversation`);
    await page.locator(".wb-mermaid svg").waitFor();
    assert.ok((await page.locator(".wb-mermaid svg").textContent()).includes("Postgres"));
    await page.getByText("Unable to render this diagram. Its source is available below.").waitFor();
    assert.equal(await page.locator(".wb-diagram details[open]").count(), 1);
    for (const alt of ["Captured screenshot", "Markdown screenshot"]) {
      const image = page.getByRole("img", { name: alt, exact: true });
      await image.scrollIntoViewIfNeeded();
      await image.evaluate((node) => node.decode());
      assert.equal(await image.evaluate((node) => node.naturalWidth), 1);
    }
    assert.equal(await page.evaluate(() => window.unsafeImage), undefined);
    await page.evaluate(
      (complete) =>
        window.testEvents.dispatchEvent(
          new MessageEvent("event", {
            data: JSON.stringify({
              type: "item.upserted",
              seq: 101,
              conversationId: complete.conversationId,
              createdAt: complete.createdAt,
              item: complete,
            }),
          }),
        ),
      { ...stream, position: 3, data: { text: `${stream.data.text}\nControl-->>Browser: Items\n\`\`\`` } },
    );
    await page.waitForFunction(() => document.querySelectorAll(".wb-mermaid svg").length === 2);
    const before = await page.locator(".wb-mermaid svg").first().getAttribute("id");
    await page.getByRole("combobox", { name: "Theme" }).selectOption("dark");
    await page.waitForFunction((id) => document.querySelector(".wb-mermaid svg")?.id !== id, before);
    await page.waitForFunction(() => document.querySelectorAll(".wb-mermaid svg").length === 2);
    await page.reload();
    await page.locator(".wb-mermaid svg").waitFor();
    assert.equal(await page.getByRole("combobox", { name: "Theme" }).inputValue(), "dark");
    assert.equal(await page.getByRole("img", { name: "Captured screenshot", exact: true }).count(), 1);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${name}: diagrams, syntax fallback, streamed fences, native and Markdown images, sanitization, themes, replay`,
    );
    await context.close();
  }
} finally {
  await browser.close();
}
