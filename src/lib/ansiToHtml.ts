// ANSI 转义序列 → 带 <span> 颜色的 HTML:完整历史"导出 HTML"用,保留终端配色。
// 只处理渲染必需的 SGR(颜色/加粗/下划线/反显),其余序列(光标移动/OSC/DCS 等)
// 直接剔除——与 stripAnsi 的清理范围一致,输出已做 HTML 转义,无注入风险。
//
// 颜色对照 xterm 256 色的前 16 色标准色板(与 Terminal.tsx 主题一致)。

const FG = ['#0a0e14', '#ef4444', '#10b981', '#f59e0b', '#3b82f6', '#ec48e9', '#06b6d4', '#e2e8f0']
const BG = ['#0a0e14', '#ef4444', '#10b981', '#f59e0b', '#3b82f6', '#ec48e9', '#06b6d4', '#e2e8f0']
const FG_BRIGHT = ['#475569', '#f87171', '#34d399', '#fbbf24', '#60a5fa', '#f472b6', '#22d3ee', '#f8fafc']
const BG_BRIGHT = ['#475569', '#f87171', '#34d399', '#fbbf24', '#60a5fa', '#f472b6', '#22d3ee', '#f8fafc']

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

interface Style { fg?: string; bg?: string; bold?: boolean; underline?: boolean; inverse?: boolean }

function styleToAttrs(st: Style): string {
  const parts: string[] = []
  if (st.fg) parts.push(`color:${st.fg}`)
  if (st.bg) parts.push(`background-color:${st.bg}`)
  if (st.bold) parts.push('font-weight:bold')
  if (st.underline) parts.push('text-decoration:underline')
  return parts.length ? ` style="${parts.join(';')}"` : ''
}

/** 把含 ANSI 序列的终端文本转成 HTML 片段(行以 <div> 包裹,颜色以 span 保留) */
export function ansiToHtml(text: string): string {
  // 一次性按"普通文本 or 转义序列"分词,再逐段生成
  const tokens = String(text || '').split(/(\x1b\[[0-9;:<=>?]*[ -\/]*[@-~]|\x1b\][^\x1b\x07]*(?:\x1b\\|\x07)?|\x1b[P_^X\\][^\x1b]*(?:\x1b\\)?|\x1b[()][0-9A-Z])/g)
  let st: Style = {}
  let html = ''
  let open = false
  const closeSpan = () => { if (open) { html += '</span>'; open = false } }
  const openSpan = () => {
    const attrs = styleToAttrs(st)
    if (attrs) { html += `<span${attrs}>`; open = true } else closeSpan()
  }

  for (const tk of tokens) {
    if (!tk) continue
    if (tk[0] === '\x1b') {
      // SGR(\x1b[..m)才影响样式;其余转义(光标/OSC/DCS/字符集)直接丢弃
      const m = /^\x1b\[([0-9;:<=>?]*)m$/.exec(tk)
      if (!m) continue
      closeSpan()
      const params = (m[1] || '0').split(';').map((x) => parseInt(x, 10) || 0)
      for (const p of params) {
        if (p === 0) st = {}
        else if (p === 1) st.bold = true
        else if (p === 4) st.underline = true
        else if (p === 7) st.inverse = true
        else if (p === 22) st.bold = false
        else if (p === 24) st.underline = false
        else if (p === 27) st.inverse = false
        else if (p >= 30 && p <= 37) st.fg = FG[p - 30]
        else if (p === 39) delete st.fg
        else if (p >= 40 && p <= 47) st.bg = BG[p - 40]
        else if (p === 49) delete st.bg
        else if (p >= 90 && p <= 97) st.fg = FG_BRIGHT[p - 90]
        else if (p >= 100 && p <= 107) st.bg = BG_BRIGHT[p - 100]
        // 256 色/RGB(38;5;n / 48;2;r;g;b)需消费后续参数,这里降级为默认色
        else if (p === 38 || p === 48) { /* 简化:忽略扩展色,保留其余参数为默认 */ }
      }
      openSpan()
    } else {
      if (!open) openSpan()
      // \r 与 \n 规范成行分隔;其余控制符(\x07 等)剔除
      const cleaned = tk.replace(/\r\n|\r/g, '\n').replace(/[\x00-\x08\x0b-\x1f]/g, '')
      html += escapeHtml(cleaned)
    }
  }
  closeSpan()
  // 行包 <div>,空行用占位保证高度
  return html.split('\n').map((l) => `<div>${l || ' '}</div>`).join('')
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
