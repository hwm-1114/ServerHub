// 离线回归:拖入文件夹时的相对路径与目标目录映射
// (旧实现把顶层目录名丢掉 → 两个文件夹里的同名文件落到同一远端路径互相覆盖,
//  且带子目录时拼出 <当前目录>/子目录/文件 却没有任何 mkdir → 子目录文件全部失败)
// 运行: node scripts/verify-drag-paths.mjs
import { build } from 'esbuild'
import fs from 'fs'
import os from 'os'
import path from 'path'

const root = process.cwd()
const out = path.join(os.tmpdir(), `serverhub-drag-${Date.now()}.mjs`)
await build({
  stdin: {
    contents: `export { collectDroppedFiles, targetDirForRelPath } from './src/lib/dragFiles'`,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true, format: 'esm', platform: 'node', packages: 'external', outfile: out, logLevel: 'error',
})
const { collectDroppedFiles, targetDirForRelPath } = await import('file://' + out.replace(/\\/g, '/'))

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ✅', label) } else { fail++; console.log('  ❌', label) }
  if (extra) console.log('     ', extra)
}

// ---- 假 DataTransfer / FileSystemEntry:结构与浏览器一致 ----
function fakeFile(name, content = 'x') {
  return { name, _content: content, isFile: true }
}
function entryFromFs(map, name) {
  // map: { 'a.txt': 'content', 'sub': { ... } }
  const v = map[name]
  if (typeof v === 'string') {
    return {
      isFile: true, isDirectory: false, name,
      file: (cb) => cb(fakeFile(name, v)),
    }
  }
  return {
    isFile: false, isDirectory: true, name,
    createReader: () => {
      let done = false
      return {
        readEntries: (cb) => {
          if (done) return cb([])
          done = true
          cb(Object.keys(v).map(k => entryFromFs(v, k)))
        },
      }
    },
  }
}
function fakeDataTransfer(fsMap) {
  const entries = Object.keys(fsMap).map(k => entryFromFs(fsMap, k))
  return {
    items: entries.map(e => ({ webkitGetAsEntry: () => e })),
    files: [],
  }
}

console.log('\n【1】targetDirForRelPath:路径映射(单一定义,组件与测试共用)')
{
  const base = '/home/u'
  ok(targetDirForRelPath(base, 'a.txt') === '/home/u', '顶层文件 → 当前目录')
  ok(targetDirForRelPath(base, 'src/a.txt') === '/home/u/src', '一级目录 → 当前目录/一级')
  ok(targetDirForRelPath(base, 'src/sub/a.txt') === '/home/u/src/sub', '多级目录 → 逐级还原')
  ok(targetDirForRelPath('/home/u/', 'src/a.txt') === '/home/u/src', 'base 末尾斜杠不会产生双斜杠')
  ok(targetDirForRelPath('/', 'src/a.txt') === '/src', '根目录 base 正常')
}

console.log('\n【2】collectDroppedFiles:顶层目录名必须保留')
{
  const files = await collectDroppedFiles(fakeDataTransfer({ p: { 'x.txt': '1', sub: { 'y.txt': '2' } } }))
  const rels = files.map(f => f.relPath).sort()
  ok(JSON.stringify(rels) === JSON.stringify(['p/sub/y.txt', 'p/x.txt']),
    '拖入文件夹 p(含 sub/y.txt)→ relPath 带顶层目录名', JSON.stringify(rels))
  const dirs = files.map(f => targetDirForRelPath('/home/u', f.relPath)).sort()
  ok(JSON.stringify(dirs) === JSON.stringify(['/home/u/p', '/home/u/p/sub']),
    '目标目录逐级还原(供上传前 mkdir -p)', JSON.stringify(dirs))
}

console.log('\n【3】两个文件夹里的同名文件不能再落到同一路径')
{
  const files = await collectDroppedFiles(fakeDataTransfer({
    p: { 'x.txt': 'P', sub: { 'y.txt': 'P2' } },
    q: { 'x.txt': 'Q', sub: { 'y.txt': 'Q2' } },
  }))
  const targets = files.map(f => `${targetDirForRelPath('/home/u', f.relPath)}/${f.file.name}`).sort()
  const uniq = [...new Set(targets)]
  ok(uniq.length === targets.length && targets.length === 4,
    '4 个文件的远端落点互不相同(旧实现只有 2 个落点,同名文件互相覆盖)',
    JSON.stringify(targets))
}

console.log('\n【4】顶层单文件 / 多文件仍然正确')
{
  const files = await collectDroppedFiles(fakeDataTransfer({ 'a.txt': 'A', 'b.txt': 'B' }))
  ok(files.length === 2 && files.every(f => targetDirForRelPath('/home/u', f.relPath) === '/home/u'),
    '顶层多文件都落到当前目录', JSON.stringify(files.map(f => f.relPath)))
}

console.log('\n' + '='.repeat(52))
console.log(`拖拽路径回归: ${pass} PASS / ${fail} FAIL`)
console.log('='.repeat(52))
fs.rmSync(out, { force: true })
process.exit(fail ? 1 : 0)
