// Both ledger suites drive the real handler over a real socket, so the socket code lives here once.
// The port is chosen by the OS — a fixed one collides with the dev server or a parallel run.
import http from "node:http";
import { handleSiteApi, type SiteEnv } from "../lib/site-api";

export type SiteServer = { port: number; base: string; close(): Promise<void> };

export async function startSiteServer(env: SiteEnv): Promise<SiteServer> {
  const server = http.createServer(async (request, response) => {
    const method = request.method || "GET";
    // The socket is loopback, but the Worker answers on calvras.com — the handler must not care.
    const headers: Record<string, string> = { host: "calvras.com" };
    for (const [name, value] of Object.entries(request.headers)) {
      if (value === undefined) continue;
      headers[name] = Array.isArray(value) ? value.join(", ") : String(value);
    }
    const init: RequestInit = { method, headers };
    if (method !== "GET" && method !== "HEAD") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      init.body = new Uint8Array(Buffer.concat(chunks));
    }
    try {
      const handled = await handleSiteApi(new Request("http://calvras.com" + (request.url || "/"), init), env);
      if (!handled) { response.writeHead(404, { "content-type": "text/plain" }); response.end("not a site route"); return; }
      response.writeHead(handled.status, Object.fromEntries(handled.headers.entries()));
      response.end(await handled.text());
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end(String(error));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { port, base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
