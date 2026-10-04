// Shared by Node and the browser, so this uses Web Crypto only.

/** Time-ordered UUIDv7, so primary keys sort by creation time. */
export function uuidv7(now = Date.now()): string {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  for (let i = 5; i >= 0; i--) {
    b[i] = now % 256;
    now = Math.floor(now / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const nowIso = () => new Date().toISOString();
