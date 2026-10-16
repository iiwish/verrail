export function isSupportedWorkflowNodeVersion(value) {
  if (value === "24") return true;
  const match = /^24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match !== null && Number(match[1]) >= 11;
}
