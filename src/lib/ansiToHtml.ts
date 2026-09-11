// ANSI 转义序列 → 带 <span> 颜色的 HTML:完整历史"导出 HTML"用,保留终端配色。
// 只处理渲染必需的 SGR(颜色/加粗/下划线/反显,含 256 色与真彩色),其余序列
// (光标移动/OSC/DCS 等)直接剔除——与 stripAnsi 的清理范围一致,输出已做 HTML 转义,
// 无注入风险。颜色对照 xterm 标准色板(与 Terminal.tsx 主题一致)。
//
// 两个真机/离线都复现过的坑(已修):
//  1) 旧实现逐个参数处理,遇到 p===0 就重置全部样式。而 `\x1b[1;38;2;255;0;0m`
//     这种真彩色序列里 38;2 后面就跟着分量 0 和 255 —— 旧实现把分量里的 0 当成
//     重置指令,导出的 HTML 既没有颜色也没有加粗(chalk/现代 CLI 默认就是真彩色)。
//     现在 38/48 会按规范消费后续参数(5;n 或 2;r;g;b),不再误判。
//  2) 旧实现先拼好整段 HTML 再按 \n 切 <div>,跨行的 <span> 会被 <div> 隐式截断,
//     只有第一行有颜色(还留下游离 </span>)。现在按行渲染,行尾关 span、行首按当前
//     样式重开,跨行配色得以保留。

const FG = ['#0a0e14', '#ef4444', '#10b981', '#f59e0b', '#3b82f6', '#ec48e9', '#06b6d4', '#e2e8f0']
const BG = ['#0a0e14', '#ef4444', '#10b981', '#f59e0b', '#3b82f6', '#ec48e9', '#06b6d4', '#e2e8f0']
const FG_BRIGHT = ['#475569', '#f87171', '#34d399', '#fbbf24', '#60a5fa', '#f472b6', '#22d3ee', '#f8fafc']
const BG_BRIGHT = ['#475569', '#f87171', '#34d399', '#fbbf24', '#60a5fa', '#f472b6', '#22d3ee', '#f8fafc']

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(Number(n) || 0)))
const rgb = (r: number, g: number, b: number) => `rgb(${clamp255(r)},${clamp255(g)},${clamp255(b)})`

// xterm 256 色 → CSS 颜色:0-15 用标准/高亮色板,16-231 是 6×6×6 色立方,232-255 是灰阶
function xterm256(i: number): string {
  if (i < 8) return FG[i]
  if (i < 16) return FG_BRIGHT[i - 8]
  if (i >= 232) {
    const v = 8 + (i - 232) * 10
    return rgb(v, v, v)
  }
  const n = i - 16
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40)
  return rgb(level(Math.floor(n / 36)), level(Math.floor((n % 36) / 6)), level(n % 6))
}

interface Style { fg?: string; bg?: string; bold?: boolean; underline?: boolean; inverse?: boolean }

function styleToAttrs(st: Style): string {
  const fg = st.inverse ? (st.bg ?? '#0a0e14') : st.fg
  const bg = st.inverse ? (st.fg ?? '#c8d3e0') : st.bg
  const parts: string[] = []
  if (fg) parts.push(`color:${fg}`)
  if (bg) parts.push(`background-color:${bg}`)
  if (st.bold) parts.push('font-weight:bold')
  if (st.underline) parts.push('text-decoration:underline')
  return parts.length ? ` style="${parts.join(';')}"` : ''
}

