import {
  Bot,
  FolderKanban,
  House,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  ServerCog,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { Link, useLocation } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { PluginSlotOutlet } from "@/plugins/slots";
import { PluginLauncherOutlet } from "@/plugins/launchers";
import { useCompany } from "../context/CompanyContext";
import { useSidebar } from "../context/SidebarContext";
import { useTranslation } from "@/i18n";
import { SidebarCompanyMenu } from "./SidebarCompanyMenu";
import { SidebarNavItem } from "./SidebarNavItem";
import { SidebarSection } from "./SidebarSection";
import { VerrailBrand } from "./VerrailBrand";
import { resolveVerrailManagementSection } from "../lib/verrail-section-navigation";

export function VerrailSidebar() {
  const { t } = useTranslation();
  const { companies, selectedCompanyId, selectedCompany } = useCompany();
  const { isMobile, collapsed, collapseLocked, peeking, toggleCollapsed, setCollapsed } = useSidebar();
  const location = useLocation();
  const rail = collapsed && !peeking;
  const projectsActive = resolveVerrailManagementSection(
    location.pathname,
    selectedCompany?.issuePrefix,
  ) === "projects";
  const pluginContext = {
    companyId: selectedCompanyId,
    companyPrefix: selectedCompany?.issuePrefix ?? null,
  };

  return (
    <aside className="flex h-full min-h-0 w-full flex-col border-r border-border bg-background">
      <div className="flex h-12 shrink-0 items-center gap-2 px-3">
        <Link to="/home" className="flex min-w-0 flex-1 items-center px-2" aria-label={t("nav.home")}>
          <VerrailBrand variant={rail ? "mark" : "lockup"} decorative className="h-5 max-w-full" />
        </Link>
        {!rail && !isMobile && !collapseLocked ? (
          peeking ? (
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-label={t("nav.keepSidebarExpanded")}
              title={t("nav.keepSidebarExpanded")}
              onClick={() => setCollapsed(false)}
            >
              <Pin className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground"
              aria-expanded={!collapsed}
              aria-label={collapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
              title={collapsed ? t("nav.expandSidebar") : t("nav.collapseSidebar")}
              onClick={() => toggleCollapsed()}
            >
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </Button>
          )
        ) : null}
      </div>

      {(companies ?? []).filter((company) => company.status !== "archived").length > 1 ? (
        <div className="shrink-0 px-3 pb-2">
          <SidebarCompanyMenu />
        </div>
      ) : null}

      <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-2 scrollbar-auto-hide pointer-coarse:gap-3">
        <div className="flex flex-col gap-0.5" data-testid="verrail-primary-navigation">
          <SidebarNavItem to="/home" label={t("nav.home")} icon={House} end />
          <SidebarNavItem
            to="/projects"
            label={t("nav.projects")}
            icon={FolderKanban}
            active={projectsActive}
          />
          <SidebarNavItem to="/agents" label={t("nav.agents")} icon={Bot} />
          <SidebarNavItem to="/infrastructure" label={t("nav.infrastructure")} icon={ServerCog} />
          <SidebarNavItem to="/governance" label={t("nav.governance")} icon={ShieldCheck} />
          <SidebarNavItem to="/settings" label={t("nav.settings")} icon={Settings} />
        </div>

        <SidebarSection label={t("settingsNav.plugins")}>
          <PluginSlotOutlet
            slotTypes={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-(length:--text-compact) font-medium"
            missingBehavior="placeholder"
          />
          <PluginLauncherOutlet
            placementZones={["sidebar"]}
            context={pluginContext}
            className="flex flex-col gap-0.5"
            itemClassName="text-(length:--text-compact) font-medium"
          />
        </SidebarSection>
      </nav>
    </aside>
  );
}
