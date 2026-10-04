// Application previews (decision 0006). Each preview gets its own origin: a
// proxy listener on `targetPort + offset`, bound to the Tailscale address by
// default. Only ports that belong to a running Workbench app process are
// proxied; there is no arbitrary URL proxy. Access needs a short-lived signed
// link from the authenticated app, exchanged for a per-port cookie.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, request, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { connect, type Socket } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { type Config, type Database, type Logger, listProcesses, listWorkspaces } from "@workbench/db";

// Preview listeners sit outside the app port range (default 10000-19999 -> 20000-29999).
const OFFSET = Number(process.env.WORKBENCH_PREVIEW_OFFSET ?? 10000);
const TOKEN_TTL_S = 120;
const PROTOCOL_CACHE_MS = 30_000;

/**
 * Whether the app on a loopback port speaks TLS (dev servers such as Vite with
 * plugin-basic-ssl use self-signed certificates). Certificates are not
 * verified: the connection never leaves 127.0.0.1.
 */
function detectTls(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false, servername: "localhost" });
    const done = (tls: boolean) => {
      clearTimeout(timer);
      s.destroy();
      resolve(tls);
    };
    const timer = setTimeout(() => done(false), 1500);
    s.once("secureConnect", () => done(true));
    s.once("error", () => done(false));
  });
}
const COOKIE_TTL_S = 12 * 3600;

function tailscaleAddress(): string | null {
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (
        a.family === "IPv4" &&
        (name.startsWith("tailscale") || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address))
      ) {
        return a.address;
      }
    }
  }
  return null;
}

export class Previews {
  readonly bindHost: string;
  readonly urlHost: string;
  private readonly secret: Buffer;
  private listeners = new Map<number, Server>();
  private protocols = new Map<number, { tls: boolean; at: number }>();
  private readonly db: Database;
  private readonly config: Config;
  private readonly log: Logger;

  constructor(db: Database, config: Config, log: Logger) {
    this.db = db;
    this.config = config;
    this.log = log;
    this.bindHost = process.env.WORKBENCH_PREVIEW_HOST ?? tailscaleAddress() ?? "127.0.0.1";
    this.urlHost = process.env.WORKBENCH_PREVIEW_URL_HOST ?? this.bindHost;
    const file = join(config.stateDir, "preview-secret");
    if (!existsSync(file)) {
      writeFileSync(file, randomBytes(32).toString("hex"), { mode: 0o600 });
      chmodSync(file, 0o600);
    }
    this.secret = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
  }

  private sign(s: string) {
    return createHmac("sha256", this.secret).update(s).digest("base64url");
  }

  private verify(value: string, expectedPrefix: string): boolean {
    const [payload, sig] = value.split(".");
    if (!payload || !sig) return false;
    const want = Buffer.from(this.sign(payload));
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
    const [prefix, exp] = Buffer.from(payload, "base64url").toString().split("|");
    return prefix === expectedPrefix && Number(exp) > Date.now() / 1000;
  }

