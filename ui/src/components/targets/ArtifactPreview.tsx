import { useState } from "react";
import { Eye, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";

export function ArtifactPreview({ workspaceId, revisionId }: { workspaceId: string; revisionId: string }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const preview = async () => {
    setOpen(!open);
    if (open || text !== null || pending) return;
    setPending(true);
    setFailed(false);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/artifact-revisions/${encodeURIComponent(revisionId)}/content`);
      if (!response.ok || !response.body) throw new Error("Unavailable");
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      let size = 0;
      let content = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 256 * 1024) throw new Error("Preview limit");
          content += decoder.decode(value, { stream: true });
        }
        content += decoder.decode();
        if (content.includes("\u0000")) throw new Error("Binary content");
        setText(content);
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    } catch {
      setFailed(true);
    } finally {
      setPending(false);
    }
  };
  return <>
    <Button variant="ghost" size="icon" title={t("targets.delivery.preview")} aria-label={t("targets.delivery.preview")} aria-expanded={open} onClick={() => void preview()}>
      {pending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Eye className="h-4 w-4" />}
    </Button>
    {open ? <div className="w-full border-t border-border py-3">
      {failed ? <p role="alert" className="text-xs text-destructive">{t("targets.delivery.previewFailed")}</p> : <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{text}</pre>}
    </div> : null}
  </>;
}
