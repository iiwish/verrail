import { useCallback, useEffect, useMemo, useState, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams, useNavigate, useLocation, Navigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { PROJECT_COLORS, PROJECT_ICON_NAMES, isUuidLike, type BudgetPolicySummary } from "@paperclipai/shared";
import { budgetsApi } from "../api/budgets";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { agentsApi } from "../api/agents";
import { heartbeatsApi } from "../api/heartbeats";
import { assetsApi } from "../api/assets";
import { usePanel } from "../context/PanelContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useDialogActions } from "../context/DialogContext";
import { queryKeys } from "../lib/queryKeys";
import { ProjectProperties, type ProjectConfigFieldKey, type ProjectFieldSaveState } from "../components/ProjectProperties";
import { InlineEditor } from "../components/InlineEditor";
import { StatusBadge } from "../components/StatusBadge";
import { ProjectTile } from "../components/ProjectTile";
import { BudgetPolicyCard } from "../components/BudgetPolicyCard";
import { IssuesList } from "../components/IssuesList";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { ProjectWorkspacesContent } from "../components/ProjectWorkspacesContent";
import { SummarySlotCard } from "../components/SummarySlotCard";
import { TargetList } from "../components/TargetList";
import { MembershipAction } from "../components/MembershipAction";
import { StarToggle } from "../components/StarToggle";
import { buildProjectWorkspaceSummaries } from "../lib/project-workspaces-tab";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { projectRouteRef } from "../lib/utils";
import { PROJECT_ICONS } from "../lib/project-icons";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { formatDate } from "../i18n/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { Tabs } from "@/components/ui/tabs";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { PluginSlotMount, PluginSlotOutlet, usePluginSlots } from "@/plugins/slots";
import { Target } from "lucide-react";
import { isVerrailNavigationEnabled } from "../lib/verrail-navigation";
import {
  isStarred,
  resourceMembershipState,
  useResourceMembershipMutation,
  useResourceMemberships,
} from "../hooks/useResourceMemberships";

/* ── Top-level tab types ── */

type ProjectBaseTab = "overview" | "targets" | "list" | "plugin-operations" | "workspaces" | "configuration" | "budget";
type ProjectPluginTab = `plugin:${string}`;
type ProjectTab = ProjectBaseTab | ProjectPluginTab;

function isProjectPluginTab(value: string | null): value is ProjectPluginTab {
  return typeof value === "string" && value.startsWith("plugin:");
}

function resolveProjectTab(pathname: string, projectId: string): ProjectTab | null {
  const segments = pathname.split("/").filter(Boolean);
  const projectsIdx = segments.indexOf("projects");
  if (projectsIdx === -1 || segments[projectsIdx + 1] !== projectId) return null;
  const tab = segments[projectsIdx + 2];
  if (tab === "overview") return "overview";
  if (tab === "targets") return "targets";
  if (tab === "configuration") return "configuration";
  if (tab === "budget") return "budget";
  if (tab === "issues") return "list";
  if (tab === "legacy-work") return "list";
  if (tab === "plugin-operations") return "plugin-operations";
  if (tab === "workspaces") return "workspaces";
  return null;
}

/* ── Overview tab content ── */

function OverviewContent({
  project,
  onUpdate,
  imageUploadHandler,
}: {
  project: { description: string | null; status: string; targetDate: string | null };
  onUpdate: (data: Record<string, unknown>) => void;
  imageUploadHandler?: (file: File) => Promise<string>;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <InlineEditor
        value={project.description ?? ""}
        onSave={(description) => onUpdate({ description })}
        nullable
        as="p"
        className="text-sm text-muted-foreground"
        placeholder={t("projects.detail.addDescription")}
        multiline
        imageUploadHandler={imageUploadHandler}
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">{t("projects.detail.status")}</span>
          <div className="mt-1">
            <StatusBadge status={project.status} />
          </div>
        </div>
        {project.targetDate && (
          <div>
            <span className="text-muted-foreground">{t("projects.detail.targetDate")}</span>
            <p>{formatDate(project.targetDate)}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Combined icon + color picker popover (PAP-72 / PAP-68 part 4) ── */

const DEFAULT_PROJECT_ICON = "folder";

function ProjectTilePicker({
  color,
  icon,
  onSelectIcon,
  onSelectColor,
}: {
  color: string | null;
  icon: string | null;
  onSelectIcon: (icon: string) => void;
  onSelectColor: (color: string | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filteredIcons = useMemo(() => {
    const entries = PROJECT_ICON_NAMES.map((name) => [name, PROJECT_ICONS[name]] as const);
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter(([name]) => name.includes(q));
  }, [search]);

  // Keep the popover open across selections so the user can pick both an icon
  // and a color in one pass; reset the search when it closes.
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSearch("");
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded-lg cursor-pointer hover:ring-2 hover:ring-foreground/20 transition-(--tp-box-shadow)"
          aria-label={t("projects.detail.changeAppearance")}
        >
          <ProjectTile color={color} icon={icon} size="md" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        {/* Icon search + grid */}
        <p className="text-xs font-medium text-muted-foreground mb-2">{t("projects.detail.icon")}</p>
        <Input
          placeholder={t("projects.detail.searchIcons")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mb-2 h-8 text-sm"
          autoFocus
        />
        <div className="grid grid-cols-7 gap-1 max-h-40 overflow-y-auto">
          {filteredIcons.map(([name, Icon]) => (
            <button
              key={name}
              type="button"
              onClick={() => onSelectIcon(name)}
              className={cn(
                "flex items-center justify-center h-8 w-8 rounded hover:bg-accent transition-colors",
                (icon ?? DEFAULT_PROJECT_ICON) === name && "bg-accent ring-1 ring-primary",
              )}
              title={name}
            >
              <Icon className="h-4 w-4" />
            </button>
          ))}
          {filteredIcons.length === 0 && (
            <p className="col-span-7 text-xs text-muted-foreground text-center py-2">{t("projects.detail.noIconsMatch")}</p>
          )}
        </div>

        {/* Color swatches */}
        <div className="mt-3 border-t border-border pt-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">{t("projects.detail.color")}</p>
          <div className="grid grid-cols-5 gap-1.5">
            {/* Neutral / reset-to-gray option */}
            <button
              type="button"
              onClick={() => onSelectColor(null)}
              className={`h-6 w-6 cursor-pointer transition-(--tp-transform-box-shadow) duration-150 hover:scale-110 ${
                color === null
                  ? "ring-2 ring-foreground ring-offset-1 ring-offset-background rounded-md"
                  : ""
              }`}
              aria-label={t("projects.detail.resetColor")}
              title={t("projects.detail.neutralColor")}
            >
              <ProjectTile color={null} size="sm" />
            </button>
            {PROJECT_COLORS.map((swatch) => (
              <button
                key={swatch}
                type="button"
                onClick={() => onSelectColor(swatch)}
                className={`h-6 w-6 rounded-md cursor-pointer transition-(--tp-transform-box-shadow) duration-150 hover:scale-110 ${
                  swatch === color
                    ? "ring-2 ring-foreground ring-offset-1 ring-offset-background"
                    : "hover:ring-2 hover:ring-foreground/30"
                }`}
                style={{ backgroundColor: swatch }}
                aria-label={t("projects.detail.selectColor", { color: swatch })}
              />
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/* ── List (issues) tab content ── */

function ProjectIssuesList({ projectId, companyId }: { projectId: string; companyId: string }) {
  const queryClient = useQueryClient();

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });

  const liveRunsQueryKey = queryKeys.liveRuns(companyId);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!companyId,
    // Event-sourced via LiveUpdatesProvider (issue 9627); no interval poll needed.
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
  });

  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, projectId),
    queryFn: () => issuesApi.list(companyId, { projectId }),
    enabled: !!companyId,
  });
  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns, issues), [issues, liveRuns]);

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveIssueIds={liveIssueIds}
      projectId={projectId}
      viewStateKey="paperclip:project-issues-view"
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}

function ProjectPluginOperationsList({
  projectId,
  companyId,
  pluginKey,
}: {
  projectId: string;
  companyId: string;
  pluginKey: string;
}) {
  const queryClient = useQueryClient();
  const originKindPrefix = `plugin:${pluginKey}`;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: !!companyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId),
    queryFn: () => projectsApi.list(companyId),
    enabled: !!companyId,
  });
  const liveRunsQueryKey = queryKeys.liveRuns(companyId);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!companyId,
    // Event-sourced via LiveUpdatesProvider (issue 9627); no interval poll needed.
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);
  const { data: issues, isLoading, error } = useQuery({
    queryKey: queryKeys.issues.listPluginOperationsByProject(companyId, projectId, originKindPrefix),
    queryFn: () => issuesApi.list(companyId, { projectId, originKindPrefix }),
    enabled: !!companyId && !!projectId,
  });
  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns, issues), [issues, liveRuns]);

  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listPluginOperationsByProject(companyId, projectId, originKindPrefix) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listByProject(companyId, projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
    },
  });

  return (
    <IssuesList
      issues={issues ?? []}
      isLoading={isLoading}
      error={error as Error | null}
      agents={agents}
      projects={projects}
      liveIssueIds={liveIssueIds}
      projectId={projectId}
      viewStateKey={`paperclip:project-plugin-operations-view:${pluginKey}`}
      onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
    />
  );
}

