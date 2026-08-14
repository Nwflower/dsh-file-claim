import { test } from 'node:test'
import assert from 'node:assert/strict'
import plugin from '../index.mjs'

test('index.mjs 导出合法 Cordis 插件契约（name + apply）', () => {
  assert.equal(typeof plugin, 'object')
  assert.equal(plugin.name, 'dsh-file-claim')
  assert.equal(typeof plugin.apply, 'function')
})
