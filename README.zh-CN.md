# dsh-file-claim

[![English](https://img.shields.io/badge/lang-English-blue.svg)](README.md) [![简体中文](https://img.shields.io/badge/lang-%E7%AE%80%E4%BD%93%E4%B8%AD%E6%96%87-red.svg)](README.zh-CN.md)

[![CI](https://github.com/Nwflower/dsh-file-claim/actions/workflows/ci.yml/badge.svg)](https://github.com/Nwflower/dsh-file-claim/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Nwflower/dsh-file-claim)](https://github.com/Nwflower/dsh-file-claim/stargazers)
[![node](https://img.shields.io/badge/node-%3E%3D18-green.svg)](package.json)

> **并行写作，永不覆盖。**
> 同一工作区并行 DeepSeek Harness (DSH) 会话的文件认领/保护插件。

多个 DSH 会话并行操作同一工作区时，彼此毫无感知：两个会话可能覆盖同一文件、崩溃会话留下
陈旧状态、想改他人已占文件的会话只能干等或赌。`dsh-file-claim` 把一套久经验证的协调协议做成
原生 DSH 工具、生命周期事件与写入守卫——让并行 Agent 协作而非互相踩踏。

## ✨ 特性

- **claim / release** —— 会话在编辑前声明对文件路径的独占认领。
- **心跳 + stale 接管** —— 心跳自动刷新；崩溃会话的认领过期（默认 2h）后可用 `--force` 接管。
- **异步 pending 合并区** —— 不阻塞：会话把「改好的新内容 + git HEAD base」写入待合并区；
  持有者 release 后 `pending apply` 做 **git 三路合并**（current × base × pending），无冲突自动落盘。
- **写入守卫** —— `tools/pre-execute` 拒绝写他人活跃认领文件的工具调用（协作式、尽力而为——
  shell 写入无法完全拦截）。
- **零自动化负担** —— `agent/created` / `agent/status` 自动刷新心跳，`agent/disposed`
  自动释放离开会话的全部认领。
- **纯 Host 插件、零依赖** —— 无 Browser 侧、无构建步骤，只用 `node:` 内置模块。

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

## 快速开始

1. **先认领，再落笔。** 要改文件？先调用 `claim_files` 声明独占认领，其他会话就不会碰它。
2. **放心写。** 自己的认领永不阻塞自己；写入被*其他*活跃会话认领的文件会被拒绝，并附带提示
   （等待 / 对方 stale 后接管 / 写入 pending）。
3. **文件被占？别干等——写入 pending。** 用 `pending_write` 把改好的内容（含 git HEAD base）
   放进待合并区。持有者 `release_files` 后，`pending_apply` 干净三路合并落盘。
4. **写完释放。** `release_files` 清空认领，并运行解锁检查：指向你的待合并条目会浮出提示。

```text
claim_files({ paths: ["README.md", "src/"] })
write / edit ...
release_files({ paths: ["README.md"] })
```

## 工具

8 个模型可见工具（身份即调用会话，无需 `--as`）：

| 工具 | 用途 |
| --- | --- |
| `claim_files` | 编辑前独占认领文件/目录（`paths`、可选 `note`、stale 接管用 `force`） |
| `release_files` | 释放指定路径（`paths`）或全部（`all`） |
| `who_claims` | 只读：查询路径被谁认领 |
| `claim_status` | 只读：会话登记、认领与待合并区总览 |
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

## 写入守卫

`tools/pre-execute` 拒绝 `write` / `edit` / `bash` / `pwsh` 调用中目标路径被**其他**活跃会话
认领的情况。拒绝信息带持有者与建议：等 `release_files`、对方 stale 后 `claim_files(force: true)`
接管、或 `pending_write` 异步写入。`read` **不拦截**——读取是观察不是修改，认领契约只保护写面。
shell 路径解析（`bash`/`pwsh`）为尽力而为：提取引号字面量与重定向目标；解析不出目标即放行
（fail-open）。

## 配置

在 bundle（`cordis.patch.yml`）中作为插件 config 传入：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `staleMs` | `7200000`（2h） | 心跳过期多久视为 stale |
| `stateDirName` | `.dsh-file-claim` | 工作区根下的注册表 + 待合并区目录名 |
| `guard` | `true` | 设 `false` 关闭 pre-execute 写入守卫 |
| `heartbeatMs` | `600000`（10min） | 兜底心跳间隔 |

认领注册表与待合并区位于 `<工作区根>/<stateDirName>/`——建议加入 `.gitignore`。状态跨重启
保留；绝不触碰 `.git/`。

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

`release_files` 带解锁检查：指向被释放路径（或释放会话）的待合并条目会出现在释放输出中。

## 拦截边界

守卫是**协作式护栏**，不是强制锁：任意 shell 命令（`echo > file`、`git checkout`、脚本）、
外部编辑器、IDE/git 操作完全绕过工具栈。它把「靠 AGENTS.md 自律」升级为「工具层护栏 +
模型可见状态」，与整个品类的 fail-open 定位一致。

## 开发

```sh
npm test        # node --test：claim.mjs 单测（16）+ index.mjs mock ctx 集成（8）
npm pack --dry-run
```

结构：`claim.mjs` 是零依赖纯逻辑核心（可移植，保留 CLI 入口）；`index.mjs` 是唯一宿主面文件；
`test/` 覆盖两者。

## 许可

MIT
