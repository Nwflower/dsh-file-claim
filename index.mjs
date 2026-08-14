// index.mjs — dsh-file-claim 宿主面（唯一依赖 DSH 宿主服务的文件）
//
// 职责（REQ-02 / REQ-04）：
//   1. 注册模型工具 claim_files / release_files / who_claims / claim_status /
//      pending_write / pending_apply / pending_show / pending_drop；
//   2. 注册人类命令 /claim /release /claim-status（模型不可用时人工可用，复用
//      claim.mjs run()，rawInput 引号感知分词；命令入会话日志、不进模型历史）；
//   3. 事件挂接：agent/created + agent/status → 自动登记/心跳；agent/disposed →
//      自动释放该会话全部认领；ctx.timer.interval 兜底心跳；
//   4. tools/pre-execute 拦截：write/edit/bash/pwsh 目标被**其他活跃**会话认领 →
//      deny（read 不拦截：读取不构成修改，认领只保护写面）；bash/pwsh 只识别
//      重定向目标与显式写命令目标（引号字面量不视为写目标，fail-open）；
//      guardCommit:true 时额外拦截 `git commit` 显式提交他人认领路径（opt-in）；
//   5. 注册表持久化：工作区本地文件（<repoRoot>/.dsh-file-claim/registry.json，
//      原子写 + 互斥锁），由 claim.mjs 纯逻辑承担——零 DSH 依赖、跨重启可恢复；
//   6. 认领根：当前会话 cwd 经 workspaceRegistry.resolveByPath 解析的工作区，无
//      工作区时回退 cwd（多仓库并行天然隔离）。
//
// 身份：exec.agent.id / agent.id（等价 DSH_SESSION_ID）。失败大声、绝不静默吞掉。

import { join } from 'node:path'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { run, normPath, loadRegistry, pathConflict } from './claim.mjs'

const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000
const DEFAULT_STATE_DIR = '.dsh-file-claim'
const DEFAULT_HEARTBEAT_MS = 10 * 60 * 1000

// 写面工具（read 放行：读取不修改内容）
const WRITE_TOOLS = new Set(['write', 'edit', 'bash', 'pwsh'])

const OK_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: '操作是否成功' },
    lines: { type: 'array', items: { type: 'string' }, description: '输出行' },
  },
  required: ['ok', 'lines'],
  additionalProperties: false,
}

const PROTOCOL_SECTION = `## 多会话文件认领协议（dsh-file-claim）

同一工作区可能并行运行多个 DSH 会话。编辑文件前先调用 claim_files 认领独占路径；
写入被其他活跃会话认领的文件会被拦截拒绝。被拒时的三个选择：
1. 等对方 release_files 后再写；
2. 对方已 stale（心跳过期）时 claim_files(force: true) 接管；
3. 用 pending_write 把改好的内容写入待合并区（自动记录 git HEAD base），
   对方 release 后 pending_apply 做三路合并（current × base × pending）。
who_claims / claim_status 可随时查看占用；写完 release_files 释放。`

// ---------- 解析与身份 ----------

function agentId(agent) {
  return agent && typeof agent.id === 'string' ? agent.id : null
}

// 会话 cwd → 工作区根（workspaceRegistry 解析失败/不可用时回退 cwd）
async function resolveRepoRoot(ctx, cwd) {
  const ws = ctx.get('workspaceRegistry')
  if (ws && typeof ws.resolveByPath === 'function') {
    try {
      const w = await ws.resolveByPath(cwd)
      if (w && typeof w.path === 'string') return w.path
    } catch {
      // 解析失败回退 cwd，不阻断
    }
  }
  return cwd
}

// 构造 claim.mjs run() 的上下文（状态目录 = 工作区根的 .dsh-file-claim/）
async function claimCtx(ctx, config, agent) {
  const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined
  if (!cwd) return null
  const repoRoot = await resolveRepoRoot(ctx, cwd)
  if (!repoRoot) return null
  return {
    stateDir: join(repoRoot, config.stateDirName),
    repoRoot,
    env: {},
    now: Date.now(),
    staleMs: config.staleMs,
  }
}

// ---------- 工具注册（makeClaimTool 工厂） ----------

