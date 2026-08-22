// 离线验证"切换会话页面时,之前的会话仍在正常执行"
// 原理:用一个假的 ssh2 Client 注入后端,开两条 WebSocket(两条独立 shell),
//      模拟"会话1正在运行耗时命令"时"切到会话2操作",断言会话1的输出不被中断。
// 运行: node scripts/verify-sessions.mjs   (需先 npm run build 或至少 dist 存在?不需要)
import { createRequire } from 'module'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'

const require = createRequire(import.meta.url)

// ---------- 假的 ssh2 Client / shell ----------
class FakeStream extends EventEmitter {
  constructor() {
    super()
    this.stderr = new EventEmitter()
    this.closed = false
  }
  write(buf) { /* 输入:这里可触发行为;本测试改由外部 emit 驱动 */ return true }
  setWindow() {}
  end() { this.close() }
  close() { if (this.closed) return; this.closed = true; this.emit('close') }
}

const createdShells = [] // 按创建顺序记录每个 shell,方便测试驱动
class FakeClient extends EventEmitter {
  constructor() { super(); this._config = null }
  connect(config) {
    this._config = config
    setTimeout(() => this.emit('ready'), 10)
  }
  shell(opts, cb) {
    const stream = new FakeStream()
    createdShells.push(stream)
    setTimeout(() => cb(null, stream), 5)
  }
  exec(cmd, cb) {
    const stream = new FakeStream()
    stream.stdoutData = cmd
    setTimeout(() => cb(null, stream), 5)
  }
  end() { this.emit('close') }
}

// 在导入后端之前,把假的 Client 打进去(ssh-manager 的 import { Client } 在导入时快照)
const ssh2 = require('ssh2')
ssh2.Client = FakeClient

// ---------- 准备独立数据目录 + 一台假服务器 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serverhub-verify-'))
process.env.SERVERHUB_DATA_DIR = tmp
fs.writeFileSync(path.join(tmp, 'servers.json'), JSON.stringify([
  { id: 'srv-demo', name: 'demo', host: '127.0.0.1', port: 22, username: 'u', password: 'p' },
]))

process.env.PORT = '37999'
const { server } = await import('../server/index.js')
if (!server.listening) await new Promise(r => server.once('listening', r))

const { WebSocket } = await import('ws')

const WS = () => `ws://localhost:37999/ws/terminal?serverId=srv-demo`

function openWs(sessionId) {
  return new Promise((resolve, reject) => {
    const wsv = new WebSocket(`${WS()}&session=${sessionId}`)
    const msgs = []
    let opened = null
    wsv.on('message', (d) => {
      const m = JSON.parse(d.toString())
      msgs.push(m)
      if (m.type === 'connected') { opened = m; resolve({ wsv, msgs }) }
      if (m.type === 'error') reject(new Error('WS error: ' + m.message))
    })
    wsv.on('error', reject)
    setTimeout(() => reject(new Error('connect timeout')), 5000)
  })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const texts = (msgs) => msgs.filter(m => m.type === 'data').map(m => Buffer.from(m.data, 'base64').toString('utf8')).join('')
let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  ✅', label) } else { fail++; console.log('  ❌', label) } }

console.log('说明: 会话1(ses-1)先执行耗时输出,期间切到会话2(ses-2)操作,验证会话1不中断。\n')

// 会话1:打开并连上
const s1 = await openWs('ses-1')
const shell1 = createdShells[0]
console.log('会话1已连接(独立 shell 已创建)')

// 会话1 正在"运行耗时命令":分 3 段持续输出(0/400/800ms)
shell1.emit('data', Buffer.from('A-START: 开始执行 long-running 用例...\r\n'))
setTimeout(() => shell1.emit('data', Buffer.from('A-TICK-1: 进行中(400ms)\r\n')), 400)
setTimeout(() => shell1.emit('data', Buffer.from('A-DONE: 用例执行完毕(800ms)\r\n')), 800)

// 400ms 后切到会话2并操作
await sleep(450)
const s2 = await openWs('ses-2')
const shell2 = createdShells[1]
shell2.emit('data', Buffer.from('B-OUTPUT: 会话2执行了另一个用例\r\n'))
console.log('→ 已切到会话2(ses-2)并执行另一用例')

// 等会话1的后续输出也全部到达
await sleep(700)

// 断言
console.log('\n结果:')
const s1text = texts(s1.msgs)
const s2text = texts(s2.msgs)

// 1) 会话1在切走之前已开始
ok(s1text.includes('A-START'), '会话1:切走前已在执行 A-START')
// 2) 会话2能用
ok(s2text.includes('B-OUTPUT'), '会话2:切换后正常执行 B-OUTPUT')
// 3) 会话1在切到会话2后继续输出并完成 —— 关键断言
ok(s1text.includes('A-TICK-1'), '会话1:切到会话2后仍在输出 A-TICK-1(未被中断)')
ok(s1text.includes('A-DONE'), '会话1:最终完成 A-DONE')
// 4) 两条 WS 都还开着
ok(s1.wsv.readyState === WebSocket.OPEN, '会话1 :WS 仍保持连接(未被打断)')
ok(s2.wsv.readyState === WebSocket.OPEN, '会话2 :WS 仍保持连接')

console.log('\n' + '='.repeat(40))
console.log(`验证结果: ${pass} 通过, ${fail} 失败`)
console.log('='.repeat(40))

// 清理
s1.wsv.close(); s2.wsv.close()
server.close()
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
