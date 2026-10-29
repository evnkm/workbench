import { useCallback, useEffect, useRef, useState } from "react";
import { uploadImage } from "./api.ts";

export function useImageUpload(
  conversationId: string,
  enabled: boolean,
  onUploaded: (path: string, name: string) => void,
) {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!files.length) return;
      if (!enabled || request.current) {
        setError("Wait for the current upload or message to finish before attaching images.");
        return;
      }
      const controller = new AbortController();
      request.current = controller;
      setUploading(true);
      setError(null);
      let uploaded = 0;
      const failures: string[] = [];
      try {
        for (const [index, file] of files.entries()) {
          setStatus(`Uploading ${file.name} (${index + 1}/${files.length})…`);
          try {
            const image = await uploadImage(conversationId, file, controller.signal);
            if (controller.signal.aborted) return;
            onUploaded(image.path, file.name);
            uploaded++;
          } catch (e) {
            if (controller.signal.aborted) return;
            failures.push(`${file.name}: ${(e as Error).message}`);
          }
        }
        setStatus(
          uploaded
            ? `${uploaded} ${uploaded === 1 ? "image uploaded" : "images uploaded"}. Paths added to your message.`
            : null,
        );
        if (failures.length) setError(failures.join("\n"));
      } finally {
        request.current = null;
        setUploading(false);
      }
    },
    [conversationId, enabled, onUploaded],
  );

  useEffect(() => {
    let depth = 0;
    const files = (event: DragEvent) => event.dataTransfer?.types.includes("Files");
    const enter = (event: DragEvent) => {
      if (files(event)) {
        event.preventDefault();
        depth++;
        setDragging(true);
      }
    };
    const over = (event: DragEvent) => {
      if (files(event)) {
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      }
    };
    const leave = (event: DragEvent) => {
      if (files(event) && --depth <= 0) {
        depth = 0;
        setDragging(false);
      }
    };
    const drop = (event: DragEvent) => {
      if (!files(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      void uploadFiles(Array.from(event.dataTransfer!.files));
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [uploadFiles]);
  return { dragging, uploading, status, error, uploadFiles };
}
