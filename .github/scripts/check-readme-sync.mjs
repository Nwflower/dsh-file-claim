// .github/scripts/check-readme-sync.mjs — 双语 README 标题结构同步检查（CI 用）
// 提取 README.md 与 README.zh-CN.md 的标题层级序列（##/### ...），不一致即失败。
// 只比较结构不比较文字：翻译必然改文案，但章节结构必须保持一致。

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function headingLevels(text) {
  return text
    .split('\n')
    .filter((l) => /^#{1,6}\s/.test(l))
    .map((l) => l.match(/^(#+)\s/)[1].length)
}

const [en, zh] = await Promise.all(
  ['README.md', 'README.zh-CN.md'].map((f) => readFile(join(root, f), 'utf8')),
)

const a = headingLevels(en).join(',')
const b = headingLevels(zh).join(',')

if (a !== b) {
  console.error('README 双语标题结构不一致：')
  console.error('  README.md        ：' + a)
  console.error('  README.zh-CN.md  ：' + b)
  process.exit(1)
}
console.log('README 双语标题结构一致（' + a + '）')
