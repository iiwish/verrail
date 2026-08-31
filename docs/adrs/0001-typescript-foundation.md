# ADR-0001：采用 Paperclip TypeScript 基座并硬分叉

状态：`Accepted`

日期：2026-08-25

后续决策：ADR-0004 已取代本 ADR 第 7 条关于 TypeScript 正式控制平面的长期结论；硬分叉、许可证、基座复用和渐进迁移决策继续有效。

## 上下文

Verrail 需要认证、PostgreSQL、对象存储、Agent Adapter、Plugin、Secret、成本、运行日志、工作区、安装和 Web 操作台等大量基础能力。重新以 Go 从零建设这些能力会延迟产品差异化验证，并重复实现已经存在的工程基础。

Verrail 的差异化来自可信交付领域模型、Human-Agent Work Graph、Artifact/Evidence/Acceptance 和企业执行边界，而不是后端语言。

## 决策

1. Verrail 以 Paperclip 仓库的 TypeScript Monorepo 作为代码基座；
2. 采用硬分叉，不以持续合并上游为设计目标；
3. 保留 MIT 许可证、NOTICE 和可追溯的上游来源；
4. 保留可复用的认证、数据库、存储、Adapter、Plugin、Secret、成本、日志和运行时实现；
5. 用 Project、Target、Stage、Work Graph、Artifact、Evidence、Review 和 Acceptance 重构产品领域；
6. 领域迁移使用兼容层和垂直切片，不执行一次性全库重命名；
7. TypeScript 是当前正式控制平面技术栈，Go 不作为完成 Verrail MVP 的前置条件。

## 后果

- 可以立即在成熟、可运行的 Web 和服务端基座上验证产品；
- 必须承担内部命名、包发布、环境变量、数据表和 UI 语义的系统性重构；
- 不需要为上游合并保留抽象或避免深度修改；
- 仍需跟踪上游安全修复，但以补丁审查和选择性移植处理；
- 任何保留的 Paperclip 产品语义都只是迁移输入，不能成为 Verrail 的长期兼容承诺。

## 约束

- 重构期间每个提交保持基座可构建、可测试、可迁移；
- 不删除许可证与第三方归属；
- 不把品牌替换和领域行为修改混为一个无法审阅的机械提交；
- 新的产品对象和 API 以 `docs/` 中的 Verrail 合同为准。
