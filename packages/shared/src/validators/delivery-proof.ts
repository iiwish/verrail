// These are complete source-contract clauses, not aliases for individual CI checks.
export const DELIVERY_PROOF_ASSERTIONS = Object.freeze({
  feishu_target: Object.freeze([
    "真实飞书消息经明确确认创建版本化 Target，并返回可追踪回复",
    "保留 callback、事件、会话和回复的脱敏 Provider 标识",
  ] as const),
  codex_execution: Object.freeze([
    "Codex 执行绑定版本、运行、环境、日志、成本与权限，并产生内容寻址工件",
    "固定提交通过独立 CI 并形成 Evidence 与 VerificationResult",
  ] as const),
});

export type DeliveryProofKind = keyof typeof DELIVERY_PROOF_ASSERTIONS;

export function deliveryProofKindForAssertions(assertions: readonly unknown[]): DeliveryProofKind | null {
  for (const kind of Object.keys(DELIVERY_PROOF_ASSERTIONS) as DeliveryProofKind[]) {
    const expected = DELIVERY_PROOF_ASSERTIONS[kind];
    if (assertions.length === expected.length && new Set(assertions).size === expected.length
      && expected.every(assertion => assertions.includes(assertion))) return kind;
  }
  return null;
}
