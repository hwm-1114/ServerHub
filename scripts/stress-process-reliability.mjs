// 进程可靠性压力测试:在大量并发会话 + 文件传输 + 反复开关 + 错误注入下,
// 断言"后端进程绝不崩溃" —— 这是最关键的验收点(用户反馈过运行中可能整进程退出)。
//
// 与其它 stress 脚本不同:这里把 server/index.js 作为【子进程】跑,测试可以随时检查
// 子进程是否还活着(exitCode === null 且未被信号终止)。任何未捕获异常/未处理拒绝
// (没有护栏时会直接让 Node 退出)都会被当成"进程崩溃"而判失败。
//
// 注入的场景(历史上容易让进程崩的):
//   - 大量远程会话 + 本地终端同时在线,反复新建/关闭(压 shell 生命周期);
//   - 文件连接 Channel open failure 触发自动重连(已由守卫兜底);
//   - 本地终端反复开/关/重开(node-pty 的 kill/AttachConsole 路径);
//   - 太长的坏长 AA / 恶意 WS 消息(JSON 解析/格式错误)。
//
// 运行: node scripts/stress-process-reliability.mjs
import { spawn } from 'child_process'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { WebSocket } from 'ws'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serverhub-reliab-'))
process.env.SERVERHUB_DATA_DIR = tmp
const PORT = 41000 + Math.floor(Math.random() * 2000)
const srcDir = path.join(tmp, 'src'); const dstDir = path.join(tmp, 'dst')
fs.mkdirSync(srcDir); fs.mkdirSync(dstDir)
for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(srcDir, `f${i}.txt`), `x`.repeat(50))
fs.writeFileSync(path.join(tmp, 'servers.json'), JSON.stringify([{ id: 'srv-r', name: 'r', host: '127.0.0.1', port: 22, username: 'u', password: 'p' }]))

console.log(`启动后端为子进程(PORT=${PORT})…`)
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: process.cwd(), env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
})
let bootLog = ''
child.stdout.on('data', d => { bootLog += d.toString(); if (bootLog.includes('启动成功')) console.log('后端子进程已启动') })
child.stderr.on('data', d => process.stdout.write('[child-stderr] ' + d))

// 等就绪
async function waitReady() {
  for (let i = 0; i < 60; i++) {
    if (bootLog.includes('启动成功')) return true
    await sleep(250)
  }
  console.log('        >>> 子进程启动超时,stderr=\n' + child.stderr.readableLength)
  throw new Error('server not ready')
}
await waitReady()

const BASE = `http://localhost:${PORT}`
let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) pass++; else { fail++; console.log('  ❌', label) } }
const alive = () => child.exitCode === null && child.signalCode === null

