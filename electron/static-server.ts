import express from "express";
import type { Server } from "http";
import path from "path";

// Loopback-only host: serving a bundled SPA must never be reachable from the LAN
// (CLAUDE.md security rule — bind 127.0.0.1 ONLY). Used in packaged builds to
// replace the per-app dev servers (Vite / Next) with static file serving.
const LOOPBACK_HOST = "127.0.0.1";

export interface StaticServerHandle {
  readonly server: Server;
  close(): Promise<void>;
}

/**
 * Serve a built static SPA directory on a fixed loopback port with history-API
 * fallback to index.html. Resolves once the socket is listening.
 */
export async function startStaticServer(
  rootDir: string,
  port: number,
): Promise<StaticServerHandle> {
  const indexFile = path.join(rootDir, "index.html");
  const app = express();

  // Security headers on every static response — parity with the proxy. Even on
  // loopback, a DNS-rebinding or compromised-renderer vector could fetch these
  // assets; nosniff blocks MIME-confusion, DENY blocks clickjacking via <iframe>,
  // and no-referrer stops the loopback URL leaking in outbound Referer headers.
  app.use((_req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    // Parité avec le proxy : X-Frame-Options est legacy, frame-ancestors 'none'
    // est la directive moderne honorée par les navigateurs récents.
    res.setHeader("Content-Security-Policy", "frame-ancestors 'none'");
    res.setHeader("Referrer-Policy", "no-referrer");
    next();
  });

  // express.static rejects path traversal by design; serve assets first.
  app.use(express.static(rootDir, { fallthrough: true, index: "index.html" }));

  // SPA fallback: any unmatched GET returns the app shell so client routing works.
  app.get(/.*/, (_req, res) => {
    res.sendFile(indexFile);
  });

  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, LOOPBACK_HOST, () => resolve(s));
    s.on("error", reject);
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
