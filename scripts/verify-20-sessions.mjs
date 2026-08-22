// 离线验证"同一服务器同时开 20 个会话":
//   - 后端已改成"多连接分摊"(每条终端连接≤8 个 shell,最多 ~3 条连接承载 20 会话),
//     让 20 个并发会话在默认 sshd MaxSessions=10 下也能全开。
//   - 这里用假 ssh2 Client 注入后端:它的 connect 每次都会 ready(支撑连接池新开多条),
//     shell 可创建任意多条。同时对一台假服务器开 20 条 /ws/terminal 会话,
//     断言:20 条全部 connected、全部保持 OPEN、每条 shell 注入输出后对应 WS 都能收到 data。
// 运行: node scripts/verify-20-sessions.mjs
import { createRequire } from 'module'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'

const require = createRequire(import.meta.url)

// ---------- 假的 ssh2 Client / shell(支持连接池新开多条连接) ----------
class FakeStream extends EventEmitter {
  constructor() {
    super()
    this.stderr = new EventEmitter()
    this.closed = false
    this.sessionId = null
  }
  write(buf) { return true }
  setWindow() {}
  end() { this.close() }
  close() { if (this.closed) return; this.closed = true; this.emit('close') }
}

let shellSeq = 0
const allShells = [] // 所有连接上创建的 shell
class FakeClient extends EventEmitter {
  constructor() { super(); this._config = null }
  connect(config) {
    this._config = config
    // 立即 ready,模拟一条新连接就绪(连接池会为第 9/17 个 shell 新开连接)
    setImmediate(() => this.emit('ready'))
  }
  shell(opts, cb) {
    const stream = new FakeStream()
    stream.seq = shellSeq++
    allShells.push(stream)
    setImmediate(() => cb(null, stream))
  }
  exec(cmd, cb) {
    const stream = new FakeStream()
    setImmediate(() => cb(null, stream))
  }
  end() { setImmediate(() => this.emit('close')) }
}

const ssh2 = require('ssh2')
ssh2.Client = FakeClient

// ---------- 独立数据目录 + 一台假服务器 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serverhub-sess20-'))
process.env.SERVERHUB_DATA_DIR = tmp
fs.writeFileSync(path.join(tmp, 'servers.json'), JSON.stringify([
  { id: 'srv-20', name: 'sess20', host: '127.0.0.1', port: 22, username: 'u', password: 'p' },
]))

const PORTN = 37200 + Math.floor(Math.random() * 2000)
process.env.PORT = String(PORTN)
const { server } = await import('../server/index.js')
if (!server.listening) await new Promise(r => server.once('listening', r))
const { WebSocket } = await import('ws')

const BASE = `ws://localhost:${PORTN}`
const TOTAL = 20

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; } else { fail++; console.log('  ❌', label) } }

// 打开一条会话 WS,返回 { ws, connected(boolean), gotData(boolean) }
function openSession(sessionId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${BASE}/ws/terminal?serverId=srv-20&session=${sessionId}`)
    const state = { ws, connected: false, gotData: false }
    const timer = setTimeout(() => { ws.close(); resolve(state) }, 8000)
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString())
      if (m.type === 'connected') state.connected = true
      if (m.type === 'data' && Buffer.from(m.data, 'base64').toString('utf8').includes(`OUT-${sessionId}`)) state.gotData = true
    })
    ws.on('error', () => { clearTimeout(timer); resolve(state) })
    // 用"任意消息+延时"兜底:无论是否连上都返回
    setTimeout(() => { clearTimeout(timer); resolve(state) }, 7000)
  })
}

console.log(`开始:同一台服务器同时开 ${TOTAL} 个会话(多连接分摊,每条≤8 个 shell)\n`)

const sessions = []
for (let i = 1; i <= TOTAL; i++) {
  const id = `ses-${i}`
  sessions.push({ id, state: await openSession(id) })
}

// 等所有连接稳定(连接池最多新开 3 条)
await new Promise(r => setTimeout(r, 1200))

// 给每条 shell 注入输出,验证对应 WS 能收到(10/11 跨连接也要通)
for (let i = 1; i <= TOTAL; i++) {
  const shell = allShells.find(s => s.sessionId === `ses-${i}`)
  if (shell) shell.emit('data', Buffer.from(`OUT-ses-${i}\r\n`))
}
await new Promise(r => setTimeout(r, 1500))

const connectedCount = sessions.filter(s => s.state.connected).length
const openCount = sessions.filter(s => s.state.ws.readyState === WebSocket.OPEN).length

console.log(`已连接的会话:${connectedCount}/${TOTAL};WS 保持 OPEN:${openCount}/${TOTAL}`)
ok(connectedCount === TOTAL, `全部 ${TOTAL} 条会话收到 connected(实际 ${connectedCount})`)
ok(openCount === TOTAL, `全部 ${TOTAL} 条会话 WS 保持 OPEN(实际 ${openCount})`)
ok(allShells.length >= TOTAL, `后端创建了至少 ${TOTAL} 个 shell(实际 ${allShells.length})`)

// 每条 shell 的输出都送到对应 WS
let allDelivered = true
for (let i = 1; i <= TOTAL; i++) {
  if (!sessions[i - 1].state.gotData) { allDelivered = false; console.log(`  ⚠ 会话 ses-${i} 未收到自己的输出`) }
}
ok(allDelivered, `每条 shell 的输出都送达对应 WS(${TOTAL} 条全通)`)

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
sessions.forEach(s => s.state.ws.close())
server.close()
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }) } catch {}
process.exit(fail ? 1 : 0)
