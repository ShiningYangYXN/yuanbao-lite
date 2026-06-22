# Yuanbao Lite 开发文档

本目录包含 Yuanbao Lite 项目的完整开发文档。文档按主题组织，便于开发者快速定位所需信息。

## 文档索引

| 文档 | 内容 | 适用读者 |
|------|------|----------|
| [架构总览](./architecture.md) | 项目整体架构、模块划分、数据流 | 所有开发者（必读） |
| [快速上手](./getting-started.md) | 安装、配置、第一个 Bot | 新用户 |
| [核心 API 参考](./api-reference.md) | YuanbaoBot 类、事件、方法的完整参考 | 应用开发者 |
| [命令系统](./command-system.md) | 53 个内置命令、自定义命令、权限模型 | 命令开发者 |
| [LLM 接管引擎](./llm-takeover.md) | 多供应商配置、密钥池、迭代调用、用量统计 | LLM 集成开发者 |
| [持久化适配器](./persistence-adapter.md) | PersistenceAdapter 接口、NodeFsAdapter、浏览器适配器 | 跨平台开发者 |
| [浏览器解耦](./browser-decouple.md) | 同构架构、Web Crypto、动态导入、打包指南 | 浏览器/Edge 开发者 |
| [CLI 与 Daemon](./cli-daemon.md) | CLI 命令、daemon 架构、HTTP 路由、systemd 集成 | 运维人员 |
| [消息协议](./message-protocol.md) | WebSocket 协议、Protobuf 编解码、消息体结构 | 协议开发者 |
| [安全模型](./security.md) | 信任系统、封禁系统、unsafe 模式、插值安全 | 安全审计人员 |
| [贡献指南](./contributing.md) | 代码规范、提交规范、测试要求、发布流程 | 贡献者 |

## 版本历史

- **v11.7.0** — Phase 4：js-md5 替换手搓 MD5；核心库与 CLI 拆分（`yuanbao-lite/cli` 子路径）；完整开发文档
- **v11.6.0** — Phase 3：彻底移除 `require()`，命令系统浏览器移植，Web Crypto API 全面替换
- **v11.5.x** — Phase 1-2：浏览器解耦——命令系统懒加载、PersistenceAdapter 接口、Web Crypto HMAC 签名、原生 WebSocket
- **v11.4.x** 及更早 — 原 daemon-first 架构（Node-only）

## 支持的运行环境

| 运行时 | 支持状态 | 说明 |
|--------|----------|------|
| Node.js 18+ | ✅ 完整支持 | 所有功能可用（含 CLI、daemon、文件上传） |
| Node.js 21+ | ✅ 完整支持 | 使用原生 `globalThis.WebSocket`，无需 `ws` 包 |
| 现代浏览器 | ✅ 核心支持 | 连接、收发消息、LLM、命令系统均可用；文件上传需额外适配 |
| Edge Workers | ⚠️ 部分支持 | 需提供自定义 PersistenceAdapter；无 child_process（/shell、/term 不可用） |
| Deno | ⚠️ 未测试 | 理论上支持（ESM + Web Crypto），但未验证 |

## 快速链接

- [GitHub 仓库](https://github.com/ShiningYangYXN/yuanbao-lite)
- [问题反馈](https://github.com/ShiningYangYXN/yuanbao-lite/issues)
- [浏览器解耦分析报告](../BROWSER_DECOUPLE_ANALYSIS.md) — 详细的依赖审计与分阶段计划
