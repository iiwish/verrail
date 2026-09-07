// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CriterionProofEditor } from "./CriterionProofEditor";
import { setLocale, t } from "@/i18n";
import enRaw from "../../i18n/locales/en.json?raw";
import zhRaw from "../../i18n/locales/zh-CN.json?raw";
import ts from "typescript";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { document.body.innerHTML = ""; });

describe("criterion proof commands", () => {
  it("keeps both locales free of duplicate object keys and resolves the real translator", async () => {
    for (const [locale, raw] of [["en", enRaw], ["zh-CN", zhRaw]] as const) {
      const source = ts.parseJsonText(`${locale}.json`, raw);
      const visit = (node: ts.Node) => {
        if (ts.isObjectLiteralExpression(node)) {
          const keys = node.properties.map((property) => property.name?.getText(source));
          expect(new Set(keys).size).toBe(keys.length);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      await setLocale(locale);
      expect(t("targets.proof")).not.toBe("targets.proof");
      expect(t("targets.criterionProof.revise")).toBe(locale === "en" ? "Revise proof contract" : "修订证明合同");
      expect(t("targets.criterionProof.phases.post_effect")).toBe(locale === "en" ? "After external effect" : "外部动作后");
    }
  });

  it("retries an uncertain save with the same input, expected revision and idempotency key", async () => {
    await setLocale("en");
    const container = document.createElement("div"); document.body.append(container);
    const root = createRoot(container);
    const onSave = vi.fn().mockRejectedValueOnce(new Error("503 unavailable")).mockResolvedValueOnce(undefined);
    const criterion = { id: "criterion-1", title: "Technical delivery", description: "Independent CI and recovery" };
    const render = async (revision: string) => act(async () => root.render(<CriterionProofEditor criterion={criterion} targetRevisionId={revision} disabled={false} onSave={onSave} />));
    await render("revision-1");
    await act(async () => (container.querySelector("button") as HTMLButtonElement).click());
    const save = () => [...document.querySelectorAll("button")].find((button) => button.textContent?.includes("Create revision"))!;
    await act(async () => save().click());
    expect(document.body.textContent).toContain("503 unavailable");
    await render("revision-2");
    await act(async () => save().click());
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(onSave.mock.calls[0]).toEqual(onSave.mock.calls[1]);
    expect(onSave.mock.calls[1]?.[1]).toBe("revision-1");
    await act(async () => root.unmount());
  });
});
