import { useEffect, useRef, useState } from "react";
import { GitBranch, LoaderCircle } from "lucide-react";
import type { RepositorySourceReceipt } from "@paperclipai/shared";
import { targetsApi } from "@/api/targets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTranslation } from "@/i18n";

export function TargetRepositorySource(props: {
  workspaceId: string; targetId: string; targetRevisionId: string; graphRevisionId: string;
  onPrepared: (receipt: RepositorySourceReceipt | null) => void;
  onBusy: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<RepositorySourceReceipt | null>(null);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);
  const onBusy = props.onBusy;
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; request.current?.abort(); onBusy(false); };
  }, [onBusy]);
  const prepare = async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); props.onBusy(true); setFailed(false);
    props.onPrepared(null); setReceipt(null);
    try {
      const result = await targetsApi.prepareRepositorySource(props.workspaceId, props.targetId, {
        targetRevisionId: props.targetRevisionId, graphRevisionId: props.graphRevisionId, ref: ref.trim(),
      }, controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      if (result.workspaceId !== props.workspaceId || result.targetId !== props.targetId
        || result.targetRevisionId !== props.targetRevisionId || result.graphRevisionId !== props.graphRevisionId) throw new Error("Source scope mismatch");
      setReceipt(result); props.onPrepared(result); props.onBusy(false);
    } catch { if (mounted.current) setFailed(true); }
    finally { request.current = null; if (mounted.current) setBusy(false); }
  };
  return <div className="space-y-2">
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground">
        <span>{t("targets.repositorySource.ref")}</span>
        <Input value={ref} disabled={busy} maxLength={256} onChange={event => {
          setRef(event.target.value); setReceipt(null); props.onPrepared(null); setFailed(false);
          props.onBusy(Boolean(event.target.value.trim()));
        }} />
      </label>
      <Button type="button" size="sm" variant="outline" disabled={busy || !ref.trim()} onClick={() => void prepare()}>
        {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <GitBranch className="h-4 w-4" />}
        {t("targets.repositorySource.prepare")}
      </Button>
    </div>
    {receipt ? <p className="break-all text-xs text-muted-foreground">{receipt.repository} <code>{receipt.baseCommit}</code></p> : null}
    {failed ? <p role="alert" className="text-xs text-destructive">{t("targets.repositorySource.failed")}</p> : null}
  </div>;
}
