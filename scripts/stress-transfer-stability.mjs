// 压力验证:大量文件上传/下载 + 反复"切换"期间,远程终端会话 与 本地终端会话 必须保持不中断。
//
// 做法(全部离线,不碰真实服务器/设备):
//  1. 用假 ssh2 Client(可触发文件连接通道耗尽)与假 SFTP 注入后端;
//  2. 打开一条远程终端 WS(shell) + 一条本地终端 WS(node-pty PowerShell);
//  3. 高频率循环调用文件接口(local-to-remote / remote-to-local / 列目录),
//     并周期性模拟"文件连接 Channel open failure"(触发 retryFileAfterReconnect 只重连文件连接);
//  4. 全程断言:远程 shell 与本地 WS 始终 OPEN、远程 shell 始终能出数据,绝不被文件操作打断。
//
// 运行: node scripts/stress-transfer-stability.mjs
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
  _maybeFail(cb, fallback) {
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
    // 路由 await ws.on('close');Writable 默认只在 destroy 时 close,这里显式触发
    ws.on('finish', () => process.nextTick(() => { if (!ws.destroyed) ws.destroy(); }))
    ws.on('close', () => { /* 路由会 resolve */ })
    // 失败一次(模拟通道耗尽造成写通道打不开)
    if (fileFailsRemaining > 0) {
      fileFailsRemaining--
      process.nextTick(() => { if (!ws.destroyed) { ws.destroy(new Error('(SSH) Channel open failure: open failed')) } })
    } else {
      process.nextTick(() => ws.emit('open'))
    }
    return ws
  }
}

const createdShells = [] // 终端连接创建的 shell
class FakeClient extends EventEmitter {
  constructor() { super(); this.sftpInst = null }
  connect(config) { this.setTimeout = () => {}; setTimeout(() => this.emit('ready'), 5) }
  shell(opts, cb) { const s = new FakeStream(); createdShells.push(s); setTimeout(() => cb(null, s), 3) }
  exec(cmd, cb) {
    const s = new FakeStream(); s.stdoutData = cmd
    setTimeout(() => cb(null, s), 3)
    // ls 回退在 listDirectory 里 await stream 'data'/'close',必须发出以正常结束
    setTimeout(() => { s.emit('data', Buffer.from(`-rw-r--r-- 1 0 0 0 date time _placeholder_\n`)); s.emit('close') }, 10)
  }
  sftp(cb) {
    if (!this.sftpInst) { this.sftpInst = new FakeSftp(new Map()); setTimeout(() => cb(null, this.sftpInst), 2) }
    else setTimeout(() => cb(null, this.sftpInst), 1)
  }
  end() { if (this.sftpInst) this.sftpInst.dead = true; this.emit('close') }
}

const ssh2 = require('ssh2')
ssh2.Client = FakeClient

// ---------- 独立数据目录 + 一台假服务器 + 本地临时传输目录 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serverhub-stress-'))
process.env.SERVERHUB_DATA_DIR = tmp
const srcDir = path.join(tmp, 'src'); const dstDir = path.join(tmp, 'dst')
fs.mkdirSync(srcDir); fs.mkdirSync(dstDir)
// 准备一批本地待上传文件
for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(srcDir, `file${i}.txt`), `content-${i}-`.repeat(100))
fs.writeFileSync(path.join(tmp, 'servers.json'), JSON.stringify([
  { id: 'srv-stress', name: 'stress', host: '127.0.0.1', port: 22, username: 'u', password: 'p' },
]))

const PORTN = 37000 + Math.floor(Math.random() * 3000)
process.env.PORT = String(PORTN)
const { server } = await import('../server/index.js')
if (!server.listening) await new Promise(r => server.once('listening', r))
const { WebSocket } = await import('ws')

const BASE = `http://localhost:${PORTN}`
let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log('  ❌', label) } }
if (fail === 0) console.log('(断言将在循环结束后统一输出)\n')

// ========== 1) 打开远程终端会话(独立 shell) ==========
const wsTerm = new WebSocket(`ws://localhost:${PORTN}/ws/terminal?serverId=srv-stress&session=ses-term`)
const termMsg = []
await new Promise((res, rej) => { wsTerm.on('message', (d) => { const m = JSON.parse(d.toString()); termMsg.push(m); if (m.type === 'connected') res(); if (m.type === 'error') rej(new Error(m.message)) }); wsTerm.on('error', rej); setTimeout(() => rej(new Error('term timeout')), 5000) })
const remoteShell = createdShells[0] // 快捷;下面按顺序取
console.log('✔ 远程终端会话(ses-term)已建立(独立 shell 已创建)')

