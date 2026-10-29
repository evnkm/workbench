// Disposable API fixtures: validates Mac-style file drops, paste and file picker
// without modifying user conversations or invoking an agent.
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";

const base = process.env.B ?? "http://127.0.0.1:5197";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);
const now = new Date().toISOString();
const conversation = {
  id: "c",
  workspaceId: "w",
  provider: "codex",
  title: "Image upload",
  model: null,
  reasoningEffort: null,
  serviceTier: null,
  approvalPolicy: "never",
  createdAt: now,
  lastActivityAt: now,
};
const workspace = {
  id: "w",
  projectId: "p",
  name: "Images",
  state: "ready",
  baseRef: "main",
  branch: "images",
  worktreePath: "/fixture",
  createdAt: now,
};
const path = `/fixture/media/${"a".repeat(64)}.png`;
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
          setTimeout(() => this.dispatchEvent(new Event("ready")), 5);
        }
        close() {}
      };
    });
    const page = await context.newPage();
    const errors = [];
    const uploads = [];
    const commands = [];
    let reject = false;
    page.on("pageerror", (error) => errors.push(error.message));
    await context.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/conversations/c/images") {
        uploads.push(route.request().postDataBuffer());
        await new Promise((resolve) => setTimeout(resolve, 250));
        return route.fulfill(
          reject
            ? { status: 415, json: { error: "Only PNG, JPEG, GIF, and WebP images are supported." } }
            : { status: 201, json: { path, mediaId: `${"a".repeat(64)}.png` } },
        );
      }
      if (url.pathname === "/api/state")
        return route.fulfill({
          json: {
            cursor: 100,
            projects: [],
            workspaces: [workspace],
            conversations: [conversation],
            activeRuns: [],
            openInputs: [],
            processes: [],
            jobs: [],
            worker: { heartbeatAt: now, codex: { state: "ready" }, claude: { state: "ready" } },
          },
        });
      if (url.pathname.endsWith("/snapshot"))
        return route.fulfill({ json: { cursor: 100, conversation, items: [], runs: [], inputs: [], hasMore: false } });
      if (url.pathname === "/api/commands") {
        commands.push(route.request().postDataJSON());
        return route.fulfill({ json: { command: { state: "succeeded", result: {} } } });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto(`${base}/w/w/c/c`);
    const message = page.getByRole("combobox", { name: "Message", exact: true });
    await message.fill("Please inspect this photo");
    const dataTransfer = await page.evaluateHandle((bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "Mac photo [1].png", { type: "image/png" }));
      return transfer;
    }, Array.from(png));
    await page.dispatchEvent("body", "dragenter", { dataTransfer });
    await page.getByText("Drop images to attach to this conversation").waitFor();
    await page.dispatchEvent("body", "drop", { dataTransfer });
    assert.equal(await page.getByRole("button", { name: "Send", exact: true }).isDisabled(), true);
    await page.getByText("1 image uploaded. Paths added to your message.").waitFor();
    assert.deepEqual(uploads[0], png);
    assert.ok((await message.inputValue()).includes(path));
    assert.ok((await message.inputValue()).startsWith("Please inspect this photo"));
    await page.reload();
    await message.waitFor();
    assert.ok((await message.inputValue()).includes(path));
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(commands[0].type, "turn.start");
    assert.ok(commands[0].payload.text.includes(path));
    assert.equal(await message.inputValue(), "");
    await page.evaluate((bytes) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)], "Pasted.png", { type: "image/png" }));
      document
        .querySelector("textarea")
        .dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, Array.from(png));
    await page.getByText("1 image uploaded. Paths added to your message.").waitFor();
    assert.ok((await message.inputValue()).includes("Pasted.png"));
    const draft = await message.inputValue();
    reject = true;
    await page
      .locator('input[type="file"]')
      .setInputFiles({ name: "not-an-image.png", mimeType: "image/png", buffer: Buffer.from("invalid") });
    await page.getByRole("alert").filter({ hasText: "Only PNG" }).waitFor();
    assert.equal(await message.inputValue(), draft);
    reject = false;
    await page.locator('input[type="file"]').setInputFiles([
      { name: "one.png", mimeType: "image/png", buffer: png },
      { name: "two.png", mimeType: "image/png", buffer: png },
    ]);
    await page.getByText("2 images uploaded. Paths added to your message.").waitFor();
    assert.ok((await message.inputValue()).includes("one.png"));
    assert.ok((await message.inputValue()).includes("two.png"));
    assert.deepEqual(errors, []);
    console.log(`${name}: drop, paste, picker, draft persistence, reference submission, and upload failure pass`);
    await context.close();
  }
} finally {
  await browser.close();
}
