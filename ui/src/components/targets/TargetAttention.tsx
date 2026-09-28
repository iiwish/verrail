import { AlertCircle, ArrowRight } from "lucide-react";
import type { TargetAttentionItemV1, TargetAvailableCommandV1 } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { attentionCommand, commandReasonKey } from "./workbench-model";

export function TargetAttention({ items, commands, onInspect, executingActionIds = [] }: {
  items: TargetAttentionItemV1[];
  commands: TargetAvailableCommandV1[];
  onInspect: (item: TargetAttentionItemV1) => void;
  executingActionIds?: string[];
}) {
  const { t } = useTranslation();
  return <ul className="grid gap-3">
    {items.map((item) => {
      const command = attentionCommand(item, commands);
      const executing = item.resourceId && executingActionIds.includes(item.resourceId);
      return <li key={item.id} className="flex items-start gap-3 rounded-lg bg-muted/50 p-4">
        <AlertCircle className="target-attention-icon mt-0.5 h-4 w-4 shrink-0" data-severity={item.severity} aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">{t(executing ? "targets.workbench.actionExecuting" : `targets.attentionKinds.${item.kind}`)}</p>
          <p className="text-sm text-muted-foreground">{t(executing ? "targets.workbench.executing" : `targets.workbench.guidance.${item.kind}`)}</p>
          {!executing && command?.state === "blocked" && command.reason ? <p className="break-words text-xs text-muted-foreground">{commandReasonKey(command.reason) ? t(commandReasonKey(command.reason)!) : command.reason}</p> : null}
          {item.detail ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">{t("targets.delivery.auditDetails")}</summary><p className="mt-2 break-words font-mono">{item.detail}</p></details> : null}
        </div>
        <Button size="sm" variant="ghost" onClick={() => onInspect(item)} aria-label={`${t("targets.workbench.inspect")} · ${t(executing ? "targets.workbench.actionExecuting" : `targets.attentionKinds.${item.kind}`)}`}><ArrowRight className="h-4 w-4" />{t("targets.workbench.inspect")}</Button>
      </li>;
    })}
  </ul>;
}
