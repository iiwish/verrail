import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const FEISHU_PLUGIN_ID = "verrail.channel-connector-feishu";
export const FEISHU_CONNECTOR_KEY = "feishu";
export const FEISHU_WEBHOOK_ENDPOINT_KEY = "events";

const secretRefSchema = {
  type: "object",
  format: "secret-ref",
  properties: {
    type: { type: "string", const: "secret_ref", default: "secret_ref" },
    secretId: { type: "string" },
    version: { anyOf: [{ type: "integer", minimum: 1 }, { const: "latest" }] },
  },
  required: ["type", "secretId"],
  additionalProperties: false,
};

const manifest: PaperclipPluginManifestV1 = {
  id: FEISHU_PLUGIN_ID,
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Verrail Feishu Channel",
  description: "Receives authenticated Feishu messages and returns normalized Channel Connector V1 events.",
  author: "Verrail",
  categories: ["connector", "automation"],
  capabilities: ["webhooks.receive", "http.outbound", "secrets.read-ref"],
  entrypoints: { worker: "./dist/worker.js" },
  webhooks: [
    {
      endpointKey: FEISHU_WEBHOOK_ENDPOINT_KEY,
      displayName: "Feishu events",
      description: "Authenticated Feishu event-subscription callback.",
    },
  ],
  channelConnectors: [
    {
      contractVersion: 1,
      connectorKey: FEISHU_CONNECTOR_KEY,
      providerKey: "feishu",
      webhookEndpointKey: FEISHU_WEBHOOK_ENDPOINT_KEY,
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      channelConnections: {
        type: "array",
        items: {
          type: "object",
          properties: {
            contractVersion: { type: "integer", const: 1, default: 1, readOnly: true },
            connectorKey: { type: "string", const: FEISHU_CONNECTOR_KEY, default: FEISHU_CONNECTOR_KEY, readOnly: true },
            connectionId: { type: "string" },
            appId: { type: "string" },
            transport: { type: "string", enum: ["webhook", "long_connection"], default: "webhook" },
            appSecretRef: secretRefSchema,
            verificationTokenRef: secretRefSchema,
            encryptKeyRef: secretRefSchema,
            authorizedUsers: {
              type: "array",
              default: [],
              items: {
                type: "object",
                properties: {
                  providerUserId: { type: "string" },
                  userId: { type: "string" },
                },
                required: ["providerUserId", "userId"],
                additionalProperties: false,
              },
            },
          },
          required: [
            "contractVersion",
            "connectorKey",
            "connectionId",
            "appId",
            "appSecretRef",
            "authorizedUsers"
          ],
          allOf: [{
            if: { properties: { transport: { const: "long_connection" } }, required: ["transport"] },
            then: {},
            else: { required: ["verificationTokenRef", "encryptKeyRef"] },
          }],
          additionalProperties: false,
        },
      },
    },
    required: ["channelConnections"],
    additionalProperties: false,
  },
};

export default manifest;
