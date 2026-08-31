import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { instanceSettingsApi } from "../api/instanceSettings";
import { issuesApi } from "../api/issues";
import { buildProjectWorkspaceSummaries } from "../lib/project-workspaces-tab";
import { queryKeys } from "../lib/queryKeys";

export function useProjectWorkspaceNavigation(
  project: Project | null | undefined,
  companyId: string | null | undefined,
) {
  const projectId = project?.id ?? null;
  const experimentalSettingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    enabled: Boolean(projectId),
  });
  const isolatedWorkspacesEnabled = experimentalSettingsQuery.data?.enableIsolatedWorkspaces === true;
  const issuesQuery = useQuery({
    queryKey: projectId && companyId
      ? queryKeys.issues.listByProject(companyId, projectId)
      : ["issues", "__workspace-navigation__", "disabled"],
    queryFn: () => issuesApi.list(companyId!, { projectId: projectId! }),
    enabled: Boolean(companyId && projectId && isolatedWorkspacesEnabled),
  });
  const executionWorkspacesQuery = useQuery({
    queryKey: projectId && companyId
      ? queryKeys.executionWorkspaces.list(companyId, { projectId })
      : ["execution-workspaces", "__workspace-navigation__", "disabled"],
    queryFn: () => executionWorkspacesApi.list(companyId!, { projectId: projectId! }),
    enabled: Boolean(companyId && projectId && isolatedWorkspacesEnabled),
  });
  const summaries = useMemo(() => {
    if (!project || !isolatedWorkspacesEnabled) return [];
    return buildProjectWorkspaceSummaries({
      project,
      issues: issuesQuery.data ?? [],
      executionWorkspaces: executionWorkspacesQuery.data ?? [],
    });
  }, [executionWorkspacesQuery.data, isolatedWorkspacesEnabled, issuesQuery.data, project]);
  const decisionLoaded = experimentalSettingsQuery.isFetched
    && (!isolatedWorkspacesEnabled || (!issuesQuery.isLoading && !executionWorkspacesQuery.isLoading));

  return {
    decisionLoaded,
    error: (issuesQuery.error ?? executionWorkspacesQuery.error) as Error | null,
    showWorkspaces: isolatedWorkspacesEnabled && summaries.length > 0,
    summaries,
  };
}
