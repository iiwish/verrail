import { useQuery } from "@tanstack/react-query";
import type { TargetReadModelV1 } from "@paperclipai/shared";
import { AlertTriangle, ArrowRight, Target } from "lucide-react";
import { Link } from "@/lib/router";
import { targetsApi } from "../api/targets";
import { queryKeys } from "../lib/queryKeys";
import { relativeTime } from "../lib/utils";
import { useTranslation } from "@/i18n";

function TargetRow({ target }: { target: TargetReadModelV1 }) {
  const { t } = useTranslation();
  return (
    <Link
      to={`/targets/${target.targetId}/overview`}
      className="flex min-h-16 items-center gap-3 border-b border-border py-3 last:border-b-0 hover:bg-accent/30"
    >
      <Target className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{target.title}</span>
          {target.attentionSummary.total > 0 ? (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" aria-label={t("targets.attention")} />
          ) : null}
        </span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {target.currentStage?.label ?? t("targets.unknownStage")} · {t(`targets.statuses.${target.status}`)}
        </span>
      </span>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">
        {relativeTime(target.updatedAt)}
      </span>
      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </Link>
  );
}

export function TargetList({
  workspaceId,
  collectionId,
  limit = 50,
}: {
  workspaceId: string;
  collectionId?: string | null;
  limit?: number;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: queryKeys.targets.list(workspaceId, collectionId, { limit }),
    queryFn: () => collectionId
      ? targetsApi.listForCollection(workspaceId, collectionId, { limit })
      : targetsApi.list(workspaceId, { limit }),
  });

  if (query.isLoading) return <p className="py-8 text-sm text-muted-foreground">{t("targets.loading")}</p>;
  if (query.error) return <p className="py-8 text-sm text-destructive">{t("targets.loadFailed")}</p>;
  if (!query.data?.items.length) {
    return (
      <div className="border-y border-border py-10 text-center">
        <Target className="mx-auto h-5 w-5 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">{t("targets.empty")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("targets.emptyDetail")}</p>
      </div>
    );
  }

  return (
    <div className="border-y border-border">
      {query.data.items.map((target) => <TargetRow key={target.targetId} target={target} />)}
    </div>
  );
}
