export function isControlPlaneCredentialEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  const normalized = upper.startsWith("ACPX_AUTH_")
    ? upper.slice("ACPX_AUTH_".length).replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
    : upper;
  return normalized === "VERRAIL_DOMAIN_API_TOKEN" || normalized === "VERRAIL_GITHUB_CI_PROOF_TOKEN";
}

export function sanitizeControlPlaneEnv(env: Record<string, string>): Record<string, string>;
export function sanitizeControlPlaneEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function sanitizeControlPlaneEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !isControlPlaneCredentialEnvKey(key)));
}

export class ControlPlaneCredentialEnvError extends Error {
  constructor() {
    super("Control-plane credentials cannot be used in agent provider configuration");
  }
}
