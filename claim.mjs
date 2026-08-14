#!/usr/bin/env node
// claim.mjs — dsh-file-claim 纯逻辑核心（零 DSH 依赖，Node >= 18）
//
// 移植自 dsh-chat-import 的 dev/bin/session.mjs（661 行零依赖 CLI，16 自测），
// 语义不变：同一工作区并行多 Agent 会话的文件认领/保护协议。本模块只含纯逻辑，
// 不依赖任何 DSH 宿主服务；宿主集成（工具/事件/拦截）在 index.mjs。
//
// 协议（与 dsh-chat-import 完全一致）：
//   - claim 独占认领：他人活跃占用时拒绝；会话崩溃后心跳过期（默认 2h）视为
//     stale，可用 --force 接管（被接管者丢掉的只有认领，文件内容不受影响）。
//   - sync 刷新心跳并更新备注；每次 commit/push 后应调用一次。
//   - release 释放认领；状态只在 stateDir 下，绝不触碰 .git/。
//   - pending 待合并区：他人活跃占用时，把「改好的新内容 + git HEAD base」写入
//     待合并区；持有者 release（解锁）时检查提示；pending apply 用 git merge-file
//     三路合并（current × base × pending），无冲突自动落盘、冲突写标记留条目、
//     base 缺失拒盲合、apply 要求无活跃占用。
//
// 身份默认取环境变量 DSH_SESSION_ID（DSH 注入，每个 Agent 会话唯一），
// 可用 --as <tag> 覆盖。测试用 ctx.stateDir / ctx.now / ctx.mergeFile 注入。
//
// 用法速查：
//   node claim.mjs new
//   node claim.mjs sync --note "做什么"
//   node claim.mjs claim <path>... [--note ".."] [--force]
//   node claim.mjs release [<path>... | --all]
//   node claim.mjs status | who <path>...
//   node claim.mjs prune | drop <tag> [--force]
//   node claim.mjs audit [n]                       # 查看最近 n 条操作审计（默认 10）
//   node claim.mjs pending <path> <内容文件|-表示stdin>   # 写入待合并区
//   node claim.mjs pending list | show <path> | apply <path> | drop <path>

import { open, readFile, rename, stat, unlink, writeFile, mkdir, copyFile, readdir, appendFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join, relative, resolve, sep } from 'node:path'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'

// 默认仓库根 = 本模块所在目录（CLI 直跑语义）；宿主集成时由 index.mjs 传 ctx.repoRoot。
const MODULE_ROOT = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '')
const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000 // 心跳 2 小时未刷新 → stale
const LOCK_TIMEOUT_MS = 10_000
const LOCK_POLL_MS = 100
const LOCK_STALE_MS = 60_000

