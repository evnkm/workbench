import DOMPurify from "dompurify";
import { Marked } from "marked";
import { memo, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { conversationImageUrl } from "../lib/images.ts";
import { MermaidDiagram } from "./MermaidDiagram.tsx";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Markdown remains stored as text; diagrams and images are rendered on replay too. */
export const Markdown = memo(function Markdown({
  text,
  itemId,
  className = "",
}: {
  text: string;
  itemId?: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounts, setMounts] = useState<HTMLElement[]>([]);
  const parsed = useMemo(() => {
    const diagrams: string[] = [];
    const markdown = new Marked({
      gfm: true,
      breaks: false,
      renderer: {
        code(token) {
          if (token.lang?.trim().toLowerCase() !== "mermaid" || !/(?:^|\n) {0,3}(?:`{3,}|~{3,})\s*$/.test(token.raw))
            return false;
          const index = diagrams.push(token.text) - 1;
          return `<div data-wb-diagram="${index}"></div>`;
        },
        image(token) {
          const url = escapeHtml(conversationImageUrl(itemId, token.href));
          return `<a href="${url}"><img src="${url}" alt="${escapeHtml(token.text)}" loading="lazy"></a>`;
        },
      },
    });
    return { html: DOMPurify.sanitize(markdown.parse(text, { async: false })), diagrams };
  }, [text, itemId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: discover portal targets after the sanitized HTML changes.
  useLayoutEffect(() => {
    setMounts(Array.from(ref.current!.querySelectorAll<HTMLElement>("[data-wb-diagram]")));
  }, [parsed.html]);
  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify above. */}
      <div ref={ref} className={`wb-prose ${className}`} dangerouslySetInnerHTML={{ __html: parsed.html }} />
      {mounts.map(
        (node, index) =>
          parsed.diagrams[index] !== undefined &&
          createPortal(<MermaidDiagram source={parsed.diagrams[index]!} />, node, String(index)),
      )}
    </>
  );
});
