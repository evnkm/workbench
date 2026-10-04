import type { ConversationItem } from "@workbench/contracts";
import { useState } from "react";
import { conversationImageUrl } from "../lib/images.ts";

export function ConversationImages({ item }: { item: ConversationItem }) {
  if (!item.data.images?.length && !item.data.error) return null;
  return (
    <div className="space-y-2">
      {item.data.images?.map((image) => (
        <ConversationImage key={image.source} itemId={item.id} image={image} />
      ))}
      {item.data.error && (
        <p role="status" className="text-[13px] text-neutral-400">
          {item.data.error}
        </p>
      )}
    </div>
  );
}

function ConversationImage({
  itemId,
  image,
}: {
  itemId: string;
  image: NonNullable<ConversationItem["data"]["images"]>[number];
}) {
  const [failed, setFailed] = useState(false);
  if (image.error || failed)
    return (
      <p role="status" className="text-[13px] text-neutral-400">
        Image unavailable: {image.error ?? image.alt}
      </p>
    );
  const url = conversationImageUrl(itemId, image.source);
  return (
    <figure className="overflow-hidden rounded-lg border border-wb-border bg-wb-panel">
      <a href={url} target="_blank" rel="noreferrer" aria-label={`Open image: ${image.alt}`}>
        <img
          src={url}
          alt={image.alt}
          loading="lazy"
          onError={() => setFailed(true)}
          className="block max-h-[70dvh] max-w-full object-contain"
        />
      </a>
      <figcaption className="px-3 py-2 text-[12px] text-neutral-500">{image.alt} · Tap to open full size</figcaption>
    </figure>
  );
}