export function stateDirOf(env, repoRoot) {
  return env.DSH_SESSION_STATE || join(repoRoot, 'dev', 'sessions')
}
export function staleMsOf(env) {
  const n = Number(env.DSH_SESSION_STALE_MS)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_STALE_MS
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------- 路径 ----------

// 把用户输入（相对/绝对/Windows 或 POSIX 风格）归一化为仓库根相对路径，
// 统一用 '/' 分隔；越出仓库根返回 null。'.' 表示整仓库。
export function normPath(input, repoRoot) {
  const raw = String(input).trim().replace(/^"|"$/g, '')
  if (!raw) return null
  if (raw === '.') return '.'
  const abs = resolve(repoRoot, raw)
  if (abs !== repoRoot && !abs.startsWith(repoRoot + sep)) return null
  const rel = relative(repoRoot, abs).replace(/\\/g, '/')
  return rel === '' ? '.' : rel
}

// 两个认领是否重叠：'.' 覆盖一切；目录认领覆盖其下所有路径；大小写不敏感
// （Windows 文件系统不区分大小写）。
export function claimsOverlap(a, b) {
  if (a === '.' || b === '.') return true
  const x = a.toLowerCase()
  const y = b.toLowerCase()
  return x === y || x.startsWith(y + '/') || y.startsWith(x + '/')
}

export function pathConflict(claimed, wanted) {
  return claimed.some((c) => wanted.some((w) => claimsOverlap(c, w)))
}

// ---------- 注册表读写（原子：临时文件 + rename） ----------

async function ensureStateDir(dir) {
  await mkdir(dir, { recursive: true })
}

export async function loadRegistry(stateDir) {
  await ensureStateDir(stateDir)
  try {
    const raw = await readFile(join(stateDir, 'registry.json'), 'utf8')
    const reg = JSON.parse(raw)
    if (!reg || typeof reg !== 'object' || typeof reg.sessions !== 'object') {
      throw new Error('registry.json 结构损坏')
    }
    return reg
  } catch (e) {
    if (e.code === 'ENOENT') return { version: 1, sessions: {} }
    throw e
  }
}

export async function saveRegistry(stateDir, reg) {
  const tmp = join(stateDir, 'registry.json.tmp')
  await writeFile(tmp, JSON.stringify(reg, null, 2) + '\n', 'utf8')
  await rename(tmp, join(stateDir, 'registry.json'))
}

// ---------- 操作审计（audit.jsonl，append 一行一个事件） ----------
//
// 记录业务变更（claim/release/接管/pending 写·apply·drop/prune/drop），供追溯与
// 崩溃后核对。心跳（sync）不记——避免噪音。审计是附加记录，不参与协议语义；
// 写入失败不阻断操作（append 单行原子，失败只会丢这一条）。

export async function appendAudit(stateDir, entry) {
  try {
    await appendFile(join(stateDir, 'audit.jsonl'), JSON.stringify(entry) + '\n', 'utf8')
    return null
  } catch (e) {
    return '审计写入失败（不影响操作）：' + (e && e.message ? e.message : String(e))
  }
}

// 读最近 count 条审计（倒序，最新在前）；文件不存在返回 []。
export async function readAudit(stateDir, count = 10) {
  try {
    const raw = await readFile(join(stateDir, 'audit.jsonl'), 'utf8')
    const all = raw
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l)
        } catch {
          return null
        }
      })
      .filter(Boolean)
    return all.slice(-count).reverse()
  } catch {
    return []
  }
}

function fmtAuditEntry(e) {
  const who = e.tag ? ' ' + e.tag : ''
  const what = e.paths && e.paths.length ? ' ' + e.paths.join(', ') : e.path ? ' ' + e.path : ''
  return '  ' + fmtTime(e.at) + who + ' ' + e.type + what + (e.detail ? '（' + e.detail + '）' : '')
}

// ---------- 互斥锁（'wx' 独占创建，跨进程原子） ----------

async function acquireLock(stateDir) {
  await ensureStateDir(stateDir)
  const lockPath = join(stateDir, '.lock')
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx')
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }))
      await fh.close()
      return
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        const st = await stat(lockPath)
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => {}) // 上次进程崩溃残留的锁
          continue
        }
      } catch {
        continue // 锁刚被释放
      }
      if (Date.now() > deadline) {
        throw new Error('等待会话锁超时（' + lockPath + ' 被占用）')
      }
      await sleep(LOCK_POLL_MS)
    }
  }
}

async function releaseLock(stateDir) {
  await unlink(join(stateDir, '.lock')).catch(() => {})
}

async function withLock(stateDir, fn) {
  await acquireLock(stateDir)
  try {
    return await fn()
  } finally {
    await releaseLock(stateDir)
  }
}

// ---------- 会话身份 ----------

