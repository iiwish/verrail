import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  FolderKanban,
  Plus,
} from "lucide-react";
import type { Project } from "@paperclipai/shared";
import { Link, useParams } from "@/lib/router";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { resourceMembershipState, useResourceMemberships } from "../hooks/useResourceMemberships";
import { useTranslation } from "../i18n";
import { queryKeys } from "../lib/queryKeys";
import { cn, projectRouteRef } from "../lib/utils";
import { Button } from "./ui/button";
import { ProjectTile } from "./ProjectTile";
import { SidebarNavItem } from "./SidebarNavItem";

function projectNameOrder(left: Project, right: Project) {
  return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
}

export function VerrailProjectsSidebar() {
  const { t } = useTranslation();
  const { projectId: routeProjectRef } = useParams<{ projectId?: string }>();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { openNewProject } = useDialogActions();
  const { isMobile, setSidebarOpen } = useSidebar();
  const membershipsQuery = useResourceMemberships(selectedCompanyId);
  const projectsQuery = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const projectQuery = useQuery({
    queryKey: [...queryKeys.projects.detail(routeProjectRef ?? "__none__"), selectedCompanyId ?? null],
    queryFn: () => projectsApi.get(routeProjectRef!, selectedCompanyId ?? undefined),
    enabled: Boolean(routeProjectRef && selectedCompanyId),
  });
  const activeProject = projectQuery.data ?? null;
  const selectedProjects = useMemo(() => {
    const visible = (projectsQuery.data ?? []).filter((project) => {
      if (!membershipsQuery.isSuccess) return true;
      return resourceMembershipState(membershipsQuery.data, "project", project.id) !== "left";
    });
    if (activeProject && !visible.some((project) => project.id === activeProject.id)) {
      visible.push(activeProject);
    }
    return visible.sort(projectNameOrder);
  }, [activeProject, membershipsQuery.data, membershipsQuery.isSuccess, projectsQuery.data]);

  const closeMobileSidebar = () => {
    if (isMobile) setSidebarOpen(false);
  };

  const createLabel = t("projects.add");
  const handleCreate = () => {
    openNewProject();
    closeMobileSidebar();
  };

  const isProjectSelected = (project: Project) => {
    return activeProject?.id === project.id;
  };

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col border-r border-border bg-background"
      data-testid="verrail-projects-sidebar"
    >
      <div className="flex shrink-0 flex-col gap-1 px-3 py-3">
        <Link
          to="/home"
          onClick={closeMobileSidebar}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate">{selectedCompany?.name ?? t("settings.company.fallbackName")}</span>
        </Link>
        <div className="flex items-center gap-1">
          <Link
            to="/projects"
            onClick={closeMobileSidebar}
            aria-current={!routeProjectRef ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-semibold transition-colors",
              !routeProjectRef
                ? "bg-accent text-foreground"
                : "text-foreground hover:bg-accent/50",
            )}
          >
            <FolderKanban className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{t("nav.projects")}</span>
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={handleCreate}
            aria-label={createLabel}
            title={createLabel}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-2 scrollbar-auto-hide" aria-label={t("nav.projects")}>
        {selectedProjects.length > 0 ? (
          <div className="mt-2 flex flex-col gap-0.5">
            {selectedProjects.map((project) => {
              const selected = isProjectSelected(project);
              const ref = projectRouteRef(project);
              return (
                <div key={project.id}>
                  <SidebarNavItem
                    to={`/projects/${ref}/overview`}
                    label={project.name}
                    iconNode={<ProjectTile color={project.color ?? null} icon={project.icon ?? null} size="xs" />}
                    active={selected}
                    labelClassName={selected ? "font-semibold text-foreground" : undefined}
                  />
                </div>
              );
            })}
          </div>
        ) : null}
      </nav>
    </aside>
  );
}
