export type VerrailManagementSection = "targets" | "projects" | "agents" | "infrastructure" | "governance";

function workspaceRelativePath(pathname: string, companyPrefix: string | undefined): string {
  const segments = pathname.split("/").filter(Boolean);
  if (companyPrefix && segments[0]?.toUpperCase() === companyPrefix.toUpperCase()) {
    return `/${segments.slice(1).join("/")}`;
  }
  return `/${segments.join("/")}`;
}

export function resolveVerrailManagementSection(
  pathname: string,
  companyPrefix: string | undefined,
): VerrailManagementSection | null {
  const path = workspaceRelativePath(pathname, companyPrefix).toLowerCase();

  if (
    path === "/targets"
    || path.startsWith("/targets/")
    || path === "/collections"
    || path.startsWith("/collections/")
  ) {
    return "targets";
  }

  if (path === "/projects" || path.startsWith("/projects/")) {
    return "projects";
  }

  if (path === "/agents" || path.startsWith("/agents/")) {
    return "agents";
  }

  if (
    path === "/infrastructure" ||
    path.startsWith("/infrastructure/") ||
    path === "/company/settings/secrets" ||
    path.startsWith("/company/settings/secrets/") ||
    path === "/company/settings/instance/environments" ||
    path.startsWith("/company/settings/instance/environments/") ||
    path === "/company/settings/instance/adapters" ||
    path.startsWith("/company/settings/instance/adapters/") ||
    path === "/company/settings/instance/plugins" ||
    path.startsWith("/company/settings/instance/plugins/")
  ) {
    return "infrastructure";
  }

  if (
    path === "/governance" ||
    path.startsWith("/governance/") ||
    path === "/decisions" ||
    path.startsWith("/decisions/") ||
    path === "/approvals" ||
    path.startsWith("/approvals/") ||
    path === "/activity" ||
    path === "/costs"
  ) {
    return "governance";
  }

  return null;
}
