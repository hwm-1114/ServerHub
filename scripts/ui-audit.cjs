// UI 级验证 v2:用 Electron 隐藏窗口真实驱动界面,围绕用户报的四个疑点取证。
// 关键手法:连接/会话等"状态"用 API 造(避免依赖 hover 菜单的点击),界面只做观测与必要点击。
// 运行: node_modules\.bin\electron.cmd .verify\ui-audit.cjs
const path = require('path')
const fs = require('fs')
const os = require('os')
const { app, BrowserWindow } = require('electron')

app.disableHardwareAcceleration()

// ---------- 假 ssh2 ----------
const { EventEmitter } = require('events')
const { Readable, Writable } = require('stream')
const files = new Map([['/home/u/readme.txt', 'HELLO-REMOTE'], ['/home/u/big.bin', 'X'.repeat(2048)]])
const dirs = new Set(['/', '/home', '/home/u', '/home/u/sub'])
class FakeStream extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); this.closed = false }
  write() { return true }
  setWindow() {}
  end() { this.close() }
  close() { if (!this.closed) { this.closed = true; this.emit('close') } }
}
function attrs(p) {
  const isDir = dirs.has(p)
  return { size: isDir ? 0 : Buffer.byteLength(files.get(p) || ''), mode: isDir ? 0o40755 : 0o100644, mtime: 1700000000, isDirectory: () => isDir, isFile: () => !isDir, isSymbolicLink: () => false }
}
class FakeSftp extends EventEmitter {
  stat(p, cb) { setTimeout(() => (files.has(p) || dirs.has(p) ? cb(null, attrs(p)) : cb(Object.assign(new Error('No such file'), { code: 2 }))), 1) }
  lstat(p, cb) { return this.stat(p, cb) }
  readdir(p, cb) {
    setTimeout(() => {
      if (!dirs.has(p)) return cb(Object.assign(new Error('No such file'), { code: 2 }))
      const kids = [...new Set([...files.keys(), ...dirs].filter(x => x !== p && path.posix.dirname(x) === p))]
      cb(null, kids.map(k => ({ filename: path.posix.basename(k), longname: '', attrs: attrs(k) })))
    }, 1)
  }
  unlink(p, cb) { files.delete(p); setTimeout(() => cb(null), 1) }
  rmdir(p, cb) { dirs.delete(p); setTimeout(() => cb(null), 1) }
  mkdir(p, cb) { dirs.add(p); setTimeout(() => cb(null), 1) }
  rename(a, b, cb) { const c = files.get(a); files.delete(a); if (c) files.set(b, c); setTimeout(() => cb(null), 1) }
  createReadStream(p) { return files.has(p) ? Readable.from([Buffer.from(files.get(p))]) : Readable.from([]) }
  createWriteStream(p) {
    const chunks = []
    const ws = new Writable({ write(c, _e, cb) { chunks.push(c); cb() } })
    ws.on('finish', () => files.set(p, Buffer.concat(chunks).toString()))
    process.nextTick(() => ws.emit('open', 1))
    return ws
  }
}
class FakeClient extends EventEmitter {
  connect() { setTimeout(() => this.emit('ready'), 10) }
  shell(_o, cb) { setTimeout(() => cb(null, new FakeStream()), 5) }
  exec(cmd, cb) {
    const s = new FakeStream()
    setTimeout(() => {
      cb(null, s)
      // 供前端解析 ~ 的 echo $HOME
      setTimeout(() => { s.emit('data', Buffer.from('/home/u\n')); s.close() }, 5)
    }, 5)
    void cmd
  }
  sftp(cb) { setTimeout(() => cb(null, new FakeSftp()), 5); return new FakeSftp() }
  end() { this.emit('close') }
}
// 注意:.verify/ 下自带 node_modules(含 ssh2),require('ssh2') 拿到的是另一份实例,
// 补丁打不到 server/ssh-manager.js 实际加载的根 node_modules/ssh2 —— 必须按绝对路径取根那份。
require(path.join(__dirname, '..', 'node_modules', 'ssh2')).Client = FakeClient

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverhub-ui-'))
process.env.SERVERHUB_DATA_DIR = dataDir
fs.writeFileSync(path.join(dataDir, 'servers.json'), '[]')
const PORT = 38161
process.env.PORT = String(PORT)
const API = `http://127.0.0.1:${PORT}/api`

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log('  ✅', label) } else { fail++; console.log('  ❌', label) }
  if (extra) console.log('     ', extra)
}