  private token(kind: string, port: number, ttl: number) {
    const payload = Buffer.from(`${kind}:${port}|${Math.floor(Date.now() / 1000) + ttl}`).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  /** The workspace app port a proxy port maps to, if a running app owns it. */
  private target(proxyPort: number): number | null {
    const port = proxyPort - OFFSET;
    const running = listProcesses(this.db).filter((p) => p.kind === "app" && p.state === "running");
    const workspaces = new Map(listWorkspaces(this.db).map((w) => [w.id, w]));
    for (const p of running) {
      const base = workspaces.get(p.workspaceId)?.portBase;
      if (base != null && port >= base && port < base + this.config.portsPerWorkspace) return port;
    }
    return null;
  }

  /** Create (or reuse) the listener for a target port and return a signed entry URL. */
  async link(targetPort: number, path: string): Promise<string> {
    const proxyPort = targetPort + OFFSET;
    if (!this.listeners.has(proxyPort)) await this.listen(proxyPort);
    const t = this.token("enter", proxyPort, TOKEN_TTL_S);
    const next = path.startsWith("/") ? path : `/${path}`;
    return `http://${this.urlHost}:${proxyPort}/__workbench/enter?token=${t}&next=${encodeURIComponent(next)}`;
  }

  private listen(proxyPort: number): Promise<void> {
    const server = createServer((req, res) => this.handle(proxyPort, req, res));
    server.on("upgrade", (req, socket, head) => this.upgrade(proxyPort, req, socket, head));
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(proxyPort, this.bindHost, () => {
        this.listeners.set(proxyPort, server);
        this.log.info("preview listener open", { host: this.bindHost, port: proxyPort });
        resolve();
      });
    });
  }

  private async upstreamTls(port: number): Promise<boolean> {
    const cached = this.protocols.get(port);
    if (cached && Date.now() - cached.at < PROTOCOL_CACHE_MS) return cached.tls;
    const tls = await detectTls(port);
    this.protocols.set(port, { tls, at: Date.now() });
    return tls;
  }

  private cookieName(proxyPort: number) {
    return `wb_preview_${proxyPort}`;
  }

  private authorized(proxyPort: number, cookieHeader: string | undefined) {
    const name = this.cookieName(proxyPort);
    const v = cookieHeader
      ?.split(/;\s*/)
      .find((c) => c.startsWith(`${name}=`))
      ?.slice(name.length + 1);
    return Boolean(v && this.verify(v, `cookie:${proxyPort}`));
  }

  /** Remove our cookie before forwarding so the app never sees it. */
  private stripCookie(proxyPort: number, header: string | undefined) {
    const name = this.cookieName(proxyPort);
    const rest = header
      ?.split(/;\s*/)
      .filter((c) => !c.startsWith(`${name}=`))
      .join("; ");
    return rest || undefined;
  }

  private handle(proxyPort: number, req: IncomingMessage, res: ServerResponse) {
    void this.handleAsync(proxyPort, req, res).catch((e) => {
      this.log.warn("preview request failed", { proxyPort, err: e });
      if (!res.headersSent) page(res, 502, "The preview proxy failed.");
      else res.destroy();
    });
  }

  private async handleAsync(proxyPort: number, req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/__workbench/enter") {
      const t = url.searchParams.get("token") ?? "";
      if (!this.verify(t, `enter:${proxyPort}`))
        return page(res, 403, "This preview link expired. Open the preview again from Workbench.");
      const next = url.searchParams.get("next") ?? "/";
      res.writeHead(302, {
        "Set-Cookie": `${this.cookieName(proxyPort)}=${this.token("cookie", proxyPort, COOKIE_TTL_S)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_TTL_S}`,
        Location: next.startsWith("/") && !next.startsWith("//") ? next : "/",
      });
      return res.end();
    }
    if (!this.authorized(proxyPort, req.headers.cookie)) {
      return page(res, 401, "Open this preview from Workbench to sign in to it.");
    }
    const port = this.target(proxyPort);
    if (port == null)
      return page(res, 502, "No running Workbench app owns this port. Start the app from the Run panel.");
    const headers: Record<string, string | string[] | undefined> = {
      ...req.headers,
      host: `localhost:${port}`,
      cookie: this.stripCookie(proxyPort, req.headers.cookie),
      "x-forwarded-host": req.headers.host,
      "x-forwarded-proto": "http",
    };
    // Our cookie may have been the only one; an undefined header value is invalid.
    if (headers.cookie === undefined) delete headers.cookie;
    const tls = await this.upstreamTls(port);
    const send = tls ? httpsRequest : request;
    const opts = { host: "127.0.0.1", port, method: req.method, path: req.url, headers };
    const upstream = send(tls ? { ...opts, rejectUnauthorized: false, servername: "localhost" } : opts, (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", (e) => {
      if (!res.headersSent) page(res, 502, `The app is not accepting connections on port ${port} (${e.message}).`);
      else res.destroy();
    });
    req.pipe(upstream);
  }

  private upgrade(proxyPort: number, req: IncomingMessage, socket: Duplex, head: Buffer) {
    const port = this.target(proxyPort);
    if (!this.authorized(proxyPort, req.headers.cookie) || port == null) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    void this.upstreamTls(port).then((tls) => this.pipeUpgrade(proxyPort, port, tls, req, socket, head));
  }

  private pipeUpgrade(
    proxyPort: number,
    port: number,
    tls: boolean,
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) {
    const onConnect = () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i]!;
        let v = req.rawHeaders[i + 1]!;
        if (k.toLowerCase() === "host") v = `localhost:${port}`;
        if (k.toLowerCase() === "cookie") {
          const stripped = this.stripCookie(proxyPort, v);
          if (!stripped) continue;
          v = stripped;
        }
        lines.push(`${k}: ${v}`);
      }
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    };
    const up: Socket = tls
      ? tlsConnect({ host: "127.0.0.1", port, rejectUnauthorized: false, servername: "localhost" }, onConnect)
      : connect(port, "127.0.0.1", onConnect);
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  }

  /** Close listeners whose ports no longer belong to a running app. */
  sweep() {
    for (const [proxyPort, server] of this.listeners) {
      if (this.target(proxyPort) == null) {
        server.close();
        this.listeners.delete(proxyPort);
      }
    }
  }

  close() {
    for (const s of this.listeners.values()) s.close();
  }
}

function page(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(
    `<!doctype html><meta name=viewport content="width=device-width"><title>Workbench preview</title><body style="font:15px system-ui;padding:2rem;color:#ddd;background:#111"><p>${message.replace(/</g, "&lt;")}</p>`,
  );
}