/* ── Main project page ── */

export function ProjectDetail() {
  const { t } = useTranslation();
  const { companyPrefix, projectId, filter } = useParams<{
    companyPrefix?: string;
    projectId: string;
    filter?: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { closePanel } = usePanel();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { openNewTarget } = useDialogActions();
  const location = useLocation();
  const [fieldSaveStates, setFieldSaveStates] = useState<Partial<Record<ProjectConfigFieldKey, ProjectFieldSaveState>>>({});
  const [dismissedLeftProjectIds, setDismissedLeftProjectIds] = useState<Set<string>>(() => new Set());
  const fieldSaveRequestIds = useRef<Partial<Record<ProjectConfigFieldKey, number>>>({});
  const fieldSaveTimers = useRef<Partial<Record<ProjectConfigFieldKey, ReturnType<typeof setTimeout>>>>({});
  const routeProjectRef = projectId ?? "";
  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);
  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchProject = routeProjectRef.length > 0 && (isUuidLike(routeProjectRef) || Boolean(lookupCompanyId));
  const activeRouteTab = routeProjectRef ? resolveProjectTab(location.pathname, routeProjectRef) : null;
  const pluginTabFromSearch = useMemo(() => {
    const tab = new URLSearchParams(location.search).get("tab");
    return isProjectPluginTab(tab) ? tab : null;
  }, [location.search]);
  const activeTab = activeRouteTab ?? pluginTabFromSearch;

  const { data: project, isLoading, error } = useQuery({
    queryKey: [...queryKeys.projects.detail(routeProjectRef), lookupCompanyId ?? null],
    queryFn: () => projectsApi.get(routeProjectRef, lookupCompanyId),
    enabled: canFetchProject,
  });
  const canonicalProjectRef = project ? projectRouteRef(project) : routeProjectRef;
  const projectLookupRef = project?.id ?? routeProjectRef;
  const resolvedCompanyId = project?.companyId ?? selectedCompanyId;
  const verrailNavigationEnabled = isVerrailNavigationEnabled(
    companies.find((company) => company.id === resolvedCompanyId),
  );
  const membershipsQuery = useResourceMemberships(resolvedCompanyId);
  const membershipMutation = useResourceMembershipMutation(resolvedCompanyId);
  const projectMembershipState = project?.id
    ? resourceMembershipState(membershipsQuery.data, "project", project.id)
    : "joined";
  const experimentalSettingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const {
    slots: pluginDetailSlots,
    isLoading: pluginDetailSlotsLoading,
  } = usePluginSlots({
    slotTypes: ["detailTab"],
    entityType: "project",
    companyId: resolvedCompanyId,
    enabled: !!resolvedCompanyId,
  });
  const pluginTabItems = useMemo(
    () => pluginDetailSlots.map((slot) => ({
      value: `plugin:${slot.pluginKey}:${slot.id}` as ProjectPluginTab,
      label: slot.displayName,
      slot,
    })),
    [pluginDetailSlots],
  );
  const activePluginTab = pluginTabItems.find((item) => item.value === activeTab) ?? null;
  // The slots query is disabled until the project's company resolves, and a
  // disabled query reports isLoading=false — so "not loading" alone cannot
  // distinguish "contribution unavailable" from "not asked yet" on cold loads.
  const pluginTabDecisionLoaded = Boolean(resolvedCompanyId) && !pluginDetailSlotsLoading;
  const isolatedWorkspacesEnabled = experimentalSettingsQuery.data?.enableIsolatedWorkspaces === true;
  const workspaceTabProjectId = project?.id ?? null;
  const { data: workspaceTabIssues = [], isLoading: isWorkspaceTabIssuesLoading, error: workspaceTabIssuesError } = useQuery({
    queryKey: workspaceTabProjectId && resolvedCompanyId
      ? queryKeys.issues.listByProject(resolvedCompanyId, workspaceTabProjectId)
      : ["issues", "__workspace-tab__", "disabled"],
    queryFn: () => issuesApi.list(resolvedCompanyId!, { projectId: workspaceTabProjectId! }),
    enabled: Boolean(resolvedCompanyId && workspaceTabProjectId && isolatedWorkspacesEnabled),
  });
  const {
    data: workspaceTabExecutionWorkspaces = [],
    isLoading: isWorkspaceTabExecutionWorkspacesLoading,
    error: workspaceTabExecutionWorkspacesError,
  } = useQuery({
    queryKey: workspaceTabProjectId && resolvedCompanyId
      ? queryKeys.executionWorkspaces.list(resolvedCompanyId, { projectId: workspaceTabProjectId })
      : ["execution-workspaces", "__workspace-tab__", "disabled"],
    queryFn: () => executionWorkspacesApi.list(resolvedCompanyId!, { projectId: workspaceTabProjectId! }),
    enabled: Boolean(resolvedCompanyId && workspaceTabProjectId && isolatedWorkspacesEnabled),
  });
  const workspaceSummaries = useMemo(() => {
    if (!project || !isolatedWorkspacesEnabled) return [];
    return buildProjectWorkspaceSummaries({
      project,
      issues: workspaceTabIssues,
      executionWorkspaces: workspaceTabExecutionWorkspaces,
    });
  }, [project, isolatedWorkspacesEnabled, workspaceTabIssues, workspaceTabExecutionWorkspaces]);
  const showWorkspacesTab = isolatedWorkspacesEnabled && workspaceSummaries.length > 0;
  const workspaceTabDecisionLoaded =
    experimentalSettingsQuery.isFetched &&
    (!isolatedWorkspacesEnabled || (!isWorkspaceTabIssuesLoading && !isWorkspaceTabExecutionWorkspacesLoading));
  const workspaceTabError = (workspaceTabIssuesError ?? workspaceTabExecutionWorkspacesError) as Error | null;

  useEffect(() => {
    if (!project?.companyId || project.companyId === selectedCompanyId) return;
    setSelectedCompanyId(project.companyId, { source: "route_sync" });
  }, [project?.companyId, selectedCompanyId, setSelectedCompanyId]);

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
    if (resolvedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(resolvedCompanyId) });
    }
  };

  const updateProject = useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId),
    onSuccess: invalidateProject,
  });

  const archiveProject = useMutation({
    mutationFn: (archived: boolean) =>
      projectsApi.update(
        projectLookupRef,
        { archivedAt: archived ? new Date().toISOString() : null },
        resolvedCompanyId ?? lookupCompanyId,
      ),
    onSuccess: (updatedProject, archived) => {
      invalidateProject();
      const name = updatedProject?.name ?? project?.name ?? t("projects.detail.project");
      if (archived) {
        pushToast({ title: t("projects.detail.archived", { name }), tone: "success" });
        navigate("/dashboard");
      } else {
        pushToast({ title: t("projects.detail.unarchived", { name }), tone: "success" });
      }
    },
    onError: (_, archived) => {
      pushToast({
        title: archived ? t("projects.detail.archiveFailed") : t("projects.detail.unarchiveFailed"),
        tone: "error",
      });
    },
  });

  const uploadImage = useMutation({
    mutationFn: async (file: File) => {
      if (!resolvedCompanyId) throw new Error(t("projects.selectCompany"));
      return assetsApi.uploadImage(resolvedCompanyId, file, `projects/${projectLookupRef || "draft"}`);
    },
  });

  const { data: budgetOverview } = useQuery({
    queryKey: queryKeys.budgets.overview(resolvedCompanyId ?? "__none__"),
    queryFn: () => budgetsApi.overview(resolvedCompanyId!),
    enabled: !!resolvedCompanyId,
    refetchInterval: 30_000,
    staleTime: 5_000,
  });

  useEffect(() => {
    const section = activeTab === "targets"
      ? t("projects.detail.tabs.targets")
      : activeTab === "list" && verrailNavigationEnabled
        ? t("projects.detail.tabs.legacyWork")
        : null;
    const breadcrumbs = [
      { label: t("projects.title"), href: "/projects" },
      {
        label: project?.name ?? routeProjectRef ?? t("projects.detail.project"),
        ...(section ? { href: `/projects/${canonicalProjectRef}/overview` } : {}),
      },
    ];
    if (section) breadcrumbs.push({ label: section });
    setBreadcrumbs(breadcrumbs);
  }, [activeTab, canonicalProjectRef, project, routeProjectRef, setBreadcrumbs, t, verrailNavigationEnabled]);

  useEffect(() => {
    if (!project) return;
    if (routeProjectRef === canonicalProjectRef) return;
    if (isProjectPluginTab(activeTab)) {
      navigate(`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(activeTab)}`, { replace: true });
      return;
    }
    if (activeTab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`, { replace: true });
      return;
    }
    if (activeTab === "targets") {
      navigate(`/projects/${canonicalProjectRef}/targets`, { replace: true });
      return;
    }
    if (activeTab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`, { replace: true });
      return;
    }
    if (activeTab === "budget") {
      navigate(`/projects/${canonicalProjectRef}/budget`, { replace: true });
      return;
    }
    if (activeTab === "plugin-operations") {
      navigate(`/projects/${canonicalProjectRef}/plugin-operations`, { replace: true });
      return;
    }
    if (activeTab === "workspaces") {
      navigate(`/projects/${canonicalProjectRef}/workspaces`, { replace: true });
      return;
    }
    if (activeTab === "list") {
      if (filter) {
        navigate(`/projects/${canonicalProjectRef}/issues/${filter}`, { replace: true });
        return;
      }
      navigate(`/projects/${canonicalProjectRef}/${verrailNavigationEnabled ? "legacy-work" : "issues"}`, { replace: true });
      return;
    }
    navigate(`/projects/${canonicalProjectRef}`, { replace: true });
  }, [project, routeProjectRef, canonicalProjectRef, activeTab, filter, navigate, verrailNavigationEnabled]);

  useEffect(() => {
    closePanel();
    return () => closePanel();
  }, [closePanel]);

  useEffect(() => {
    if (!project?.id || projectMembershipState !== "joined") return;
    setDismissedLeftProjectIds((current) => {
      if (!current.has(project.id)) return current;
      const next = new Set(current);
      next.delete(project.id);
      return next;
    });
  }, [project?.id, projectMembershipState]);

  useEffect(() => {
    return () => {
      Object.values(fieldSaveTimers.current).forEach((timer) => {
        if (timer) clearTimeout(timer);
      });
    };
  }, []);

  const setFieldState = useCallback((field: ProjectConfigFieldKey, state: ProjectFieldSaveState) => {
    setFieldSaveStates((current) => ({ ...current, [field]: state }));
  }, []);

  const scheduleFieldReset = useCallback((field: ProjectConfigFieldKey, delayMs: number) => {
    const existing = fieldSaveTimers.current[field];
    if (existing) clearTimeout(existing);
    fieldSaveTimers.current[field] = setTimeout(() => {
      setFieldSaveStates((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
      delete fieldSaveTimers.current[field];
    }, delayMs);
  }, []);

  const updateProjectField = useCallback(async (field: ProjectConfigFieldKey, data: Record<string, unknown>) => {
    const requestId = (fieldSaveRequestIds.current[field] ?? 0) + 1;
    fieldSaveRequestIds.current[field] = requestId;
    setFieldState(field, "saving");
    try {
      await projectsApi.update(projectLookupRef, data, resolvedCompanyId ?? lookupCompanyId);
      invalidateProject();
      if (fieldSaveRequestIds.current[field] !== requestId) return;
      setFieldState(field, "saved");
      scheduleFieldReset(field, 1800);
    } catch (error) {
      if (fieldSaveRequestIds.current[field] !== requestId) return;
      setFieldState(field, "error");
      scheduleFieldReset(field, 3000);
      throw error;
    }
  }, [invalidateProject, lookupCompanyId, projectLookupRef, resolvedCompanyId, scheduleFieldReset, setFieldState]);

  const projectBudgetSummary = useMemo(() => {
    const matched = budgetOverview?.policies.find(
      (policy) => policy.scopeType === "project" && policy.scopeId === (project?.id ?? routeProjectRef),
    );
    if (matched) return matched;
    return {
      policyId: "",
      companyId: resolvedCompanyId ?? "",
      scopeType: "project",
      scopeId: project?.id ?? routeProjectRef,
      scopeName: project?.name ?? t("projects.detail.project"),
      metric: "billed_cents",
      windowKind: "lifetime",
      amount: 0,
      observedAmount: 0,
      remainingAmount: 0,
      utilizationPercent: 0,
      warnPercent: 80,
      hardStopEnabled: true,
      notifyEnabled: true,
      isActive: false,
      status: "ok",
      paused: Boolean(project?.pausedAt),
      pauseReason: project?.pauseReason ?? null,
      windowStart: new Date(),
      windowEnd: new Date(),
    } satisfies BudgetPolicySummary;
  }, [budgetOverview?.policies, project, resolvedCompanyId, routeProjectRef, t]);

  const budgetMutation = useMutation({
    mutationFn: (amount: number) =>
      budgetsApi.upsertPolicy(resolvedCompanyId!, {
        scopeType: "project",
        scopeId: project?.id ?? routeProjectRef,
        amount,
        windowKind: "lifetime",
      }),
    onSuccess: () => {
      if (!resolvedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.budgets.overview(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(routeProjectRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(projectLookupRef) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(resolvedCompanyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.dashboard(resolvedCompanyId) });
    },
  });

  if (pluginTabFromSearch && !activePluginTab && !error) {
    if (!pluginTabDecisionLoaded) {
      return <PageSkeleton variant="detail" />;
    }
    return <Navigate to={`/projects/${canonicalProjectRef}/${verrailNavigationEnabled ? "overview" : "issues"}`} replace />;
  }

  if (activeTab === "workspaces" && workspaceTabDecisionLoaded && !showWorkspacesTab) {
    return <Navigate to={`/projects/${canonicalProjectRef}/${verrailNavigationEnabled ? "overview" : "issues"}`} replace />;
  }

  // Verrail always opens the Project overview; classic mode preserves its cached tab behavior.
  if (routeProjectRef && activeTab === null) {
    if (verrailNavigationEnabled) {
      return <Navigate to={`/projects/${canonicalProjectRef}/overview`} replace />;
    }
    let cachedTab: string | null = null;
    if (project?.id) {
      try { cachedTab = localStorage.getItem(`paperclip:project-tab:${project.id}`); } catch {}
    }
    if (cachedTab === "overview") {
      return <Navigate to={`/projects/${canonicalProjectRef}/overview`} replace />;
    }
    if (cachedTab === "configuration") {
      return <Navigate to={`/projects/${canonicalProjectRef}/configuration`} replace />;
    }
    if (cachedTab === "budget") {
      return <Navigate to={`/projects/${canonicalProjectRef}/budget`} replace />;
    }
    if (cachedTab === "plugin-operations" && project?.managedByPlugin) {
      return <Navigate to={`/projects/${canonicalProjectRef}/plugin-operations`} replace />;
    }
    if (cachedTab === "workspaces" && workspaceTabDecisionLoaded && showWorkspacesTab) {
      return <Navigate to={`/projects/${canonicalProjectRef}/workspaces`} replace />;
    }
    if (cachedTab === "workspaces" && !workspaceTabDecisionLoaded) {
      return <PageSkeleton variant="detail" />;
    }
    if (isProjectPluginTab(cachedTab)) {
      return <Navigate to={`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(cachedTab)}`} replace />;
    }
    return <Navigate to={`/projects/${canonicalProjectRef}/issues`} replace />;
  }

  if (isLoading) return <PageSkeleton variant="detail" />;
  if (error) return <p className="text-sm text-destructive">{error.message}</p>;
  if (!project) return null;
  const showLeftProjectNotice =
    projectMembershipState === "left" && !dismissedLeftProjectIds.has(project.id);
  const projectMembershipPending =
    membershipMutation.isPending &&
    membershipMutation.variables?.resourceType === "project" &&
    membershipMutation.variables.resourceId === project.id;
  const projectStarred = isStarred(membershipsQuery.data, "project", project.id);
  const projectStarPending = projectMembershipPending && membershipMutation.variables?.starred !== undefined;
  const projectJoinLeavePending = projectMembershipPending && membershipMutation.variables?.starred === undefined;

  const handleTabChange = (tab: ProjectTab) => {
    // Cache the active tab per project
    if (project?.id) {
      try { localStorage.setItem(`paperclip:project-tab:${project.id}`, tab); } catch {}
    }
    if (isProjectPluginTab(tab)) {
      navigate(`/projects/${canonicalProjectRef}?tab=${encodeURIComponent(tab)}`);
      return;
    }
    if (tab === "overview") {
      navigate(`/projects/${canonicalProjectRef}/overview`);
    } else if (tab === "targets") {
      navigate(`/projects/${canonicalProjectRef}/targets`);
    } else if (tab === "workspaces") {
      navigate(`/projects/${canonicalProjectRef}/workspaces`);
    } else if (tab === "budget") {
      navigate(`/projects/${canonicalProjectRef}/budget`);
    } else if (tab === "plugin-operations") {
      navigate(`/projects/${canonicalProjectRef}/plugin-operations`);
    } else if (tab === "configuration") {
      navigate(`/projects/${canonicalProjectRef}/configuration`);
    } else {
      navigate(`/projects/${canonicalProjectRef}/${verrailNavigationEnabled ? "legacy-work" : "issues"}`);
    }
  };

  return (
    <div className="space-y-6">
      {showLeftProjectNotice ? (
        <div className="flex items-center gap-3 border border-yellow-300/35 bg-yellow-300/10 px-3 py-2 text-sm text-yellow-900 dark:text-yellow-100">
          <p className="min-w-0 flex-1">
            {t("projects.detail.leftNotice")}
          </p>
          <MembershipAction
            compact
            state="left"
            pending={projectJoinLeavePending}
            pendingState={projectJoinLeavePending ? membershipMutation.variables?.state : null}
            resourceName={project.name}
            onJoin={() => membershipMutation.mutate({
              resourceType: "project",
              resourceId: project.id,
              resourceName: project.name,
              state: "joined",
            })}
            onLeave={() => membershipMutation.mutate({
              resourceType: "project",
              resourceId: project.id,
              resourceName: project.name,
              state: "left",
            })}
          />
          <button
            type="button"
            className="h-6 w-6 shrink-0 text-yellow-900/70 hover:text-yellow-900 dark:text-yellow-100/70 dark:hover:text-yellow-100"
            aria-label={t("projects.detail.dismissMembershipNotice")}
            onClick={() => setDismissedLeftProjectIds((current) => new Set(current).add(project.id))}
          >
            ×
          </button>
        </div>
      ) : null}
      <div className="flex items-start gap-3">
        <div className="h-7 flex items-center">
          <ProjectTilePicker
            color={project.color ?? null}
            icon={project.icon ?? null}
            onSelectIcon={(icon) => updateProject.mutate({ icon })}
            onSelectColor={(color) => updateProject.mutate({ color })}
          />
        </div>
        <div className="min-w-0 space-y-2">
          <InlineEditor
            value={project.name}
            onSave={(name) => updateProject.mutate({ name })}
            as="h2"
            className="text-xl font-bold"
          />
          {project.pauseReason === "budget" ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-red-500/30 bg-red-500/10 px-3 py-1 text-(length:--text-micro) font-medium uppercase tracking-(--tracking-caps) text-red-800 dark:text-red-200">
              <span className="h-2 w-2 rounded-full bg-red-400" />
              {t("projects.detail.pausedByBudget")}
            </div>
          ) : null}
          {project.managedByPlugin ? (
            <div className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1 text-(length:--text-micro) font-medium text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: project.color ?? "var(--project-seed)" }} />
              {t("projects.detail.managedBy", { name: project.managedByPlugin.pluginDisplayName })}
            </div>
          ) : null}
        </div>
        <div className="ml-auto flex items-center gap-2">
          {verrailNavigationEnabled ? (
            <Button variant="default" size="sm" onClick={() => openNewTarget({ projectId: project.id })}>
              <Target className="h-4 w-4" />
              {t("targets.create.submit")}
            </Button>
          ) : null}
          <StarToggle
            size="button"
            starred={projectStarred}
            pending={projectStarPending}
            resourceName={project.name}
            onToggle={(next) => membershipMutation.mutate({
              resourceType: "project",
              resourceId: project.id,
              resourceName: project.name,
              starred: next,
            })}
          />
        </div>
      </div>

      <SummarySlotCard
        companyId={resolvedCompanyId}
        scopeKind="project"
        scopeId={project.id}
        title={t("projects.detail.summaryTitle")}
        description={t("projects.detail.summaryDescription")}
      />

      <PluginSlotOutlet
        slotTypes={["toolbarButton", "contextMenuItem"]}
        entityType="project"
        context={{
          companyId: resolvedCompanyId ?? null,
          companyPrefix: companyPrefix ?? null,
          projectId: project.id,
          projectRef: canonicalProjectRef,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
        missingBehavior="placeholder"
      />

      <PluginLauncherOutlet
        placementZones={["toolbarButton"]}
        entityType="project"
        context={{
          companyId: resolvedCompanyId ?? null,
          companyPrefix: companyPrefix ?? null,
          projectId: project.id,
          projectRef: canonicalProjectRef,
          entityId: project.id,
          entityType: "project",
        }}
        className="flex flex-wrap gap-2"
        itemClassName="inline-flex"
      />

      <Tabs value={activeTab ?? (verrailNavigationEnabled ? "overview" : "list")} onValueChange={(value) => handleTabChange(value as ProjectTab)}>
        <PageTabBar
          items={verrailNavigationEnabled
            ? [
                { value: "overview", label: t("projects.detail.tabs.overview") },
                { value: "targets", label: t("projects.detail.tabs.targets") },
                ...(project.managedByPlugin ? [{ value: "plugin-operations", label: t("projects.detail.tabs.pluginOperations") }] : []),
                ...(showWorkspacesTab ? [{ value: "workspaces", label: t("projects.detail.tabs.resources") }] : []),
                { value: "configuration", label: t("projects.detail.tabs.settings") },
                { value: "budget", label: t("projects.detail.tabs.budget") },
                { value: "list", label: t("projects.detail.tabs.legacyWork") },
                ...pluginTabItems.map((item) => ({ value: item.value, label: item.label })),
              ]
            : [
                { value: "list", label: t("projects.detail.tabs.tasks") },
                { value: "overview", label: t("projects.detail.tabs.overview") },
                ...(project.managedByPlugin ? [{ value: "plugin-operations", label: t("projects.detail.tabs.pluginOperations") }] : []),
                ...(showWorkspacesTab ? [{ value: "workspaces", label: t("projects.detail.tabs.workspaces") }] : []),
                { value: "configuration", label: t("projects.detail.tabs.configuration") },
                { value: "budget", label: t("projects.detail.tabs.budget") },
                ...pluginTabItems.map((item) => ({ value: item.value, label: item.label })),
              ]}
          align="start"
          value={activeTab ?? (verrailNavigationEnabled ? "overview" : "list")}
          onValueChange={(value) => handleTabChange(value as ProjectTab)}
        />
      </Tabs>

      {activeTab === "overview" && (
        <div className="space-y-8">
          <OverviewContent
            project={project}
            onUpdate={(data) => updateProject.mutate(data)}
            imageUploadHandler={async (file) => {
              const asset = await uploadImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
          {verrailNavigationEnabled && resolvedCompanyId ? (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-sm font-semibold">{t("projects.detail.recentTargets")}</h3>
                <Button asChild variant="ghost" size="sm">
                  <Link to={`/projects/${canonicalProjectRef}/targets`}>{t("projects.detail.viewAllTargets")}</Link>
                </Button>
              </div>
              <TargetList workspaceId={resolvedCompanyId} projectId={project.id} limit={5} />
            </section>
          ) : null}
        </div>
      )}

      {activeTab === "targets" && resolvedCompanyId ? (
        <TargetList workspaceId={resolvedCompanyId} projectId={project.id} />
      ) : null}

      {activeTab === "list" && project?.id && resolvedCompanyId && (
        <div className="space-y-4">
          {verrailNavigationEnabled ? (
            <div className="border-y border-border py-4">
              <p className="text-sm font-medium">{t("projects.detail.legacyWorkTitle")}</p>
              <p className="mt-1 max-w-3xl text-xs text-muted-foreground">
                {t("projects.detail.legacyWorkDescription")}
              </p>
            </div>
          ) : null}
          <ProjectIssuesList projectId={project.id} companyId={resolvedCompanyId} />
        </div>
      )}

      {activeTab === "plugin-operations" && project?.id && resolvedCompanyId && project.managedByPlugin && (
        <ProjectPluginOperationsList
          projectId={project.id}
          companyId={resolvedCompanyId}
          pluginKey={project.managedByPlugin.pluginKey}
        />
      )}

      {activeTab === "workspaces" ? (
        workspaceTabDecisionLoaded ? (
          workspaceTabError ? (
            <p className="text-sm text-destructive">{workspaceTabError.message}</p>
          ) : (
            <ProjectWorkspacesContent
              companyId={resolvedCompanyId!}
              projectId={project.id}
              projectRef={canonicalProjectRef}
              summaries={workspaceSummaries}
            />
          )
        ) : (
          <p className="text-sm text-muted-foreground">{t("projects.detail.loadingWorkspaces")}</p>
        )
      ) : null}

      {activeTab === "configuration" && (
        <div className="max-w-4xl">
          <ProjectProperties
            project={project}
            onUpdate={(data) => updateProject.mutate(data)}
            onFieldUpdate={updateProjectField}
            getFieldSaveState={(field) => fieldSaveStates[field] ?? "idle"}
            onArchive={(archived) => archiveProject.mutate(archived)}
            archivePending={archiveProject.isPending}
          />
        </div>
      )}

      {activeTab === "budget" && resolvedCompanyId ? (
        <div className="max-w-3xl">
          <BudgetPolicyCard
            summary={projectBudgetSummary}
            variant="plain"
            isSaving={budgetMutation.isPending}
            onSave={(amount) => budgetMutation.mutate(amount)}
          />
        </div>
      ) : null}

      {activePluginTab && (
        <PluginSlotMount
          slot={activePluginTab.slot}
          context={{
            companyId: resolvedCompanyId,
            companyPrefix: companyPrefix ?? null,
            projectId: project.id,
            projectRef: canonicalProjectRef,
            entityId: project.id,
            entityType: "project",
          }}
          missingBehavior="placeholder"
        />
      )}
    </div>
  );
}
