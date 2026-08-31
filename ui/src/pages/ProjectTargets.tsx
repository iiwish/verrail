import { useEffect } from "react";
import { useParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { TargetList } from "../components/TargetList";
import { useTranslation } from "@/i18n";

export function ProjectTargetsPanel({ projectId }: { projectId: string }) {
  const { selectedCompanyId } = useCompany();
  if (!selectedCompanyId) return null;
  return <TargetList workspaceId={selectedCompanyId} projectId={projectId} />;
}

export function ProjectTargets() {
  const { projectId } = useParams<{ projectId: string }>();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();

  useEffect(() => {
    setBreadcrumbs([
      { label: t("nav.projects"), href: "/projects" },
      { label: t("targets.title") },
    ]);
  }, [setBreadcrumbs, t]);

  if (!selectedCompanyId || !projectId) return null;
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header>
        <h2 className="text-xl font-semibold">{t("targets.title")}</h2>
      </header>
      <TargetList workspaceId={selectedCompanyId} projectId={projectId} />
    </div>
  );
}