// ========== 2) 打开本地终端会话(/ws/local → node-pty PowerShell) ==========
const wsLocal = new WebSocket(`ws://localhost:${PORTN}/ws/local?session=ses-local&cwd=${encodeURIComponent(tmp)}`)
const localMsg = []
await new Promise((res, rej) => { wsLocal.on('message', (d) => { const m = JSON.parse(d.toString()); localMsg.push(m); if (m.type === 'connected') res(); if (m.type === 'error') rej(new Error(m.message)) }); wsLocal.on('error', rej); setTimeout(() => rej(new Error('local timeout')), 5000) })
console.log('✔ 本地终端会话(ses-local)已建立(node-pty PowerShell)')

// ========== 3) 压力循环:大量上传/下载/列目录 + 周期性触发文件连接通道耗尽 ==========
// 带超时的 fetch,避免某个文件路由卡住导致整个测试挂起
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

const ROUNDS = 40            // 总循环轮数
const EXHAUST_AT = [5, 12, 25] // 在这些轮次前预埋文件连接通道耗尽
console.log(`开始压力循环:${ROUNDS} 轮上传/下载/列目录,并在 ${EXHAUST_AT.join(',')} 轮预埋文件连接通道耗尽\n`)
let errCount = 0       // 真正意外的错误(读/写/连接等真实失败)
const CHANNEL_RE = /channel open failure/i
// 返回 {unexpected:boolean} 归类:通道失败=预期自动恢复;其余=真实错误
async function cls(fn) {
  try {
    const r = await fn()
    if (r && r.error && !CHANNEL_RE.test(String(r.error))) return { unexpected: true, msg: r.error }
    return { unexpected: false }
  } catch (e) {
    // fetch 网络/超时等真实错误
    return { unexpected: true, msg: e && e.message }
  }
}
let recoveries = 0
for (let i = 0; i < ROUNDS; i++) {
  if (EXHAUST_AT.includes(i)) { armedFailures(3); console.log(`→ 第 ${i} 轮:预埋文件连接通道耗尽(触发自动重连,应只重连文件连接)`) }
  for (const [name, fn] of [['list', HELPERS.list], ['up', () => HELPERS.up(i)], ['down', () => HELPERS.down(i)]]) {
    const r = await cls(fn)
    if (r.unexpected) { errCount++; console.log(`  ⚠ 轮 ${i} ${name}:意外错误 ${r.msg}`) }
    else if (name === 'down' && recoveries < 99) { /* 不需要计数 */ }
  }
  // 模拟"切换/后台活动":远程 shell 持续输出,验证不被文件操作中断
  if (i % 4 === 0) remoteShell.emit('data', Buffer.from(`TERM-TICK-${i}: 远程会话仍在运行\r\n`))
  if (i % 10 === 0 || i === ROUNDS - 1) console.log(`  轮 ${i + 1}/${ROUNDS} 完成(累计意外错误 ${errCount})`)
}

// ========== 4) 验收断言 ==========
console.log('\n结果:')
const termText = termMsg.filter(m => m.type === 'data').map(m => Buffer.from(m.data, 'base64').toString('utf8')).join('')

// 4.1 远程会话:全程未被文件操作/切换打断
ok(wsTerm.readyState === WebSocket.OPEN, `远程终端 WS 仍 OPEN(readyState=${wsTerm.readyState}) → 会话不中断`)
ok(termText.includes('TERM-TICK-0'), '远程终端在压力期间收到过输出(TERM-TICK-0)')
ok(termText.includes('TERM-TICK-36') || termText.includes('TERM-TICK-20'), '远程终端在压力后期仍在持续输出(未被文件操作打断)')
const alivePersist = termText.length > 0 && wsTerm.readyState === WebSocket.OPEN

// 4.2 本地会话:全程未被文件操作/切换打断
ok(wsLocal.readyState === WebSocket.OPEN, `本地终端 WS 仍 OPEN(readyState=${wsLocal.readyState}) → 本地会话不中断`)

// 4.3 文件操作多数走通(允许少量是"预埋通道失败自动重连")
ok(errCount === 0, `无预期外的文件操作错误(仅有通道耗尽自动重连,errCount=${errCount})`)

// 4.4 远程 shell 未因文件操作被关闭
const shellStillOpen = createdShells[0] && !createdShells[0].closed
ok(shellStillOpen, '远程 shell 对象仍存活(未被文件操作 disconnect 关闭)')

console.log(`\n压力轮数:${ROUNDS},预埋通道耗尽:${EXHAUST_AT.length} 次`)
console.log(`总断言:${pass} 通过, ${fail} 失败`)

// 清理(node-pty/ws 可能仍占用临时目录,rm 失败可忽略)
wsTerm.close(); wsLocal.close()
server.close()
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }) } catch {}
process.exit(fail || errCount || !alivePersist ? 1 : 0)
