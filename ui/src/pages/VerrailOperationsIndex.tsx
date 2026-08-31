import { useEffect, type ComponentType } from "react";
import {
  Activity,
  AppWindow,
  ChevronRight,
  CircleDollarSign,
  CircleUserRound,
  FolderKanban,
  Gauge,
  KeyRound,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { Link } from "@/lib/router";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useTranslation } from "@/i18n";

type IndexItem = {
  label: string;
  to: string;
  icon: ComponentType<{ className?: string }>;
};

function OperationsIndex({ title, items }: { title: string; items: IndexItem[] }) {
  const { setBreadcrumbs } = useBreadcrumbs();

  useEffect(() => {
    setBreadcrumbs([{ label: title }]);
  }, [setBreadcrumbs, title]);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <h2 className="text-xl font-semibold">{title}</h2>
      <div className="border-t border-border">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Link key={item.to} to={item.to} className="flex items-center gap-3 border-b border-border py-4 hover:bg-accent/30">
              <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 text-sm font-medium">{item.label}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export function VerrailInfrastructure() {
  const { t } = useTranslation();
  return (
    <OperationsIndex
      title={t("nav.infrastructure")}
      items={[
        { label: t("nav.projects"), to: "/projects", icon: FolderKanban },
        { label: t("settingsNav.environments"), to: "/company/settings/instance/environments", icon: Gauge },
        { label: t("settingsNav.secrets"), to: "/company/settings/secrets", icon: KeyRound },
        { label: t("settingsNav.adapters"), to: "/company/settings/instance/adapters", icon: Settings2 },
        { label: t("settingsNav.plugins"), to: "/company/settings/instance/plugins", icon: AppWindow },
      ]}
    />
  );
}

export function VerrailGovernance() {
  const { t } = useTranslation();
  return (
    <OperationsIndex
      title={t("nav.governance")}
      items={[
        { label: t("nav.decisions"), to: "/decisions", icon: ShieldCheck },
        { label: t("approvals.title"), to: "/approvals", icon: CircleUserRound },
        { label: t("nav.activity"), to: "/activity", icon: Activity },
        { label: t("nav.costs"), to: "/costs", icon: CircleDollarSign },
        { label: t("settingsNav.members"), to: "/company/settings/members", icon: Gauge },
      ]}
    />
  );
}
