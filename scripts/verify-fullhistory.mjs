// 离线验证「查看完整历史」的两个核心机制(与组件同一路径:xterm 状态机):
//   1. 重建视图:把原始字节流回放进离屏 xterm,读主缓冲区 —— TUI 程序(claude 等)
//      靠 \r 原地重绘/光标定位渲染,剥转义序列会糊成一团,回放才能还原最终画面;
//   2. 全屏抓屏:退出备用屏幕(1049/1047/47)前快照整屏,注入历史流 —— 否则 TUI
//      程序(vim/htop/备用屏模式的 agent)退出时内容整体消失。
// 运行: node scripts/verify-fullhistory.mjs
import headless from '@xterm/headless'
const { Terminal } = headless

let pass = 0, fail = 0
const ok = (cond, label) => {
  if (cond) { pass++; console.log(`  PASS  ${label}`) }
  else { fail++; console.log(`  FAIL  ${label}`) }
}

// 读出 xterm 主缓冲区全部非空行(与 FullHistoryViewer 的提取逻辑一致)
function readBuffer(term) {
  const b = term.buffer.normal
  const out = []
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
  return out
}
// 与组件一致的重建流程:分块写入 + 空写回调等待全部解析
async function replay(raw, cols = 120) {
  const term = new Terminal({ scrollback: 200000, cols, rows: 24, allowProposedApi: true })
  const CH = 512 * 1024
  for (let i = 0; i < raw.length; i += CH) term.write(raw.subarray(i, i + CH))
  await new Promise(r => term.write('', r))
  const lines = readBuffer(term)
  term.dispose()
  return lines
}
// 与组件一致的旧提取方式(剥 ANSI 后按行切),作对照
function stripAnsi(text) {
  return (text || '')
    .replace(/\x1b\[[0-9;:<=>?]*[ -\/]*[@-~]/g, '')
    .replace(/\x1b\][^\x1b]*(?:\x1b\\)?/g, '')
    .replace(/\x1b\][^\x07\x1b]*\x07/g, '')
    .replace(/\x1b[P_^X\\][^\x1b]*(?:\x1b\\)?/g, '')
    .replace(/\x1b[()][0-9A-Z]/g, '')
    .replace(/\x07/g, '').replace(/\x1b/g, '')
}

const enc = (s) => new TextEncoder().encode(s)

console.log('== 1. 重建视图:AI agent 式原地重绘(claude 类输出) ==')
{
  // 模拟 agent:同一行上 \r 原地刷新 50 帧,最后输出最终结果
  let stream = '\r\n$ agent run\r\n'
  for (let i = 1; i <= 50; i++) stream += `\r\x1b[36m[agent]\x1b[0m 处理中 ${i}/50 ...`
  stream += '\r\nAGENT_FINAL_RESULT_OK\r\n'
  const raw = enc(stream)
  const lines = await replay(raw)
  const text = lines.join('\n')
  ok(text.includes('AGENT_FINAL_RESULT_OK'), '重建视图包含最终结果')
  const frameCount = (text.match(/处理中 \d+\/50/g) || []).length
  ok(frameCount <= 1, `重绘帧不会糊成一团(残留帧 ${frameCount} ≤ 1;旧方式为 50)`)
  // 对照:旧方式(剥转义)把 50 帧全部留下
  const oldText = stripAnsi(stream)
  const oldFrames = (oldText.match(/处理中 \d+\/50/g) || []).length
  ok(oldFrames === 50, `对照:旧原始文本方式 50 帧全糊在一起(${oldFrames})`)
}

console.log('== 2. 全屏抓屏:备用屏幕内容退出时快照(vim/htop 类) ==')
{
  const live = new Terminal({ scrollback: 200000, cols: 120, rows: 24, allowProposedApi: true })
  const journal = [] // 组件里 push 进 fullBytesRef
  // 与组件一致的抓屏钩子
  const snapshotAltScreen = () => {
    try {
      const buf = live.buffer
      if (buf.active !== buf.alternate) return
      const b = buf.alternate
      const altLines = []
      for (let i = 0; i < b.length; i++) altLines.push(b.getLine(i)?.translateToString(true) ?? '')
      const content = altLines.join('\n').replace(/\s+$/, '')
      if (!content.trim()) return
      journal.push(enc(`\r\n──── 全屏模式输出(退出时快照) ────\r\n${content}\r\n──── 全屏输出结束 ────\r\n`))
    } catch {}
  }
  const onDec = (params) => {
    if (params.length === 1 && (params[0] === 1049 || params[0] === 1047 || params[0] === 47)) snapshotAltScreen()
    return false
  }
  ;['h', 'l'].map(f => live.parser.registerCsiHandler({ prefix: '?', final: f }, onDec))

  // 备用屏上绘制内容后退出
  const stream = '\r\n$ vim file\r\n' +
    '\x1b[?1049h' + '\x1b[H\x1b[2J' + 'ALT_SCREEN_MARKER_XYZ\r\n第二行: 全屏内容行2' +
    '\x1b[?1049l' + '\r\nBACK_TO_MAIN_OK\r\n'
  live.write(stream)
  await new Promise(r => live.write('', r))

  const liveText = readBuffer(live).join('\n')
  ok(!liveText.includes('ALT_SCREEN_MARKER_XYZ'), '实时终端(主屏)退出后确实看不到备用屏内容')
  ok(liveText.includes('BACK_TO_MAIN_OK'), '主屏恢复正常内容')
  ok(journal.length === 1 && journal[0].length > 0, '退出备用屏时抓屏了一次')
  live.dispose()

  // 回放 = 原始流 + 抓屏快照 → 历史里能看到全屏内容
  const combined = Buffer.concat([enc(stream), ...journal])
  const histLines = await replay(new Uint8Array(combined))
  const histText = histLines.join('\n')
  ok(histText.includes('ALT_SCREEN_MARKER_XYZ'), '完整历史(重建视图)能看到备用屏内容')
  ok(histText.includes('全屏模式输出(退出时快照)'), '快照带分节标记')
  ok(histText.includes('BACK_TO_MAIN_OK'), '主屏内容同样在')
}

console.log('== 3. 重建后行数与内容量合理性 ==')
{
  // 大量普通输出(非 TUI)在重建视图下不丢内容
  let stream = ''
  for (let i = 1; i <= 5000; i++) stream += `line-${i}\r\n`
  const lines = await replay(enc(stream))
  const text = lines.join('\n')
  ok(text.includes('line-1') && text.includes('line-5000'), '普通输出首尾都在(5000 行)')
  ok(lines.filter(l => l.startsWith('line-')).length >= 5000, `行数完整(${lines.filter(l => l.startsWith('line-')).length})`)
}

console.log(`\n结果: ${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