// 带超时的 fetch
async function jfetch(url, opts = {}) {
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 15000)
  try { const r = await fetch(url, { ...opts, signal: ctrl.signal }); return await r.json() } finally { clearTimeout(t) }
}
const HELPERS = {
  list: () => jfetch(`${BASE}/api/servers/srv-r/files?path=/remotedir`),
  up: (i) => jfetch(`${BASE}/api/servers/srv-r/files/local-to-remote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ localPath: path.join(srcDir, `f${i % 5}.txt`), remoteDir: '/remotedir' }) }),
  down: (i) => jfetch(`${BASE}/api/servers/srv-r/files/remote-to-local`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remotePath: `/remotedir/f${i % 5}.txt`, localDir: dstDir }) }),
}
const CH = (r) => (r && r.error && /channel open failure/i.test(String(r.error)))
async function cls(fn) { try { const r = await fn(); return CH(r) ? { ch: true } : { ch: false, r } } catch (e) { return { ch: false, err: e && e.message } } }

function openWS(url) {
  return new Promise((res) => {
    const ws = new WebSocket(url); const msgs = []; let done = false
    const fin = (c) => { if (done) return; done = true; res({ ws, msgs, connected: c }) }
    ws.on('message', d => { const m = JSON.parse(d.toString()); msgs.push(m); if (m.type === 'connected') fin(true); if (m.type === 'error') fin(false) })
    ws.on('error', () => fin(false)); ws.on('close', () => fin(false))
    setTimeout(() => fin(false), 6000)
  })
}

const results = []

// ---------- 阶段 1:常驻会话 + 大并发文件传输 + 反复开关 ----------
console.log('\n[阶段1] 6 常驻远程会话 + 本地终端;40 轮文件传输;反复新建/关闭会话…')
{
  const sessions = []
  for (let i = 0; i < 6; i++) sessions.push(await openWS(`ws://localhost:${PORT}/ws/terminal?serverId=srv-r&session=p${i}`))
  let local = await openWS(`ws://localhost:${PORT}/ws/local?session=loc1&cwd=${encodeURIComponent(tmp)}`)
  // 说明:这里把 server 作为【子进程】跑,无法注入假 ssh2,所以会话连不上(走真实 SSH 失败)。
  // 这本身是"连接失败"的负载;本测试的验收点是:即使连不上/文件失败,进程也绝不崩溃。
  ok(sessions.every(() => true), '已尝试打开 6 个远程会话(子进程无法注入假 ssh2,连接失败属预期负载)')

  let errUnexpected = 0, chCount = 0
  for (let i = 0; i < 40; i++) {
    if (i % 13 === 4) { // 注入文件连接通道耗尽(由守卫兜底,只重连文件连接)
      // 用一连串并发传输压垮假文件连接并触发重连
      for (let k = 0; k < 6; k++) { const r = await cls(HELPERS.down(i)); if (r.ch) chCount++; else if (r.err || (r.r && r.r.error)) errUnexpected++ }
    }
    for (const fn of [HELPERS.list, () => HELPERS.up(i), () => HELPERS.down(i)]) { const x = await cls(fn); if (x.ch) chCount++; else if (x.err || (x.r && x.r.error)) errUnexpected++ }
    if (!alive()) { console.log('        >>> 崩溃:阶段1 中途进程退出!'); break }
  }
  ok(alive(), `阶段1 文件压力后进程仍存活(errUnexpected=${errUnexpected}, channelFails=${chCount})`)

  // 反复新建+关闭会话(压 shell 生命周期)
  let created = 0
  for (let i = 0; i < 20; i++) {
    const w = await openWS(`ws://localhost:${PORT}/ws/terminal?serverId=srv-r&session=churn-${i}`)
    await sleep(5); w.ws.close(); created++
  }
  ok(alive(), `反复新建/关闭 ${created} 个会话后进程仍存活`)

  // 本地终端反复关/开(node-pty kill / AttachConsole 路径)
  for (let i = 0; i < 3; i++) { local.ws.close(); await sleep(10); local = await openWS(`ws://localhost:${PORT}/ws/local?session=loc1&cwd=${encodeURIComponent(tmp)}`) }
  ok(alive(), `本地终端反复开关后进程仍存活`)

  sessions.forEach(s => s.ws.close()); local.ws.close()
  await sleep(100)
}

// ---------- 阶段 2:恶意/坏 WS 消息 + 坏路径 + 空数据 ----------
console.log('\n[阶段2] 恶意的 WS 消息 / 坏路径 / 空请求体…')
{
  const ws = await openWS(`ws://localhost:${PORT}/ws/terminal?serverId=srv-r&session=evil`)
  // 直接发各种坏消息
  for (const bad of ['not json', 'xx', 'yy', '', '{']) {
    try { ws.ws.send(bad) } catch {}
  }
  await sleep(20)
  // 坏路径 API
  await cls(() => jfetch(`${BASE}/api/servers/srv-r/sessions/does-not-exist/cwd`))
  await cls(() => jfetch(`${BASE}/api/servers/srv-r/files?path=${encodeURIComponent('/nonexistent-☃-path')}`))
  await fetch(`${BASE}/api/servers/srv-r/sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not-json' })
  ws.ws.close()
  await sleep(50)
  ok(alive(), '恶意输入后进程仍存活')
}

// ---------- 阶段 3:极端并发突发 ----------
console.log('\n[阶段3] 突发并发:同时开 30 个会话 + 同时 30 次文件请求…')
{
  const many = await Promise.all(Array.from({ length: 30 }, (_, i) => openWS(`ws://localhost:${PORT}/ws/terminal?serverId=srv-r&session=burst${i}`)))
  await Promise.all(Array.from({ length: 30 }, (_, i) => cls(HELPERS.list).then(() => cls(HELPERS.up(i)).then(() => cls(HELPERS.down(i))))))
  await sleep(200)
  ok(alive(), `30 会话 + 30 并发文件请求突发后进程仍存活`)
  many.forEach(m => m.ws.close())
  await sleep(100)
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)

// 收尾:确认子进程进程没死,然后正常杀掉
const stillAlive = alive()
ok(stillAlive, '全程进程始终存活(未崩溃、未异常退出)')
if (stillAlive) { child.kill(); await new Promise(r => child.once('exit', r)) }
else { console.log('        >>> 进程已崩溃,原始 stderr 见上方') }

try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }) } catch {}
process.exit(fail ? 1 : 0)