function makeClaimTool(ctx, config, { name, description, properties, required, build }) {
  return {
    name,
    description,
    parameters: { type: 'object', properties, ...(required ? { required } : {}) },
    output: {
      schema: OK_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: value.lines.join('\n') }],
    },
    async execute(args, exec) {
      const tag = agentId(exec.agent)
      if (!tag) {
        return { ok: false, lines: ['无法确定会话身份：工具调用缺少 agent。'] }
      }
      const base = await claimCtx(ctx, config, exec.agent)
      if (!base) {
        return { ok: false, lines: ['无法解析会话工作区：缺少会话 cwd。'] }
      }
      let cleanup = null
      try {
        const built = await build(args, base)
        const argv = Array.isArray(built) ? built : built.argv
        if (!Array.isArray(built)) cleanup = built.cleanup || null
        const res = await run(argv, { ...base, env: { ...base.env, DSH_SESSION_ID: tag } })
        return { ok: res.code === 0, lines: res.lines }
      } catch (e) {
        return { ok: false, lines: ['错误：' + (e && e.message ? e.message : String(e))] }
      } finally {
        if (cleanup) {
          try {
            await cleanup()
          } catch {
            // 临时文件清理失败不影响结果
          }
        }
      }
    },
  }
}

function defineTools(ctx, config) {
  const tools = [
    {
      name: 'claim_files',
      description:
        '认领工作区文件/目录路径（独占）：编辑前调用，其他会话不得再修改。路径越出工作区根被拒绝；被其他活跃会话占用时失败，对方 stale 后可用 force 接管。',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '要认领的文件或目录路径（相对工作区根）' },
        note: { type: 'string', description: '认领备注（可选）' },
        force: { type: 'boolean', description: '对方会话已 stale 时强制接管（默认 false）' },
      },
      required: ['paths'],
      build: (args) => [
        'claim',
        ...(Array.isArray(args.paths) ? args.paths : []),
        ...(args.force ? ['--force'] : []),
        ...(args.note !== undefined ? ['--note', String(args.note)] : []),
      ],
    },
    {
      name: 'release_files',
      description: '释放本会话的文件认领：release_files({paths:[...]}) 释放指定路径；release_files({all:true}) 释放全部。',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '要释放的路径（可选）' },
        all: { type: 'boolean', description: '释放全部认领（默认 false）' },
      },
      build: (args) => ['release', ...(Array.isArray(args.paths) ? args.paths : []), ...(args.all ? ['--all'] : [])],
    },
    {
      name: 'who_claims',
      description: '查询路径当前被哪些会话认领（只读）。',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '要查询的路径' },
      },
      required: ['paths'],
      build: (args) => ['who', ...(Array.isArray(args.paths) ? args.paths : [])],
    },
    {
      name: 'claim_status',
      description: '查看当前工作区的会话登记、认领与待合并区总览（只读）。',
      properties: {},
      build: () => ['status'],
    },
    {
      name: 'pending_write',
      description:
        '异步写入待合并区：目标文件被其他活跃会话认领时，把改好的新内容（含 git HEAD base）写入待合并区；对方 release 后可用 pending_apply 三路合并。无活跃占用时拒绝（应直接 claim 后修改）。',
      properties: {
        path: { type: 'string', description: '目标文件路径（相对工作区根）' },
        content: { type: 'string', description: '改好的新文件内容' },
      },
      required: ['path', 'content'],
      async build(args) {
        const tmp = await mkdtemp(join(tmpdir(), 'dsh-pending-write-'))
        await writeFile(join(tmp, 'content'), args.content, 'utf8')
        return {
          argv: ['pending', args.path, join(tmp, 'content')],
          cleanup: () => rm(tmp, { recursive: true, force: true }),
        }
      },
    },
    {
      name: 'pending_apply',
      description: '对待合并区条目做三路合并（current × base × pending）落盘；无冲突自动清除条目，冲突写标记留条目。要求目标无活跃占用、存在 base。',
      properties: {
        path: { type: 'string', description: '待合并条目路径（相对工作区根）' },
      },
      required: ['path'],
      build: (args) => ['pending', 'apply', args.path],
    },
    {
      name: 'pending_show',
      description: '查看待合并区条目的元信息与内容（只读）。',
      properties: {
        path: { type: 'string', description: '待合并条目路径（相对工作区根）' },
      },
      required: ['path'],
      build: (args) => ['pending', 'show', args.path],
    },
    {
      name: 'pending_drop',
      description: '丢弃待合并区条目（不落盘）。',
      properties: {
        path: { type: 'string', description: '待合并条目路径（相对工作区根）' },
      },
      required: ['path'],
      build: (args) => ['pending', 'drop', args.path],
    },
  ]
  for (const def of tools) {
    ctx.effect(() => ctx.tools.register(makeClaimTool(ctx, config, def)))
  }
}

