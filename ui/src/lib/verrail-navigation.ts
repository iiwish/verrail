export function isVerrailNavigationEnabled(
  workspace: { enableVerrailNavigation?: boolean } | null | undefined,
): boolean {
  return workspace?.enableVerrailNavigation === true;
}

export function workspaceLandingRoute(
  workspace: { enableVerrailNavigation?: boolean } | null | undefined,
): "home" | "dashboard" {
  return isVerrailNavigationEnabled(workspace) ? "home" : "dashboard";
}
