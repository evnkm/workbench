// Password login with server-side sessions. The password hash lives in the
// environment file; session tokens are random and stored only as SHA-256.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Config, Database } from "@workbench/db";
import { createAuthSession, deleteAuthSession, validAuthSession } from "@workbench/db";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";

export const SESSION_COOKIE = "wb_session";

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const N = 2 ** 15;
  const hash = scryptSync(password, salt, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$8$1$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const actual = scryptSync(password, Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

const tokenHash = (t: string) => createHash("sha256").update(t).digest("hex");

export class Auth {
  private readonly db: Database;
  private readonly config: Config;
  private failures: number[] = [];

  constructor(db: Database, config: Config) {
    this.db = db;
    this.config = config;
  }

  /** Global login throttle: at most 10 failures per 5 minutes. */
  private throttled() {
    const cutoff = Date.now() - 5 * 60_000;
    this.failures = this.failures.filter((t) => t > cutoff);
    return this.failures.length >= 10;
  }

  login(c: Context, password: string): { ok: true } | { ok: false; status: 401 | 429 | 503; error: string } {
    if (!this.config.passwordHash) {
      return { ok: false, status: 503, error: "No password is configured. Run `npm run set-password` on the server." };
    }
    if (this.throttled()) return { ok: false, status: 429, error: "Too many failed attempts. Try again later." };
    if (!verifyPassword(password, this.config.passwordHash)) {
      this.failures.push(Date.now());
      return { ok: false, status: 401, error: "Incorrect password." };
    }
    const token = randomBytes(32).toString("base64url");
    const ttl = this.config.sessionTtlDays * 86_400_000;
    createAuthSession(this.db, tokenHash(token), ttl, c.req.header("user-agent") ?? null);
    setCookie(c, SESSION_COOKIE, token, {
      httpOnly: true,
      secure: this.config.secureCookies,
      sameSite: "Strict",
      path: "/",
      maxAge: Math.floor(ttl / 1000),
    });
    return { ok: true };
  }

  logout(c: Context) {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) deleteAuthSession(this.db, tokenHash(token));
    deleteCookie(c, SESSION_COOKIE, { path: "/" });
  }

  authenticated(c: Context): boolean {
    const token = getCookie(c, SESSION_COOKIE);
    return Boolean(token && validAuthSession(this.db, tokenHash(token)));
  }

  /** Validate a raw Cookie header (used for WebSocket upgrades). */
  authenticatedCookieHeader(header: string | undefined): boolean {
    const m = header?.split(/;\s*/).find((p) => p.startsWith(`${SESSION_COOKIE}=`));
    const token = m?.slice(SESSION_COOKIE.length + 1);
    return Boolean(token && validAuthSession(this.db, tokenHash(decodeURIComponent(token))));
  }

  /**
   * Origin check: browsers send Origin on mutations, EventSource, and
   * WebSocket requests. It must name this host or an allowed origin.
   */
  originAllowed(origin: string | undefined, host: string | undefined, required: boolean): boolean {
    if (!origin) return !required;
    if (this.config.allowedOrigins.includes(origin)) return true;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  middleware(): MiddlewareHandler {
    return async (c, next) => {
      const path = c.req.path;
      const mutation = !["GET", "HEAD", "OPTIONS"].includes(c.req.method);
      if (!this.originAllowed(c.req.header("origin"), c.req.header("host"), mutation)) {
        return c.json({ error: "Origin not allowed." }, 403);
      }
      if (path === "/api/auth/login" || path === "/api/health") return next();
      if (!this.authenticated(c)) return c.json({ error: "Not signed in." }, 401);
      return next();
    };
  }
}
