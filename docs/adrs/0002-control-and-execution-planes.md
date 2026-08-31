# ADR-0002：控制平面与独立执行平面

状态：`Accepted`

日期：2026-08-25

后续决策：ADR-0004 已取代本 ADR 第 1、7、8 条关于控制平面语言和 Go 提取范围的结论；独立执行平面、Runner 出站连接、SandboxDriver、Lease 和 fencing 决策继续有效。

## 上下文

Verrail 既要支持开发者本机和开源自托管，也要支持托管 Linux Sandbox、客户 VPC、企业内网资源和未来 Cloud 服务。浏览器或控制平面进程直接启动所有 Agent 无法满足隔离、恢复、容量和企业网络要求。

同时，未来可能使用 Go 改善 Gateway、Runner 或调度 Worker 的资源和部署特性，但全量改写控制平面会破坏当前 TypeScript 基座的验证速度。

## 决策

1. PostgreSQL-backed TypeScript Server 是当前控制平面；
2. 执行通过版本化 Execution Gateway 和 Headless Runner 协议完成；
3. Runner 主动建立出站连接，不直连控制平面数据库；
4. HostTrusted、CubeSandbox、容器和 Kubernetes 通过 `SandboxDriver` 实现统一 RuntimeProfile；
5. Cloud Managed Runner 与客户 VPC Runner 使用相同 Lease、事件、Artifact 和审计合同；
6. CubeSandbox 是 Linux 强隔离候选，必须通过独立准入，不作为不可替换依赖；
7. Go 只通过 Strangler 模式提取语言中立边界，优先候选为 Gateway、Runner、Lease/Fencing 和数据流服务；
8. Project、Target、Graph、权限、Review 和 Acceptance 继续由控制平面拥有，执行服务不得复制领域事实。

## 后果

- 本地与企业执行共享产品语义，运行环境可以独立演进；
- 需要较早定义协议版本、租约、fencing、幂等、事件 Cursor 和数据出站策略；
- MVP 可以先使用 TypeScript 和 HostTrusted 跑通交付闭环，再增加强隔离；
- 私有 Runner 能让代码与运行时 Secret 留在客户网络；
- Go 演进有清晰入口，但不存在必须迁移整个后端的承诺。

## 否决方案

- 浏览器直接控制本机 CLI：安全边界、恢复和企业部署不可接受；
- Runner 直连 PostgreSQL：破坏租户、权限和协议边界；
- 每种 Sandbox 定义一套产品模型：造成行为分裂；
- 立即全量 Go 重写：延迟核心价值验证并扩大回归面；
- CubeSandbox 直接进入领域模型：形成不必要的供应商绑定。
