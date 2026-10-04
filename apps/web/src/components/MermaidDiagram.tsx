import DOMPurify from "dompurify";
import { useEffect, useRef, useState } from "react";
import { useTheme } from "../lib/theme.ts";

// Mermaid configuration is global. Serialize configuration and rendering so
// concurrent diagrams and appearance changes cannot use each other's theme.
let queue: Promise<unknown> = Promise.resolve();
let nextId = 0;

function renderDiagram(source: string, theme: "light" | "dark", isActive: () => boolean) {
  const result = queue.then(async () => {
    if (!isActive()) return null;
    const { default: mermaid } = await import("mermaid");
    if (!isActive()) return null;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      htmlLabels: false,
      theme: theme === "dark" ? "dark" : "default",
      fontFamily: "Inter, sans-serif",
      secure: [
        "secure",
        "securityLevel",
        "startOnLoad",
        "suppressErrorRendering",
        "htmlLabels",
        "theme",
        "fontFamily",
        "maxTextSize",
        "maxEdges",
      ],
    });
    const { svg } = await mermaid.render(`wb-mermaid-${nextId++}`, source);
    return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } });
  });
  queue = result.catch(() => {});
  return result;
}

export function MermaidDiagram({ source }: { source: string }) {
  const { effective } = useTheme();
  const [result, setResult] = useState<{ svg: string } | { error: string } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    let active = true;
    setResult(null);
    void renderDiagram(source, effective, () => active).then(
      (svg) => {
        if (active && svg) setResult({ svg });
      },
      (error: unknown) => {
        if (active) setResult({ error: error instanceof Error ? error.message : String(error) });
      },
    );
    return () => {
      active = false;
    };
  }, [source, effective]);

  useEffect(() => {
    if (!result || !("svg" in result)) return;
    const svg = container.current?.querySelector("svg");
    if (svg) {
      svg.style.width = zoomed ? `${svg.viewBox.baseVal.width}px` : "100%";
      svg.style.maxWidth = zoomed ? "none" : "100%";
    }
  }, [result, zoomed]);

  return (
    <figure className="wb-diagram my-3 overflow-hidden rounded-lg border border-wb-border bg-wb-panel p-3">
      {result && "svg" in result ? (
        <div
          ref={container}
          className="wb-mermaid overflow-auto"
          role="img"
          aria-label="Mermaid diagram"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Mermaid uses strict mode and its SVG is sanitized above.
          dangerouslySetInnerHTML={{ __html: result.svg }}
        />
      ) : (
        <p role="status" className="text-[13px] text-neutral-400">
          {result ? "Unable to render this diagram. Its source is available below." : "Rendering diagram…"}
        </p>
      )}
      {result && "svg" in result && (
        <button
          type="button"
          onClick={() => setZoomed(!zoomed)}
          className="mt-2 rounded-md border border-wb-border px-3 py-2 text-[12px] text-neutral-400 hover:text-neutral-100"
        >
          {zoomed ? "Fit diagram" : "Zoom diagram"}
        </button>
      )}
      <details className="mt-2 text-[12px] text-neutral-500" open={Boolean(result && "error" in result)}>
        <summary className="cursor-pointer py-1">Diagram source</summary>
        {result && "error" in result && <p className="my-2 whitespace-pre-wrap">{result.error}</p>}
        <pre className="mt-2">
          <code>{source}</code>
        </pre>
      </details>
    </figure>
  );
}
