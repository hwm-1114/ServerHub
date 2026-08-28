// 可靠性压测矩阵:模拟"多会话执行任务 + 高频切换 + 界面操作 + 持续/批量文件传输"
// 的真实使用形态,离线(伪造 ssh2 + 内存文件系统)验证后端全部不变式。
//
// 覆盖用例(R1-R12):
//   R1  20 会话并发执行持续输出任务,API 洪峰(会话列表/重排/重命名≈前端高频切换的
//       后端负载)下全部 WS 保持 OPEN、输出行数持续增长
//   R2  会话输出隔离:每个 WS 只收到自己会话的输出,无串流
//   R3  中途删除 2 个会话 + 复制 1 个会话,其余 18 个不受影响
//   R4  会话上限:第 21 个 API 创建与裸 WS 直连均被拒;删 1 后可再建
//   R5  混合文件负载(上传/下载/列目录/删除 150 轮)期间 20 会话持续输出不断
//   R6  批量上传 20 个文件(串行,模拟前端队列)全部成功,期间会话稳定
//   R7  上传中途断开:远端无半成品残留,后续上传正常
//   R8  文件连接通道耗尽注入(第 17 次起周期性抛错):自动重连自愈,终端会话零影响
//   R9  快速导航竞态:60 次并发列不同目录,响应内容与请求目录一一对应(无串目录)
//   R10 数据层并发:并发 40 建会话恰好 20 成功 20 拒绝;POST/DELETE 交错后状态一致
//   R11 sessions.json 损坏自愈:API 恢复空表,生成 .corrupt.bak,进程不退出
//   R12 删除正在使用中的服务器:进程存活,另一台服务器的会话不受影响
//   收尾:15 秒全并发大乱炖(会话+传输+API 洪峰)后进程存活、无失败累积
// 运行: node scripts/stress-reliability-matrix.mjs
import { createRequire } from 'module'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import http from 'http'

const require = createRequire(import.meta.url)

// ---------- 内存文件系统(供伪 sftp) ----------
const fakeFS = new Map() // 绝对路径 -> { isDir: bool, size: number, content: Buffer|null }
function seedFS() {
  fakeFS.clear()
  fakeFS.set('/tmp', { isDir: true })
  for (let d = 0; d < 8; d++) {
    fakeFS.set(`/tmp/dir${d}`, { isDir: true })
    for (let f = 0; f < 5; f++) {
      fakeFS.set(`/tmp/dir${d}/DIR${d}-file${f}.txt`, { isDir: false, content: Buffer.from(`content of dir${d} file${f}\n`), size: 20 + f })
    }
  }
  fakeFS.set('/home', { isDir: true })
}
seedFS()

// ---------- 通道耗尽注入开关(R8 用) ----------
let exhaustEvery = 0 // 0=不注入; N=每 N 次 sftp 操作抛一次 channel open failure
let opCount = 0
function maybeExhaust() {
  if (!exhaustEvery) return null
  opCount++
  if (opCount % exhaustEvery === 0) {
    return new Error('(SSH) Channel open failure: open failed')
  }
  return null
}

