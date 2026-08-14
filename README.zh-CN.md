# dsh-file-claim

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/dsh-file-claim)](https://www.npmjs.com/package/dsh-file-claim)
[![npm downloads](https://img.shields.io/npm/dm/dsh-file-claim)](https://www.npmjs.com/package/dsh-file-claim)
[![CI](https://github.com/Nwflower/dsh-file-claim/actions/workflows/ci.yml/badge.svg)](https://github.com/Nwflower/dsh-file-claim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)

> **并行写作，永不覆盖。**
> 同一工作区并行 DeepSeek Harness (DSH) 会话的文件认领/保护插件。

多个 DSH 会话并行操作同一工作区时，彼此毫无感知：两个会话可能覆盖同一文件、崩溃会话留下
陈旧状态、想改他人已占文件的会话只能干等或赌。`dsh-file-claim` 把一套久经验证的协调协议做成
原生 DSH 工具、生命周期事件与写入守卫——让并行 Agent 协作而非互相踩踏。

```text
claim_files({ paths: ["README.md"] })   # 「我来改这个文件」
write / edit ...                          # 写他人认领的文件会被拒绝
release_files({ paths: ["README.md"] })  # 「改完了」——等待中的 pending 编辑现在自动合并
```

## 目录

- [特性](#特性)
- [为什么需要它](#为什么需要它)
- [安装](#安装)
- [快速开始](#快速开始)
- [使用示例](#使用示例)
- [工具](#工具)
- [命令](#命令)
- [写入守卫](#写入守卫)
- [配置](#配置)
- [审计日志](#审计日志)
- [Pending 合并区](#pending-合并区)
- [拦截边界](#拦截边界)
- [常见问题](#常见问题)
- [开发](#开发)
- [相关项目](#相关项目)
- [许可证](#许可证)

## 特性

- 🔒 **claim / release** —— 会话在编辑前声明对文件路径的独占认领；重复认领幂等合并，目录
  认领覆盖其下所有路径，`'.'` 认领整个工作区。
- ❤️ **心跳 + stale 接管** —— 心跳经 agent 生命周期事件自动刷新；崩溃会话的认领过期（默认
  2h）后可用 `--force` 接管。
- 🧩 **异步 pending 合并区** —— 不阻塞：会话把「改好的新内容 + git HEAD base」写入待合并区；
  持有者 release 后**自动尝试** **git 三路合并**（current × base × pending），无冲突即落盘；
  冲突时 `pending apply` 手动处理。
- 🛡️ **写入守卫** —— `tools/pre-execute` 拒绝写他人活跃认领文件的工具调用，附建议
  （等待 / stale 后接管 / 写入 pending），并有可选的 commit 级守卫。
- ⚡ **零自动化负担** —— `agent/created` / `agent/status` 自动刷新心跳，`agent/disposed`
  自动释放离开会话的全部认领。
- 📦 **纯 Host 插件、零依赖** —— 无 Browser 侧、无构建步骤，只用 `node:` 内置模块；
  Windows 友好。
- 🧾 **审计日志** —— 每次 claim / release / 接管 / pending 变更追加一行 JSON，供追溯与
  崩溃后核对。

## 为什么需要它

DSH 宿主无内建跨会话文件保护；505 个 `dsh-plugin` topic 仓库全量扫描**零命中**
文件认领/协调类插件。pending 合并区——现在写下改动、持有者释放后干净合并——在 agent
文件锁品类内独有。这是**填补空白而非重复造轮子**。

### 与同类方案对比

对照 11 个 Claude Code / Codex 文件锁与协调工具（claude-code-file-locks、parallel-sessions、
guardex、agent-orchestrator、blackboard-mcp、mclaude、ruah-orch、knot 等）：

| 差异化 | dsh-file-claim | 同类方案 |
| --- | --- | --- |
| 冲突处理 | **pending 异步区 + git 三路合并**——先写入、对方释放后干净合并 | 只能等待/拒绝（「锁→写→释放」） |
| 目标平台 | **DSH 原生**——身份、工具、事件、守卫、命令全集成 | Claude Code / Codex hooks；无一面向 DSH |
| 平台支持 | 零依赖 Node，**Windows 友好** | Bash/jq/flock 方案偏 macOS/Linux；guardex 无原生 Windows |
| 强制层 | 工具层协作式护栏（fail-open，与品类事实标准一致） | hook 拦截/声明式锁；头部工具退化为 worktree 硬隔离 |

## 安装

```sh
dsh plugin add dsh-file-claim
```

开发/手工验证（本地 checkout）：

```sh
dsh plugin --profile web add -w link:<仓库路径>
```

要求 DSH 环境 `node >= 18`，且 `git` 在 `PATH` 中（仅三路合并时使用）。

## 快速开始

1. **先认领，再落笔。** 要改文件？先调用 `claim_files` 声明独占认领，其他会话就不会碰它。
2. **放心写。** 自己的认领永不阻塞自己；写入被*其他*活跃会话认领的文件会被拒绝，并附带提示
   （等待 / 对方 stale 后接管 / 写入 pending）。
3. **文件被占？别干等——写入 pending。** 用 `pending_write` 把改好的内容（含 git HEAD base）
   放进待合并区。持有者 `release_files` 后自动三路合并（无冲突即落盘）；冲突时 `pending_apply`
   手动处理。
4. **写完释放。** `release_files` 清空认领、自动合并等待中的 pending 条目，并浮出需要手动
   处理的条目。

```text
claim_files({ paths: ["README.md", "src/"] })
write / edit ...
release_files({ paths: ["README.md"] })
```

## 使用示例

**两个会话，一个工作区。** 会话 A 持有 `README.md`；会话 B 也想改它：

```text
// 会话 A
claim_files({ paths: ["README.md"], note: "重写文档" })
write  ...  README.md          // 允许：自己的认领
release_files({ paths: ["README.md"] })

// 会话 B —— 同时进行
who_claims({ paths: ["README.md"] })          // → 被 A 认领
write ... README.md                           // → 拒绝并附提示
pending_write({ path: "README.md", content: "..." })  // 异步，不阻塞
// A release 后条目自动三路合并（或浮出供手动 pending_apply）
```

**从崩溃会话恢复。** 会话 A 中途崩溃；其认领在 `staleMs`（默认 2h）后过期：

```text
claim_status()                      # → A 显示 [stale]
claim_files({ paths: ["README.md"], force: true })   # 接管
```

## 工具

8 个模型可见工具（身份即调用会话，无需 `--as`）：

| 工具 | 用途 |
| --- | --- |
| `claim_files` | 编辑前独占认领文件/目录（`paths`、可选 `note`、stale 接管用 `force`） |
| `release_files` | 释放指定路径（`paths`）或全部（`all`） |
| `who_claims` | 只读：查询路径被谁认领 |
| `claim_status` | 只读：会话登记、认领、待合并区总览与最近审计 |
| `pending_write` | 异步写：目标被其他活跃会话占用时，把改好的内容（+ git HEAD base）写入待合并区 |
| `pending_apply` | 三路合并 `current × base × pending` 落盘；无冲突自动清除，冲突写标记 |
| `pending_show` | 只读：查看某待合并条目的元信息与内容 |
| `pending_drop` | 丢弃某待合并条目（不合并） |

## 命令

人工可用的斜杠命令（与上述工具同语义——模型不可用或习惯命令行时使用）。命令名后的行按
引号感知分词，含空格的路径与备注可用（`--note "多 行 备注"`）。命令执行只记入会话日志，
绝不进模型历史。

| 命令 | 用途 |
| --- | --- |
| `/claim <path>... [--note <备注>] [--force]` | 独占认领文件/目录；`--force` 接管 stale 持有者 |
| `/release [<path>... \| --all]` | 释放指定路径或全部 |
| `/claim-status` | 只读：会话登记、认领与待合并区总览 |

纯逻辑核心同时提供 CLI：`node claim.mjs status | audit [n] | claim ...`——语义相同，
无需 DSH 环境。

## 写入守卫

`tools/pre-execute` 拒绝 `write` / `edit` / `bash` / `pwsh` 调用中目标路径被**其他**活跃会话
认领的情况。拒绝信息带持有者与建议：等 `release_files`、对方 stale 后 `claim_files(force: true)`
接管、或 `pending_write` 异步写入。`read` **不拦截**——读取是观察不是修改，认领契约只保护写面。
shell 路径解析（`bash`/`pwsh`）为尽力而为：只提取**重定向目标**与**显式写命令的目标参数**
（pwsh `Set-Content` / `Add-Content` / `Out-File` / `New-Item` / `Copy-Item` / `Move-Item` /
`Remove-Item` / `Rename-Item`；bash `tee` / `dd of=` / `cp` / `mv` / `rm`）。**引号字面量绝不
视为写目标**——它们是数据/URL/模式，不是要写的文件；解析不出目标即放行（fail-open）。

开启 `guardCommit: true` 后，`git commit` **显式**提交其他会话活跃认领路径（`git commit -- <path>`
或老语法 `git commit <path>`）也会被拒绝；提交信息（message）绝不检查，裸 `git commit`（无路径）
放行——其改动范围无法获知。

## 配置

在 bundle（`cordis.patch.yml`）中作为插件 config 传入：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `staleMs` | `7200000`（2h） | 心跳过期多久视为 stale |
| `stateDirName` | `.dsh-file-claim` | 工作区根下的注册表 + 待合并区目录名 |
| `guard` | `true` | 设 `false` 关闭 pre-execute 写入守卫 |
| `guardCommit` | `false` | 可选：额外拦截 `git commit` 显式提交其他会话活跃认领的路径 |
| `heartbeatMs` | `600000`（10min） | 兜底心跳间隔 |

```yaml
- insert:
    - id: dsh-file-claim
      name: dsh-file-claim
      config:
        staleMs: 3600000        # 1 小时
        guardCommit: true       # 同时守卫显式 git commit
```

认领注册表与待合并区位于 `<工作区根>/<stateDirName>/`——建议加入 `.gitignore`。状态跨重启
保留；绝不触碰 `.git/`。

## 审计日志

每个业务变更——claim、接管、release、pending 写/apply/drop、prune、drop——都以一行 JSON
追加到 `<stateDir>/audit.jsonl`（`{ at, tag, type, paths/path, detail }`），供追溯与崩溃后核对。
心跳**刻意不记**（避免噪音）。`node claim.mjs audit [n]` 打印最近 `n` 条（默认 10）；
`claim_status` 恒显示最近 3 条。审计只追加、不参与也不改变认领语义；审计写入失败只会提示
警告行，不阻断操作。

## Pending 合并区

存储布局（`<工作区根>/<stateDirName>/pending/` 下）：

```text
pending/<relpath>/content     待合并的新文件内容
pending/<relpath>/base        写入时 git HEAD 版本（合并 base）
pending/<relpath>/meta.json   { pender, claimedBy, at, baseSha }
```

写入条件：`pending_write` 要求目标被其他会话**活跃**认领——否则应 `claim_files` 后直接写。
`base` 仅在 git HEAD 含该路径时记录；无 base 是刻意标注的不可自动合并条目。

apply 语义（`pending_apply`）：用 `git merge-file` 对 `current × base × pending` 三路合并
（三个真实文件快照暂存临时目录）。无冲突 → 合并内容落盘并清除条目；有冲突 → 带冲突标记的
合并结果落盘且条目**保留**供手动解决；缺 base → 拒绝，绝不盲合；任一会话仍活跃占用 →
拒绝直至释放。

`release_files` 带解锁检查：指向被释放路径（或释放会话）的待合并条目会**自动尝试三路合并**
——无冲突即落盘并清除条目；无法自动合并（仍被占用 / 缺 base / 冲突 / 文件缺失）的条目保留，
并附 `pending_apply` / `pending_show` / `pending_drop` 手动处理提示。

## 拦截边界

守卫是**协作式护栏**，不是强制锁：任意 shell 命令（`echo > file`、`git checkout`、脚本）、
外部编辑器、IDE/git 操作完全绕过工具栈。它把「靠 AGENTS.md 自律」升级为「工具层护栏 +
模型可见状态」，与整个品类的 fail-open 定位一致。

## 常见问题

**bash/pwsh 写入能完全拦截吗？** 不能。只解析重定向目标与显式写命令的目标参数；任意 shell、
脚本、外部编辑器与 IDE/git 操作都绕过工具栈。这是文档化的协作边界，不是缺陷——见
[拦截边界](#拦截边界)。

**崩溃会话的认领多久过期？** `staleMs`，默认 2h。离开的会话经 `agent/disposed` 自动释放，
stale 接管只是最后的兜底。

**支持多仓库并行吗？** 支持。认领根 = 会话 cwd 解析出的工作区（`workspaceRegistry`），
无工作区时回退 cwd——多仓库天然隔离。

**状态存在哪？** `<工作区根>/.dsh-file-claim/`（注册表、待合并区、审计）。建议加入
`.gitignore`；跨重启保留，绝不触碰 `.git/`。

**为什么模型看不到 claim 工具？** 模型可见工具取决于部署的工具展示/限制（与所有插件工具
相同）。插件经 `ctx.tools.register` 全局注册，与官方工具包同一路径。

**pending 条目无法合并怎么办？** 条目保留并附原因（仍被占用 / 缺 base / 冲突 / 文件缺失）。
用 `pending_show` 查看、`pending_apply` / `pending_drop` 处理——绝不盲合。

## 开发

```sh
npm test        # node --test：claim.mjs 单测（17）+ index.mjs mock ctx 集成（11）
npm pack --dry-run
```

结构：`claim.mjs` 是零依赖纯逻辑核心（可移植，保留 CLI 入口）；`index.mjs` 是唯一宿主面文件；
`test/` 覆盖两者。CI 跑测试、双语 README 结构同步检查与 pack dry-run。

## 相关项目

- [dsh-chat-import](https://github.com/Nwflower/dsh-chat-import) —— 姊妹 DSH 插件，本插件的
  `session.mjs` 协调协议移植并增强自该项目。
- [awesome-dsh-plugin](https://github.com/bruc3van/awesome-dsh-plugin) —— DSH 插件生态索引
  （本项目调研时扫描过 505 个仓库）。
- [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh) —— DeepSeek Harness 宿主。

## 许可证

MIT —— 见 [LICENSE](LICENSE)。
