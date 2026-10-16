import http from "node:http";
import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";

const DESTINATIONS = new Set(["chatgpt.com:443", "api.openai.com:443", "auth.openai.com:443"]);

export async function startChatEgressProxy({ upstreamProxy } = {}) {
  const upstreamUrl = upstreamProxy ? new URL(upstreamProxy) : null;
  if (upstreamUrl && (upstreamUrl.protocol !== "http:" || upstreamUrl.hostname !== "127.0.0.1")) {
    throw new Error("Chat upstream proxy must be a loopback HTTP proxy");
  }
  const token = randomBytes(32).toString("hex");
  const authorization = Buffer.from(`Basic ${Buffer.from(`chat:${token}`).toString("base64")}`);
  const sockets = new Set();
  const server = http.createServer((_req, res) => res.writeHead(403).end());
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.setTimeout(120_000, () => socket.destroy());
    socket.on("error", () => socket.destroy());
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", (req, client, head) => {
    const supplied = Buffer.from(req.headers["proxy-authorization"] ?? "");
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      client.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n");
      return;
    }
    if (!DESTINATIONS.has(req.url) || sockets.size > 16) {
      client.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    const attach = (upstream, upstreamHead = Buffer.alloc(0)) => {
      sockets.add(upstream);
      upstream.setTimeout(120_000, () => upstream.destroy());
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      if (upstreamHead.length) client.write(upstreamHead);
      client.pipe(upstream).pipe(client);
    };
    if (upstreamUrl) {
      const request = http.request({
        hostname: upstreamUrl.hostname,
        port: upstreamUrl.port || 80,
        method: "CONNECT",
        path: req.url,
        headers: { Host: req.url },
        timeout: 15_000,
      });
      request.on("connect", (response, socket, upstreamHead) => {
        if (response.statusCode !== 200 || client.destroyed) {
          socket.destroy(); client.destroy(); return;
        }
        attach(socket, upstreamHead);
      });
      request.on("error", () => client.destroy());
      request.on("timeout", () => request.destroy());
      client.on("close", () => request.destroy());
      request.end();
    } else {
      const upstream = net.connect({ host: req.url.split(":")[0], port: 443 });
      upstream.on("error", () => client.destroy());
      client.on("close", () => upstream.destroy());
      upstream.setTimeout(15_000, () => upstream.destroy());
      upstream.on("connect", () => attach(upstream));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    port,
    url: `http://chat:${token}@127.0.0.1:${port}`,
    close: () => { for (const socket of sockets) socket.destroy(); server.close(); },
  };
}
