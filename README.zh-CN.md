# dsh-file-claim

同一工作区**并行 DSH 会话**的文件认领/保护插件。

> 状态：**规划中** —— 仓库骨架已建，插件行为尚未实现。见 `dev/REQUIREMENTS.md`（本地、不入库）与评估报告 `dev/file-protection-plugin-study.md`（本项目立项的调研与可行性评估）。

## 将实现什么

多个 DSH 会话并行操作同一工作区时，目前彼此无感知：两个会话可能覆盖同一文件、崩溃会话留下陈旧状态、想改他人已占文件的会话只能干等或赌。`dsh-file-claim` 把 `dsh-chat-import` 仓库中验证过的协调协议（`dev/bin/session.mjs`）做成 DSH 原生 Host 插件：

- **claim / release** —— 会话在编辑前声明对文件路径的独占认领。
- **心跳 + stale 接管** —— 会话刷新心跳；崩溃会话的认领过期后可用 `--force` 接管。
- **异步 pending 合并区** —— 不阻塞：会话把「改好的新内容 + git HEAD base」写入待合并区；持有者 release 后 `pending apply` 做 **git 三路合并**（current × base × pending），无冲突自动落盘。
- **拦截** —— 模型可见工具（`claim_files` / `release_files` / `who_claims` / …）+ `tools/pre-execute` 守卫：拒绝写他人活跃认领文件的工具调用（协作式、尽力而为——shell 写入无法完全拦截）。

这是**填补空白而非重复造轮子**：DSH 宿主无内建跨会话文件保护；505 个 `dsh-plugin` topic 仓库全量扫描零命中文件认领/协调类插件；pending 合并区在 agent 文件锁品类内独有。

## 安装（实现后）

```sh
dsh plugin add dsh-file-claim
```

## 设计来源

- 可行性评估：`dev/file-protection-plugin-study.md`（本地；按政策不入库）。
- 需求文档：`dev/REQUIREMENTS.md`（本地；按政策不入库）。
- 移植的协议：`dsh-chat-import` 仓库的 `dev/bin/session.mjs`（[Nwflower/dsh-chat-import](https://github.com/Nwflower/dsh-chat-import)）。

## 许可

MIT
