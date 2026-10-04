import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConversationImage } from "@workbench/contracts";
import { marked } from "marked";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function markdownImages(text: string): ConversationImage[] {
  const images: ConversationImage[] = [];
  marked.walkTokens(marked.lexer(text), (token) => {
    if (token.type === "image") images.push({ source: token.href, alt: token.text || "Conversation image" });
  });
  return images;
}

export function imageType(bytes: Buffer): "png" | "jpeg" | "gif" | "webp" {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpeg";
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return "gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "webp";
  throw new Error("Only PNG, JPEG, GIF, and WebP images are supported.");
}

/** Retain local/tool images before publishing their item; never fetch remote URLs. */
export function retainImages(stateDir: string, cwd: string, images: ConversationImage[]): ConversationImage[] {
  return [...new Map(images.map((image) => [image.source, image])).values()].map((image) => {
    if (image.mediaId || /^https?:\/\//i.test(image.source)) return image;
    try {
      let bytes: Buffer;
      if (image.source.startsWith("data:")) {
        const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(image.source);
        if (!match || match[1]!.length > (MAX_IMAGE_BYTES * 4) / 3 + 4) throw new Error("Invalid image data.");
        bytes = Buffer.from(match[1]!, "base64");
      } else {
        if (/^[a-z][a-z0-9+.-]*:/i.test(image.source) && !image.source.startsWith("file:")) {
          throw new Error("Unsupported image URL.");
        }
        const path = image.source.startsWith("file:")
          ? fileURLToPath(image.source)
          : resolve(cwd, decodeURIComponent(image.source));
        const stat = statSync(path);
        if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) throw new Error("Image must be a file smaller than 20 MiB.");
        bytes = readFileSync(path);
      }
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Image is larger than 20 MiB.");
      const extension = imageType(bytes);
      const mediaId = `${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
      mkdirSync(join(stateDir, "media"), { recursive: true });
      try {
        writeFileSync(join(stateDir, "media", mediaId), bytes, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      return { source: image.source.startsWith("data:") ? `media:${mediaId}` : image.source, alt: image.alt, mediaId };
    } catch (error) {
      return {
        source: image.source.startsWith("data:") ? "unavailable" : image.source,
        alt: image.alt,
        error: (error as Error).message,
      };
    }
  });
}

export function readRetainedImage(stateDir: string, mediaId: string): { bytes: Buffer; contentType: string } {
  if (!/^[a-f0-9]{64}\.(png|jpeg|gif|webp)$/.test(mediaId)) throw new Error("Invalid image identifier.");
  const bytes = readFileSync(join(stateDir, "media", mediaId));
  return { bytes, contentType: `image/${imageType(bytes)}` };
}