const HELPERS = `
window.__t = {
  txt: (sel) => (document.querySelector(sel)?.textContent || '').trim(),
  all: (sel) => [...document.querySelectorAll(sel)],
  vis: (el) => !!(el && el.offsetParent !== null),
  byText: (t, tag) => [...document.querySelectorAll(tag || 'button,span,div,a')].filter(e => (e.textContent || '').trim() === t || (e.textContent || '').includes(t)),
  clickText: (t, tag) => {
    const els = window.__t.byText(t, tag).filter(e => window.__t.vis(e))
    if (!els.length) return 'NOT_FOUND'
    els[els.length - 1].click(); return 'CLICKED'
  },
  clickExact: (t, tag) => {
    const els = [...document.querySelectorAll(tag || 'button')].filter(b => (b.textContent || '').trim() === t && window.__t.vis(b))
    if (!els.length) return 'NOT_FOUND'
    els[0].click(); return 'CLICKED'
  },
  setInput: (el, v) => {
    const d = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
    d.set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }))
  },
  fillLabel: (labelText, value) => {
    const lab = [...document.querySelectorAll('label')].find(l => (l.textContent || '').includes(labelText))
    if (!lab) return 'NO_LABEL'
    const inp = lab.parentElement.querySelector('input, textarea')
    if (!inp) return 'NO_INPUT'
    window.__t.setInput(inp, value); return 'OK'
  },
  counts: () => ({
    tabs: [...document.querySelectorAll('span')].filter(s => /^会话 \\d+$/.test((s.textContent || '').trim())).length,
    tabsAny: (document.body.innerText.match(/会话 \\d+/g) || []).length,
    terminalReady: document.body.innerText.includes('终端就绪'),
    noServerOverlay: (document.body.innerText.match(/服务器未连接/g) || []).length,
    emptyState: document.body.innerText.includes('开始管理你的服务器'),
    visibleConnect: window.__t.byText('连接服务器').filter(e => window.__t.vis(e)).length,
    visibleDisconnect: window.__t.byText('断开连接').filter(e => window.__t.vis(e)).length,
    localPanel: !!document.querySelector('[data-localpanel]'),
    fileRows: [...document.querySelectorAll('td')].length,
    transferItems: document.body.innerText.includes('上传') || document.body.innerText.includes('下载'),
  }),
  body: () => document.body.innerText.replace(/\\n{2,}/g, '\\n'),
}
'READY'`

