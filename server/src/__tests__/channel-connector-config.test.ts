import { describe, expect, it } from "vitest";
import manifest from "../../../packages/plugins/channel-connectors/feishu/src/manifest.js";
import { validateInstanceConfig } from "../services/plugin-config-validator.js";
import { extractSecretRefBindingsFromConfig } from "../services/plugin-secrets-handler.js";
import { findConnection } from "../../../packages/plugins/channel-connectors/feishu/src/feishu-connector.js";

const config = { channelConnections: [{
  contractVersion: 1, connectorKey: "feishu", connectionId: "one", appId: "cli_test",
  transport: "long_connection", authorizedUsers: [],
  appSecretRef: { type: "secret_ref", secretId: "local-secret", version: "latest" },
}] };

describe("Feishu settings schema", () => {
  it("resolves the same positional secret paths that settings persist, including after reordering", () => {
    const first = { ...config.channelConnections[0], appSecretRef: { ...config.channelConnections[0]!.appSecretRef, secretId: "11111111-1111-4111-8111-111111111111" } };
    const second = { ...first, connectionId: "two", appSecretRef: { ...first.appSecretRef, secretId: "22222222-2222-4222-8222-222222222222" } };
    for (const channelConnections of [[first, second], [second, first]]) {
      const settings = { channelConnections };
      const refs = extractSecretRefBindingsFromConfig(settings, manifest.instanceConfigSchema);
      for (const connection of channelConnections) {
        const parsed = findConnection(settings, connection.connectionId!);
        expect(refs).toContainEqual(expect.objectContaining({
          secretId: connection.appSecretRef.secretId, configPath: `${parsed.configPath}.appSecretRef`,
        }));
      }
    }
  });
  it("accepts a picker reference without HTTP callback keys for long connections", () => {
    expect(validateInstanceConfig(config, manifest.instanceConfigSchema!)).toEqual({ valid: true });
  });
  it("requires both callback secrets in webhook mode and rejects raw credential values", () => {
    expect(validateInstanceConfig({ channelConnections: [{ ...config.channelConnections[0], transport: "webhook" }] }, manifest.instanceConfigSchema!).valid).toBe(false);
    expect(validateInstanceConfig({ channelConnections: [{ ...config.channelConnections[0], appSecretRef: "raw-value" }] }, manifest.instanceConfigSchema!).valid).toBe(false);
  });
});