export function resolveTag(argv, env) {
  const idx = argv.indexOf('--as')
  const v = idx !== -1 ? argv[idx + 1] : undefined
  if (v && !v.startsWith('-')) return v
  return env.DSH_SESSION_ID || null
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function fmtDuration(ms) {
  const m = Math.round(ms / 60000)
  return m < 1 ? '不足 1 分钟' : m < 60 ? m + ' 分钟' : Math.round(m / 60) + ' 小时'
}

// ---------- 命令（ctx: { stateDir, repoRoot, tag, now, env, staleMs }） ----------

function cmdNew() {
  return { code: 0, lines: ['s-' + randomBytes(4).toString('hex')] }
}

// 只读；registry.json 经原子 rename 写入，读到的永远是完整版本，无需拿锁。
async function cmdStatus(ctx) {
  const reg = await loadRegistry(ctx.stateDir)
  const lines = []
  const tags = Object.keys(reg.sessions)
  if (tags.length === 0) {
    lines.push('当前没有登记的会话。')
  }
  for (const t of tags.sort()) {
    const s = reg.sessions[t]
    const stale = ctx.now - s.lastSeenAt > ctx.staleMs
    const me = t === ctx.tag ? '（本会话）' : ''
    lines.push('会话 ' + t + ' ' + me + (stale ? ' [stale]' : ' [活跃]'))
    lines.push('  开始于 ' + fmtTime(s.startedAt) + '，最近心跳 ' + fmtDuration(ctx.now - s.lastSeenAt) + ' 前')
    if (s.note) lines.push('  备注：' + s.note)
    if (s.claims.length === 0) {
      lines.push('  认领：无')
    } else {
      lines.push('  认领：' + s.claims.join(', '))
    }
  }
  const pending = await listPendingEntries(ctx.stateDir)
  if (pending.length > 0) {
    lines.push('')
    lines.push('待合并区（' + pending.length + ' 项，用 pending apply/show/drop 处理）：')
    for (const p of pending) lines.push('  - ' + fmtPendingMeta(p.rel, p.meta))
  }
  const recent = await readAudit(ctx.stateDir, 3)
  if (recent.length > 0) {
    lines.push('')
    lines.push('最近审计（audit [n] 查看全部）：')
    for (const e of recent) lines.push(fmtAuditEntry(e))
  }
  return { code: 0, lines }
}

async function cmdAudit(ctx, countArg) {
  const n = countArg ? Math.min(50, Math.max(1, Number(countArg) || 10)) : 10
  const entries = await readAudit(ctx.stateDir, n)
  if (entries.length === 0) return { code: 0, lines: ['暂无审计记录。'] }
  return { code: 0, lines: ['最近审计（' + entries.length + ' 条）：', ...entries.map(fmtAuditEntry)] }
}

async function cmdSync(ctx, opts) {
  return withLock(ctx.stateDir, async () => {
    const reg = await loadRegistry(ctx.stateDir)
    const s = reg.sessions[ctx.tag] || { startedAt: ctx.now, claims: [] }
    s.lastSeenAt = ctx.now
    if (opts.note !== undefined) s.note = opts.note
    reg.sessions[ctx.tag] = s
    await saveRegistry(ctx.stateDir, reg)
    return cmdStatus(ctx)
  })
}

async function cmdClaim(ctx, opts, paths) {
  if (paths.length === 0) {
    return { code: 1, lines: ['用法：claim <path>... [--note ".."] [--force]'] }
  }
  const normed = []
  for (const p of paths) {
    const n = normPath(p, ctx.repoRoot)
    if (n === null) return { code: 1, lines: ['拒绝认领 ' + p + '：路径越出仓库根'] }
    normed.push(n)
  }
  return withLock(ctx.stateDir, async () => {
    const reg = await loadRegistry(ctx.stateDir)
    const mine = reg.sessions[ctx.tag] || { startedAt: ctx.now, claims: [] }
    const blockers = Object.keys(reg.sessions).filter((t) => t !== ctx.tag && pathConflict(reg.sessions[t].claims, normed))
    const active = blockers.filter((t) => ctx.now - reg.sessions[t].lastSeenAt <= ctx.staleMs)
    if (active.length > 0) {
      const who = active.map((t) => t + '（' + reg.sessions[t].claims.join(', ') + '）').join('；')
      return {
        code: 1,
        lines: [
          '认领失败：' + normed.join(', ') + ' 正被活跃会话占用 —— ' + who,
          '请先 status 看占用详情；等对方 release，或对方 stale 后用 --force 接管。',
        ],
      }
    }
    const lines = []
    if (blockers.length > 0 && !opts.force) {
      return {
        code: 1,
        lines: [
          '认领失败：' + normed.join(', ') + ' 被 stale 会话占用（' + blockers.join('、') + '）。',
          '确认对方已不在工作后可加 --force 接管。',
        ],
      }
    }
    for (const t of blockers) {
      reg.sessions[t].claims = reg.sessions[t].claims.filter((c) => !normed.some((w) => claimsOverlap(c, w)))
      lines.push('[接管] 已从 stale 会话 ' + t + ' 收回 ' + normed.join(', '))
    }
    for (const n of normed) {
      if (!mine.claims.some((c) => c === n)) mine.claims.push(n)
    }
    mine.lastSeenAt = ctx.now
    if (opts.note !== undefined) mine.note = opts.note
    reg.sessions[ctx.tag] = mine
    await saveRegistry(ctx.stateDir, reg)
    lines.push('已认领：' + mine.claims.join(', '), '其他会话不得修改这些文件；完成后 release。')
    const warn = await appendAudit(ctx.stateDir, {
      at: ctx.now,
      tag: ctx.tag,
      type: blockers.length > 0 ? 'takeover' : 'claim',
      paths: normed,
      detail: blockers.length > 0 ? '接管 stale: ' + blockers.join('、') : undefined,
    })
    if (warn) lines.push('⚠️ ' + warn)
    return { code: 0, lines }
  })
}

async function cmdRelease(ctx, opts, paths) {
  return withLock(ctx.stateDir, async () => {
    const reg = await loadRegistry(ctx.stateDir)
    const mine = reg.sessions[ctx.tag]
    if (!mine || mine.claims.length === 0) {
      return { code: 0, lines: ['本会话没有认领可释放。'] }
    }
    let toRelease = []
    if (paths.length > 0) {
      const normed = []
      for (const p of paths) {
        const n = normPath(p, ctx.repoRoot)
        if (n === null) return { code: 1, lines: ['拒绝释放 ' + p + '：路径越出仓库根'] }
        normed.push(n)
      }
      toRelease = mine.claims.filter((c) => normed.some((n) => n === c))
    } else if (opts.all) {
      toRelease = [...mine.claims]
    } else {
      return { code: 0, lines: ['未指定释放范围：release <path>... 或 release --all'] }
    }
    mine.claims = mine.claims.filter((c) => !toRelease.includes(c))
    mine.lastSeenAt = ctx.now
    if (mine.claims.length === 0 && !mine.note) {
      delete reg.sessions[ctx.tag]
    } else {
      reg.sessions[ctx.tag] = mine
    }
    await saveRegistry(ctx.stateDir, reg)
    const lines = [
      '已释放：' + (toRelease.length ? toRelease.join(', ') : '（无匹配认领）'),
      mine.claims.length ? '剩余认领：' + mine.claims.join(', ') : '认领已清空。',
    ]
    // 解锁检查：本次释放的路径（或指向本会话的）有待合并内容 → 自动尝试无冲突合并并提示。
    const pendingLines = await pendingUnlockCheck(ctx, toRelease, ctx.tag)
    if (pendingLines.length > 0) lines.push('', ...pendingLines)
    const warn = await appendAudit(ctx.stateDir, { at: ctx.now, tag: ctx.tag, type: 'release', paths: toRelease })
    if (warn) lines.push('⚠️ ' + warn)
    return { code: 0, lines }
  })
}

async function cmdWho(ctx, paths) {
  if (paths.length === 0) return { code: 1, lines: ['用法：who <path>...'] }
  const reg = await loadRegistry(ctx.stateDir)
  const lines = []
  for (const p of paths) {
    const n = normPath(p, ctx.repoRoot)
    if (n === null) {
      lines.push(p + '：路径越出仓库根')
      continue
    }
    const holders = Object.keys(reg.sessions).filter((t) => pathConflict(reg.sessions[t].claims, [n]))
    lines.push(n + '：' + (holders.length ? '被 ' + holders.join('、') + ' 认领' : '无人占用'))
  }
  return { code: 0, lines }
}

async function cmdPrune(ctx) {
  return withLock(ctx.stateDir, async () => {
    const reg = await loadRegistry(ctx.stateDir)
    const stale = Object.keys(reg.sessions).filter((t) => ctx.now - reg.sessions[t].lastSeenAt > ctx.staleMs)
    for (const t of stale) delete reg.sessions[t]
    await saveRegistry(ctx.stateDir, reg)
    const lines = [stale.length ? '已清理 stale 会话：' + stale.join('、') : '没有 stale 会话。']
    if (stale.length > 0) {
      const warn = await appendAudit(ctx.stateDir, { at: ctx.now, tag: ctx.tag, type: 'prune', paths: stale })
      if (warn) lines.push('⚠️ ' + warn)
    }
    return { code: 0, lines }
  })
}

async function cmdDrop(ctx, opts, target) {
  return withLock(ctx.stateDir, async () => {
    const reg = await loadRegistry(ctx.stateDir)
    const s = reg.sessions[target]
    if (!s) return { code: 0, lines: ['没有会话 ' + target + '。'] }
    const stale = ctx.now - s.lastSeenAt > ctx.staleMs
    if (target !== ctx.tag && !stale && !opts.force) {
      return { code: 1, lines: [target + ' 仍活跃，drop 需要 --force（会丢弃其认领记录）。'] }
    }
    delete reg.sessions[target]
    await saveRegistry(ctx.stateDir, reg)
    const warn = await appendAudit(ctx.stateDir, { at: ctx.now, tag: ctx.tag, type: 'drop', path: target })
    return { code: 0, lines: warn ? ['已移除会话 ' + target + '。', '⚠️ ' + warn] : ['已移除会话 ' + target + '。'] }
  })
}

// ---------- 待合并区（pending）----------
//
// 场景：会话 B 想改一个被活跃会话 A 认领的文件（如 README.md）。按协议 B 不能
// 直接改；与其干等，B 可以把「改好的新内容」写进待合并区（stateDir/pending/
// <路径>/），A release（解锁）时会自动检查并提示待合并内容，随后由 B（或任一会话）
// 用 `pending apply` 做三路合并落盘。
//
// 存储结构（全部在 stateDir/pending/ 下，本地工程面，永不入库）：
//   pending/<relpath>/content     待合并的新文件内容
//   pending/<relpath>/base        写入时 git HEAD 版本的内容（三路合并的公共祖先）
//   pending/<relpath>/meta.json   { pender, claimedBy, at, baseSha }

export function pendingRoot(stateDir) {
  return join(stateDir, 'pending')
}

export function pendingEntryDir(stateDir, rel) {
  return join(stateDir, 'pending', rel)
}

export async function loadPendingMeta(stateDir, rel) {
  try {
    return JSON.parse(await readFile(join(pendingEntryDir(stateDir, rel), 'meta.json'), 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

// 递归收集 pending 条目 [{ rel, meta }]，按路径排序；目录不存在返回 []。
export async function listPendingEntries(stateDir) {
  const root = pendingRoot(stateDir)
  const out = []
  async function walk(dir) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full)
      } else if (e.name === 'meta.json') {
        const rel = relative(root, dir).replace(/\\/g, '/')
        out.push({ rel, meta: JSON.parse(await readFile(full, 'utf8')) })
      }
    }
  }
  await walk(root)
  out.sort((a, b) => a.rel.localeCompare(b.rel))
  return out
}

function fmtPendingMeta(rel, meta) {
  return rel + '（来自 ' + meta.pender + '，写入 ' + fmtTime(meta.at) + (meta.baseSha ? '，base ' + meta.baseSha.slice(0, 7) : '') + '）'
}

// 解锁检查：release 后调用。对被释放路径（或指向释放会话）的 pending 条目**自动尝试**
// 无冲突三路合并：成功落盘并清除；失败（占用/缺 base/冲突/文件缺失）保留并提示手动。
async function pendingUnlockCheck(ctx, released, releasedBy) {
  const all = await listPendingEntries(ctx.stateDir)
  const hits = all.filter(
    (p) => p.meta.claimedBy === releasedBy || released.some((r) => p.rel === r || p.rel.startsWith(r + '/')),
  )
  if (hits.length === 0) return []
  const lines = ['⚠️ 解锁检查：以下待合并内容已处理 ——']
  for (const p of hits) {
    const r = await mergePendingEntry(ctx, p.rel)
    if (r.ok) {
      const warn = await appendAudit(ctx.stateDir, {
        at: ctx.now,
        tag: ctx.tag,
        type: 'pending-apply',
        path: p.rel,
        detail: 'release 自动合并',
      })
      lines.push('  - ' + p.rel + '：已自动三路合并落盘（来自 ' + p.meta.pender + '）' + (warn ? '（⚠️ ' + warn + '）' : ''))
    } else {
      const why =
        r.reason === 'conflicts'
          ? '合并冲突（已写冲突标记）'
          : r.reason === 'no-base'
            ? '缺 base'
            : r.reason === 'no-file'
              ? '当前文件不存在'
              : r.reason === 'occupied'
                ? '仍被占用（' + r.detail + '）'
                : r.reason === 'merge-failed'
                  ? '合并失败：' + r.detail
                  : '条目不存在'
      lines.push('  - ' + fmtPendingMeta(p.rel, p.meta) + '：自动合并未执行（' + why + '）')
      lines.push('    → pending apply ' + p.rel + ' / pending show ' + p.rel + ' / pending drop ' + p.rel)
    }
  }
  return lines
}

// 对单个 pending 条目执行三路合并（须在 withLock 内调用）。返回：
//   { ok: true }                已合并落盘、条目清除（无冲突）
//   { ok: false, reason, detail? }  未完成合并（条目保留）
// reason: 'no-entry' | 'occupied' | 'no-file' | 'no-base' | 'conflicts'（已写冲突标记）| 'merge-failed'
async function mergePendingEntry(ctx, n) {
  const meta = await loadPendingMeta(ctx.stateDir, n)
  if (!meta) return { ok: false, reason: 'no-entry' }
  const reg = await loadRegistry(ctx.stateDir)
  const holders = Object.keys(reg.sessions).filter((t) => pathConflict(reg.sessions[t].claims, [n]))
  const active = holders.filter((t) => ctx.now - reg.sessions[t].lastSeenAt <= ctx.staleMs)
  if (active.length > 0) return { ok: false, reason: 'occupied', detail: active.join('、') }
  const dir = pendingEntryDir(ctx.stateDir, n)
  const currentPath = join(ctx.repoRoot, n)
  let current
  try {
    current = await readFile(currentPath, 'utf8')
  } catch (e) {
    return { ok: false, reason: 'no-file', detail: e.code }
  }
  let base
  try {
    base = await readFile(join(dir, 'base'), 'utf8')
  } catch {
    base = null
  }
  if (base === null) return { ok: false, reason: 'no-base' }
  const other = await readFile(join(dir, 'content'), 'utf8')
  const merge = ctx.mergeFile || gitMergeFile
  // 三路合并需要真实文件路径；把 current/base/other 落到临时文件再调 merge。
  const tmp = join(tmpdir(), 'dsh-apply-' + randomBytes(4).toString('hex'))
  await mkdir(tmp, { recursive: true })
  try {
    const curF = join(tmp, 'current')
    const baseF = join(tmp, 'base')
    const otherF = join(tmp, 'other')
    await writeFile(curF, current, 'utf8')
    await writeFile(baseF, base, 'utf8')
    await writeFile(otherF, other, 'utf8')
    const res = await merge(curF, baseF, otherF)
    if (res.ok) {
      await writeFile(currentPath, res.content, 'utf8')
      await rmSync(dir, { recursive: true, force: true })
      return { ok: true }
    }
    if (res.conflicts) {
      await writeFile(currentPath, res.content, 'utf8')
      return { ok: false, reason: 'conflicts' }
    }
    return { ok: false, reason: 'merge-failed', detail: res.message || '未知错误' }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// git 三路合并（默认实现，可被 ctx.mergeFile 注入替换以便测试）。
export async function gitMergeFile(currentPath, basePath, otherPath) {
  const tmp = join(tmpdir(), 'dsh-merge-' + randomBytes(4).toString('hex'))
  await mkdir(tmp, { recursive: true })
  try {
    const cur = join(tmp, 'current')
    const base = join(tmp, 'base')
    const other = join(tmp, 'other')
    await copyFile(currentPath, cur)
    await copyFile(basePath, base)
    await copyFile(otherPath, other)
    const r = spawnSync('git', ['merge-file', '-p', cur, base, other], { encoding: 'utf8' })
    if (r.error) return { ok: false, content: '', message: 'git 调用失败：' + r.error.message }
    return {
      ok: r.status === 0,
      conflicts: r.status === 1,
      content: r.stdout || '',
      message: r.status > 1 ? (r.stderr || 'git merge-file 异常') : '',
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

async function gitHeadInfo(rel, repoRoot) {
  // 返回 { baseSha, base }：git HEAD 的 commit sha 与文件内容；失败返回空值（不阻断 pending）。
  try {
    const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' })
    if (sha.error || sha.status !== 0) return { baseSha: null, base: null }
    const show = spawnSync('git', ['show', 'HEAD:' + rel], { cwd: repoRoot, encoding: 'utf8' })
    if (show.error || show.status !== 0) return { baseSha: sha.stdout.trim() || null, base: null }
    return { baseSha: sha.stdout.trim() || null, base: show.stdout }
  } catch {
    return { baseSha: null, base: null }
  }
}

async function cmdPending(ctx, opts, sub, rest) {
  // 两种形式：
  //   写入：pending <path> <内容文件|->
  //   操作：pending list | show <path> | apply <path> | drop <path>
  if (sub === 'list') {
    const all = await listPendingEntries(ctx.stateDir)
    if (all.length === 0) return { code: 0, lines: ['待合并区为空。'] }
    return { code: 0, lines: ['待合并内容（' + all.length + ' 项）：', ...all.map((p) => '  - ' + fmtPendingMeta(p.rel, p.meta))] }
  }

  if (sub === 'show' || sub === 'apply' || sub === 'drop') {
    if (!rest[0]) return { code: 1, lines: ['用法：pending ' + sub + ' <path>'] }
    const n = normPath(rest[0], ctx.repoRoot)
    if (n === null || n === '.') return { code: 1, lines: ['拒绝操作 ' + rest[0] + '：路径越出仓库根或为整仓库'] }

    if (sub === 'show') {
      const meta = await loadPendingMeta(ctx.stateDir, n)
      if (!meta) return { code: 1, lines: [n + ' 没有待合并内容。'] }
      const content = await readFile(join(pendingEntryDir(ctx.stateDir, n), 'content'), 'utf8')
      return { code: 0, lines: [fmtPendingMeta(n, meta), '---', content, '---'] }
    }

    if (sub === 'drop') {
      return withLock(ctx.stateDir, async () => {
        const meta = await loadPendingMeta(ctx.stateDir, n)
        if (!meta) return { code: 1, lines: [n + ' 没有待合并内容。'] }
        await rmSync(join(pendingEntryDir(ctx.stateDir, n)), { recursive: true, force: true })
        const warn = await appendAudit(ctx.stateDir, { at: ctx.now, tag: ctx.tag, type: 'pending-drop', path: n })
        return { code: 0, lines: warn ? ['已丢弃待合并内容：' + n + '（来自 ' + meta.pender + '）', '⚠️ ' + warn] : ['已丢弃待合并内容：' + n + '（来自 ' + meta.pender + '）'] }
      })
    }

    // apply：三路合并
    return withLock(ctx.stateDir, async () => {
      const r = await mergePendingEntry(ctx, n)
      if (r.ok) {
        const warn = await appendAudit(ctx.stateDir, { at: ctx.now, tag: ctx.tag, type: 'pending-apply', path: n, detail: '已合并' })
        return { code: 0, lines: warn ? ['已合并：' + n + '（三路合并，无冲突，待合并内容已清除）。', '⚠️ ' + warn] : ['已合并：' + n + '（三路合并，无冲突，待合并内容已清除）。'] }
      }
      if (r.reason === 'no-entry') return { code: 1, lines: [n + ' 没有待合并内容。'] }
      if (r.reason === 'occupied') return { code: 1, lines: [n + ' 仍被活跃会话占用（' + r.detail + '），先等其 release 再合并。'] }
      if (r.reason === 'no-file') return { code: 1, lines: [n + ' 当前文件不存在（' + r.detail + '），无法合并。'] }
      if (r.reason === 'no-base') {
        return { code: 1, lines: [n + ' 缺少 base（写入时无 git HEAD 版本），无法自动合并——请 pending show 查看后手动处理，或 pending drop 丢弃。'] }
      }
      if (r.reason === 'conflicts') {
        const warn = await appendAudit(ctx.stateDir, { at: ctx.now, tag: ctx.tag, type: 'pending-apply', path: n, detail: '冲突留标记' })
        return {
          code: 1,
          lines: warn
            ? ['合并冲突：' + n + ' —— 已写入冲突标记到工作树，请手动解决后执行 pending drop ' + n + ' 清理。', '⚠️ ' + warn]
            : ['合并冲突：' + n + ' —— 已写入冲突标记到工作树，请手动解决后执行 pending drop ' + n + ' 清理。'],
        }
      }
      return { code: 1, lines: ['合并失败：' + n + ' —— ' + (r.detail || '未知错误')] }
    })
  }

  // 写入形式：pending <path> <内容文件>（sub 是目标路径，rest[0] 是内容文件）
  const n = normPath(sub, ctx.repoRoot)
  if (n === null || n === '.') return { code: 1, lines: ['拒绝操作 ' + sub + '：路径越出仓库根或为整仓库'] }
  const contentFile = rest[0]
  if (!contentFile) return { code: 1, lines: ['用法：pending <path> <内容文件>（- 表示从 stdin 读）'] }
  return withLock(ctx.stateDir, async () => {
    const reg = await loadRegistry(ctx.stateDir)
    const holders = Object.keys(reg.sessions).filter((t) => t !== ctx.tag && pathConflict(reg.sessions[t].claims, [n]))
    const active = holders.filter((t) => ctx.now - reg.sessions[t].lastSeenAt <= ctx.staleMs)
    if (active.length === 0) {
      return {
        code: 1,
        lines: [n + ' 没有活跃会话占用——直接 claim 后修改即可，无需 pending。' + (holders.length ? '（对方已 stale，可 claim --force 接管）' : '')],
      }
    }
    let content
    try {
      content = contentFile === '-' ? await readFile(0, 'utf8') : await readFile(resolve(ctx.repoRoot, contentFile), 'utf8')
    } catch (e) {
      return { code: 1, lines: ['读取内容失败：' + (e && e.message ? e.message : String(e))] }
    }
    const dir = pendingEntryDir(ctx.stateDir, n)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'content'), content, 'utf8')
    const { baseSha, base } = await gitHeadInfo(n, ctx.repoRoot)
    if (base !== null) await writeFile(join(dir, 'base'), base, 'utf8')
    const meta = { pender: ctx.tag, claimedBy: active[0], at: ctx.now, baseSha }
    await writeFile(join(dir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8')
    const warn = await appendAudit(ctx.stateDir, {
      at: ctx.now,
      tag: ctx.tag,
      type: 'pending-write',
      path: n,
      detail: '持有者 ' + active[0] + (baseSha ? '，base ' + baseSha.slice(0, 7) : ''),
    })
    return {
      code: 0,
      lines: [
        '已写入待合并区：' + n + '（持有者 ' + active[0] + '，' + (baseSha ? 'base ' + baseSha.slice(0, 7) : '无 base') + '）',
        '对方 release（解锁）时会提示；你也可以稍后执行：',
        '  pending apply ' + n + '（三路合并落盘）/ pending show ' + n + ' / pending drop ' + n,
        ...(warn ? ['⚠️ ' + warn] : []),
      ],
    }
  })
}

// ---------- 入口 ----------

// 解析 argv：选项可出现在任意位置；命令 = 第一个非选项 token。
export function parseArgs(argv) {
  const opts = { note: undefined, force: false, all: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--force') opts.force = true
    else if (a === '--all') opts.all = true
    else if (a === '--note') opts.note = argv[++i]
    else if (a === '--as') i++ // 身份在 resolveTag 单独解析
    else if (a.startsWith('-')) throw new Error('未知选项：' + a)
    else positional.push(a)
  }
  return { opts, positional }
}

// run(argv, ctx?) — 可测入口：ctx.stateDir 重定向状态目录（测试用临时目录），
// ctx.now 注入时钟（测试 stale），ctx.env 注入身份/超时环境变量，
// ctx.repoRoot 注入仓库根（宿主集成传「当前会话工作区根」，缺省取本模块目录）。
export async function run(argv, ctx = {}) {
  const env = ctx.env || process.env
  const repoRoot = ctx.repoRoot || MODULE_ROOT
  const full = {
    stateDir: ctx.stateDir || stateDirOf(env, repoRoot),
    repoRoot,
    mergeFile: ctx.mergeFile,
    tag: resolveTag(argv, env),
    now: ctx.now || Date.now(),
    env,
    staleMs: ctx.staleMs || staleMsOf(env),
  }
  const { opts, positional } = parseArgs(argv)
  const cmd = positional[0]
  const rest = positional.slice(1)
  // pending 的写/合并/丢弃是变更操作，需要身份；list/show 只读不需要。
  const needsTag = cmd === 'sync' || cmd === 'claim' || cmd === 'release' || (cmd === 'pending' && !['list', 'show'].includes(rest[0]))
  if (needsTag && !full.tag) {
    return { code: 1, lines: ['无法确定会话身份：请用 --as <tag> 指定，或设置 DSH_SESSION_ID'] }
  }
  try {
    switch (cmd) {
      case 'new': return cmdNew()
      case 'status': return cmdStatus(full)
      case 'sync': return cmdSync(full, opts)
      case 'claim': return cmdClaim(full, opts, rest)
      case 'release': return cmdRelease(full, opts, rest)
      case 'who': return cmdWho(full, rest)
      case 'prune': return cmdPrune(full)
      case 'drop': return cmdDrop(full, opts, rest[0])
      case 'audit': return cmdAudit(full, rest[0])
      case 'pending': return cmdPending(full, opts, rest[0], rest.slice(1))
      case undefined: return { code: 1, lines: ['无参数时运行 status。'] }
      default: return { code: 1, lines: ['未知命令：' + cmd] }
    }
  } catch (e) {
    return { code: 1, lines: ['错误：' + (e && e.message ? e.message : String(e))] }
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const { code, lines } = await run(argv.length === 0 ? ['status'] : argv, {})
  for (const l of lines) console.log(l)
  process.exitCode = code
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  main().catch((e) => {
    console.error('致命错误：' + (e && e.message ? e.message : String(e)))
    process.exitCode = 1
  })
}