async function main() {
  // 界面回归跑的是**真实前端产物**:server/index.js 只在 dist/ 存在时服务静态文件,
  // 缺产物时首页是 404,十几条断言会集体失败且原因难查,所以这里先明确报错。
  if (!fs.existsSync(path.join(__dirname, '..', 'dist', 'index.html'))) {
    console.error('缺少前端产物 dist/index.html,请先执行 npm run build 再跑 audit:ui')
    app.exit(2)
    return
  }
  const { server } = await import('../server/index.js')
  if (!server.listening) await new Promise(r => server.once('listening', r))
  const win = new BrowserWindow({ show: false, width: 1400, height: 900, webPreferences: { contextIsolation: true, nodeIntegration: false } })
  const errors = []
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(String(msg)) })
  const js = (code) => win.webContents.executeJavaScript(code)
  const wait = (ms = 500) => new Promise(r => setTimeout(r, ms))
  const counts = () => js(`window.__t.counts()`)
  // loadURL 的 resolve 只代表 load 事件,React 挂载还在其后;固定 sleep 在慢机器(CI)上会 snapshot 到
  // 还没渲染的空壳,于是断言集体失败。改成轮询等 #root 真的有子节点,再注入 HELPERS。
  const waitMounted = async (ms = 15000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const mounted = await js('!!document.querySelector("#root")?.children.length').catch(() => false)
      if (mounted) return true
      await wait(200)
    }
    return false
  }
  const reload = async () => {
    await win.loadURL(`http://127.0.0.1:${PORT}/`)
    if (!await waitMounted()) console.log('     (等待界面挂载超时,后续断言可能失败)')
    await js(HELPERS)
  }
  const api = (p, init) => fetch(API + p, init).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }))
  const jpost = (p, b) => api(p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) })

  await reload()

  console.log('\n【1】新建服务器(走界面)')
  {
    ok(await js(`window.__t.clickText('添加服务器')`) === 'CLICKED', '存在可见的「添加服务器」入口')
    await wait(400)
    const titles = await js(`[...document.querySelectorAll('h2')].map(h => h.textContent.trim())`)
    ok(titles.some(t => /添加服务器/.test(t)), '弹窗打开', JSON.stringify(titles))
    // 弹窗打开时就检查字段(私钥入口)
    const keyField = await js(`[...document.querySelectorAll('label')].some(l => /私钥|密钥/.test(l.textContent))`)
    const pwRequired = await js(`(() => { const l = [...document.querySelectorAll('label')].find(x => x.textContent.trim() === '密码'); return l ? !!l.parentElement.querySelector('input[required]') : null })()`)
    ok(keyField, '弹窗提供私钥认证入口(后端支持 privateKey;旧界面完全没有)', `有私钥字段=${keyField}`)
    ok(pwRequired === false, '密码不再强制必填(可用私钥认证建服务器)', `密码必填=${pwRequired}`)
    await js(`window.__t.clickText('添加')`)   // 空表单提交
    await wait(300)
    const t2 = await js(`[...document.querySelectorAll('h2')].map(h => h.textContent.trim())`)
    ok(t2.some(t => /添加服务器/.test(t)), '必填为空时提交被应用拦下(弹窗保持打开)')
    for (const [l, v] of [['名称', '测试机'], ['IP 地址', '10.0.0.9'], ['端口', '2222'], ['用户名', 'root'], ['密码', 'pw123']]) {
      const r = await js(`window.__t.fillLabel(${JSON.stringify(l)}, ${JSON.stringify(v)})`)
      if (r !== 'OK') console.log(`       (字段 ${l}: ${r})`)
    }
    await js(`window.__t.clickText('添加')`)
    await wait(700)
    const list = (await api('/servers')).body
    ok(list.length === 1 && list[0].host === '10.0.0.9' && String(list[0].port) === '2222' && list[0].name === '测试机',
      '界面新建后落盘字段正确', JSON.stringify(list))
    await reload()
  }

  console.log('\n【2】连接/断开入口可见性(不 hover 齿轮菜单)')
  let sid
  {
    sid = (await api('/servers')).body[0].id
    // 服务器行上的连接/断开是纯图标按钮,按 title 统计(图标按钮没有文本)
    const btns = await js(`window.__t.all('button[title]').filter(b => window.__t.vis(b)).map(b => b.getAttribute('title'))`)
    const conn = btns.filter(t => /^连接/.test(t)).length
    const disc = btns.filter(t => /^断开/.test(t)).length
    ok(conn + disc > 0, '服务器行上有**可见**的连接/断开按钮(无需 hover 设置菜单)', `可见按钮 title=${JSON.stringify(btns.filter(t => /连接|断开/.test(t)))}`)
  }

  console.log('\n【3】断开连接后会话是否消失(用户报告的核心)')
  {
    // 先用 API 造出"已连接 + 3 个会话",再刷新页面,得到最接近用户的初始状态
    await jpost(`/servers/${sid}/connect`)
    for (let i = 0; i < 3; i++) await jpost(`/servers/${sid}/sessions`, { name: `会话 ${i + 1}` })
    await reload()
    // 选中服务器(用户点服务器行)→ 加载会话列表
    await js(`window.__t.clickText('测试机', 'span')`)
    await wait(1200)
    const connected = await counts()
    ok(connected.tabs >= 1 || connected.tabsAny >= 1, '已连接时能看到会话标签', JSON.stringify({ tabs: connected.tabs, tabsAny: connected.tabsAny }))
    console.log(`       状态: 终端就绪=${connected.terminalReady} 空状态=${connected.emptyState} 服务器未连接遮罩=${connected.noServerOverlay}`)

    // 断开(等价于用户点断开连接;界面入口在齿轮菜单里,这里直接调 API 触发同样的状态变化)
    await jpost(`/servers/${sid}/disconnect`)
    await wait(6500)   // 等 5s 状态轮询把 disconnected 推给前端
    const after = await counts()
    const sessionsApi = (await api(`/servers/${sid}/sessions`)).body
    ok(after.tabsAny >= 1, '断开后会话标签仍在(前端不清空会话列表)',
      `断开后“会话 N”出现 ${after.tabsAny} 处;空状态=${after.emptyState};未连接遮罩=${after.noServerOverlay}`)
    ok(!after.emptyState, '断开后不会退回"开始管理你的服务器"空状态')
    ok(Array.isArray(sessionsApi) && sessionsApi.length === 3, '断开不会删除后端会话记录', `sessions=${sessionsApi.length}`)
    console.log(`       断开后状态: tabsAny=${after.tabsAny} 空状态=${after.emptyState} 未连接遮罩=${after.noServerOverlay} 可见断开按钮=${after.visibleDisconnect}`)
  }

  console.log('\n【4】文件页 + 本机↔远端 真实互传(走界面按钮)')
  {
    await jpost(`/servers/${sid}/connect`)
    await wait(6000)  // 等状态轮询
    // 造一个本机临时目录 + 收藏,方便把本机面板导航过去(界面没有路径输入框)
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverhub-upl-'))
    fs.writeFileSync(path.join(localDir, 'upload-me.txt'), 'FROM-LOCAL-UI')
    fs.writeFileSync(path.join(localDir, '第二文件.txt'), 'SECOND')
    await jpost('/local/favorites', { path: localDir, name: 'UI上传源' })
    await reload()
    await wait(6500)  // 等 5s 状态轮询把 connected 推给前端(否则文件页显示"未连接")

    await js(`window.__t.clickExact('文件')`)
    await wait(2500)
    let c = await counts()
    if (c.fileRows === 0) {
      const b = await js(`window.__t.body()`)
      console.log('       [调试] 点击文件页后的界面文字:\n' + b.slice(0, 600).split('\n').map(l => '        ' + l).join('\n'))
    }
    ok(c.fileRows > 0, '远程文件列表渲染出行', `td 数=${c.fileRows}`)

    const toggle = await js(`(() => { const b = window.__t.all('button[title]').find(x => /本机/.test(x.getAttribute('title') || '')); if (!b) return 'NOT_FOUND'; b.click(); return 'CLICKED' })()`)
    await wait(1500)
    c = await counts()
    ok(toggle === 'CLICKED' && c.localPanel, '本机目录面板可打开', `开关=${toggle} data-localpanel=${c.localPanel}`)

    // 通过收藏把本机面板导航到临时目录
    const favClick = await js(`window.__t.clickText('UI上传源')`)
    await wait(1500)
    const localFiles = await js(`[...document.querySelectorAll('[data-localpanel] div[title]')].map(d => d.getAttribute('title')).filter(Boolean)`)
    ok(favClick === 'CLICKED' && localFiles.some(t => t.includes('upload-me.txt')), '本机面板进入临时目录并列出文件', `收藏点击=${favClick} 行=${JSON.stringify(localFiles.slice(0, 6))}`)

    // 勾选两个本机文件 → 上传选中到远程
    const sel = await js(`(() => { const b = window.__t.all('button[title]').find(x => /批量选择/.test(x.getAttribute('title') || '')); if (!b) return 'NOT_FOUND'; b.click(); return 'CLICKED' })()`)
    await wait(700)
    const picked = await js(`(() => {
      const rows = [...document.querySelectorAll('[data-localpanel] div[title]')].filter(d => /upload-me\\.txt|第二文件\\.txt/.test(d.getAttribute('title') || ''))
      rows.forEach(r => r.click())
      return rows.length
    })()`)
    await wait(500)
    const uploadBtnTxt = await js(`(window.__t.byText('上传选中到远程').filter(e => window.__t.vis(e))[0]?.textContent || '').trim()`)
    const up = await js(`window.__t.clickText('上传选中到远程')`)
    await wait(3000)
    const remoteAfter = await (await fetch(`${API}/servers/${sid}/files?path=${encodeURIComponent('/home/u')}`)).json()
    const upOk = (remoteAfter.entries || []).some(e => e.filename === 'upload-me.txt')
    ok(sel === 'CLICKED' && up === 'CLICKED' && upOk, '界面批量上传本机→远端成功',
      `选择模式=${sel} 勾选=${picked} 按钮"${uploadBtnTxt}" 点击=${up} 远端条目=${JSON.stringify((remoteAfter.entries || []).map(e => e.filename))}`)

    // 远端勾选(远程行是"点整行切换勾选",没有 input[type=checkbox])→ 下载选中到本机
    // 注:刷新期间列表会被 loading 占位,必须轮询等行出现,不能固定等待
    let remoteRows = 0
    for (let i = 0; i < 20 && remoteRows === 0; i++) {
      remoteRows = await js(`[...document.querySelectorAll('tr')].filter(tr => /upload-me\\.txt/.test(tr.textContent)).length`)
      if (remoteRows === 0) await wait(500)
    }
    const selRemote = await js(`(() => { const b = window.__t.all('button[title]').find(x => /批量勾选远程文件/.test(x.getAttribute('title') || '')); if (!b) return 'NOT_FOUND'; b.click(); return 'CLICKED' })()`)
    await wait(700)
    const pickedRemote = await js(`(() => {
      const rows = [...document.querySelectorAll('tr')].filter(tr => /upload-me\\.txt/.test(tr.textContent))
      rows.forEach(tr => tr.click())
      return rows.length
    })()`)
    await wait(700)
    if (pickedRemote === 0) {
      const dbg = await js(`({
        trs: document.querySelectorAll('tr').length,
        hasName: document.body.innerText.includes('upload-me.txt'),
        tableText: (document.querySelector('table')?.innerText || '').slice(0, 160).replace(/\\n/g, ' | '),
        titles: window.__t.all('button[title]').map(b => b.getAttribute('title')).filter(t => /勾选|本机/.test(t)),
      })`)
      console.log('       [调试] ' + JSON.stringify(dbg))
    }
    const dlTxt = await js(`(window.__t.byText('下载选中到本机').filter(e => window.__t.vis(e))[0]?.textContent || '').trim()`)
    const dl = await js(`window.__t.clickText('下载选中到本机')`)
    await wait(3500)
    const localGot = fs.existsSync(path.join(localDir, 'upload-me.txt')) && fs.readFileSync(path.join(localDir, 'upload-me.txt'), 'utf8') === 'FROM-LOCAL-UI'
    ok(selRemote === 'CLICKED' && dl === 'CLICKED' && localGot, '界面批量下载远端→本机成功',
      `勾选模式=${selRemote} 勾选行数=${pickedRemote} 按钮"${dlTxt}" 点击=${dl} 本地文件内容=${localGot ? '一致' : '不一致/缺失'}`)

    // 传输条是否出现记录
    const bar = await js(`document.body.innerText.includes('传输') || document.body.innerText.includes('上传')`)
    console.log(`       传输条区域文本可见=${bar}`)
    fs.rmSync(localDir, { recursive: true, force: true })
  }

  console.log('\n【5】会话重命名(输入框必须自动聚焦;用户报"很容易重命名失败")')
  {
    // 展开侧栏服务器行(reload 后 expandedServers 重置为折叠;已展开则不动)
    const expand = await js(`(() => {
      const hasRow = [...document.querySelectorAll('div')].some(d => String(d.className || '').includes('group/ses') && /^会话 \\d+$/.test((d.textContent || '').trim()))
      if (hasRow) return 'ALREADY'
      const srvRow = [...document.querySelectorAll('div')].find(d => (d.textContent || '').includes('测试机') && String(d.className || '').includes('gap-2 px-2 py-2 rounded-lg') && d.querySelector('button'))
      if (!srvRow) return 'NO_SRV'
      srvRow.querySelector('button').click()
      return 'EXPANDED'
    })()`)
    await wait(700)
    // 打开侧栏会话行的 ⋮ 菜单 → 点"重命名"。
    // 注意只匹配侧栏行(group/ses 类):主区 SessionTabs 的标签文本同样是"会话 N",
    // 标签上的最后一个按钮是"关闭会话(X)",误点会直接删掉会话
    const openMenu = await js(`(() => {
      const rows = [...document.querySelectorAll('div')].filter(d => String(d.className || '').includes('group/ses') && /^会话 \\d+$/.test((d.textContent || '').trim()))
      const row = rows.find(r => r.textContent.trim() === '会话 1')
      if (!row) return 'NO_ROW'
      const btns = [...row.querySelectorAll('button')]
      btns[btns.length - 1].click()
      return 'CLICKED'
    })()`)
    await wait(500)
    ok(openMenu === 'CLICKED', '能打开会话行菜单', `展开=${expand} 打开=${openMenu}`)
    const clickedRename = await js(`window.__t.clickExact('重命名', 'button')`)
    await wait(400)
    const dbg = await js(`({
      menuBtns: window.__t.all('button').filter(b => window.__t.vis(b)).map(b => (b.textContent || '').trim()).filter(t => /重命名|关闭会话/.test(t)),
      inputs: window.__t.all('input').filter(i => window.__t.vis(i)).map(i => i.value),
      active: document.activeElement ? document.activeElement.tagName + ':' + (document.activeElement.value || '') : 'none',
    })`)
    console.log('       [调试] 菜单按钮=', JSON.stringify(dbg.menuBtns), ' 可见输入=', JSON.stringify(dbg.inputs), ' 焦点=', dbg.active)
    // 核心回归点:输入框出现时必须已自动聚焦。修复前没有 autoFocus,焦点留在别处,
    // 用户点完菜单直接打字毫无反应(甚至打进远端终端),表现为"重命名很容易失败"
    const st = await js(`(() => {
      const inputs = [...document.querySelectorAll('input')].filter(i => window.__t.vis(i) && i.value === '会话 1')
      const inp = inputs[inputs.length - 1]
      if (!inp) return { found: false }
      return { found: true, focused: document.activeElement === inp }
    })()`)
    ok(st.found && st.focused, '重命名输入框出现时**自动聚焦**(本次修复点)', JSON.stringify(st))
    // 不点击输入框,直接改值 + Enter 提交(等价于聚焦正常的用户行为)
    const renamed = await js(`(() => {
      const inputs = [...document.querySelectorAll('input')].filter(i => window.__t.vis(i) && i.value === '会话 1')
      const inp = inputs[inputs.length - 1]
      if (!inp) return 'NO_INPUT'
      window.__t.setInput(inp, '改名会话')
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      return 'ENTERED'
    })()`)
    await wait(1200)
    const body = await js(`window.__t.body()`)
    ok(renamed === 'ENTERED' && body.includes('改名会话'), '回车提交后界面显示新名称', `提交=${renamed}`)
    const sessionsApi = (await api(`/servers/${sid}/sessions`)).body
    ok(Array.isArray(sessionsApi) && sessionsApi.some(x => x.name === '改名会话'), '后端会话记录持久化了新名称', JSON.stringify((sessionsApi || []).map(x => x.name)))
  }

  console.log('\n【6】文件批量勾选 → 批量删除(新增功能)')
  {
    await js(`window.__t.clickExact('文件')`)
    await wait(2000)
    // 等远程列表渲染出 upload-me.txt(【4】上传过),再确保勾选模式开启
    // (【4】结束时勾选模式可能仍是开启状态,开关标题已变"退出批量勾选")
    let remoteRows = 0
    for (let i = 0; i < 20 && remoteRows === 0; i++) {
      remoteRows = await js(`[...document.querySelectorAll('tr')].filter(tr => /upload-me\\.txt/.test(tr.textContent)).length`)
      if (remoteRows === 0) await wait(500)
    }
    const selRemote = await js(`(() => {
      const b = window.__t.all('button[title]').find(x => /批量勾选远程文件/.test(x.getAttribute('title') || ''))
      if (!b) return 'ALREADY'
      b.click(); return 'CLICKED'
    })()`)
    await wait(700)
    const picked = await js(`(() => {
      const rows = [...document.querySelectorAll('tr')].filter(tr => /upload-me\\.txt/.test(tr.textContent))
      rows.forEach(tr => tr.click())
      return rows.length
    })()`)
    await wait(500)
    const btnTxt = await js(`(window.__t.byText('删除选中').filter(e => window.__t.vis(e))[0]?.textContent || '').trim()`)
    const clicked = await js(`window.__t.clickText('删除选中')`)
    await wait(500)
    ok((selRemote === 'CLICKED' || selRemote === 'ALREADY') && picked > 0 && clicked === 'CLICKED', '勾选远程文件后出现「删除选中」并可点击',
      `模式=${selRemote} 勾选=${picked} 按钮="${btnTxt}" 点击=${clicked}`)
    // 危险确认:输入"删除"并点确认按钮
    const typed = await js(`(() => {
      const inputs = [...document.querySelectorAll('input')].filter(i => window.__t.vis(i))
      const inp = inputs[inputs.length - 1]
      if (!inp) return 'NO_INPUT'
      window.__t.setInput(inp, '删除')
      return 'OK'
    })()`)
    const confirmed = await js(`window.__t.clickText('删除 1 项', 'button')`)
    await wait(3000)
    const remoteAfter = await (await fetch(`${API}/servers/${sid}/files?path=${encodeURIComponent('/home/u')}`)).json()
    const gone = !(remoteAfter.entries || []).some(e => e.filename === 'upload-me.txt')
    ok(typed === 'OK' && confirmed === 'CLICKED' && gone, '输入"删除"确认后文件被删除',
      `输入=${typed} 确认=${confirmed} 远端剩余=${JSON.stringify((remoteAfter.entries || []).map(e => e.filename))}`)
    // 完成后勾选集合清空:「删除选中」按钮应消失
    await wait(800)
    const btnLeft = await js(`window.__t.byText('删除选中').filter(e => window.__t.vis(e)).length`)
    ok(btnLeft === 0, '删除完成后勾选集合清空(按钮消失)', `残留按钮=${btnLeft}`)
  }

  console.log('\n【页面 console 错误】')
  if (errors.length) errors.slice(0, 8).forEach(e => console.log('   ⚠', e.slice(0, 180)))
  else console.log('   (无)')

  console.log('\n' + '='.repeat(52))
  console.log(`UI 审计结果: ${pass} PASS / ${fail} FAIL`)
  console.log('='.repeat(52))
  try { server.close() } catch {}
  fs.rmSync(dataDir, { recursive: true, force: true })
  // 断言失败必须以非 0 退出,否则 CI/脚本串跑会把"界面回归挂了"当成通过
  app.exit(fail ? 1 : 0)
}

app.whenReady().then(() => main().catch(err => { console.error('UI 审计异常:', err); app.exit(2) }))