// ---------- 命令注册（REQ-04：模型不可用时人工可用） ----------

// 最小引号感知分词：rawInput → argv（"..." / '...' 内的空白保留，引号剥掉）。
// 命令行的路径/备注可含空格（如 --note "多 行 备注"）；不用复杂 shell 解析。
function splitCommandArgs(input) {
  const out = []
  let cur = ''
  let quote = null
  for (const ch of String(input)) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

function defineCommands(ctx, config) {
  const commands = ctx.get('commands')
  if (!commands || typeof commands.register !== 'function') return

  // 命令处理器与工具同构：身份 + 工作区解析 + claim.mjs run()，只是 argv 来自 rawInput。
  const makeHandler = (build) => async ({ agent, rawInput }) => {
    const tag = agentId(agent)
    if (!tag) {
      return { kind: 'error', text: '无法确定会话身份：命令缺少 agent。' }
    }
    const base = await claimCtx(ctx, config, agent)
    if (!base) {
      return { kind: 'error', text: '无法解析会话工作区：缺少会话 cwd。' }
    }
    const res = await run(build(splitCommandArgs(rawInput)), {
      ...base,
      env: { ...base.env, DSH_SESSION_ID: tag },
    })
    return res.code === 0
      ? { kind: 'success', text: res.lines.join('\n') }
      : { kind: 'error', text: res.lines.join('\n') }
  }

  const defs = [
    {
      name: 'claim',
      description: '认领工作区文件/目录路径（独占）：编辑前声明，其他会话不得再修改；对方 stale 后可加 --force 接管。',
      input: { hint: '<path>... [--note <备注>] [--force]' },
      build: (argv) => ['claim', ...argv],
    },
    {
      name: 'release',
      description: '释放本会话的文件认领：/release <path>... 释放指定路径，/release --all 释放全部。',
      input: { hint: '[<path>... | --all]' },
      build: (argv) => ['release', ...argv],
    },
    {
      name: 'claim-status',
      description: '查看当前工作区的会话登记、认领与待合并区总览（只读）。',
      build: () => ['status'],
    },
  ]
  for (const def of defs) {
    ctx.effect(() =>
      commands.register({
        name: def.name,
        description: def.description,
        input: def.input,
        handler: makeHandler(def.build),
      }),
    )
  }
}

// ---------- 拦截（tools/pre-execute，写面协作护栏） ----------

// 写命令白名单：pwsh 写 cmdlet（大小写不敏感）+ bash 写命令。
// 只认这些命令的目标参数与重定向目标为「写目标」；其余（引号字面量、普通参数、
// 只读命令）一律不算——引号里的路径多半是数据/URL/模式，不是要写的文件。
const PWSH_WRITE_CMDLETS = new Set([
  'set-content',
  'add-content',
  'out-file',
  'new-item',
  'copy-item',
  'move-item',
  'remove-item',
  'rename-item',
])
const BASH_WRITE_CMDS = new Set(['tee', 'cp', 'mv', 'rm'])
const WRITE_OPTION = /^-(path|literalpath|destination|filepath)$/i
const REDIRECT = /^(?:[12]?>>?|<>)$/
const CMD_BOUNDARY = /^[|;&]$/

function addWriteTarget(out, p) {
  if (p && !p.includes('://') && !/^--/.test(p)) out.add(p)
}

// 写命令的裸参数（位置参数）目标规则：Copy/Move（pwsh 与 bash 同）目标在最后
// （-Destination 位），Remove 全取（删哪个都是写），其余取第一个（-Path 位）。
function positionalTargets(cmd, positional) {
  if (cmd === 'copy-item' || cmd === 'move-item' || cmd === 'cp' || cmd === 'mv') {
    return positional.length ? [positional[positional.length - 1]] : []
  }
  if (cmd === 'remove-item' || cmd === 'rm') return positional
  return positional.length ? [positional[0]] : []
}

// 尽力从 bash/pwsh 命令串提取「写目标」路径：重定向目标 + 显式写命令的目标参数；
// 解析不出 → 放行（fail-open）。引号字面量绝不视为写目标（防只读命令误报）。
function extractShellWriteTargets(command) {
  const out = new Set()
  const tokens = splitCommandArgs(String(command))
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    // 重定向目标
    if (REDIRECT.test(t)) {
      if (tokens[i + 1] !== undefined) addWriteTarget(out, tokens[i + 1])
      continue
    }
    // dd of=目标
    if (t === 'dd') {
      for (let j = i + 1; j < tokens.length && !CMD_BOUNDARY.test(tokens[j]); j++) {
        const m = /^of=(.+)$/.exec(tokens[j])
        if (m) addWriteTarget(out, m[1])
      }
      continue
    }
    const low = t.toLowerCase()
    if (!PWSH_WRITE_CMDLETS.has(low) && !BASH_WRITE_CMDS.has(low)) continue
    // 扫描该命令的参数直到命令边界（| ; &）
    let j = i + 1
    while (j < tokens.length && !CMD_BOUNDARY.test(tokens[j])) j++
    const rest = tokens.slice(i + 1, j)
    const positional = []
    let afterDoubleDash = false
    for (let k = 0; k < rest.length; k++) {
      const tok = rest[k]
      if (afterDoubleDash) {
        positional.push(tok)
        continue
      }
      if (tok === '--') {
        afterDoubleDash = true
        continue
      }
      if (tok.startsWith('-')) {
        if (WRITE_OPTION.test(tok)) {
          if (rest[k + 1] !== undefined) addWriteTarget(out, rest[k + 1])
          k++
        } else if (rest[k + 1] !== undefined && !rest[k + 1].startsWith('-')) {
          k++ // 未知选项：跳过其值（防把选项值误当位置参数）
        }
      } else {
        positional.push(tok)
      }
    }
    for (const p of positionalTargets(low, positional)) addWriteTarget(out, p)
  }
  return [...out]
}

