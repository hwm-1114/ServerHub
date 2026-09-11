// 桌面版(GUI)审计:驱动**打包后的真实 ServerHub.exe**,验证只能人工/GUI 才能覆盖的部分:
//   1) 打包产物能起、内置后端在 33120、数据目录确实落在 userData(而不是仓库 data/)
//   2) 界面新建服务器 → 连接真实服务器 → 会话自动出现
//   3) 文件页:真实 SFTP 列目录
//   4) 【GUI 级】把本机文件"拖"到远程列表 = 上传(用 CDP Input.dispatchDragEvent 合成真实 OS 拖放)
//   5) 【GUI 级】把文件拖到侧栏(非投放区):窗口绝不能导航走(验证 will-navigate 守卫 + 根层兜底)
//   6) 断开连接后会话标签仍在(批次 M 回归)
//   7) 单实例锁:再启一个进程应立刻退出且不影响第一个
// 用法(凭据走环境变量;未设置则跳过真机部分,只做 1/5/7):
//   $env:SH_HOST=..; $env:SH_USER=..; $env:SH_PASS=..; node scripts/desktop-audit.mjs
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { createRequire } from 'module'
const require = createRequire(new URL('../package.json', import.meta.url))
const { WebSocket } = require('ws')

const EXE = path.join(process.cwd(), 'release', 'win-unpacked', 'ServerHub.exe')
const CDP_PORT = Number(process.env.CDP_PORT || 39222)
const APP_PORT = 33120
const HOST = process.env.SH_HOST, USER = process.env.SH_USER, PASS = process.env.SH_PASS
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'serverhub-desktop-'))
const REMOTE_DIR = `/root/serverhub-desktop-${Date.now()}`

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log('  ✅', label) } else { fail++; console.log('  ❌', label) }
  if (extra) console.log('     ', extra)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const api = (p, init) => fetch(`http://127.0.0.1:${APP_PORT}/api${p}`, init).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))
const jpost = (p, b) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })

if (!fs.existsSync(EXE)) { console.error('未找到打包产物:', EXE, '\n请先 npm run app'); process.exit(2) }

// ---------- CDP ----------
async function connectCdp() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find(t => t.type === 'page' && String(t.url).includes(String(APP_PORT)))
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* 还没起来 */ }
    await sleep(500)
  }
  throw new Error('CDP 目标页未就绪(应用没起来或端口被占)')
}
function makeCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let id = 0
  const pending = new Map()
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString())
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  })
  const send = (method, params) => new Promise((res, rej) => {
    const i = ++id
    pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m)))
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 200))
    return r.result?.result?.value
  }
  const ready = new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  return { send, evaluate, ready, close: () => ws.close() }
}

