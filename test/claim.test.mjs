// test/claim.test.mjs — claim.mjs 行为测试（node --test，零依赖）
// 迁移自 dsh-chat-import 的 dev/bin/session.test.mjs（16 用例，断言语义不变）。
// 每个用例用独立临时目录作状态目录（DSH_SESSION_STATE 语义），不碰真实 dev/sessions。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../claim.mjs'

const env = { ...process.env }

async function tmpState() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-file-claim-test-'))
  return dir
}

// 断言返回码与输出行（可省略 lines 只查 code）
function expect(res, code, ...subs) {
  assert.equal(res.code, code, 'exit code 不符：' + res.lines.join(' | '))
  for (const s of subs) {
    assert.ok(res.lines.some((l) => l.includes(s)), '输出缺少「' + s + '」：' + res.lines.join(' | '))
  }
}

test('new 生成可用的会话 tag', async () => {
  const res = await run(['new'])
  assert.match(res.lines[0], /^s-[0-9a-f]{8}$/)
})

test('sync 登记会话与备注；status 可见', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  try {
    await run(['sync', '--as', 's-a', '--note', '做批量导入'], { stateDir: dir, repoRoot: root })
    const st = await run(['status', '--as', 's-a'], { stateDir: dir, repoRoot: root })
    expect(st, 0, 's-a', '做批量导入', '（本会话）')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('claim 后 status/who 可见；release 清空并注销空会话', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  try {
    await run(['claim', '--as', 's-a', 'convert.mjs', 'index.mjs'], { stateDir: dir, repoRoot: root })
    const who = await run(['who', 'convert.mjs', 'README.md'], { stateDir: dir, repoRoot: root })
    expect(who, 0, 'convert.mjs：被 s-a 认领', 'README.md：无人占用')
    await run(['release', '--as', 's-a', '--all'], { stateDir: dir, repoRoot: root })
    const st = await run(['status'], { stateDir: dir, repoRoot: root })
    expect(st, 0, '当前没有登记的会话')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('活跃会话占用时 claim 被拒绝（不覆盖他人认领）', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  try {
    await run(['claim', '--as', 's-a', 'convert.mjs'], { stateDir: dir, repoRoot: root })
    const res = await run(['claim', '--as', 's-b', 'convert.mjs'], { stateDir: dir, repoRoot: root })
    expect(res, 1, '认领失败', 's-a')
    // 不冲突的文件可以认领
    const ok = await run(['claim', '--as', 's-b', 'index.mjs'], { stateDir: dir, repoRoot: root })
    expect(ok, 0, '已认领：index.mjs')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('同一会话重复认领幂等合并', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  try {
    await run(['claim', '--as', 's-a', 'convert.mjs'], { stateDir: dir, repoRoot: root })
    await run(['claim', '--as', 's-a', 'convert.mjs', 'README.md'], { stateDir: dir, repoRoot: root })
    const reg = JSON.parse(await readFile(join(dir, 'registry.json'), 'utf8'))
    assert.deepEqual([...reg.sessions['s-a'].claims].sort(), ['README.md', 'convert.mjs'])
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test("目录认领覆盖其下路径；整仓库 '.' 与一切冲突", async () => {
  const dir = await tmpState()
  const root = await tmpState()
  try {
    await run(['claim', '--as', 's-a', 'test/'], { stateDir: dir, repoRoot: root })
    const res = await run(['claim', '--as', 's-b', 'test/convert.test.mjs'], { stateDir: dir, repoRoot: root })
    expect(res, 1, '认领失败', 's-a')
    const dot = await run(['claim', '--as', 's-c', '.'], { stateDir: dir, repoRoot: root })
    expect(dot, 1, '认领失败')
    // s-a 释放目录后 s-c 可整仓库认领
    await run(['release', '--as', 's-a', '--all'], { stateDir: dir, repoRoot: root })
    const ok = await run(['claim', '--as', 's-c', '.'], { stateDir: dir, repoRoot: root })
    expect(ok, 0, '已认领：.')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('stale 会话：无 --force 拒绝，有 --force 接管', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  const smallStale = { ...env, DSH_SESSION_STALE_MS: '1000' }
  try {
    const t0 = Date.now()
    await run(['claim', '--as', 's-a', 'convert.mjs'], { stateDir: dir, repoRoot: root, env: smallStale, now: t0 })
    const t1 = t0 + 5000 // 5 秒后 → s-a 已 stale
    const noForce = await run(['claim', '--as', 's-b', 'convert.mjs'], { stateDir: dir, repoRoot: root, env: smallStale, now: t1 })
    expect(noForce, 1, '被 stale 会话占用')
    const forced = await run(['claim', '--as', 's-b', 'convert.mjs', '--force'], { stateDir: dir, repoRoot: root, env: smallStale, now: t1 })
    expect(forced, 0, '接管', 's-a', '已认领：convert.mjs')
    // s-a 的认领已被收回
    const st = await run(['status'], { stateDir: dir, repoRoot: root, env: smallStale, now: t1 })
    expect(st, 0, 's-a', '认领：无')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('越出仓库根的路径被拒绝', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  try {
    const res = await run(['claim', '--as', 's-a', '../outside.mjs'], { stateDir: dir, repoRoot: root })
    expect(res, 1, '越出仓库根')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('prune 只清理 stale；drop 对活跃会话需 --force', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  const smallStale = { ...env, DSH_SESSION_STALE_MS: '1000' }
  try {
    const t0 = Date.now()
    await run(['sync', '--as', 's-old'], { stateDir: dir, repoRoot: root, env: smallStale, now: t0 })
    await run(['sync', '--as', 's-new'], { stateDir: dir, repoRoot: root, env: smallStale, now: t0 })
    const t1 = t0 + 5000
    await run(['sync', '--as', 's-new'], { stateDir: dir, repoRoot: root, env: smallStale, now: t1 }) // s-new 心跳刷新 → 活跃
    // 活跃的 s-new 不能被无 --force 的 drop
    const dropActive = await run(['drop', '--as', 's-x', 's-new'], { stateDir: dir, repoRoot: root, env: smallStale, now: t1 })
    expect(dropActive, 1, '仍活跃')
    // prune 只清 stale 的 s-old，活跃的 s-new 保留
    const pruned = await run(['prune'], { stateDir: dir, repoRoot: root, env: smallStale, now: t1 })
    expect(pruned, 0, 's-old')
    const st = await run(['status'], { stateDir: dir, repoRoot: root, env: smallStale, now: t1 })
    expect(st, 0, 's-new')
    // 会话列表不再有 s-old（审计行是历史记录，可能含该 tag，只断言会话行）
    assert.ok(!st.lines.some((l) => l.includes('会话 s-old')))
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('release 指定路径只释放匹配项', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  try {
    await run(['claim', '--as', 's-a', 'convert.mjs', 'README.md'], { stateDir: dir, repoRoot: root })
    const res = await run(['release', '--as', 's-a', 'convert.mjs'], { stateDir: dir, repoRoot: root })
    expect(res, 0, '已释放：convert.mjs', '剩余认领：README.md')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('无身份时 sync 报错而不是凭空建会话', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  const bare = { ...env }
  delete bare.DSH_SESSION_ID
  try {
    const res = await run(['sync'], { stateDir: dir, repoRoot: root, env: bare })
    expect(res, 1, '无法确定会话身份')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

// ---------- pending 待合并区 ----------

test('pending：无占用拒绝；有活跃占用可写入；list/show/drop 工作', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  try {
    await run(['claim', '--as', 's-a', 'README.md'], { stateDir: dir, repoRoot: root })
    // 无活跃占用 → 拒绝（提示直接 claim）
    const noHold = await run(['pending', '--as', 's-b', 'AGENTS.md', join(root, 'x.txt')], { stateDir: dir, repoRoot: root })
    expect(noHold, 1, '没有活跃会话占用')
    // 有活跃占用 → 写入待合并区
    await writeFile(join(root, 'x.txt'), '改好的 README 内容\n', 'utf8')
    const pend = await run(['pending', '--as', 's-b', 'README.md', join(root, 'x.txt')], { stateDir: dir, repoRoot: root })
    expect(pend, 0, '已写入待合并区', 'README.md', 's-a')
    const list = await run(['pending', 'list'], { stateDir: dir, repoRoot: root })
    expect(list, 0, 'README.md', 's-b')
    const show = await run(['pending', 'show', 'README.md'], { stateDir: dir, repoRoot: root })
    expect(show, 0, '改好的 README 内容')
    const drop = await run(['pending', 'drop', '--as', 's-b', 'README.md'], { stateDir: dir, repoRoot: root })
    expect(drop, 0, '已丢弃')
    const list2 = await run(['pending', 'list'], { stateDir: dir, repoRoot: root })
    expect(list2, 0, '待合并区为空')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('release 解锁时检查待合并区并提示待合并内容', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  try {
    await writeFile(join(root, 'c.txt'), '新内容\n', 'utf8')
    await run(['claim', '--as', 's-a', 'README.md'], { stateDir: dir, repoRoot: root })
    await run(['pending', '--as', 's-b', 'README.md', join(root, 'c.txt')], { stateDir: dir, repoRoot: root })
    const rel = await run(['release', '--as', 's-a', 'README.md'], { stateDir: dir, repoRoot: root })
    expect(rel, 0, '已释放：README.md', '解锁检查', 'README.md', 's-b', 'pending apply')
    // status 也展示待合并区
    const st = await run(['status'], { stateDir: dir, repoRoot: root })
    expect(st, 0, '待合并区', 'README.md')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('release 自动合并：pending 无冲突时自动三路合并落盘并清除条目', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  try {
    execSync('git init -q', { cwd: root })
    execSync('git config user.email t@test && git config user.name t', { cwd: root })
    await writeFile(join(root, 'README.md'), 'v1\n', 'utf8')
    execSync('git add README.md && git commit -qm init', { cwd: root })
    await run(['claim', '--as', 's-a', 'README.md'], { stateDir: dir, repoRoot: root })
    await writeFile(join(root, 'pending-content.txt'), 'v2\n', 'utf8')
    const pw = await run(['pending', 'README.md', 'pending-content.txt'], {
      stateDir: dir,
      repoRoot: root,
      env: { ...env, DSH_SESSION_ID: 's-b' },
    })
    expect(pw, 0, '已写入待合并区', 'base')
    // A release → 解锁检查自动合并（current v1 × base v1 × pending v2 → v2 无冲突）
    const rel = await run(['release', '--as', 's-a', '--all'], { stateDir: dir, repoRoot: root })
    expect(rel, 0, '已自动三路合并落盘', 'README.md')
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), 'v2\n')
    // 条目已清除
    const list = await run(['pending', 'list'], { stateDir: dir, repoRoot: root })
    expect(list, 0, '待合并区为空')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('pending apply：三路合并（注入 mergeFile）成功/冲突/失败；仍被占用时拒绝', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  try {
    await writeFile(join(root, 'foo.mjs'), '当前内容 v1\n', 'utf8')
    await writeFile(join(root, 'mine.txt'), '我的内容\n', 'utf8')
    // 成功路径
    await run(['claim', '--as', 's-a', 'foo.mjs'], { stateDir: dir, repoRoot: root })
    await run(['pending', '--as', 's-b', 'foo.mjs', join(root, 'mine.txt')], { stateDir: dir, repoRoot: root })
    // 仍被 s-a 占用 → apply 拒绝
    const held = await run(['pending', 'apply', '--as', 's-b', 'foo.mjs'], { stateDir: dir, repoRoot: root, mergeFile: async () => ({ ok: true, content: 'MERGED\n' }) })
    expect(held, 1, '仍被活跃会话占用')
    await run(['release', '--as', 's-a', '--all'], { stateDir: dir, repoRoot: root })
    // 手动补 base（模拟 gitHeadInfo 拿到 base）
    const pdir = join(dir, 'pending', 'foo.mjs')
    await writeFile(join(pdir, 'base'), 'base 内容\n', 'utf8')
    const ok = await run(['pending', 'apply', '--as', 's-b', 'foo.mjs'], { stateDir: dir, repoRoot: root, mergeFile: async () => ({ ok: true, content: 'MERGED\n' }) })
    expect(ok, 0, '已合并', 'foo.mjs')
    assert.equal(await readFile(join(root, 'foo.mjs'), 'utf8'), 'MERGED\n')
    const list = await run(['pending', 'list'], { stateDir: dir, repoRoot: root })
    expect(list, 0, '待合并区为空')
    // 冲突路径：保留待合并条目 + 写入冲突标记
    await run(['claim', '--as', 's-a', 'foo.mjs'], { stateDir: dir, repoRoot: root })
    await run(['pending', '--as', 's-b', 'foo.mjs', join(root, 'mine.txt')], { stateDir: dir, repoRoot: root })
    await run(['release', '--as', 's-a', '--all'], { stateDir: dir, repoRoot: root })
    await writeFile(join(pdir, 'base'), 'base\n', 'utf8')
    const conflict = await run(['pending', 'apply', '--as', 's-b', 'foo.mjs'], { stateDir: dir, repoRoot: root, mergeFile: async () => ({ ok: false, conflicts: true, content: '<<<<<<< HEAD\n' }) })
    expect(conflict, 1, '合并冲突')
    assert.equal(await readFile(join(root, 'foo.mjs'), 'utf8'), '<<<<<<< HEAD\n')
    const still = await run(['pending', 'list'], { stateDir: dir, repoRoot: root })
    expect(still, 0, 'foo.mjs')
    // 失败路径
    const fail = await run(['pending', 'apply', '--as', 's-b', 'foo.mjs'], { stateDir: dir, repoRoot: root, mergeFile: async () => ({ ok: false, message: 'boom' }) })
    expect(fail, 1, '合并失败', 'boom')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('pending 无 base 时 apply 拒绝（不盲改）', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  try {
    await writeFile(join(root, 'ghost.mjs'), 'x\n', 'utf8')
    await writeFile(join(root, 'mine.txt'), 'y\n', 'utf8')
    await run(['claim', '--as', 's-a', 'ghost.mjs'], { stateDir: dir, repoRoot: root })
    await run(['pending', '--as', 's-b', 'ghost.mjs', join(root, 'mine.txt')], { stateDir: dir, repoRoot: root })
    await run(['release', '--as', 's-a', '--all'], { stateDir: dir, repoRoot: root })
    // 没有 base 文件（gitHeadInfo 拿不到）→ 拒绝自动合并
    const res = await run(['pending', 'apply', '--as', 's-b', 'ghost.mjs'], { stateDir: dir, repoRoot: root })
    expect(res, 1, '缺少 base')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('pending 写/合并需要身份；list/show 只读不需要', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  const bare = { ...env }
  delete bare.DSH_SESSION_ID
  try {
    await run(['claim', '--as', 's-a', 'README.md'], { stateDir: dir, repoRoot: root })
    const noTag = await run(['pending', 'README.md', join(root, 'x.txt')], { stateDir: dir, repoRoot: root, env: bare })
    expect(noTag, 1, '无法确定会话身份')
    const list = await run(['pending', 'list'], { stateDir: dir, repoRoot: root, env: bare })
    expect(list, 0, '待合并区为空')
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('audit：claim/release 操作写入 audit.jsonl；audit 命令与 status 可读', async () => {
  const dir = await tmpState()
  const root = await tmpState()
  try {
    await run(['claim', '--as', 's-a', 'README.md'], { stateDir: dir, repoRoot: root })
    await run(['release', '--as', 's-a', '--all'], { stateDir: dir, repoRoot: root })
    // audit 命令看到 claim/release 记录
    const au = await run(['audit'], { stateDir: dir, repoRoot: root })
    expect(au, 0, 'claim', 'release', 'README.md')
    // status 末尾显示最近审计
    const st = await run(['status'], { stateDir: dir, repoRoot: root })
    expect(st, 0, '最近审计')
    // audit.jsonl 每行是合法 JSON 事件
    const raw = await readFile(join(dir, 'audit.jsonl'), 'utf8')
    const entries = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    assert.ok(entries.length >= 2, '至少 2 条审计')
    for (const e of entries) {
      assert.equal(typeof e.at, 'number')
      assert.equal(typeof e.tag, 'string')
      assert.equal(typeof e.type, 'string')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(root, { recursive: true, force: true })
  }
})
