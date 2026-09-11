// 离线回归:ANSI → HTML 导出(完整历史「导出 HTML」)的配色正确性
// 旧实现两个缺陷(离线可复现):
//  1) 真彩色序列 `1;38;2;255;0;0` 里的 0 分量被当成"重置全部样式" → 导出后既没颜色也没加粗
//  2) 先生成 HTML 再按 \n 切 <div> → 跨行 span 被隐式截断,只有第一行有颜色,且留下游离 </span>
// 运行: node scripts/verify-ansi-html.mjs
import { build } from 'esbuild'
import fs from 'fs'
import os from 'os'
import path from 'path'

const root = process.cwd()
const out = path.join(os.tmpdir(), `serverhub-ansi-${Date.now()}.mjs`)
await build({
  stdin: { contents: `export { ansiToHtml } from './src/lib/ansiToHtml'`, resolveDir: root, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', packages: 'external', outfile: out, logLevel: 'error',
})
const { ansiToHtml } = await import('file://' + out.replace(/\\/g, '/'))

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ✅', label) } else { fail++; console.log('  ❌', label) }
  if (extra) console.log('     ', extra)
}

console.log('\n【1】真彩色 / 256 色不再被 0 分量重置')
{
  const h1 = ansiToHtml('\x1b[1;38;2;255;0;0mBOLDRED\x1b[0m')
  ok(/color:rgb\(255,0,0\)/.test(h1) && /font-weight:bold/.test(h1),
    '真彩色 1;38;2;255;0;0 → 红字 + 加粗(旧实现两者都丢)', h1)

  const h2 = ansiToHtml('\x1b[48;2;0;0;0;38;2;0;255;0mX\x1b[0m')
  ok(/background-color:rgb\(0,0,0\)/.test(h2) && /color:rgb\(0,255,0\)/.test(h2),
    '同一序列里的真彩背景 + 真彩前景都保留', h2)

  const h3 = ansiToHtml('\x1b[38;5;196mRED256\x1b[0m')
  ok(/color:rgb\(255,0,0\)/.test(h3), '256 色 38;5;196 → 正确 RGB(不再"降级为默认色")', h3)

  const h4 = ansiToHtml('\x1b[38;5;0mBLACK\x1b[0m')
  ok(/color:#0a0e14/.test(h4), '256 色索引 0(其参数就是 0)不被误判成重置', h4)
}

console.log('\n【2】跨行颜色必须延续(span 不被 <div> 截断)')
{
  const h = ansiToHtml('\x1b[31mline1\nline2\nline3\x1b[0m')
  const colored = (h.match(/<div><span style="color:#ef4444">/g) || []).length
  ok(colored === 3, '三行都各自带上了同一颜色 span', `命中 ${colored} 个带色 div; ${h}`)
  ok(!/<\/span>\s*<\/span>|<\/div><div>[^<]*<\/span>/.test(h), '没有游离 </span>(标签配对正确)', h)
  const opens = (h.match(/<span/g) || []).length
  const closes = (h.match(/<\/span>/g) || []).length
  ok(opens === closes, 'span 开闭数量相等', `open=${opens} close=${closes}`)
}

console.log('\n【3】基本样式与转义(回归保护)')
{
  const h = ansiToHtml('\x1b[4;32mUNDER-GREEN\x1b[0m')
  ok(/text-decoration:underline/.test(h) && /color:#10b981/.test(h), '下划线 + 绿色', h)
  const esc = ansiToHtml('<img src=x onerror=alert(1)>')
  ok(!/<img/.test(esc) && /&lt;img/.test(esc), 'HTML 转义(无注入)', esc)
  const rst = ansiToHtml('\x1b[31mR\x1b[0mPLAIN')
  ok(/<span style="color:#ef4444">R<\/span>PLAIN/.test(rst), '重置后后续文本不再带颜色(span 只包住 R)', rst)
}

console.log('\n' + '='.repeat(52))
console.log(`ANSI 导出回归: ${pass} PASS / ${fail} FAIL`)
console.log('='.repeat(52))
fs.rmSync(out, { force: true })
process.exit(fail ? 1 : 0)
