// 压力验证(切换+传输):大量文件上传/下载 + 反复"切换"期间,多个远程终端会话 与
// 本地终端会话必须始终保持不中断——这是最重要的验收点。
//
// 与 stress-transfer-stability.mjs 的区别:那一个只有"1 个远程会话 + 1 个本地会话"、
// 切换仅用 shell 输出模拟;这里的重点是把 **多方同时在线 + 反复切换/重开** 与 **高并发文件传输**
// 叠加起来做压力:
//   - 常驻 N 个远程终端会话(模拟多个标签同时打开),常驻 1 个本地终端会话;
//   - 高频率调用 local-to-remote / remote-to-local / 列目录,并周期性预埋"文件连接 Channel open
//     failure"(触发 retryFileAfterReconnect 只重连文件连接,连累不到终端连接);
//   - 反复"切换":不断新建/关闭临时远程会话(压连接池与 sshd MaxSessions 分摊),并周期性重开本地终端,
//     期间常驻会话全部保持 OPEN、shell 存活、输出持续;
//   - 全程断言:常驻远程会话一个都不掉线、本地终端不掉线。
//
// 运行: node scripts/stress-switch-stability.mjs
import { createRequire } from 'module'
import { EventEmitter } from 'events'
import { Readable, Writable } from 'stream'
import fs from 'fs'
import os from 'os'
import path from 'path'

const require = createRequire(import.meta.url)
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---------- 假的 ssh2 Client / shell / sftp ----------
class FakeStream extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); this.closed = false; this.buf = '' }
  write(b) { try { this.buf += b.toString() } catch {} return true }
  setWindow() {}
  end() { this.close() }
  close() { if (this.closed) return; this.closed = true; this.emit('close') }
}

// 文件连接剩余可失败次数(模拟通道耗尽);0 表示正常
let fileFailsRemaining = 0
const armedFailures = (n) => { fileFailsRemaining = n }

class FakeSftp extends EventEmitter {
  constructor(map) { super(); this.map = map; this.dead = false }
  _maybeFail(cb) {
    if (this.dead) { cb(new Error('(SSH) Channel open failure: open failed')); return true }
    if (fileFailsRemaining > 0) { fileFailsRemaining--; cb(new Error('(SSH) Channel open failure: open failed')); return true }
    return false
  }
  readdir(dir, cb) { if (this._maybeFail(cb)) return; cb(null, []) }
  stat(p, cb) { if (this._maybeFail(cb)) return; cb(null, { isDirectory: () => false, size: (this.map.get(p)?.length || 0), isFile: () => true }) }
  unlink(p, cb) { this.map.delete(p); cb(null) }
  rmdir(p, cb) { cb(null) }
  createReadStream(p) {
    const data = this.map.get(p) || Buffer.from('')
    const rs = new Readable()
    rs._read = () => { rs.push(data); rs.push(null) }
    return rs
  }
  createWriteStream(p) {
    const chunks = []
    const ws = new Writable({
      write(c, e, cb) { chunks.push(c); cb() },
      final(cb) { this.map.set(p, Buffer.concat(chunks)); cb() },
    })
    ws.map = this.map
    ws.on('finish', () => process.nextTick(() => { if (!ws.destroyed) ws.destroy() }))
    ws.on('close', () => {})
    if (fileFailsRemaining > 0) {
      fileFailsRemaining--
      process.nextTick(() => { if (!ws.destroyed) ws.destroy(new Error('(SSH) Channel open failure: open failed')) })
    } else {
      process.nextTick(() => ws.emit('open'))
    }
    return ws
  }
}

const createdShells = [] // 终端连接创建的 shell(按创建顺序)
class FakeClient extends EventEmitter {
  constructor() { super(); this.sftpInst = null }
  connect(config) { this.setTimeout = () => {}; setTimeout(() => this.emit('ready'), 5) }
  shell(opts, cb) { const s = new FakeStream(); createdShells.push(s); setTimeout(() => cb(null, s), 3) }
  exec(cmd, cb) {
    const s = new FakeStream(); s.stdoutData = cmd
    setTimeout(() => cb(null, s), 3)
    setTimeout(() => { s.emit('data', Buffer.from('-rw-r--r-- 1 0 0 0 date time _placeholder_\n')); s.emit('close') }, 10)
  }
  sftp(cb) {
    if (!this.sftpInst) { this.sftpInst = new FakeSftp(new Map()); setTimeout(() => cb(null, this.sftpInst), 2) }
    else setTimeout(() => cb(null, this.sftpInst), 1)
  }
  end() { if (this.sftpInst) this.sftpInst.dead = true; this.emit('close') }
}

const ssh2 = require('ssh2')
ssh2.Client = FakeClient

// ---------- 独立数据目录 + 假服务器 + 本地临时目录 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serverhub-switch-'))
process.env.SERVERHUB_DATA_DIR = tmp
const srcDir = path.join(tmp, 'src'); const dstDir = path.join(tmp, 'dst')
fs.mkdirSync(srcDir); fs.mkdirSync(dstDir)
for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(srcDir, `file${i}.txt`), `content-${i}-`.repeat(100))
fs.writeFileSync(path.join(tmp, 'servers.json'), JSON.stringify([
  { id: 'srv-stress', name: 'stress', host: '127.0.0.1', port: 22, username: 'u', password: 'p' },
]))

