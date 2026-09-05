import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { createFeishuConnector } from "./feishu-connector.js";
import { WSClient, EventDispatcher, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { createLongConnectionManager } from "./long-connection.js";

let context: PluginContext | null = null;
let connections: ReturnType<typeof createLongConnectionManager> | null = null;

function connector() {
  if (!context) throw new Error("Feishu connector is not initialized");
  return createFeishuConnector({
    getConfig: (workspaceId) => context!.config.get(workspaceId),
    resolveSecret: (secretRef, options) => context!.secrets.resolve(secretRef, options),
    fetch: (url, init) => context!.http.fetch(url, init),
  });
}

const plugin = definePlugin({
  multiCompanyConfig: true,
  async setup(ctx) {
    context = ctx;
    connections = createLongConnectionManager({
      resolveSecret: (ref, options) => ctx.secrets.resolve(ref, options),
      ingest: (input) => {
        if (!ctx.channels) throw new Error("Host channel ingress is unavailable");
        return ctx.channels.ingest(input);
      },
      createClient: ({ appId, appSecret, receive }) => {
        // SDK diagnostics may contain authenticated request objects or payloads.
        const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
        const client = new WSClient({ appId, appSecret, logger, loggerLevel: LoggerLevel.error });
        const dispatcher = new EventDispatcher({ logger, loggerLevel: LoggerLevel.error }).register({
          "im.message.receive_v1": receive,
        });
        return {
          start: () => client.start({ eventDispatcher: dispatcher }),
          close: () => client.close({ force: true }),
          status: () => client.getConnectionStatus().state,
        };
      },
    });
    ctx.data.register("connection-health", async ({ companyId }) => ({
      sessions: connections!.workspaceHealth(companyId),
    }));
  },
  async onConfigChanged(config, scope) {
    if (scope?.companyId) await connections!.configure(scope.companyId, config);
  },
  async onShutdown() { connections?.close(); },
  async onHealth() {
    const sessions = connections?.health() ?? [];
    return { status: sessions.some((item) => item.status !== "connected") ? "degraded" : "ok",
      details: { sessions } };
  },
  async onChannelWebhook(input) {
    return connector().handleWebhook(input);
  },
  async onChannelReply(input) {
    return connector().sendReply(input);
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
