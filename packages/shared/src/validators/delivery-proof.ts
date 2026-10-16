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
  opencode_execution: Object.freeze([
    "OpenCode 仓库执行绑定 AgentVersion、DeploymentRevision、Run/Attempt、实际运行时、环境、日志、用量、成本状态与权限，并产生内容寻址工件",
    "固定提交通过独立 CI 并形成 Evidence 与 VerificationResult",
  ] as const),
  repository_recovery: Object.freeze([
    "OpenCode 仓库执行绑定 AgentVersion、DeploymentRevision、Run/Attempt、实际运行时、环境、日志、用量、成本状态与权限，并产生内容寻址工件",
    "固定提交通过独立 CI 并形成 Evidence 与 VerificationResult",
    "同一候选的仓库执行器在已清理运行时且结果持久化后发生可验证进程中断与重启，并在同一 Run/Attempt 恢复登记，不重跑模型或重复创建工件",
    "真实旧 Attempt 的固定延迟事件被 fencing 拒绝，重复恢复调用保持业务状态不变，并保留独立签名的实际请求、响应与清理记录",
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
