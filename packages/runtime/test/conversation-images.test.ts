import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { markdownImages, readRetainedImage, retainImages } from "../src/conversation-images.ts";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
  "base64",
);

test("local screenshots are immutable and survive deletion of their source", () => {
  const state = mkdtempSync(join(tmpdir(), "wb-images-"));
  const source = join(state, "screen.png");
  writeFileSync(source, png);
  const image = retainImages(state, state, [{ source: `file://${source}`, alt: "Screenshot" }])[0]!;
  assert.ok(image.mediaId);
  const duplicate = retainImages(state, state, [{ source, alt: "Again" }])[0]!;
  assert.equal(duplicate.mediaId, image.mediaId);
  rmSync(source);
  assert.deepEqual(readRetainedImage(state, image.mediaId).bytes, png);
  assert.equal(readRetainedImage(state, image.mediaId).contentType, "image/png");
  assert.throws(() => readRetainedImage(state, "../screen.png"));
});

test("tool image data is retained without storing a second base64 copy in item metadata", () => {
  const state = mkdtempSync(join(tmpdir(), "wb-images-"));
  const image = retainImages(state, state, [
    { source: `data:image/png;base64,${png.toString("base64")}`, alt: "Tool image" },
  ])[0]!;
  assert.ok(image.mediaId);
  assert.equal(image.source, `media:${image.mediaId}`);
  assert.deepEqual(readRetainedImage(state, image.mediaId).bytes, png);
});

test("non-images and executable SVGs fail visibly; remote URLs are never fetched", () => {
  const state = mkdtempSync(join(tmpdir(), "wb-images-"));
  writeFileSync(join(state, "bad.svg"), "<svg><script>alert(1)</script></svg>");
  const [invalid, missing, remote] = retainImages(state, state, [
    { source: "bad.svg", alt: "Invalid" },
    { source: "missing.png", alt: "Missing" },
    { source: "https://invalid.test/image.png", alt: "Remote" },
  ]);
  assert.match(invalid!.error!, /Only PNG/);
  assert.ok(missing!.error);
  assert.equal(remote!.source, "https://invalid.test/image.png");
  assert.equal(remote!.mediaId, undefined);
});

test("image references follow Markdown semantics, including nested references and code exclusions", () => {
  const images = markdownImages(
    "> ![Screenshot][screen]\n\n[screen]: /tmp/screen.png\n\n```md\n![Example](/tmp/private.png)\n```",
  );
  assert.deepEqual(images, [{ source: "/tmp/screen.png", alt: "Screenshot" }]);
});