// 合成真实拖放(dragEnter → dragOver → drop),files 为绝对路径
async function dropFilesAt(cdp, files, x, y) {
  const data = { items: [], files, dragOperationsMask: 1 }
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await cdp.send('Input.dispatchDragEvent', { type, x, y, data })
    await sleep(120)
  }
  return { ok: true, x, y }
}
async function dropFiles(cdp, files, selector) {
  const box = await cdp.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(40, r.height / 2)) } })()`)
  if (!box) return { ok: false, error: `找不到投放目标 ${selector}` }
  return dropFilesAt(cdp, files, box.x, box.y)
}

const HELPERS = `
window.__d = {
  vis: (el) => !!(el && el.offsetParent !== null),
  all: (sel) => [...document.querySelectorAll(sel)],
  clickExact: (t, tag) => { const els = [...document.querySelectorAll(tag || 'button')].filter(b => (b.textContent || '').trim() === t && window.__d.vis(b)); if (!els.length) return 'NOT_FOUND'; els[0].click(); return 'CLICKED' },
  setInput: (el, v) => { const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value'); d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) },
  fillLabel: (labelText, value) => { const lab = [...document.querySelectorAll('label')].find(l => (l.textContent || '').includes(labelText)); if (!lab) return 'NO_LABEL'; const inp = lab.parentElement.querySelector('input, textarea'); if (!inp) return 'NO_INPUT'; window.__d.setInput(inp, value); return 'OK' },
  snap: () => ({
    url: location.href,
    mounted: !!document.querySelector('#root')?.children.length,
    tabs: (document.body.innerText.match(/会话 \\d+/g) || []).length,
    termReady: document.body.innerText.includes('终端就绪'),
    emptyState: document.body.innerText.includes('开始管理你的服务器'),
    fileRows: document.querySelectorAll('td').length,
    text: document.body.innerText.slice(0, 400),
  }),
}
'READY'`

let app1 = null
async function main() {
  console.log(`\n桌面版审计: ${EXE}\n临时数据目录(userData): ${DATA_DIR}`)
  // 用 --user-data-dir 把 userData 指到临时目录,避免污染 %APPDATA%/ServerHub 的真实数据
  app1 = spawn(EXE, [`--user-data-dir=${DATA_DIR}`, `--remote-debugging-port=${CDP_PORT}`], { stdio: 'ignore' })
  const wsUrl = await connectCdp()
  const cdp = makeCdp(wsUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  // 关键:CDP 目标一出现就可能被 `/json/list` 报到(此时 URL 已是 http://localhost:33120,
  // 但文档还是初始的 about:blank,导航尚未提交)。CI 上机器慢,固定 sleep 会 snapshot 到空白页,
  // 于是"界面已渲染"误判失败——这里必须轮询等真正的文档就绪,再注入 HELPERS
  // (提前注入会随导航被清掉)。
  const pageState = async () => {
    try {
      return await cdp.evaluate(`({ href: location.href, rs: document.readyState, mounted: !!document.querySelector('#root')?.children.length })`)
    } catch { return null } // 导航中执行上下文会被销毁,treat as not ready
  }
  let st = null
  for (let i = 0; i < 100; i++) {
    st = await pageState()
    if (st && st.rs === 'complete' && String(st.href).includes(String(APP_PORT)) && st.mounted) break
    await sleep(300)
  }
  if (!st || !st.mounted) console.log(`     (页面就绪等待超时: ${JSON.stringify(st)})`)
  await cdp.evaluate(HELPERS)
  const snap = () => cdp.evaluate(`window.__d.snap()`)

  console.log('\n【1】打包产物 + 内置后端 + 数据目录')
  {
    const st = await api('/servers/status')
    ok(st.status === 200, '打包版内置后端在 33120 提供 API', `HTTP ${st.status} ${JSON.stringify(st.body)}`)
    const files = fs.readdirSync(DATA_DIR)
    ok(files.includes('servers.json') || files.includes('sessions.json'), '数据目录落在 userData(--user-data-dir 指向的临时目录)', files.slice(0, 8).join(', '))
    const realUserData = path.join(process.env.APPDATA || '', 'ServerHub')
    const realExists = fs.existsSync(path.join(realUserData, 'servers.json'))
    console.log(`       (真实 %APPDATA%/ServerHub 是否被动过: ${realExists ? '存在(启动前就有,可能是你原有的数据)' : '不存在'})`)
    const s = await snap()
    ok(s.mounted && /ServerHub/.test(s.text), '界面已渲染', `url=${s.url}`)
  }

  if (!HOST || !USER || !PASS) {
    console.log('\n(未设置 SH_HOST/SH_USER/SH_PASS:跳过真机相关项,只做拖拽守卫与单实例)')
  }

  console.log('\n【2】界面新建服务器 + 连接 + 会话')
  let sid = ''
  {
    await cdp.evaluate(`window.__d.clickExact('添加服务器')`)
    await sleep(500)
    const titles = await cdp.evaluate(`[...document.querySelectorAll('h2')].map(h => h.textContent.trim())`)
    ok(titles.some(t => /添加服务器/.test(t)), '添加服务器弹窗打开', JSON.stringify(titles))
    const target = HOST ? { name: '真机', host: HOST, port: '22', user: USER, pw: PASS } : { name: '本地假机', host: '127.0.0.1', port: '22', user: 'root', pw: 'x' }
    for (const [l, v] of [['名称', target.name], ['IP 地址', target.host], ['端口', target.port], ['用户名', target.user], ['密码', target.pw]]) {
      await cdp.evaluate(`window.__d.fillLabel(${JSON.stringify(l)}, ${JSON.stringify(v)})`)
    }
    await cdp.evaluate(`window.__d.clickExact('添加')`)
    await sleep(800)
    const list = (await api('/servers')).body
    ok(Array.isArray(list) && list.length === 1 && list[0].host === target.host, '界面新建的服务器已落盘', JSON.stringify(list))
    sid = list[0].id
    if (HOST) {
      // 用可见的连接按钮连接(批次 M 新增的常显按钮)
      const clicked = await cdp.evaluate(`(() => { const b = window.__d.all('button[title]').find(x => /^连接/.test(x.getAttribute('title') || '')); if (!b) return 'NOT_FOUND'; b.click(); return 'CLICKED' })()`)
      ok(clicked === 'CLICKED', '服务器行上可见的"连接"按钮可点击(批次 M)', clicked)
      let s = null
      for (let i = 0; i < 30; i++) { await sleep(1000); s = await snap(); if (s.tabs > 0 && s.termReady) break }
      ok(s.tabs > 0, '连接真实服务器后自动出现会话标签', JSON.stringify({ tabs: s.tabs, termReady: s.termReady }))
    }
  }

  console.log('\n【3】GUI 级拖放:本机文件 → 远程列表 = 上传')
  let dragged = false
  if (HOST && sid) {
    const localFile = path.join(DATA_DIR, 'desktop-drag.txt')
    fs.writeFileSync(localFile, 'DRAG-FROM-EXPLORER')
    await jpost(`/servers/${sid}/execute`, { command: `mkdir -p '${REMOTE_DIR}'` })
    // 切到文件页并进入目标目录
    await cdp.evaluate(`window.__d.clickExact('文件')`)
    await sleep(2500)
    let s = await snap()
    ok(s.fileRows > 0, '文件页列出真实目录内容', `td=${s.fileRows}`)
    // 通过 API 让当前目录变成 REMOTE_DIR 不方便,直接拖到列表(会落到家目录),再用 API 核对家目录
    const r = await dropFiles(cdp, [localFile], 'table tbody')
    ok(r.ok, '已向远程文件列表合成拖放事件', JSON.stringify(r))
    await sleep(4000)
    const home = await api(`/servers/${sid}/files?path=${encodeURIComponent('/root')}`)
    const names = (home.body?.entries || []).map(e => e.filename)
    dragged = names.includes('desktop-drag.txt')
    ok(dragged, '拖放上传落地到远端(真实 SFTP 写入)', `远端 /root 下: ${JSON.stringify(names.slice(-6))}`)
    if (dragged) await jpost(`/servers/${sid}/execute`, { command: `rm -f '/root/desktop-drag.txt'` })
    await jpost(`/servers/${sid}/execute`, { command: `rm -rf '${REMOTE_DIR}'` })
  } else {
    console.log('     (跳过:未配置真机凭据)')
  }

  console.log('\n【4】GUI 级拖放:文件拖到侧栏/终端区(非投放区)不得把窗口导航走')
  {
    const localFile = path.join(DATA_DIR, 'guard-test.txt')
    fs.writeFileSync(localFile, 'SHOULD-NOT-NAVIGATE')
    const before = await snap()
    // 侧栏大约 0~288px 宽;再补一次终端区(用整窗中心的偏右位置)
    const r1 = await dropFilesAt(cdp, [localFile], 100, 300)
    await sleep(1200)
    const afterSidebar = await snap()
    ok(afterSidebar.url === before.url && afterSidebar.mounted, '拖到侧栏后窗口仍在应用页面(未被 file:// 导航替换)',
      `拖放=${JSON.stringify(r1)} url ${before.url} → ${afterSidebar.url} mounted=${afterSidebar.mounted}`)
    const r2 = await dropFilesAt(cdp, [localFile], 900, 500)
    await sleep(1200)
    const afterTerm = await snap()
    ok(afterTerm.url === before.url && afterTerm.mounted, '拖到终端区后窗口仍在应用页面', `拖放=${JSON.stringify(r2)} url=${afterTerm.url}`)
  }

  console.log('\n【5】断开连接后会话标签仍在(批次 M 回归,打包版)')
  if (HOST && sid) {
    await jpost(`/servers/${sid}/disconnect`)
    await sleep(6500)
    // 会话标签在"终端"页签下才可见(文件页签会把整个终端层 display:none,innerText 读不到)
    await cdp.evaluate(`window.__d.clickExact('终端')`)
    await sleep(1200)
    const s = await snap()
    ok(s.tabs > 0 && !s.emptyState, '断开后会话标签仍在、不退回空状态', JSON.stringify({ tabs: s.tabs, emptyState: s.emptyState }))
  } else {
    console.log('     (跳过:未配置真机凭据)')
  }

  console.log('\n【6】单实例锁')
  {
    const second = spawn(EXE, [`--user-data-dir=${DATA_DIR}`], { stdio: 'ignore' })
    const exitInfo = await new Promise((res) => {
      const t = setTimeout(() => res({ timeout: true }), 12000)
      second.on('exit', (code) => { clearTimeout(t); res({ code }) })
    })
    ok(!exitInfo.timeout, '第二个实例自行退出(未起第二个后端/第二个窗口)', JSON.stringify(exitInfo))
    const st = await api('/servers/status')
    ok(st.status === 200, '第一个实例的后端仍正常服务', `HTTP ${st.status}`)
    try { second.kill() } catch { /* 已退出 */ }
  }

  cdp.close()
}

main().catch(e => { console.error('桌面版审计异常:', e); fail++ }).finally(async () => {
  try { if (app1) app1.kill() } catch { /* 忽略 */ }
  await sleep(1500)
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
  console.log('\n' + '='.repeat(52))
  console.log(`桌面版审计结果: ${pass} PASS / ${fail} FAIL`)
  console.log('='.repeat(52))
  process.exit(fail ? 1 : 0)
})
