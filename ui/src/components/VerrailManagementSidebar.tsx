import {
  Activity,
  Bot,
  ChevronLeft,
  CircleDollarSign,
  Cpu,
  Inbox,
  KeyRound,
  MonitorCog,
  Plus,
  Puzzle,
  Rocket,
  ServerCog,
  ShieldCheck,
} from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { useDialogActions } from "@/context/DialogContext";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { SidebarAgents } from "./SidebarAgents";
import { SidebarNavItem } from "./SidebarNavItem";

type ManagementSidebarProps = {
  section: "agents" | "infrastructure" | "governance";
};

export function VerrailManagementSidebar({ section }: ManagementSidebarProps) {
  const { t } = useTranslation();
  const { selectedCompany } = useCompany();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { openNewAgent } = useDialogActions();
  const agents = section === "agents";
  const infrastructure = section === "infrastructure";
  const SectionIcon = agents ? Bot : infrastructure ? ServerCog : ShieldCheck;
  const title = agents ? t("nav.agents") : infrastructure ? t("nav.infrastructure") : t("nav.governance");
  const sectionPath = agents ? "/agents" : infrastructure ? "/infrastructure" : "/governance";

  const closeMobileSidebar = () => {
    if (isMobile) setSidebarOpen(false);
  };

  return (
    <aside
      className="flex h-full min-h-0 w-full flex-col border-r border-border bg-background"
      data-testid={`verrail-${section}-sidebar`}
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
            to={sectionPath}
            onClick={closeMobileSidebar}
            className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-semibold text-foreground transition-colors hover:bg-accent/50"
          >
            <SectionIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{title}</span>
          </Link>
          {agents ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                openNewAgent();
                closeMobileSidebar();
              }}
              aria-label={t("sidebarAgents.newAgent")}
              title={t("sidebarAgents.newAgent")}
            >
              <Plus className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-3 py-2 scrollbar-auto-hide" aria-label={title}>
        <div className="flex flex-col gap-0.5">
          {agents ? (
            <>
              <SidebarNavItem
                to="/agents/definitions"
                label={t("agentNav.all")}
                icon={Bot}
                end
              />
              <SidebarNavItem
                to="/agents/deployments"
                label={t("agentNav.deployments")}
                icon={Rocket}
                end
              />
              <div className="mt-4">
                <p className="px-4 pb-1 text-xs font-medium text-muted-foreground">{t("agentNav.yours")}</p>
                <SidebarAgents appearance="list" />
              </div>
            </>
          ) : infrastructure ? (
            <>
              <SidebarNavItem
                to="/infrastructure/secrets"
                label={t("settingsNav.secrets")}
                icon={KeyRound}
                end
              />
              <SidebarNavItem
                to="/infrastructure/environments"
                label={t("settingsNav.environments")}
                icon={MonitorCog}
                end
              />
              <SidebarNavItem
                to="/infrastructure/adapters"
                label={t("settingsNav.adapters")}
                icon={Cpu}
                end
              />
              <SidebarNavItem
                to="/infrastructure/plugins"
                label={t("settingsNav.plugins")}
                icon={Puzzle}
              />
            </>
          ) : (
            <>
              <SidebarNavItem
                to="/governance/attention"
                label={t("nav.decisions")}
                icon={Inbox}
              />
              <SidebarNavItem
                to="/governance/approvals"
                label={t("approvals.title")}
                icon={ShieldCheck}
              />
              <SidebarNavItem
                to="/governance/audit"
                label={t("nav.activity")}
                icon={Activity}
                end
              />
              <SidebarNavItem
                to="/governance/costs"
                label={t("nav.costs")}
                icon={CircleDollarSign}
                end
              />
            </>
          )}
        </div>
      </nav>
    </aside>
  );
}