// ---------- 伪 sftp ----------
class FakeWriteStream extends EventEmitter {
  constructor(filePath) {
    super()
    this.path = filePath
    this.chunks = []
    this.destroyed = false
    setImmediate(() => this.emit('open')) // createUploadStream 等 'open' 才 resolve
  }
  write(c) { if (!this.destroyed) this.chunks.push(Buffer.from(c)); return true }
  end() {
    const content = Buffer.concat(this.chunks)
    fakeFS.set(this.path, { isDir: false, content, size: content.length })
    setImmediate(() => this.emit('close'))
  }
  destroy() { this.destroyed = true }
}
class FakeReadStream extends EventEmitter {
  // 下载/remote-to-local 路由用 rs.pipe(dest)
  pipe(dest) { this.on('data', (d) => dest.write(d)); this.on('end', () => dest.end()); this.on('error', () => dest.destroy && dest.destroy()); return dest }
  constructor(filePath) {
    super()
    const node = fakeFS.get(filePath)
    setImmediate(() => {
      if (!node || node.isDir || !node.content) { this.emit('error', new Error('no such file')); return }
      this.emit('data', node.content)
      // flaky 节点:发出数据后中途报错(R15b 验证半成品清理)
      if (node.flaky) { this.emit('error', new Error('simulated mid-stream failure')); return }
      this.emit('end')
      this.emit('close')
    })
  }
}
class FakeSftp extends EventEmitter {
  readdir(dir, cb) { const e = maybeExhaust(); if (e) return cb(e); setImmediate(() => cb(null, [...fakeFS.entries()].filter(([p, n]) => n && !n.isDir && p.startsWith(dir + '/')).map(([p, n]) => ({ filename: p.split('/').pop(), attrs: { size: n.size ?? 0, mode: 0o100644, mtime: 1700000000, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false } })))) }
  stat(p, cb) { const e = maybeExhaust(); if (e) return cb(e); setImmediate(() => { const n = fakeFS.get(p); if (!n) return cb(Object.assign(new Error('No such file'), { code: 2 })); cb(null, { size: n.size ?? 0, isFile: () => !n.isDir, isDirectory: () => !!n.isDir }) }) }
  mkdir(p, cb) { fakeFS.set(p, { isDir: true }); setImmediate(() => cb(null)) }
  rmdir(p, cb) { fakeFS.delete(p); setImmediate(() => cb(null)) }
  unlink(p, cb) { fakeFS.delete(p); setImmediate(() => cb(null)) }
  rename(a, b, cb) { const n = fakeFS.get(a); fakeFS.delete(a); if (n) fakeFS.set(b, n); setImmediate(() => cb(null)) }
  createWriteStream(p) { return new FakeWriteStream(p) }
  createReadStream(p) { return new FakeReadStream(p) }
}

// ---------- 伪 ssh2 Client / shell(带持续输出任务) ----------
class FakeStream extends EventEmitter {
  constructor() {
    super()
    this.stderr = new EventEmitter()
    this.closed = false
    this.sessionId = null
    this._loop = null
    this._n = 0
  }
  write(buf) {
    const s = buf.toString('utf8')
    // 收到 RUNLOOP 即开始持续输出(模拟会话里跑着任务);STOP 停止
    if (s.includes('RUNLOOP') && !this._loop) {
      this._loop = setInterval(() => {
        this._n++
        this.emit('data', Buffer.from(`OUT-${this.sessionId}-${this._n}\r\n`))
      }, 40)
    }
    if (s.includes('STOPLOOP') && this._loop) { clearInterval(this._loop); this._loop = null }
    return true
  }
  setWindow() {}
  end() { this.close() }
  close() {
    if (this.closed) return
    this.closed = true
    if (this._loop) clearInterval(this._loop)
    this.emit('close')
  }
}
class FakeClient extends EventEmitter {
  constructor() { super(); this._config = null }
  connect(config) { this._config = config; setImmediate(() => this.emit('ready')) }
  shell(opts, cb) { setImmediate(() => cb(null, new FakeStream())) }
  exec(cmd, cb) {
    const s = new FakeStream()
    setImmediate(() => { s.emit('data', Buffer.from(String(cmd).slice(0, 200))); s.emit('close') })
    cb(null, s)
  }
  sftp(cb) { setImmediate(() => cb(null, new FakeSftp())) }
  end() { setImmediate(() => this.emit('close')) }
}
const ssh2 = require('ssh2')
ssh2.Client = FakeClient

// ---------- 启动后端(独立数据目录,两台假服务器) ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serverhub-matrix-'))
process.env.SERVERHUB_DATA_DIR = tmp
fs.writeFileSync(path.join(tmp, 'servers.json'), JSON.stringify([
  { id: 'srv-a', name: 'A', host: '127.0.0.1', port: 22, username: 'u', password: 'p' },
  { id: 'srv-b', name: 'B', host: '127.0.0.2', port: 22, username: 'u', password: 'p' },
]))
const PORTN = 38800 + Math.floor(Math.random() * 1000)
process.env.PORT = String(PORTN)
const { server } = await import('../server/index.js')
if (!server.listening) await new Promise(r => server.once('listening', r))
// 后端的 crash-guard 会"记录不退出"地吞掉本脚本自身的未处理拒绝,导致卡死;
// 这里在 guard 之后注册"响亮退出"钩子:测试进程出问题必须立刻暴露
process.on('unhandledRejection', (r) => { console.error('[test] unhandledRejection:', r); process.exit(2) })
process.on('uncaughtException', (e) => { console.error('[test] uncaughtException:', e); process.exit(2) })
const { WebSocket } = await import('ws')

