# dsh-file-claim

同一工作区**并行 DSH 会话**的文件认领/保护插件。

> **v0.1.0** —— 首个发布版。DSH Host 插件，把 `dsh-chat-import` 中 `dev/bin/session.mjs`
> 验证过的协调协议做成原生工具、生命周期事件与写入守卫。

多个 DSH 会话并行操作同一工作区时，目前彼此无感知：两个会话可能覆盖同一文件、崩溃会话留下
陈旧状态、想改他人已占文件的会话只能干等或赌。`dsh-file-claim` 用认领/心跳/pending 合并协议
解决：

- **claim / release** —— 会话在编辑前声明对文件路径的独占认领。
- **心跳 + stale 接管** —— 心跳自动刷新；崩溃会话的认领过期（默认 2h）后可用 `--force` 接管。
- **异步 pending 合并区** —— 不阻塞：会话把「改好的新内容 + git HEAD base」写入待合并区；
  持有者 release 后 `pending apply` 做 **git 三路合并**（current × base × pending），无冲突自动落盘。
- **拦截** —— 模型可见工具 + `tools/pre-execute` 守卫：拒绝写他人活跃认领文件的工具调用
  （协作式、尽力而为——shell 写入无法完全拦截）。

这是**填补空白而非重复造轮子**：DSH 宿主无内建跨会话文件保护；505 个 `dsh-plugin` topic 仓库
全量扫描零命中文件认领/协调类插件；pending 合并区在 agent 文件锁品类内独有。

## 安装

```sh
dsh plugin add dsh-file-claim
```

开发/手工验证（本地 checkout）：

```sh
dsh plugin --profile web add -w link:<仓库路径>
```

插件是**纯 Host 插件**——无 Browser 侧、无构建步骤。

## 用法

插件注册 8 个模型可见工具（身份即调用会话，无需 `--as`）：

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

生命周期自动化（无需手动心跳）：

- `agent/created` 与 `agent/status` → 自动登记 / 刷新会话心跳。
- `agent/disposed` → 自动释放离开会话的全部认领。
- `ctx.timer` 定时器 → 活跃会话的兜底心跳。

### 写入守卫

`tools/pre-execute` 拒绝 `write` / `edit` / `bash` / `pwsh` 调用中目标路径被**其他**活跃会话
认领的情况。拒绝信息带持有者与建议：等 `release_files`、对方 stale 后 `claim_files(force: true)`
接管、或 `pending_write` 异步写入。`read` **不拦截**——读取是观察不是修改，认领契约只保护写面。
shell 路径解析（`bash`/`pwsh`）为尽力而为：提取引号字面量与重定向目标；解析不出目标即放行
（fail-open）。

### 配置

在 bundle（`cordis.patch.yml`）中作为插件 config 传入：

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `staleMs` | `7200000`（2h） | 心跳过期多久视为 stale |
| `stateDirName` | `.dsh-file-claim` | 工作区根下的注册表 + 待合并区目录名 |
| `guard` | `true` | 设 `false` 关闭 pre-execute 写入守卫 |
| `heartbeatMs` | `600000`（10min） | 兜底心跳间隔 |

认领注册表与待合并区位于 `<工作区根>/<stateDirName>/`——建议加入 `.gitignore`。状态跨重启
保留；绝不触碰 `.git/`。

## Pending 合并区（公开契约）

存储布局（`<工作区根>/<stateDirName>/pending/` 下）：

```
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

## 拦截边界（依赖前必读）

守卫是**协作式护栏**，不是强制锁：任意 shell 命令（`echo > file`、`git checkout`、脚本）、
外部编辑器、IDE/git 操作完全绕过工具栈。它把「靠 AGENTS.md 自律」升级为「工具层护栏 +
模型可见状态」，与整个品类的 fail-open 定位一致。

## 开发

```sh
npm test        # node --test：claim.mjs 单测（16）+ index.mjs mock ctx 集成（6）
npm pack --dry-run
```

结构：`claim.mjs` 是零依赖纯逻辑核心（可移植，保留 CLI 入口）；`index.mjs` 是唯一宿主面文件；
`test/` 覆盖两者。背景见 `dev/REQUIREMENTS.md`（本地、不入库）与评估报告
`dev/file-protection-plugin-study.md`。

## 设计来源

- 可行性评估：`dev/file-protection-plugin-study.md`（本地；按政策不入库）。
- 需求文档：`dev/REQUIREMENTS.md`（本地；按政策不入库）。
- 移植的协议：`dsh-chat-import` 仓库的 `dev/bin/session.mjs`（[Nwflower/dsh-chat-import](https://github.com/Nwflower/dsh-chat-import)）。

## 许可

MIT
