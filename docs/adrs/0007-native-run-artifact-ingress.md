# ADR 0007: Native Run Artifact Ingress

状态：已采纳并实现；独立交付审查另行记录。

## 决策

原生 HostTrusted Agent 通过固定 RunAttempt 输出目录中的有界 manifest 声明文件，不持有 Board 写入身份。TypeScript Runner 依据真实 Run、Attempt、系统唤醒回执及不可变 DeploymentRevision 验证工作目录，读取并计算文件内容哈希，写入 Workspace-scoped Storage。

本地 Codex 的采集点位于 Adapter 返回及其恢复逻辑完成之后、`workspace_finalize` 屏障之前，阶段为 `after_adapter_return`。两次有界终端源码观察包围 manifest 与全部文件读取；上传使用已经固定的内存字节，不在上传或执行器轮询时重读。输入源码与终端源码允许不同；终端观察之间检测到变化时不产生成功关联。源码不可用保持显式不可用，普通文件产物不因此成为源码等价证明。

服务端回执绑定实际原生身份、调用前及终端源码观察、读取与上传时间、逐项输出路径及内容映射。完成时将日志、用量、退出、部署环境事实和完成时间纳入规范化摘要，并与 Heartbeat 成功状态条件更新原子保存。执行器从可信系统唤醒关系加载已存回执，使用固定事实和产物引用重放成功事件；Agent 输入、Adapter 元数据或 resultJson 不能提供回执权威。历史缺失不补造终端观察，无效回执不触发文件重采集。

Runner 在 `succeeded` RunEvent 的独立 `artifacts` 字段提交有界类型、标题、哈希和内容寻址引用。Go Domain API 在执行器身份、当前 Attempt、有效租约、fencing、连续游标及成功状态转换通过后，用同一数据库事务登记 Artifact、ArtifactRevision、审计和执行终态。Run 与 WorkNode 来源由数据库推导，不接受 Agent 声明的来源身份。事件幂等回执和游标重放保证已提交成功事件不重复登记产物。

人工 Artifact 命令权限保持独立；产物登记不代表验证、审查、动作审批或验收。Reviewer 使用 Workspace 授权内容端点下载已登记版本，端点只解析精确匹配 Workspace 与内容哈希的 Storage 引用。

## 约束

- 输出 manifest 最多 64 KiB，最多 10 个平级文件，每个 32 MiB、合计 64 MiB；拒绝路径逃逸、链接及特殊文件。
- 没有 manifest 的既有任务兼容成功事件；无效文件集合产生可观察执行失败，不伪造产物或成功。
- Storage 采用确定性内容寻址 key。上传完成而领域事务未提交时可能留下孤立对象；该对象不构成领域产物事实，清理是独立存储维护工作。
- Storage 返回的大小、哈希及完整 Workspace/namespace/key 必须与实际字节匹配；内容相同的不同路径保留独立有序映射。采集总期限为 60 秒，超时不证明上传已取消，不删除结果不确定的对象，也不采纳迟到上传。
- 期限到达即锁定过期状态，迟到上传返回不能启动下一个文件上传。采集错误进入 Heartbeat 日志或持久化前转换为闭集诊断码；解析器和 Storage 的原始错误消息、堆栈及 cause 不跨越该边界。
- 成功回执只随终态条件更新保存；取消、检测到租约失效、Adapter 失败、finalize 失败或持久化失败不登记成功产物。条件更新只对 Heartbeat 状态原子化，不是跨引擎租约授权事务；最后一次检查后失去租约可以留下未登记的本地观察，Go fenced 登记必须拒绝失效执行权。已上传或已存 Heartbeat 回执不等于已登记 ArtifactRevision。
- 回执建立有限源码/产物关联，不证明完整代码树等价、正在执行的构建来源、有效权限或完整 CriterionProof；源码范围不构成向外部 Provider 发布 `.verrail` 证据的授权。
- HostTrusted 信任宿主执行环境。本通道不是恶意代码沙箱，不声称可以隔离具有同等宿主文件权限的恶意进程。
- Secret 禁止进入产物；输出目录和大小检查不是内容脱敏或秘密检测替代品。

## 未采用

不放宽通用 Artifact API 的人工写权限，不让 Agent 借用 Board 身份，不使用直接数据库回填来补历史终态 Run，也不把本地路径字符串当成已持久化的 ArtifactRevision。
