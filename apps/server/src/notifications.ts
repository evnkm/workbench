// The worker commits a notification outbox with each finished turn. The API
// owns outbound delivery, so neither browser disconnection nor an API restart
// loses completion alerts. The run tag replaces a retry's visible notification.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BrowserPushSubscription, pushSubscriptionSchema, type TurnNotification } from "@workbench/contracts";
import type { Config, Database, Logger } from "@workbench/db";
import type { Hono } from "hono";
import webPush from "web-push";
import type { Auth } from "./auth.ts";

type Delivery = { id: number; endpoint: string; keys: string; origin: string; payload: string; attempts: number };
type Sender = (subscription: BrowserPushSubscription, payload: string, origin: string) => Promise<unknown>;

export class PushNotifications {
  readonly publicKey: string;
  private readonly send: Sender;
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending = false;
  private stopped = false;
  private readonly db: Database;
  private readonly log: Logger;

  constructor(db: Database, config: Config, log: Logger, sender?: Sender) {
    this.db = db;
    this.log = log;
    const path = join(config.stateDir, "push-keys.json");
    mkdirSync(config.stateDir, { recursive: true });
    let keys: ReturnType<typeof webPush.generateVAPIDKeys>;
    try {
      keys = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      keys = webPush.generateVAPIDKeys();
      writeFileSync(path, JSON.stringify(keys), { mode: 0o600, flag: "wx" });
    }
    // Validate persisted keys at startup rather than failing every delivery.
    webPush.setVapidDetails("https://workbench.invalid", keys.publicKey, keys.privateKey);
    this.publicKey = keys.publicKey;
    this.send =
      sender ??
      ((subscription, payload, origin) =>
        webPush.sendNotification(subscription, payload, {
          vapidDetails: { subject: origin, publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 3600,
          timeout: 10_000,
          urgency: "normal",
        }));
  }

  routes(app: Hono, auth: Auth) {
    app.get("/api/notifications/key", (c) => c.json({ publicKey: this.publicKey }));
    app.post("/api/notifications/subscriptions", async (c) => {
      const parsed = pushSubscriptionSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: "Invalid browser push subscription." }, 400);
      const origin = c.req.header("origin")!;
      if (!["http:", "https:"].includes(new URL(origin).protocol))
        return c.json({ error: "Invalid application origin." }, 400);
      const { endpoint, keys } = parsed.data;
      if (Buffer.from(keys.p256dh, "base64url")[0] !== 4)
        return c.json({ error: "Invalid browser push public key." }, 400);
      this.db.run(
        `INSERT INTO push_subscriptions (endpoint, keys, origin, session_hash)
        VALUES (:endpoint, :keys, :origin, :session)
        ON CONFLICT(endpoint) DO UPDATE SET keys = excluded.keys, origin = excluded.origin,
          session_hash = excluded.session_hash`,
        { endpoint, keys: JSON.stringify(keys), origin, session: auth.sessionHash(c) },
      );
      return c.json({ ok: true });
    });
    app.delete("/api/notifications/subscriptions", async (c) => {
      const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null;
      if (typeof body?.endpoint !== "string") return c.json({ error: "A push endpoint is required." }, 400);
      this.db.run("DELETE FROM push_subscriptions WHERE endpoint = :endpoint", { endpoint: body.endpoint });
      return c.json({ ok: true });
    });
    app.post("/api/notifications/test", async (c) => {
      const notification: TurnNotification = {
        title: "Workbench notifications enabled",
        body: "You'll receive an alert when a Codex turn finishes.",
        tag: "workbench-test",
        url: "/",
      };
      // Test only the device making this request, never all subscribed phones.
      const body = (await c.req.json().catch(() => null)) as { endpoint?: unknown } | null;
      if (typeof body?.endpoint !== "string") return c.json({ error: "A push endpoint is required." }, 400);
      const sub = this.db.get<{ endpoint: string }>(
        "SELECT endpoint FROM push_subscriptions WHERE endpoint = :endpoint AND session_hash = :session",
        { endpoint: body.endpoint, session: auth.sessionHash(c) },
      );
      if (!sub) return c.json({ error: "Enable notifications on this device first." }, 404);
      this.db.run(
        "INSERT INTO push_deliveries (endpoint, run_id, payload, next_attempt_at) VALUES (:endpoint, :id, :payload, :now)",
        { endpoint: sub.endpoint, id: crypto.randomUUID(), payload: JSON.stringify(notification), now: Date.now() },
      );
      return c.json({ ok: true });
    });
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.deliver(), 1000);
    void this.deliver();
  }
  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async deliver() {
    if (this.sending) return;
    this.sending = true;
    try {
      const rows = this.db.all<Delivery>(
        `SELECT d.*, p.keys, p.origin FROM push_deliveries d
        JOIN push_subscriptions p USING(endpoint) JOIN auth_sessions a ON a.token_hash = p.session_hash
        WHERE d.next_attempt_at <= :now AND a.expires_at > :iso ORDER BY d.id LIMIT 20`,
        { now: Date.now(), iso: new Date().toISOString() },
      );
      for (const row of rows) {
        try {
          await this.send({ endpoint: row.endpoint, keys: JSON.parse(row.keys) }, row.payload, row.origin);
          if (this.stopped) return;
          this.db.run("DELETE FROM push_deliveries WHERE id = :id", { id: row.id });
        } catch (error) {
          if (this.stopped) return;
          const status = (error as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.db.run("DELETE FROM push_subscriptions WHERE endpoint = :endpoint", { endpoint: row.endpoint });
          } else if (row.attempts >= 5) {
            this.log.error("push notification delivery exhausted retries", { deliveryId: row.id, status });
            this.db.run("DELETE FROM push_deliveries WHERE id = :id", { id: row.id });
          } else {
            this.db.run("UPDATE push_deliveries SET attempts = attempts + 1, next_attempt_at = :next WHERE id = :id", {
              id: row.id,
              next: Date.now() + 5000 * 2 ** row.attempts,
            });
          }
        }
      }
    } finally {
      this.sending = false;
    }
  }
}
