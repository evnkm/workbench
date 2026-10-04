export function conversationImageUrl(itemId: string | undefined, source: string): string {
  if (/^(https?:\/\/|data:image\/)/i.test(source) || !itemId) return source;
  return `/api/items/${encodeURIComponent(itemId)}/image?source=${encodeURIComponent(source)}`;
}
