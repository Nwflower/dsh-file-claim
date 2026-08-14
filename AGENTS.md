# AGENTS.md

`dsh-file-claim` 是 DeepSeek Harness 的 Host 插件：为**同一工作区并行多会话**提供文件认领/保护（claim/release、心跳 stale 接管、pending 异步三路合并区）。DSH 的哲学是 **everything is a plugin**——本仓库只做插件，不碰引擎。改代码前先读 `README.md`（对外契约）、`dev/REQUIREMENTS.md`（需求清单）与 `dev/file-protection-plugin-study.md`（立项评估）。

## 仓库布局：发布面 / 本地工程面

根目录只放发布到 GitHub / npm 的文件；本地工程文件一律收进 `dev/`（gitignore，永不提交）。

```
index.mjs        插件入口（唯一 host 面文件）：注册 claim/release/who/status/pending 工具、事件挂接、拦截守卫
claim.mjs        纯逻辑核心（零 DSH 依赖、可独立单测）——REQ-01 落地后出现
cordis.patch.yml bundle 声明（insert dsh-file-claim）
.github/         GitHub Actions CI（npm test，不进 npm 包）
package.json     npm 包元数据；files 白名单 = 发布内容
README.md        对外契约（英文，GitHub/npm 默认）；README.zh-CN.md 中文版——行为变更必须同步两版
LICENSE          MIT
test/            单测 + mock ctx 集成测试（进 GitHub，不进 npm 包）
dev/             ❌ 本地工程面：REQUIREMENTS.md、HANDOFF.md、file-protection-plugin-study.md、脚本（bin/）、夹具、并发协调状态（sessions/）——永不提交
```

- `package.json` 的 `files` 白名单就是 npm 发布面。新增被 `index.mjs` import 或 README 引用的文件必须同步加进 `files`。
- **永不提交**：`dev/`、`node_modules/`、`.prev-session*.jsonl`、任何凭据/密钥。

## 命令

```sh
npm test        # node --test 跑 test/*.test.mjs（骨架 smoke + claim.mjs 纯函数单测 + index mock 集成测试）
node --test "dev/bin/*.test.mjs"   # dev/bin/session.mjs 并发协调工具的自测（本地工程面）
```

无构建步骤：纯 ESM。DSH 手工验证：`dsh plugin --profile web add -w link:<本仓库路径>` 后重启 dsh，在会话里调用 claim/release 工具。

## 分支纪律

- `main` 是稳定主干：每个 commit 都可通过、可发布。
- 开发在 `dev` 分支进行；一个需求一个 commit（conventional 前缀）；完成一个需求后 `git checkout main && git merge dev`（线性，先 rebase 再 fast-forward），dev 继续下一需求。
- 个人仓库，push 前 `git pull --rebase origin main`；重写已推送历史只用 `--force-with-lease`。

## 提交纪律（保持仓库干净）

- **conventional commit 前缀**：`feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `test:`，中文描述。
- **一个逻辑变更一个 commit**：不混改（重构不带新功能，修 bug 不带 docs），不提交 WIP / 中间态。
- **提交前必过**：
  1. `npm test` 全绿；
  2. `git status` 无杂物（`dev/`、`node_modules/`、快照不得出现在待提交里）；
  3. `git diff --cached --check` 无空白错误。
- **行为变更同 commit 更新 README 与测试**：README 是对外契约，测试描述现有行为。
- 提交信息说明「为什么」而非复述代码；指向关联 issue/REQ 编号。

## 多会话并发开发（并行 Agent 协调）

同一台机器可能并行开多个 Agent 会话操作**同一个工作目录**。会话间靠 `dev/bin/session.mjs`（本地工具，不入库；从 dsh-chat-import 移植，`REPO_ROOT` 自适应本仓库根）协调文件占用，避免互相覆盖、避免共享文档（REQUIREMENTS / HANDOFF / 评估报告）被并发改写。

| 时机 | 动作 |
| --- | --- |
| 会话开始 / 每个里程碑 | `node dev/bin/session.mjs sync --note "本次要做什么"` |
| 动手改文件之前 | `node dev/bin/session.mjs claim <path>...`（他人活跃占用 → 拒绝，exit 1） |
| 对方占用时 | `status` 看谁在用；等对方 `release`，或对方 **stale**（心跳 2h 过期，`DSH_SESSION_STALE_MS` 可调）后 `--force` 接管 |
| **想改的文件被活跃会话占用，又不愿干等** | `pending <path> <新内容文件>` 把改动写进**临时待合并区**（`dev/sessions/pending/`），不阻塞任何会话 |
| commit + push 之后 | `node dev/bin/session.mjs release`（释放认领）——**解锁时会自动检查待合并区**，提示需要新合并的内容 |
| 解锁后被提示有 pending | `pending apply <path>` 三路合并落盘（无冲突自动合并）；有冲突时手动解决后 `pending drop <path>` 清理 |
| 崩溃 / 中断后恢复 | 先 `status`，必要时 `prune` 清掉 stale 记录 |

命令速查：`sync`（登记 + 心跳）`claim`（独占认领）`release`（释放 + 解锁检查）`status`（总览 + 待合并区）`who <path>`（谁占用某文件）`prune`（清 stale）`drop <tag>`（移除会话）`new`（生成 tag）`pending <path> <内容文件>`（写入待合并区）`pending list|show|apply|drop <path>`（查看/合并/丢弃）。完整规则见 `dev/bin/session.mjs` 头注。

## DSH 插件约束

- **只消费 host 公开服务**：`fs`、`tools`、`commands`、`workspaceRegistry`、`storageDomain`、`systemPrompt`、`sessions`/`agents`、`timer`。不发布服务 → 无需 isolate realm；无 Browser 侧（可选 host 路由 UI 除外）。
- **插件，不是引擎改动**：新行为走公开扩展点（工具注册 / 事件挂接 / 策略守卫）；绝不修改 DSH 引擎 / apiproxy / 官方 UI 包。
- **拦截点纪律**：`fs/write-intent` / `fs/edit-intent` 是单槽 waterfall 且被 `dsh-fs-observation-policy` 占用——第三方认领守卫**只能走 `tools/pre-execute`**（或组合层接管槽位，属部署决策，见评估报告 §2.4）。bash/pwsh 写入绕过 fs 工具栈：拦截是协作式护栏，不是强制锁，README 必须写明。
- **身份**：认领身份用 `agents.currentInitiator()` / session id（等价于 shell 环境的 `DSH_SESSION_ID`）。
- **幂等**：重复认领合并；会话已释放/已过期时不重复写。
- **失败要大声**：拒绝认领、合并冲突、base 缺失都要显式报告，绝不静默吞掉。

## 质量约定

- 文件以**恰好一个**换行结尾；空 `catch` 必须说明吞掉什么且 `try` 只包一条语句；不注释代码里显而易见的事实。
- 保持 `claim.mjs` 零依赖纯函数：任何 DSH 依赖只允许出现在 `index.mjs`。
- 测试描述行为而非背书正确性；夹具用合成数据，永不掺真实 transcript。
- 不写行内文档废话：注释写契约与上下文，不叙述控制流。

## 编辑本文件

规则保持自包含；改完须与仓库现状一致（目录、命令、约束过时了要同步更新）。
