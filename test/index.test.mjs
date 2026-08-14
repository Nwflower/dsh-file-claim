// test/index.test.mjs — index.mjs 宿主面集成测试（mock ctx，零 DSH 宿主依赖）
// 覆盖：工具注册形状、claim/release/who/status 工具执行、命令注册与执行、
// tools/pre-execute 拦截 deny/allow、agent/disposed 自动释放、身份解析、pending 工具往返。

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import plugin from '../index.mjs'

// ---------- mock ctx ----------

function mockCtx() {
  const tools = new Map()
  const commands = new Map()
  const listeners = new Map()
  const disposers = []
  const ctx = {
    get(name) {
      return ctx[name]
    },
    effect(fn) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(handler)
      return () => {}
    },
    emit(event, ...args) {
      for (const h of listeners.get(event) || []) {
        const r = h(...args)
        if (r && typeof r.catch === 'function') void r
      }
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
      get(name) {
        return tools.get(name)
      },
    },
    commands: {
      register(def) {
        commands.set(def.name, def)
        return () => commands.delete(def.name)
      },
      get(name) {
        return commands.get(name)
      },
    },
    timer: { interval: () => () => {} },
    workspaceRegistry: { resolveByPath: async () => undefined },
  }
  return { ctx, tools, commands, listeners, disposers }
}

function agent(id, cwd) {
  return { id, session: { header: { cwd } } }
}

const exec = (ag) => ({ agent: ag, signal: new AbortController().signal })

async function waitFor(fn, timeoutMs = 3000) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeoutMs) throw new Error('waitFor 超时')
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function tmpRoot() {
  return mkdtemp(join(tmpdir(), 'dsh-index-test-'))
}

const ALL_TOOLS = [
  'claim_files',
  'claim_status',
  'pending_apply',
  'pending_drop',
  'pending_show',
  'pending_write',
  'release_files',
  'who_claims',
]

const ALL_COMMANDS = ['claim', 'claim-status', 'release']

// 模拟命令分发：handler 只收 invocation，这里直接按 UI 语义构造。
const invoke = (cmd) => (rawInput, ag) => cmd.handler({ agent: ag, rawInput, signal: new AbortController().signal })

// ---------- 用例 ----------

test('index.mjs 导出合法 Cordis 插件契约（name + apply）', () => {
  assert.equal(typeof plugin, 'object')
  assert.equal(plugin.name, 'dsh-file-claim')
  assert.equal(typeof plugin.apply, 'function')
})

test('工具注册：8 个工具名 + 输出契约齐全', () => {
  const { ctx, tools } = mockCtx()
  plugin.apply(ctx, {})
  assert.deepEqual([...tools.keys()].sort(), ALL_TOOLS)
  for (const name of ALL_TOOLS) {
    const def = tools.get(name)
    assert.equal(typeof def.execute, 'function', name + ' 缺 execute')
    assert.equal(typeof def.output.render, 'function', name + ' 缺 output.render')
    assert.equal(typeof def.parameters, 'object', name + ' 缺 parameters')
    assert.equal(typeof def.description, 'string', name + ' 缺 description')
  }
})

