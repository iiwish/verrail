import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderKanban, Plus, Target } from "lucide-react";
import { collectionsApi } from "../api/collections";
import { EmptyState } from "../components/EmptyState";
import { EntityRow } from "../components/EntityRow";
import { PageSkeleton } from "../components/PageSkeleton";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useTranslation } from "../i18n";
import { queryKeys } from "../lib/queryKeys";

export function Collections() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  const collectionsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.collections.list(selectedCompanyId)
      : ["collections", "disabled"],
    queryFn: () => collectionsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const createCollection = useMutation({
    mutationFn: () => collectionsApi.create(selectedCompanyId!, {
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
    }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.collections.list(selectedCompanyId!) });
      setName("");
      setDescription("");
      setDialogOpen(false);
    },
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: t("nav.targets"), href: "/targets" },
      { label: t("collections.title") },
    ]);
  }, [setBreadcrumbs, t]);

  if (!selectedCompanyId) {
    return <EmptyState icon={FolderKanban} message={t("collections.selectWorkspace")} />;
  }
  if (collectionsQuery.isLoading) return <PageSkeleton variant="list" />;
  const collections = collectionsQuery.data ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">{t("collections.title")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("collections.description")}</p>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4" />
          {t("collections.create.submit")}
        </Button>
      </div>

      {collectionsQuery.isError ? (
        <p className="text-sm text-destructive">{t("collections.loadFailed")}</p>
      ) : null}
      {!collectionsQuery.isError && collections.length === 0 ? (
        <EmptyState icon={FolderKanban} message={t("collections.empty")} />
      ) : null}
      {collections.length > 0 ? (
        <div className="border-y border-border" data-testid="collection-list">
          {collections.map((collection) => (
            <EntityRow
              key={collection.id}
              to={`/targets?collectionId=${collection.id}`}
              leading={<FolderKanban className="h-4 w-4 text-muted-foreground" />}
              title={collection.name}
              subtitle={collection.description ?? undefined}
              reserveSubtitleSpace
              trailing={(
                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
                  <Target className="h-3.5 w-3.5" />
                  {t("collections.targetCount", { count: collection.targetCount })}
                </span>
              )}
            />
          ))}
        </div>
      ) : null}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("collections.create.title")}</DialogTitle>
            <DialogDescription>{t("collections.create.description")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-2">
              <Label htmlFor="collection-name">{t("collections.create.name")}</Label>
              <Input id="collection-name" value={name} maxLength={120} onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="collection-description">{t("collections.create.details")}</Label>
              <Textarea id="collection-description" value={description} maxLength={1000} onChange={(event) => setDescription(event.target.value)} />
            </div>
            {createCollection.isError ? (
              <p className="text-sm text-destructive">{t("collections.create.failed")}</p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>{t("common.cancel")}</Button>
            <Button
              disabled={!name.trim() || createCollection.isPending}
              onClick={() => createCollection.mutate()}
            >
              {createCollection.isPending ? t("collections.create.creating") : t("collections.create.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