// git commit 路径提取（guardCommit opt-in）：`git commit` 中被提交的路径。
// 只认 `--` 之后的显式路径；-m/--message/-am 等选项跳过其值（防 message 里的路径字样
// 误报）；无路径（裸 `git commit`）→ 无法确定改动范围 → fail-open。
function extractGitCommitPaths(command) {
  const tokens = splitCommandArgs(String(command))
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'git' || tokens[i + 1] !== 'commit') continue
    let j = i + 2
    while (j < tokens.length && !CMD_BOUNDARY.test(tokens[j])) {
      const t = tokens[j]
      if (t === '--') {
        for (let k = j + 1; k < tokens.length && !CMD_BOUNDARY.test(tokens[k]); k++) out.push(tokens[k])
        break
      }
      if (t.startsWith('-')) {
        j += 2 // 跳过选项及其值；无值选项（-a）会跳过真实路径 → fail-open
        continue
      }
      out.push(t) // 老语法：git commit <path>
      j++
    }
    break
  }
  return out
}

function targetsOf(name, args) {
  const a = args || {}
  if (name === 'write' || name === 'edit') {
    return typeof a.file_path === 'string' ? [a.file_path] : []
  }
  if (name === 'bash' || name === 'pwsh') {
    return extractShellWriteTargets(typeof a.command === 'string' ? a.command : '')
  }
  return []
}

