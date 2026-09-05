# ADR 0007: Native Run Artifact Ingress

状态：已采纳并实现；独立交付审查另行记录。

## 决策

原生 HostTrusted Agent 通过固定 RunAttempt 输出目录中的有界 manifest 声明文件，不持有 Board 写入身份。TypeScript Runner 依据真实 Run、Attempt、系统唤醒回执及不可变 DeploymentRevision 验证工作目录，读取并计算文件内容哈希，写入 Workspace-scoped Storage。

Runner 在 `succeeded` RunEvent 的独立 `artifacts` 字段提交有界类型、标题、哈希和内容寻址引用。Go Domain API 在执行器身份、当前 Attempt、有效租约、fencing、连续游标及成功状态转换通过后，用同一数据库事务登记 Artifact、ArtifactRevision、审计和执行终态。Run 与 WorkNode 来源由数据库推导，不接受 Agent 声明的来源身份。事件幂等回执和游标重放保证已提交成功事件不重复登记产物。

人工 Artifact 命令权限保持独立；产物登记不代表验证、审查、动作审批或验收。Reviewer 使用 Workspace 授权内容端点下载已登记版本，端点只解析精确匹配 Workspace 与内容哈希的 Storage 引用。

## 约束

- 输出 manifest 最多 64 KiB，最多 10 个平级文件，每个 32 MiB、合计 64 MiB；拒绝路径逃逸、链接及特殊文件。
- 没有 manifest 的既有任务兼容成功事件；无效文件集合产生可观察执行失败，不伪造产物或成功。
- Storage 采用确定性内容寻址 key。上传完成而领域事务未提交时可能留下孤立对象；该对象不构成领域产物事实，清理是独立存储维护工作。
- HostTrusted 信任宿主执行环境。本通道不是恶意代码沙箱，不声称可以隔离具有同等宿主文件权限的恶意进程。
- Secret 禁止进入产物；输出目录和大小检查不是内容脱敏或秘密检测替代品。

## 未采用

不放宽通用 Artifact API 的人工写权限，不让 Agent 借用 Board 身份，不使用直接数据库回填来补历史终态 Run，也不把本地路径字符串当成已持久化的 ArtifactRevision。