test('claim_files 认领写入注册表；他人再认领被拒；who/status 可见；release 释放', async () => {
  const { ctx, tools } = mockCtx()
  plugin.apply(ctx, {})
  const root = await tmpRoot()
  const a = agent('s-a', root)
  const b = agent('s-b', root)
  try {
    const claimed = await tools.get('claim_files').execute({ paths: ['README.md'], note: '改文档' }, exec(a))
    assert.equal(claimed.ok, true, claimed.lines.join(' | '))
    assert.ok(claimed.lines.some((l) => l.includes('已认领：README.md')))

    // 注册表持久化在 <root>/.dsh-file-claim/registry.json
    const reg = JSON.parse(await readFile(join(root, '.dsh-file-claim', 'registry.json'), 'utf8'))
    assert.deepEqual(reg.sessions['s-a'].claims, ['README.md'])
    assert.equal(reg.sessions['s-a'].note, '改文档')

    // 其他活跃会话认领同一路径 → 拒绝
    const denied = await tools.get('claim_files').execute({ paths: ['README.md'] }, exec(b))
    assert.equal(denied.ok, false)
    assert.ok(denied.lines.some((l) => l.includes('认领失败') && l.includes('s-a')))

    // who_claims 显示持有者
    const who = await tools.get('who_claims').execute({ paths: ['README.md', 'LICENSE'] }, exec(b))
    assert.equal(who.ok, true)
    assert.ok(who.lines.some((l) => l.includes('README.md：被 s-a 认领')))
    assert.ok(who.lines.some((l) => l.includes('LICENSE：无人占用')))

    // claim_status 总览
    const st = await tools.get('claim_status').execute({}, exec(a))
    assert.equal(st.ok, true)
    assert.ok(st.lines.some((l) => l.includes('会话') && l.includes('s-a')))

    // release 指定路径
    const rel = await tools.get('release_files').execute({ paths: ['README.md'] }, exec(a))
    assert.equal(rel.ok, true)
    assert.ok(rel.lines.some((l) => l.includes('已释放：README.md')))
    const who2 = await tools.get('who_claims').execute({ paths: ['README.md'] }, exec(b))
    assert.ok(who2.lines.some((l) => l.includes('README.md：无人占用')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('拦截：写他人活跃认领文件 deny；自己/未认领/read 放行；bash 重定向尽力解析', async () => {
  const { ctx, tools, listeners } = mockCtx()
  plugin.apply(ctx, {})
  const root = await tmpRoot()
  const a = agent('s-a', root)
  const b = agent('s-b', root)
  const next = async () => ({ kind: 'allow' })
  const pre = listeners.get('tools/pre-execute')[0]
  assert.ok(pre, 'pre-execute 处理器已注册')
  try {
    await tools.get('claim_files').execute({ paths: ['README.md'] }, exec(a))

    // 其他活跃会话 write → deny
    const d1 = await pre({ name: 'write', arguments: { file_path: 'README.md' }, agent: b }, next)
    assert.equal(d1.kind, 'deny')
    assert.ok(d1.reason.includes('s-a'))
    assert.ok(d1.reason.includes('pending_write'))

    // 其他活跃会话 edit → deny
    const d2 = await pre({ name: 'edit', arguments: { file_path: 'README.md' }, agent: b }, next)
    assert.equal(d2.kind, 'deny')

    // 持有者自己 write → 放行
    const d3 = await pre({ name: 'write', arguments: { file_path: 'README.md' }, agent: a }, next)
    assert.equal(d3.kind, 'allow')

    // 未认领路径 write → 放行
    const d4 = await pre({ name: 'write', arguments: { file_path: 'LICENSE' }, agent: b }, next)
    assert.equal(d4.kind, 'allow')

    // read 不拦截（读取不构成修改）
    const d5 = await pre({ name: 'read', arguments: { file_path: 'README.md' }, agent: b }, next)
    assert.equal(d5.kind, 'allow')

    // bash 重定向到被认领文件 → deny
    const d6 = await pre({ name: 'bash', arguments: { command: 'echo x >> README.md' }, agent: b }, next)
    assert.equal(d6.kind, 'deny')

    // 无目标路径的命令 → 放行（fail-open）
    const d7 = await pre({ name: 'bash', arguments: { command: 'echo hello' }, agent: b }, next)
    assert.equal(d7.kind, 'allow')

    // guard:false 时全部放行
    const { ctx: ctx2, tools: tools2, listeners: listeners2 } = mockCtx()
    plugin.apply(ctx2, { guard: false })
    const pre2 = listeners2.get('tools/pre-execute')[0]
    await tools2.get('claim_files').execute({ paths: ['README.md'] }, exec(a))
    const d8 = await pre2({ name: 'write', arguments: { file_path: 'README.md' }, agent: b }, next)
    assert.equal(d8.kind, 'allow')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('拦截回归（bug#extractShellPaths 误报）：引号字面量/只读命令放行，重定向与写 cmdlet 拦截', async () => {
  const { ctx, tools, listeners } = mockCtx()
  plugin.apply(ctx, {})
  const root = await tmpRoot()
  const a = agent('s-a', root)
  const b = agent('s-b', root)
  const next = async () => ({ kind: 'allow' })
  const pre = listeners.get('tools/pre-execute')[0]
  const guard = (command, tool = 'bash') => pre({ name: tool, arguments: { command }, agent: b }, next)
  try {
    await tools.get('claim_files').execute({ paths: ['README.md'] }, exec(a))

    // 只读 / 数据字面量 → 放行（fail-open，回归点：引号里的路径不是写目标）
    assert.equal(
      (await guard("foreach ($f in @('README.md','README.zh.md')) { Write-Output $f }", 'pwsh')).kind,
      'allow',
    )
    assert.equal((await guard("grep -n 'README.md' log.txt")).kind, 'allow')
    assert.equal((await guard('Get-Content README.md', 'pwsh')).kind, 'allow')
    assert.equal((await guard('echo README.md')).kind, 'allow')

    // 显式写命令 / 重定向 → 拦截
    assert.equal((await guard('Set-Content README.md x', 'pwsh')).kind, 'deny')
    assert.equal((await guard('Set-Content -Path README.md -Value x', 'pwsh')).kind, 'deny')
    assert.equal((await guard('Add-Content README.md x', 'pwsh')).kind, 'deny')
    assert.equal((await guard('Out-File -FilePath README.md', 'pwsh')).kind, 'deny')
    assert.equal((await guard('echo x > README.md')).kind, 'deny')
    assert.equal((await guard('rm README.md')).kind, 'deny')
    assert.equal((await guard('tee README.md')).kind, 'deny')

    // 被认领路径只是「源/非目标」→ 放行（只保护写目标）
    assert.equal((await guard('Copy-Item README.md backup\\', 'pwsh')).kind, 'allow')
    assert.equal((await guard('mv README.md renamed', 'pwsh')).kind, 'allow')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('guardCommit（opt-in）：git commit 提交他人认领路径 deny；msg 含路径不误报；默认关闭', async () => {
  const root = await tmpRoot()
  const a = agent('s-a', root)
  const b = agent('s-b', root)
  const next = async () => ({ kind: 'allow' })
  const setup = (config) => {
    const { ctx, tools, listeners } = mockCtx()
    plugin.apply(ctx, config)
    return { tools, pre: listeners.get('tools/pre-execute')[0] }
  }
  const g = (pre, command) => pre({ name: 'bash', arguments: { command }, agent: b }, next)
  try {
    // 默认 config：guardCommit 未启用 → git commit 提交被认领路径放行
    const def = setup({})
    await def.tools.get('claim_files').execute({ paths: ['README.md'] }, exec(a))
    assert.equal((await g(def.pre, 'git commit -- README.md')).kind, 'allow')

    // guardCommit:true：显式提交被认领路径 → deny；msg 里的路径字样不误报；未认领/无路径放行
    const en = setup({ guardCommit: true })
    await en.tools.get('claim_files').execute({ paths: ['README.md'] }, exec(a))
    assert.equal((await g(en.pre, 'git commit -- README.md')).kind, 'deny')
    assert.equal((await g(en.pre, 'git commit README.md')).kind, 'deny') // 老语法
    assert.equal((await g(en.pre, 'git commit -m "update README.md"')).kind, 'allow') // msg 不误报
    assert.equal((await g(en.pre, 'git commit -am "update README.md"')).kind, 'allow') // -am 值不误报
    assert.equal((await g(en.pre, 'git commit -m "x" -- LICENSE')).kind, 'allow') // 未认领
    assert.equal((await g(en.pre, 'git commit -m "x"')).kind, 'allow') // 无路径 fail-open
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('agent/disposed 自动释放该会话全部认领', async () => {
  const { ctx, tools, listeners } = mockCtx()
  plugin.apply(ctx, {})
  const root = await tmpRoot()
  const a = agent('s-a', root)
  const b = agent('s-b', root)
  try {
    await tools.get('claim_files').execute({ paths: ['README.md', 'index.mjs'] }, exec(a))
    await tools.get('claim_files').execute({ paths: ['LICENSE'] }, exec(b))
    for (const h of listeners.get('agent/disposed') || []) h({ agent: a })
    await waitFor(async () => {
      const reg = JSON.parse(await readFile(join(root, '.dsh-file-claim', 'registry.json'), 'utf8'))
      return !reg.sessions['s-a']
    })
    const reg = JSON.parse(await readFile(join(root, '.dsh-file-claim', 'registry.json'), 'utf8'))
    assert.equal(reg.sessions['s-a'], undefined)
    assert.deepEqual(reg.sessions['s-b'].claims, ['LICENSE'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('pending 工具往返：write → show → drop（含身份解析）', async () => {
  const { ctx, tools } = mockCtx()
  plugin.apply(ctx, {})
  const root = await tmpRoot()
  const a = agent('s-a', root)
  const b = agent('s-b', root)
  try {
    await tools.get('claim_files').execute({ paths: ['README.md'] }, exec(a))
    // 无身份 → 拒绝
    const noTag = await tools.get('pending_write').execute({ path: 'README.md', content: '新内容\n' }, exec(null))
    assert.equal(noTag.ok, false)
    assert.ok(noTag.lines.some((l) => l.includes('无法确定会话身份')))
    // s-b 写入待合并区
    const pw = await tools.get('pending_write').execute({ path: 'README.md', content: '新内容\n' }, exec(b))
    assert.equal(pw.ok, true, pw.lines.join(' | '))
    assert.ok(pw.lines.some((l) => l.includes('已写入待合并区')))
    // show 能看到内容
    const ps = await tools.get('pending_show').execute({ path: 'README.md' }, exec(b))
    assert.equal(ps.ok, true)
    assert.ok(ps.lines.some((l) => l.includes('新内容')))
    // status 总览含待合并区
    const st = await tools.get('claim_status').execute({}, exec(b))
    assert.ok(st.lines.some((l) => l.includes('待合并区')))
    // drop 清理
    const pd = await tools.get('pending_drop').execute({ path: 'README.md' }, exec(b))
    assert.equal(pd.ok, true)
    assert.ok(pd.lines.some((l) => l.includes('已丢弃')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('命令注册：/claim /release /claim-status 契约齐全（name + description + handler）', () => {
  const { ctx, commands } = mockCtx()
  plugin.apply(ctx, {})
  assert.deepEqual([...commands.keys()].sort(), ALL_COMMANDS)
  for (const name of ALL_COMMANDS) {
    const def = commands.get(name)
    assert.equal(typeof def.handler, 'function', name + ' 缺 handler')
    assert.equal(typeof def.description, 'string', name + ' 缺 description')
    if (name !== 'claim-status') {
      assert.equal(typeof def.input.hint, 'string', name + ' 缺 input.hint')
    }
  }
})

test('命令执行：/claim（含引号备注）→ /claim-status → /release --all 往返；无身份拒绝', async () => {
  const { ctx, commands } = mockCtx()
  plugin.apply(ctx, {})
  const root = await tmpRoot()
  const a = agent('s-a', root)
  const b = agent('s-b', root)
  try {
    const claim = commands.get('claim')
    const status = commands.get('claim-status')
    const release = commands.get('release')

    // 无身份 → error
    const noTag = await invoke(claim)(' README.md', null)
    assert.equal(noTag.kind, 'error')
    assert.ok(noTag.text.includes('无法确定会话身份'))

    // /claim README.md --note "多 行 备注"：引号内空白保留为单个备注
    const c1 = await invoke(claim)(' README.md --note "多 行 备注"', a)
    assert.equal(c1.kind, 'success', c1.text)
    assert.ok(c1.text.includes('已认领：README.md'))
    const reg = JSON.parse(await readFile(join(root, '.dsh-file-claim', 'registry.json'), 'utf8'))
    assert.equal(reg.sessions['s-a'].note, '多 行 备注')

    // 其他活跃会话 /claim 同一路径 → error
    const c2 = await invoke(claim)(' README.md', b)
    assert.equal(c2.kind, 'error')
    assert.ok(c2.text.includes('认领失败') && c2.text.includes('s-a'))

    // /claim-status 总览
    const st = await invoke(status)('', b)
    assert.equal(st.kind, 'success')
    assert.ok(st.text.includes('会话 s-a'))

    // /release --all 释放
    const r1 = await invoke(release)(' --all', a)
    assert.equal(r1.kind, 'success')
    assert.ok(r1.text.includes('已释放：README.md'))
    const reg2 = JSON.parse(await readFile(join(root, '.dsh-file-claim', 'registry.json'), 'utf8'))
    // 带备注的会话释放后保留登记（仅清空认领），与 claim.mjs 语义一致
    assert.deepEqual(reg2.sessions['s-a'].claims, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