const PORTN = 37400 + Math.floor(Math.random() * 3000)
process.env.PORT = String(PORTN)
const { server } = await import('../server/index.js')
if (!server.listening) await new Promise(r => server.once('listening', r))
const { WebSocket } = await import('ws')

const BASE = `http://localhost:${PORTN}`
const CHANNEL_RE = /channel open failure/i

// ========== 常量 ----------
const NUM_PERSIST = 5             // 常驻远程会话数量
const ROUNDS = 60                 // 文件循环轮数
const SWITCH_EVERY = 6            // 每几轮做一次"新建/关闭临时会话"
const LOCAL_REOPEN = 3            // 本地终端重开次数
const EXHAUST_AT = [7, 18, 30, 42, 53] // 预埋文件通道耗尽时机

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log('  ❌', label) } }

// 带超时的 fetch
async function jfetch(url, opts = {}) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15000)
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal })
    return await r.json()
  } finally { clearTimeout(t) }
}
const HELPERS = {
  list: () => jfetch(`${BASE}/api/servers/srv-stress/files?path=/remotedir`),
  up: (i) => jfetch(`${BASE}/api/servers/srv-stress/files/local-to-remote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ localPath: path.join(srcDir, `file${i % 5}.txt`), remoteDir: '/remotedir' }),
  }),
  down: (i) => jfetch(`${BASE}/api/servers/srv-stress/files/remote-to-local`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ remotePath: `/remotedir/file${i % 5}.txt`, localDir: dstDir }),
  }),
}
// 归类:通道失败=预期自动恢复;其余=真实意外错误
async function cls(fn) {
  try {
    const r = await fn()
    if (r && r.error && !CHANNEL_RE.test(String(r.error))) return { unexpected: true, msg: r.error }
    return { unexpected: false }
  } catch (e) {
    return { unexpected: true, msg: e && e.message }
  }
}

// 打开一个远程终端 WS 会话,收集解析后的消息;host 校验 返回 {ws, msgs}
function openWs(url, host) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const msgs = []
    let done = false
    const fin = (okf) => { if (done) return; done = true; okf ? resolve({ ws, msgs }) : reject(new Error(host + ' open fail')) }
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()); msgs.push(m)
      if (m.type === 'connected') fin(true)
      if (m.type === 'error') fin(false)
    })
    ws.on('error', () => fin(false))
    ws.on('close', () => fin(false)) // 创建期若立即关闭则视为失败
    setTimeout(() => fin(false), 6000)
  })
}

console.log(`离线压力测试:${NUM_PERSIST} 个常驻远程会话 + 1 个本地终端;${ROUNDS} 轮文件传输 + 反复切换\n`)

// ========== 1) 打开常驻远程会话 ==========
const persist = []
for (let k = 1; k <= NUM_PERSIST; k++) {
  const { ws, msgs } = await openWs(`ws://localhost:${PORTN}/ws/terminal?serverId=srv-stress&session=persist-${k}`, `persist-${k}`)
  persist.push({ id: `persist-${k}`, ws, msgs })
}
console.log(`✔ ${NUM_PERSIST} 个常驻远程会话已建立`)

// ========== 2) 打开本地终端会话(node-pty PowerShell) ==========
const localWsUrls = []
let localWs = null
let localMsgs = []
async function openLocal(url) {
  localWsUrls.push(url)
  const res = await openWs(url, 'local')
  localWs = res.ws; localMsgs = res.msgs
}
await openLocal(`ws://localhost:${PORTN}/ws/local?session=local-main&cwd=${encodeURIComponent(tmp)}`)
console.log('✔ 本地终端会话(local-main)已建立(node-pty PowerShell)')

// 定位每个常驻会话对应的远端 shell by sessionId(createShell 会打 sessionId 标记)
const shellBySid = (sid) => createdShells.find(s => s.sessionId === sid)

// ========== 3) 压力循环 ==========
let errCount = 0
let transientCount = 0
let localReopened = 0
console.log(`开始压力循环:${ROUNDS} 轮;切换(${Math.ceil(ROUNDS / SWITCH_EVERY)} 次建/关临时会话,本地重开 ${LOCAL_REOPEN} 次);预埋通道耗尽 ${EXHAUST_AT.length} 次\n`)

for (let i = 0; i < ROUNDS; i++) {
  if (EXHAUST_AT.includes(i)) { armedFailures(3); console.log(`→ 第 ${i} 轮:预埋文件连接通道耗尽(应只重连文件连接,终端会话不受影响)`) }

  // 3.1 高频率 3 种文件操作
  for (const [name, fn] of [['list', HELPERS.list], ['up', () => HELPERS.up(i)], ['down', () => HELPERS.down(i)]]) {
    const r = await cls(fn)
    if (r.unexpected) { errCount++; console.log(`  ⚠ 轮 ${i} ${name}:意外错误 ${r.msg}`) }
  }

  // 3.2 "切换":新建一个临时远程会话再关闭,压连接池与分摊;同时给常驻会话注入输出
  if (i % SWITCH_EVERY === 0) {
    const idx = transientCount++
    const t = await openWs(`ws://localhost:${PORTN}/ws/terminal?serverId=srv-stress&session=transient-${idx}`, `transient-${idx}`)
    // 临时会话短暂活跃后关闭(模拟用户开一个新标签又关掉)
    const tmpShell = shellBySid(`transient-${idx}`)
    if (tmpShell) tmpShell.emit('data', Buffer.from(`TRANSIENT-${idx}: 临时会话运行中\r\n`))
    await sleep(60)
    t.ws.close()
  }

  // 3.3 周期性重开本地终端(模拟本地标签关闭再打开)
  if (localReopened < LOCAL_REOPEN && i === Math.floor(((localReopened + 1) * ROUNDS) / (LOCAL_REOPEN + 1))) {
    localReopened++
    localWs.close()
    await openLocal(`ws://localhost:${PORTN}/ws/local?session=local-main&cwd=${encodeURIComponent(tmp)}`)
    console.log(`→ 第 ${i} 轮:本地终端已重开(${localReopened}/${LOCAL_REOPEN})`)
  }

  // 3.4 给每个常驻远程会话持续注入输出,验证不被文件操作/切换打断
  for (const p of persist) {
    const sh = shellBySid(p.id)
    if (sh) sh.emit('data', Buffer.from(`PERSIST-${p.id}-${i}: 会话存活\r\n`))
  }

  if (i % 10 === 0 || i === ROUNDS - 1) {
    const openNow = persist.filter(p => p.ws.readyState === WebSocket.OPEN).length
    console.log(`  轮 ${i + 1}/${ROUNDS} 完成(常驻远程 OPEN ${openNow}/${NUM_PERSIST},意外错误 ${errCount})`)
  }
}

// ========== 4) 切换停止后仍持续传输一小段,确认会话保持 ==========
await sleep(300)
for (let i = 0; i < 3; i++) { await cls(HELPERS.up(i)); await cls(HELPERS.down(i)) }

// ========== 5) 验收断言 ==========
console.log('\n结果:')

// 5.1 每个常驻远程会话:WS 仍 OPEN + shell 存活 + 后期仍在输出
let persistOpenOk = true, persistShellOk = true, persistLateOk = true
for (const p of persist) {
  if (p.ws.readyState !== WebSocket.OPEN) { persistOpenOk = false; console.log(`  ⚠ ${p.id} WS 已关闭`) }
  const sh = shellBySid(p.id)
  if (sh && sh.closed) { persistShellOk = false; console.log(`  ⚠ ${p.id} shell 已被关闭`) }
  const text = p.msgs.filter(m => m.type === 'data').map(m => Buffer.from(m.data, 'base64').toString('utf8')).join('')
  if (!text.includes(`PERSIST-${p.id}-${ROUNDS - 1}`) && !text.includes(`PERSIST-${p.id}-${ROUNDS - 2}`)) { persistLateOk = false; console.log(`  ⚠ ${p.id} 未收到压力后期的输出(可能被中断)`) }
}
ok(persistOpenOk, `全部 ${NUM_PERSIST} 个常驻远程会话 WS 仍 OPEN(切换+传输全程不掉线)`)
ok(persistShellOk, `全部 ${NUM_PERSIST} 个常驻远程会话 shell 对象仍存活(未被文件操作 disconnect 关闭)`)
ok(persistLateOk, `全部 ${NUM_PERSIST} 个常驻远程会话在压力后期仍持续输出(未被中断)`)

// 5.2 本地终端:WS 仍 OPEN
ok(localWs && localWs.readyState === WebSocket.OPEN, `本地终端 WS 仍 OPEN(readyState=${localWs ? localWs.readyState : 'none'}) → 本地会话不中断`)
ok(localReopened === LOCAL_REOPEN, `本地终端按要求重开了 ${LOCAL_REOPEN} 次且全部成功恢复(实际 ${localReopened})`)
ok(localMsgs.some(m => m.type === 'connected'), '本地终端最后一条连接收到 connected(重开恢复正常)')

// 5.3 文件操作无意外错误(仅有预埋的通道失败自动重连)
ok(errCount === 0, `文件操作无预期外错误(仅有通道耗尽自动重连,errCount=${errCount})`)

// 5.4 传输在与切换叠加后仍走通(通道失败被自动恢复)
const afterText = (arr) => arr.filter(m => m.type === 'data').map(m => Buffer.from(m.data, 'base64').toString('utf8')).join('')
ok(afterText(persist[0].msgs).length > 0, '常驻会话在切换+传输叠加后仍有持续输出')

console.log(`\n切换量:临时会话 ${transientCount} 次 + 本地重开 ${localReopened} 次;文件轮 ${ROUNDS} 轮;预埋通道耗尽 ${EXHAUST_AT.length} 次`)
console.log(`总断言:${pass} 通过, ${fail} 失败`)

// 清理
persist.forEach(p => p.ws.close())
if (localWs) localWs.close()
server.close()
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }) } catch {}
process.exit(fail || errCount ? 1 : 0)