const HTTP = `http://localhost:${PORTN}`
const WSS = `ws://localhost:${PORTN}`
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

let pass = 0, fail = 0, failLabels = []
const ok = (cond, label) => { if (cond) { pass++; console.log('  PASS ', label) } else { fail++; failLabels.push(label); console.log('  FAIL ', label) } }

async function api(method, p, body, raw = false) {
  const res = await fetch(HTTP + p, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined })
  const ct = res.headers.get('content-type') || ''
  const data = ct.includes('json') ? await res.json() : await res.text()
  return { status: res.status, data }
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const unb64 = (s) => Buffer.from(s, 'base64').toString('utf8')

// 打开会话 WS;收到 connected 后发 RUNLOOP 开始持续输出;累计自己 tag 的行数
function openTaskSession(serverId, sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WSS}/ws/terminal?serverId=${serverId}&session=${sessionId}`)
    const st = { ws, sid: sessionId, connected: false, foreign: false, text: '' }
    const timer = setTimeout(() => { try { ws.close() } catch {}; reject(new Error(`会话 ${sessionId} 连接超时`)) }, 8000)
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString())
      if (m.type === 'connected') {
        st.connected = true
        clearTimeout(timer)
        ws.send(JSON.stringify({ type: 'input', data: b64('RUNLOOP\n') }))
        resolve(st)
      } else if (m.type === 'data') {
        const t = unb64(m.data)
        st.text += t
        // 串流检测:出现别人的 tag 即污染(会话 id 本身含连字符,token 需整段匹配)
        const m2 = t.match(/OUT-[A-Za-z0-9_-]+-\d+/g) || []
        for (const hit of m2) { if (!hit.startsWith(`OUT-${sessionId}-`)) st.foreign = true }
      }
    })
    ws.on('error', (e) => { clearTimeout(timer); reject(e) })
  })
}
const lineCount = (st) => { const m = st.text.match(new RegExp(`OUT-${st.sid}-(\\d+)`, 'g')) || []; return m.length }

let uploadErrPrinted = false
async function uploadFile(dir, name, size, srv = 'srv-a') {
  const body = 'x'.repeat(size)
  const r = await api('POST', `/api/servers/${srv}/files/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(name)}`, body, true)
  if (r.status !== 201 && !uploadErrPrinted) {
    uploadErrPrinted = true
    console.log('  [诊断] 首个上传失败:', r.status, JSON.stringify(r.data).slice(0, 200))
  }
  return r
}

// ============ R1/R2:20 会话持续任务 + API 洪峰(≈高频切换的后端负载) ============
console.log('== R1/R2:20 会话持续任务 + 会话 API 洪峰 ==')
{
  // 建满 20 个会话记录
  const created = []
  for (let i = 0; i < 20; i++) {
    const r = await api('POST', '/api/servers/srv-a/sessions', { name: `t${i}` })
    created.push(r.data)
  }
  const socks = []
  for (const s of created) socks.push(await openTaskSession('srv-a', s.id))
  ok(socks.every(s => s.connected && s.ws.readyState === WebSocket.OPEN), '20 条任务会话全部连上(R1)')
  await sleep(1200)
  const base = socks.map(lineCount)
  // API 洪峰 300 次:列表 + 重排 + 重命名(前端高频切换/重排时的后端压力)。
  // 分批并发(25/批):Windows 回环端口瞬时耗尽会让 fetch 直接失败,不是后端问题
  for (let batch = 0; batch < 12; batch++) {
    await Promise.all(Array.from({ length: 25 }, (_, j) => {
      const i = batch * 25 + j
      return i % 3 === 0 ? api('GET', '/api/servers/srv-a/sessions')
        : i % 3 === 1 ? api('POST', '/api/servers/srv-a/sessions/order', { ids: created.map(s => s.id).reverse() })
          : api('PUT', `/api/servers/srv-a/sessions/${created[i % 20].id}`, { name: `t${i % 20}` })
    }))
  }
  await sleep(800)
  const after = socks.map(lineCount)
  ok(socks.every(s => s.ws.readyState === WebSocket.OPEN), 'API 洪峰后 20 条 WS 全部 OPEN(R1)')
  ok(after.every((n, i) => n > base[i] + 5), `输出持续增长(每会话 +${Math.min(...after.map((n, i) => n - base[i]))} 行以上)(R1)`)
  ok(!socks.some(s => s.foreign), '输出隔离:无串流(R2)')
  globalThis._socks = socks
  globalThis._created = created
}

// ============ R3:删除/复制会话不影响其余 ============
console.log('== R3:删除 2 个 + 复制 1 个会话 ==')
{
  const socks = globalThis._socks, created = globalThis._created
  const victims = [created[3], created[11]]
  for (const v of victims) {
    await api('DELETE', `/api/servers/srv-a/sessions/${v.id}`)
    const st = socks.find(s => s.sid === v.id)
    await new Promise(r => { if (st.ws.readyState === WebSocket.CLOSED) return r(); st.ws.on('close', r); setTimeout(r, 3000) })
  }
  const dup = await api('POST', `/api/servers/srv-a/sessions/${created[0].id}/duplicate`) // 内含 3s cwd 测量兜底
  ok(dup.status === 201, '复制会话成功(含 cwd 测量路径)')
  const dupSess = dup.data
  // 被删会话的 WS 应关闭,其余 18 条仍 OPEN 且仍在输出
  await sleep(600)
  const alive = socks.filter(s => !victims.some(v => v.id === s.sid))
  ok(alive.every(s => s.ws.readyState === WebSocket.OPEN), '其余 18 条 WS 不受删除影响(R3)')
  ok(alive.every(s => lineCount(s) > 20), '其余会话任务仍在输出(R3)')
  globalThis._socks = alive
  globalThis._created = created.filter(c => !victims.some(v => v.id === c.id)).concat([dupSess]) // 仍 20
  // 复制出的会话开一条 WS,保持满 20
  globalThis._socks.push(await openTaskSession('srv-a', dupSess.id))
}

// ============ R4:会话上限双层校验 ============
console.log('== R4:会话上限(API + 裸 WS) ==')
{
  await api('POST', '/api/servers/srv-a/sessions', { name: 'fill' }) // R3 后为 19,补满 20
  const over = await api('POST', '/api/servers/srv-a/sessions', { name: 'over' })
  ok(over.status === 400 && /20/.test(String(over.data.error || '')), '第 21 个 API 创建被明确拒绝(R4)')
  const rawWs = await new Promise((resolve) => {
    const ws = new WebSocket(`${WSS}/ws/terminal?serverId=srv-a&session=ses-raw-${Date.now()}`)
    ws.on('close', (code) => resolve(code))
    ws.on('error', () => {})
    setTimeout(() => resolve('timeout'), 5000)
  })
  ok(rawWs === 1008, `裸 WS 直连第 21 个被拒(code=${rawWs})(R4)`)
  // 删 1 个后可再建
  const socks = globalThis._socks
  const one = socks.pop()
  await api('DELETE', `/api/servers/srv-a/sessions/${one.sid}`)
  one.ws.close()
  const again = await api('POST', '/api/servers/srv-a/sessions', { name: 'again' })
  ok(again.status === 201, '删除 1 个后可再建(R4)')
  globalThis._created = globalThis._created.filter(c => c.id !== one.sid).concat([again.data])
  globalThis._socks.push(await openTaskSession('srv-a', again.data.id))
}

// ============ R5:混合文件负载期间会话不断 ============
console.log('== R5:150 轮 上传/下载/列目录/删除 混合负载 + 20 会话任务 ==')
{
  const socks = globalThis._socks
  const before = socks.map(lineCount)
  let reqFail = 0
  const uploaded = [] // 记录已上传文件,删除分支只删确实传过的
  for (let round = 0; round < 150; round++) {
    const k = round % 5
    const dir = `/tmp/dir${round % 8}`
    if (k === 0 || k === 3) { const r = await uploadFile(dir, `r${round}.txt`, 2000); if (r.status !== 201) reqFail++; else uploaded.push(`${dir}/r${round}.txt`) }
    else if (k === 1) { const r = await api('GET', `/api/servers/srv-a/files/download?path=${encodeURIComponent(dir + '/DIR' + (round % 8) + '-file1.txt')}`); if (r.status !== 200) reqFail++ }
    else if (k === 2) { const r = await api('GET', `/api/servers/srv-a/files?path=${encodeURIComponent(dir)}`); if (r.status !== 200) reqFail++ }
    else if (uploaded.length) { const p = uploaded.shift(); const r = await api('DELETE', `/api/servers/srv-a/files?path=${encodeURIComponent(p)}`); if (r.status !== 200) reqFail++ }
  }
  ok(reqFail === 0, `150 轮混合文件操作零失败(${reqFail} 失败)(R5)`)
  ok(socks.every(s => s.ws.readyState === WebSocket.OPEN), '期间 20 条 WS 全程 OPEN(R5)')
  const after = socks.map(lineCount)
  ok(after.every((n, i) => n > before[i] + 10), `会话任务全程未中断(输出 +${Math.min(...after.map((n, i) => n - before[i]))} 行)(R5)`)
}

// ============ R6:批量上传(串行队列) ============
console.log('== R6:批量上传 20 个文件(串行) ==')
{
  const socks = globalThis._socks
  let okc = 0
  for (let i = 0; i < 20; i++) {
    const r = await uploadFile('/tmp/dir2', `batch-${i}.bin`, 4096 + i)
    if (r.status === 201) okc++
  }
  ok(okc === 20, `批量上传 20/20 成功(${okc})(R6)`)
  const list = await api('GET', `/api/servers/srv-a/files?path=${encodeURIComponent('/tmp/dir2')}`)
  const cnt = (list.data.entries || []).filter(e => e.filename.startsWith('batch-')).length
  ok(cnt === 20, `列表可见全部 20 个批量文件(${cnt})(R6)`)
  ok(socks.every(s => s.ws.readyState === WebSocket.OPEN), '期间会话稳定(R6)')
  for (let i = 0; i < 20; i++) await api('DELETE', `/api/servers/srv-a/files?path=${encodeURIComponent('/tmp/dir2/batch-' + i + '.bin')}`)
}

// ============ R7:上传中途断开,半成品被清理 ============
console.log('== R7:上传中途断开 ==')
{
  await new Promise((resolve) => {
    const req = http.request(`${HTTP}/api/servers/srv-a/files/upload?path=${encodeURIComponent('/tmp')}&name=aborted.bin`, { method: 'POST', headers: { 'Content-Length': '100000' } })
    req.on('error', () => {})
    req.write('x'.repeat(1000)) // 只发一小段就断
    setTimeout(() => { req.destroy(); resolve() }, 300)
  })
  await sleep(600)
  const list = await api('GET', `/api/servers/srv-a/files?path=${encodeURIComponent('/tmp')}`)
  const leftover = (list.data.entries || []).some(e => e.filename === 'aborted.bin')
  ok(!leftover, '断开后远端无半成品残留(R7)')
  const again = await uploadFile('/tmp', 'aborted.bin', 3000)
  ok(again.status === 201, '后续上传不受影响(R7)')
  await api('DELETE', `/api/servers/srv-a/files?path=${encodeURIComponent('/tmp/aborted.bin')}`)
}

// ============ R8:文件连接通道耗尽注入 ============
console.log('== R8:通道耗尽注入(每 17 次 sftp 操作抛一次) ==')
{
  const socks = globalThis._socks
  exhaustEvery = 17
  opCount = 0
  let failCnt = 0
  for (let i = 0; i < 40; i++) {
    const r = await api('GET', `/api/servers/srv-a/files?path=${encodeURIComponent('/tmp/dir' + (i % 8))}`)
    if (r.status !== 200) failCnt++
  }
  ok(failCnt === 0, `40 次列目录在注入下全部自愈成功(${failCnt} 失败)(R8)`)
  ok(socks.every(s => s.ws.readyState === WebSocket.OPEN), '注入期间终端会话零影响(R8)')
  ok(socks.every(s => lineCount(s) > 5), '注入期间会话任务仍在输出(R8)')
  exhaustEvery = 0
}

// ============ R9:快速导航竞态 ============
console.log('== R9:60 次并发列不同目录,响应与目录一一对应 ==')
{
  let mismatch = 0, errs = 0
  const results = []
  for (let batch = 0; batch < 3; batch++) {
    results.push(...await Promise.all(Array.from({ length: 20 }, async (_, j) => {
      const i = batch * 20 + j
      const d = i % 8
      const r = await api('GET', `/api/servers/srv-a/files?path=${encodeURIComponent('/tmp/dir' + d)}`)
      return { d, r }
    })))
  }
  for (const { d, r } of results) {
    if (r.status !== 200) { errs++; continue }
    const names = (r.data.entries || []).map(e => e.filename)
    // 只有出现"其他目录的 DIRx- 标记"才算串目录;R5 上传的 r-文件属于预期内容
    if (names.some(n => /^DIR\d+-/.test(n) && !n.startsWith(`DIR${d}-`))) mismatch++
  }
  ok(errs === 0 && mismatch === 0, `无串目录/无错误(错 ${errs},串 ${mismatch})(R9)`)
}

// ============ 清场:关会话,为数据层用例重置 ============
for (const s of (globalThis._socks || [])) { try { s.ws.close() } catch {} }
for (const c of (globalThis._created || [])) await api('DELETE', `/api/servers/srv-a/sessions/${c.id}`)
await sleep(500)

// ============ R10:数据层并发 ============
console.log('== R10:并发 40 建会话 + 交错增删 ==')
{
  // 按 API 实况清场(不依赖测试自身账本,防上阶段补位会话残留)
  const pre = await api('GET', '/api/servers/srv-a/sessions')
  for (const s of (pre.data || [])) await api('DELETE', `/api/servers/srv-a/sessions/${s.id}`)
  const rs = []
  for (let batch = 0; batch < 2; batch++) {
    rs.push(...await Promise.all(Array.from({ length: 20 }, () => api('POST', '/api/servers/srv-a/sessions', { name: 'cc' }))))
  }
  const okc = rs.filter(r => r.status === 201).length
  const rejected = rs.filter(r => r.status === 400).length
  const odd = rs.find(r => r.status !== 201 && r.status !== 400)
  if (odd) console.log('  [诊断] 非常规响应:', odd.status, JSON.stringify(odd.data).slice(0, 150))
  ok(okc === 20 && rejected === 20, `并发 40 建:恰好 20 成功/20 拒绝(${okc}/${rejected})(R10)`)
  const list = await api('GET', '/api/servers/srv-a/sessions')
  ok((list.data || []).length === 20, `落盘记录无丢失更新(${(list.data || []).length} 条)(R10)`)
  // 交错增删 60 轮后状态一致
  for (let i = 0; i < 60; i++) {
    if (i % 2 === 0) await api('POST', '/api/servers/srv-a/sessions', { name: `i${i}` }).catch(() => {})
    else {
      const l = await api('GET', '/api/servers/srv-a/sessions')
      if ((l.data || []).length) await api('DELETE', `/api/servers/srv-a/sessions/${l.data[0].id}`)
    }
  }
  const final = await api('GET', '/api/servers/srv-a/sessions')
  const cnt = (final.data || []).length
  ok(cnt > 0 && cnt <= 20, `交错增删后状态一致(${cnt} 条,≤20)(R10)`)
  for (const s of final.data) await api('DELETE', `/api/servers/srv-a/sessions/${s.id}`)
}

// ============ R11:数据文件损坏自愈 ============
console.log('== R11:sessions.json 损坏自愈 ==')
{
  fs.writeFileSync(path.join(tmp, 'sessions.json'), '{broken json!!')
  const r = await api('GET', '/api/servers/srv-a/sessions')
  ok(r.status === 200 && Array.isArray(r.data), `损坏后 API 恢复(返回空表)(R11)`)
  ok(fs.existsSync(path.join(tmp, 'sessions.json.corrupt.bak')), '损坏文件已备份 .corrupt.bak(R11)')
  ok(server.listening, '进程仍存活(R11)')
  const mk = await api('POST', '/api/servers/srv-a/sessions', { name: 'after-corrupt' })
  ok(mk.status === 201, '损坏后可正常新建(自愈完成)(R11)')
  await api('DELETE', `/api/servers/srv-a/sessions/${mk.data.id}`)
}

// ============ R12:删除使用中的服务器 ============
console.log('== R12:删除使用中的服务器(srv-a),srv-b 会话不受影响 ==')
{
  const b1 = await api('POST', '/api/servers/srv-b/sessions', { name: 'b1' })
  const bs = await openTaskSession('srv-b', b1.data.id)
  // srv-a 建一个会话并开 WS(使用中),再挂一个传输
  const a1 = await api('POST', '/api/servers/srv-a/sessions', { name: 'a1' })
  const as = await openTaskSession('srv-a', a1.data.id)
  const del = await api('DELETE', '/api/servers/srv-a')
  ok(del.status === 200, '删除使用中的服务器成功(R12)')
  await sleep(800)
  ok(server.listening, '进程存活(R12)')
  ok(bs.ws.readyState === WebSocket.OPEN && lineCount(bs) > 5, 'srv-b 会话不受影响(R12)')
  // srv-a 的 WS 应被关闭(随连接断开)
  const aClosed = as.ws.readyState === WebSocket.CLOSED
  ok(aClosed, '被删服务器的会话 WS 如期关闭(R12)')
  bs.ws.close()
  await api('DELETE', `/api/servers/srv-b/sessions/${b1.data.id}`)
}

// ============ 收尾:15 秒全并发大乱炖 ============
console.log('== R13:15 秒全并发大乱炖(会话+传输+API 洪峰) ==')
{
  seedFS()
  const socks = []
  for (let i = 0; i < 8; i++) {
    const s = await api('POST', '/api/servers/srv-b/sessions', { name: `ff${i}` })
    socks.push(await openTaskSession('srv-b', s.data.id))
  }
  const t0 = Date.now()
  let ops = 0, errs = 0
  const load = async () => {
    while (Date.now() - t0 < 15000) {
      const k = ops++ % 4
      try {
        if (k === 0) { const r = await uploadFile('/tmp/dir3', `ff-${Math.random().toString(36).slice(2, 8)}.txt`, 1024, 'srv-b'); if (r.status !== 201) errs++ }
        else if (k === 1) { const r = await api('GET', `/api/servers/srv-b/files?path=${encodeURIComponent('/tmp/dir4')}`); if (r.status !== 200) errs++ }
        else if (k === 2) { const r = await api('GET', '/api/servers/srv-b/sessions'); if (r.status !== 200) errs++ }
        else { const r = await api('GET', `/api/servers/srv-b/files/download?path=${encodeURIComponent('/tmp/dir4/DIR4-file2.txt')}`); if (r.status !== 200) errs++ }
      } catch { errs++ }
    }
  }
  await Promise.all([load(), load(), load()])
  await sleep(500)
  ok(errs === 0, `乱炖负载零错误(${errs})(R13)`)
  ok(socks.every(s => s.ws.readyState === WebSocket.OPEN), '乱炖后全部会话 WS 存活(R13)')
  ok(socks.every(s => lineCount(s) > 30), '乱炖后会话任务仍在输出(R13)')
  ok(server.listening, '进程存活(R13)')
  for (const s of socks) { s.ws.close() }
}

// ============ R14/R15:本机↔远端互传的失败收尾与完整性 ============
console.log('== R14:local-to-remote 正常回环 + 本地文件缺失快速失败 ==')
{
  seedFS()
  // 正常回环:本地文件 → 远端(验证 runTransfer 成功路径含大小核对)
  const upSrc = path.join(tmp, 'r14-up.bin')
  fs.writeFileSync(upSrc, 'hello-r14-local-to-remote')
  let t0 = Date.now()
  const up = await api('POST', '/api/servers/srv-b/files/local-to-remote', { localPath: upSrc, remoteDir: '/tmp' })
  ok(up.status === 200, `local-to-remote 成功(${up.status})(R14)`)
  ok(fakeFS.get('/tmp/r14-up.bin')?.content?.toString() === 'hello-r14-local-to-remote', '远端内容完整(R14)')
  // 本地文件缺失:必须在打开远端写流之前快速失败,不留远端半成品
  const t1 = Date.now()
  const miss = await api('POST', '/api/servers/srv-b/files/local-to-remote', { localPath: path.join(tmp, 'no-such-local.bin'), remoteDir: '/tmp' })
  ok(miss.status === 500, `本地缺失返回 500(${miss.status})(R14)`)
  ok(Date.now() - t1 < 5000, `快速失败不悬挂(${Date.now() - t1}ms)(R14)`)
  ok(!fakeFS.has('/tmp/no-such-local.bin'), '远端无半成品残留(R14)')
  // 失败后文件连接仍可用(僵尸请求/句柄泄漏会在这里暴露)
  const after = await uploadFile('/tmp', 'r14-after.txt', 64, 'srv-b')
  ok(after.status === 201, `失败后连接仍可复用(${after.status})(R14)`)
}

console.log('== R15:remote-to-local 缺失快速失败 + 中途断流清理半成品 ==')
{
  seedFS()
  const dlDir = path.join(tmp, 'r15-dl')
  // 远端不存在:先 stat 就失败,不写本地任何文件
  const t0 = Date.now()
  const miss = await api('POST', '/api/servers/srv-b/files/remote-to-local', { remotePath: '/tmp/no-such-remote.bin', localDir: dlDir })
  ok(miss.status === 500, `远端缺失返回 500(${miss.status})(R15)`)
  ok(Date.now() - t0 < 5000, `快速失败不悬挂(${Date.now() - t0}ms)(R15)`)
  ok(!fs.existsSync(path.join(dlDir, 'no-such-remote.bin')), '本地无半成品残留(R15)')
  // 中途断流:读到一半 SFTP 流报错 → 本地半成品必须被清理
  fakeFS.set('/tmp/r15-flaky.bin', { isDir: false, content: Buffer.from('partial-partial'), size: 15, flaky: true })
  const flaky = await api('POST', '/api/servers/srv-b/files/remote-to-local', { remotePath: '/tmp/r15-flaky.bin', localDir: dlDir })
  ok(flaky.status === 500, `中途断流返回 500(${flaky.status})(R15)`)
  ok(String(flaky.data?.error || '').includes('读取源文件失败'), `报错指向源流失败(${JSON.stringify(flaky.data?.error || '').slice(0, 60)})(R15)`)
  ok(!fs.existsSync(path.join(dlDir, 'r15-flaky.bin')), '断流后本地半成品已清理(R15)')
  // 正常回环:远端 → 本地(验证成功路径)
  const good = await api('POST', '/api/servers/srv-b/files/remote-to-local', { remotePath: '/tmp/dir4/DIR4-file2.txt', localDir: dlDir })
  ok(good.status === 200 && fs.readFileSync(path.join(dlDir, 'DIR4-file2.txt'), 'utf-8') === 'content of dir4 file2\n', '远端→本地内容完整(R15)')
  ok(server.listening, '进程存活(R15)')
}

console.log('\n========================================')
console.log(`可靠性矩阵结果: ${pass} PASS / ${fail} FAIL`)
if (failLabels.length) failLabels.forEach(l => console.log('  失败项:', l))
console.log('========================================')
server.close()
process.exit(fail ? 1 : 0)