async function guardDenyReason(ctx, config, exec) {
  if (config.guard === false) return null
  const name = exec && exec.name
  if (!name || !WRITE_TOOLS.has(name)) return null
  const agent = exec.agent
  const tag = agentId(agent)
  if (!tag) return null
  const targets = targetsOf(name, exec.arguments)
  // commit 级守卫（opt-in）：git commit 显式提交他人认领路径 → 一并检查
  if (config.guardCommit === true && (name === 'bash' || name === 'pwsh')) {
    const cmd = exec.arguments && typeof exec.arguments.command === 'string' ? exec.arguments.command : ''
    targets.push(...extractGitCommitPaths(cmd))
  }
  if (targets.length === 0) return null // 解析不出目标 → 放行
  const cwd = agent && agent.session && agent.session.header ? agent.session.header.cwd : undefined
  if (!cwd) return null
  const repoRoot = await resolveRepoRoot(ctx, cwd)
  const stateDir = join(repoRoot, config.stateDirName)
  let reg
  try {
    reg = await loadRegistry(stateDir)
  } catch {
    return null // 注册表不可读 → 放行（不因本插件破坏正常写入）
  }
  const now = Date.now()
  const hits = []
  for (const t of targets) {
    const n = normPath(t, repoRoot)
    if (!n) continue
    const holders = Object.keys(reg.sessions).filter((s) => s !== tag && pathConflict(reg.sessions[s].claims, [n]))
    const active = holders.filter((s) => now - reg.sessions[s].lastSeenAt <= config.staleMs)
    if (active.length > 0) hits.push(n + '（' + active.join('、') + '）')
  }
  if (hits.length === 0) return null
  return (
    'dsh-file-claim 拦截：' +
    hits.join('；') +
    ' 正被其他活跃会话认领，拒绝本次写入。建议：等对方 release_files；或对方已 stale 时 claim_files(force:true) 接管；或用 pending_write 写入待合并区，对方 release 后 pending_apply 三路合并。'
  )
}

// ---------- 生命周期：自动登记 / 心跳 / 释放 ----------

async function autoRun(ctx, config, agent, argv) {
  try {
    const tag = agentId(agent)
    if (!tag) return
    const base = await claimCtx(ctx, config, agent)
    if (!base) return
    await run(argv, { ...base, env: { ...base.env, DSH_SESSION_ID: tag } })
  } catch {
    // 自动动作失败不阻断宿主（下次心跳/事件重试）
  }
}

// ---------- 插件入口 ----------

export default {
  name: 'dsh-file-claim',
  inject: ['tools'],
  apply(ctx, config = {}) {
    const cfg = {
      staleMs: DEFAULT_STALE_MS,
      stateDirName: DEFAULT_STATE_DIR,
      guard: true,
      guardCommit: false,
      heartbeatMs: DEFAULT_HEARTBEAT_MS,
      ...config,
    }

    // 1. 工具
    defineTools(ctx, cfg)

    // 2. 人类命令（模型不可用时人工可用）
    defineCommands(ctx, cfg)

    // 3. 生命周期事件
    ctx.on('agent/created', ({ agent }) => {
      void autoRun(ctx, cfg, agent, ['sync'])
    })
    ctx.on('agent/status', ({ agent }) => {
      void autoRun(ctx, cfg, agent, ['sync'])
    })
    ctx.on('agent/disposed', ({ agent }) => {
      void autoRun(ctx, cfg, agent, ['release', '--all'])
    })

    // 兜底心跳：agent/status 事件之外，定期刷新所有活跃会话心跳
    const timer = ctx.get('timer')
    if (timer && typeof timer.interval === 'function') {
      ctx.effect(() =>
        timer.interval(() => {
          const agents = ctx.get('agents')
          if (!agents || typeof agents.list !== 'function') return
          for (const a of agents.list()) void autoRun(ctx, cfg, a, ['sync'])
        }, cfg.heartbeatMs),
      )
    }

    // 3. 拦截
    ctx.on('tools/pre-execute', async (exec, next) => {
      try {
        const reason = await guardDenyReason(ctx, cfg, exec)
        if (reason) return { kind: 'deny', reason }
      } catch {
        // 守卫自身出错 → 放行（fail-open，不阻断宿主工具面）
      }
      return next()
    })

    // 4. 协议注入（模型在提示词里看到 claim/release/pending 纪律）
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt && typeof systemPrompt.section === 'function') {
      ctx.effect(() => systemPrompt.section({ name: 'dsh-file-claim-protocol', order: 120, text: PROTOCOL_SECTION }))
    }
  },
}