// 处理一段 SGR 参数(支持 38/48 的扩展色,消费其后续参数)
function applySgr(st: Style, params: number[]): Style {
  const next: Style = { ...st }
  for (let i = 0; i < params.length; i++) {
    const p = params[i]
    if (p === 0) { for (const k of Object.keys(next) as (keyof Style)[]) delete next[k] }
    else if (p === 1) next.bold = true
    else if (p === 4) next.underline = true
    else if (p === 7) next.inverse = true
    else if (p === 22) next.bold = false
    else if (p === 24) next.underline = false
    else if (p === 27) next.inverse = false
    else if (p >= 30 && p <= 37) next.fg = FG[p - 30]
    else if (p === 39) delete next.fg
    else if (p >= 40 && p <= 47) next.bg = BG[p - 40]
    else if (p === 49) delete next.bg
    else if (p >= 90 && p <= 97) next.fg = FG_BRIGHT[p - 90]
    else if (p >= 100 && p <= 107) next.bg = BG_BRIGHT[p - 100]
    else if (p === 38 || p === 48 || p === 58) {
      // 扩展色:38/48/58 后跟 5;n(256 色)或 2;r;g;b(真彩色)。必须整体消费,
      // 否则分量里的 0 会被当成"重置全部样式"(旧实现即如此,真彩色导出丢色)
      const mode = params[i + 1]
      const isBg = p === 48
      if (mode === 5) {
        const idx = params[i + 2]
        if (Number.isFinite(idx)) {
          const c = xterm256(idx)
          if (p === 58) { /* 下划线颜色:忽略 */ } else if (isBg) next.bg = c; else next.fg = c
        }
        i += 2
      } else if (mode === 2) {
        const r = params[i + 2], g = params[i + 3], b = params[i + 4]
        if ([r, g, b].every(Number.isFinite)) {
          const c = rgb(r, g, b)
          if (p === 58) { /* 忽略 */ } else if (isBg) next.bg = c; else next.fg = c
        }
        i += 4
      } else {
        i += 1
      }
    }
  }
  return next
}

/** 把含 ANSI 序列的终端文本转成 HTML 片段(行以 <div> 包裹,颜色以 span 保留) */
export function ansiToHtml(text: string): string {
  // 一次性按"普通文本 or 转义序列"分词,再逐段生成
  const tokens = String(text || '').split(/(\x1b\[[0-9;:<=>?]*[ -\/]*[@-~]|\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)?|\x1b[P_^X\\][^\x1b]*(?:\x1b\\)?|\x1b[()][0-9A-Z])/g)
  let st: Style = {}
  let open = false
  // 按行累积:行尾关 span、行首按当前样式重开,跨行颜色才能保住
  const lines: string[] = ['']
  const cur = () => lines[lines.length - 1]
  const closeSpan = () => { if (open) { lines[lines.length - 1] += '</span>'; open = false } }
  const openSpan = () => {
    const attrs = styleToAttrs(st)
    if (attrs) { lines[lines.length - 1] += `<span${attrs}>`; open = true } else closeSpan()
  }
  const newline = () => {
    closeSpan()
    lines.push('')
    open = false
    openSpan()
  }

  for (const tk of tokens) {
    if (!tk) continue
    if (tk[0] === '\x1b') {
      // SGR(\x1b[..m)才影响样式;其余转义(光标/OSC/DCS/字符集)直接丢弃
      const m = /^\x1b\[([0-9;:<=>?]*)m$/.exec(tk)
      if (!m) continue
      closeSpan()
      st = applySgr(st, (m[1] || '0').split(';').map((x) => parseInt(x, 10) || 0))
      openSpan()
    } else {
      if (!open) openSpan()
      // \r 与 \n 规范成行分隔;其余控制符(\x07 等)剔除
      const cleaned = tk.replace(/\r\n|\r/g, '\n').replace(/[\x00-\x08\x0b-\x1f]/g, '')
      const parts = cleaned.split('\n')
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) newline()
        lines[lines.length - 1] += escapeHtml(parts[i])
      }
    }
  }
  closeSpan()
  // 行包 <div>,空行用占位保证高度
  return lines.map((l) => `<div>${l || ' '}</div>`).join('')
}

/** 生成可直接保存的完整 HTML 文档(内嵌深色终端样式) */
export function ansiToHtmlDocument(title: string, text: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  body { background:#0a0e14; color:#c8d3e0; margin:0; padding:16px; }
  pre { font-family:'JetBrains Mono','Fira Code',Consolas,monospace; font-size:13px; line-height:20px; margin:0; white-space:pre-wrap; word-break:break-all; }
  .meta { color:#475569; font-size:12px; margin-bottom:12px; }
</style>
</head>
<body>
<div class="meta">ServerHub 终端历史导出 · ${escapeHtml(new Date().toLocaleString())}</div>
<pre>${ansiToHtml(text)}</pre>
</body>
</html>`
}
