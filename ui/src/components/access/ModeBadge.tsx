import type { DeploymentExposure, DeploymentMode } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "@/i18n";

export function ModeBadge({
  deploymentMode,
  deploymentExposure,
}: {
  deploymentMode?: DeploymentMode;
  deploymentExposure?: DeploymentExposure;
}) {
  const { t } = useTranslation();
  if (!deploymentMode) return null;

  const label =
    deploymentMode === "local_trusted"
      ? t("settings.instance.general.deployment.mode.localTrusted")
      : t(`settings.instance.general.deployment.mode.authenticated.${deploymentExposure ?? "private"}`);

  return <Badge variant="outline">{label}</Badge>;
}
