import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, Plus, Target } from "lucide-react";
import { Link, useParams } from "@/lib/router";
import { targetsApi } from "../api/targets";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions } from "../context/DialogContext";
import { useSidebar } from "../context/SidebarContext";
import { useTranslation } from "../i18n";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "./ui/button";
import { SidebarNavItem } from "./SidebarNavItem";

export function VerrailTargetsSidebar() {
  const { t } = useTranslation();
  const { targetId } = useParams<{ targetId?: string }>();
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { openNewTarget } = useDialogActions();
  const { isMobile, setSidebarOpen } = useSidebar();
  const targetsQuery = useQuery({
    queryKey: queryKeys.targets.list(selectedCompanyId ?? "__none__", undefined, { limit: 50 }),
    queryFn: () => targetsApi.list(selectedCompanyId!, { limit: 50 }),
    enabled: Boolean(selectedCompanyId),
  });

  const closeMobileSidebar = () => {
    if (isMobile) setSidebarOpen(false);
  };

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col border-r border-border bg-background"
      data-testid="verrail-targets-sidebar"
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
            to="/targets"
            onClick={closeMobileSidebar}
            aria-current={!targetId ? "page" : undefined}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-semibold text-foreground transition-colors hover:bg-accent/50"
          >
            <Target className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{t("nav.targets")}</span>
          </Link>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => {
              openNewTarget();
              closeMobileSidebar();
            }}
            aria-label={t("targets.create.submit")}
            title={t("targets.create.submit")}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-2 scrollbar-auto-hide" aria-label={t("nav.targets")}>
        {targetsQuery.isLoading ? (
          <p className="px-2 py-1 text-xs text-muted-foreground">{t("targets.loading")}</p>
        ) : targetsQuery.error ? (
          <p className="px-2 py-1 text-xs text-destructive">{t("targets.loadFailed")}</p>
        ) : targetsQuery.data?.items.length ? (
          <div className="flex flex-col gap-0.5">
            {targetsQuery.data.items.map((target) => (
              <SidebarNavItem
                key={target.targetId}
                to={`/targets/${target.targetId}/overview`}
                label={target.title}
                icon={Target}
                active={targetId === target.targetId}
                alert={target.attentionSummary.total > 0}
              />
            ))}
          </div>
        ) : (
          <p className="px-2 py-1 text-xs text-muted-foreground">{t("targets.empty")}</p>
        )}
      </nav>
    </aside>
  );
}
