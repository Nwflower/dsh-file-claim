// dsh-file-claim — 同一工作区并行 DSH 会话的文件认领/保护插件（骨架阶段）。
//
// 现状：仅导出最小 Cordis 插件契约（name + apply），apply 为空实现。
// 规划见 dev/REQUIREMENTS.md（REQ-01 claim.mjs 纯逻辑移植；REQ-02 宿主面工具/事件/拦截）。

export default {
  name: 'dsh-file-claim',
  apply(ctx) {
    // TODO(REQ-02): ctx.tools.register claim_files / release_files / who_claims / claim_status / pending_*
    // TODO(REQ-02): agent/created|status|disposed → 自动登记/心跳/释放
    // TODO(REQ-02): tools/pre-execute → 拒绝写他人活跃认领文件的工具调用
    // TODO(REQ-02): ctx.storageDomain → claim 注册表持久化（替代 dev/sessions/registry.json）
  },
}
