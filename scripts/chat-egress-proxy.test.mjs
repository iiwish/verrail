import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import http from "node:http";
import { startChatEgressProxy } from "./chat-egress-proxy.mjs";

test("chat proxy rejects unauthenticated, non-model, and non-HTTPS destinations", async () => {
  const proxy = await startChatEgressProxy();
  const url = new URL(proxy.url);
  const auth = Buffer.from(`${url.username}:${url.password}`).toString("base64");
  const check = (target, credential) => new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${credential}\r\n\r\n`);
    });
    socket.once("error", reject);
    socket.once("data", (chunk) => { socket.destroy(); resolve(String(chunk)); });
  });
  try {
    assert.match(await check("chatgpt.com:443", "wrong"), /407/);
    for (const target of ["example.com:443", "127.0.0.1:3270", "chatgpt.com:80", "chatgpt.com.evil.test:443"]) {
      assert.match(await check(target, auth), /403/);
    }
  } finally { proxy.close(); }
});

test("tunnels an allowed destination through the loopback upstream without forwarding proxy credentials", async () => {
  const upstream = http.createServer();
  let destination;
  let credential;
  upstream.on("connect", (req, socket) => {
    destination = req.url;
    credential = req.headers["proxy-authorization"];
    socket.end("HTTP/1.1 200 Connection Established\r\n\r\nfixture");
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = await startChatEgressProxy({ upstreamProxy: `http://127.0.0.1:${upstream.address().port}` });
  const url = new URL(proxy.url);
  try {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port: proxy.port, method: "CONNECT", path: "chatgpt.com:443",
        headers: { "Proxy-Authorization": `Basic ${Buffer.from(`${url.username}:${url.password}`).toString("base64")}` } });
      req.on("error", reject);
      req.on("connect", (res, socket) => { socket.destroy(); resolve(res.statusCode); });
      req.end();
    });
    assert.equal(result, 200);
    assert.equal(destination, "chatgpt.com:443");
    assert.equal(credential, undefined);
  } finally { proxy.close(); upstream.close(); }
});

test("rejects non-loopback upstream configuration", async () => {
  await assert.rejects(startChatEgressProxy({ upstreamProxy: "http://example.com:1234" }), /loopback/);
});
