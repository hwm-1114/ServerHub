// 安全回归（离线）：访问令牌鉴权 / WebSocket 1008 拒连 / CORS 白名单 / 未设令牌时行为不变
//
// 团队盘点出的三块"零自动化覆盖"的测试空洞，本脚本一次补齐（下列 ①②③④ 是本次覆盖的四组断言）：
//   ① REST 令牌鉴权：设 SERVERHUB_TOKEN 后，无凭据 → 401（且是中文 { error }），
//      X-ServerHub-Token 头 / ?token= 正确 → 200，错误令牌 → 401；写接口（POST/DELETE）同样受保护，
//      证明中间件不是只放行 GET；
//   ② WS 令牌鉴权：/ws/terminal 与 /ws/local 不带 token 一律 close(1008, 中文原因)；带对 token 不被 1008 拒；
//   ③ 未设令牌时"行为完全不变"：REST 直通、WS 不因鉴权被拒（另起一个子进程验证）；
//   ④ CORS：不设 SERVERHUB_CORS_ORIGIN = 默认同源（不下发任何 CORS 头）；设置后 = 逗号分隔白名单，
//      命中才回 Access-Control-Allow-Origin（预检 OPTIONS 也一样）。
//
// 断言全部照当前工作区 server/index.js 的实现写（行号为写脚本时的版本）：
//   - CORS 中间件：server/index.js:43-48。corsOrigins = split(',').map(trim).filter(Boolean)，
//     仅当非空才 app.use(cors({ origin: corsOrigins }))。实测（cors@2.8.6，本机跑出来的原始响应头）：
//       · 命中来源的 GET  → access-control-allow-origin: <该来源>（回显，不是 *）+ vary: Origin
//       · 未命中的 GET    → 200，但【完全不下发】access-control-allow-origin（浏览器据此拦截）
//       · 命中来源的预检  → 204 + access-control-allow-origin: <该来源>
//                          + access-control-allow-methods: GET,HEAD,PUT,PATCH,POST,DELETE
//                          + access-control-allow-headers（回显请求的 Access-Control-Request-Headers）
//                          + vary: Origin, Access-Control-Request-Headers
//       · 未命中的预检    → 【仍是 204】且照样回 allow-methods，但就是没有
//                          access-control-allow-origin —— 所以断言必须盯 ACAO，不能盯状态码
//                          （204 看着像成功，浏览器仍判失败）
//       · 未设 SERVERHUB_CORS_ORIGIN → 没有 cors 中间件：任何响应都没有 CORS 头，
//                          OPTIONS 落到 Express 内置 OPTIONS 处理 → 200 + allow: GET,HEAD,POST
//       · 预检之所以不校验令牌：cors 中间件注册在鉴权中间件之前，OPTIONS 由它 res.end() 收尾，
//                          请求根本走不到 server/index.js:61 的 app.use('/api', ...)
//   - 令牌中间件：server/index.js:50-64。isAuthorized() 认 x-serverhub-token 头或 ?token=；
//     ACCESS_TOKEN 为空 → 一律 return true（未设置令牌 = 维持现状）。挂在 app.use('/api', ...) 上，
//     在所有 /api 路由（含 POST/PUT/DELETE）之前执行，所以写接口一并被挡。
//   - WS 鉴权：server/index.js:1046-1052。连接建立后先 isAuthorized(req)，
//     失败 ws.close(1008, '未授权：缺少或错误的访问令牌')；/ws/local 的分流(1053-1057)在鉴权之后，
//     因此本地终端同样被令牌保护。另外两处 1008 是"缺 serverId"(1060-1063)与"会话数上限"(1071-1077)，
//     业务异常走 1011(1127-1130)——所以"没被 1008 拒"本身就是"通过了鉴权"的证据。
//   - 不存在的 serverId 会让 createShell → getServerConfig 抛 '服务器不存在'（ssh-manager.js:289-291），
//     于是带上正确令牌会收到 { type:'error', message:'服务器不存在' } + close 1011：
//     这条断言比"只是没被 1008 拒"更强——它证明请求真的进了业务分支。
//
// 后端作为【子进程】启动（照 scripts/stress-process-reliability.mjs:30-47 的写法）。
// 本脚本不需要假 ssh2：鉴权与 CORS 都在进 SSH 之前返回，连不连得上远端与断言无关。
// 数据目录固定用 os.tmpdir() 下的临时目录（绝不动 data/ 里的真实服务器密码），结束时删除。
//
// 运行: node scripts/verify-security.mjs   （失败 exit 1）
import { spawn } from 'child_process'
import http from 'http'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { WebSocket } from 'ws'

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ========== 临时数据目录：绝不触碰仓库里的 data/ ==========
const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverhub-security-'))
const dataDirOn = path.join(rootDir, 'token-on')   // 阶段 A：设令牌 + CORS 白名单
const dataDirOff = path.join(rootDir, 'token-off') // 阶段 B：都不设（行为不变）
fs.mkdirSync(dataDirOn)
fs.mkdirSync(dataDirOff)

const TOKEN = 'sec-token-3f9a1c'
const WRONG_TOKEN = 'wrong-token-000'
const CORS_ALLOW_1 = 'http://allowed.example'
const CORS_ALLOW_2 = 'http://second.example'
const CORS_DENY = 'http://evil.example'
// 故意写成 "a, b"（逗号后带空格）：验证 server/index.js:45 的 split(',').map(trim) 真的生效
const CORS_ENV = `${CORS_ALLOW_1}, ${CORS_ALLOW_2}`

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) }
  else { fail++; console.log(`  ❌ ${label}${extra ? ' —— ' + extra : ''}`) }
}

// 测试脚本自身的未处理 rejection 一律计失败：避免"断言全过却 exit 1"这种看不懂的结果
// （CI 上真发生过：收尾杀子进程时的 ECONNRESET 变成未处理 rejection）。
process.on('unhandledRejection', (e) => {
  fail++
  console.log('  ❌ 测试脚本出现未处理的 rejection:', (e && e.message) || e)
})

// ========== 子进程后端 ==========
const children = []
const openSockets = new Set()
let BASE = ''

function waitExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), ms)
    child.once('exit', () => { clearTimeout(t); resolve(true) })
  })
}

// 等 stdout 出现"启动成功"（server/index.js:1189 在 listen 回调里打印）
async function waitReady(child, getLog) {
  for (let i = 0; i < 60; i++) {           // 最多 15s
    if (getLog().includes('启动成功')) return true
    if (child.exitCode !== null) return false
    await sleep(250)
  }
  return false
}

// 端口随机（42000-43999），避开开发者本机的 3120 与 Electron 的 33120；
// 万一撞上占用（子进程 stderr 会打 EADDRINUSE，且其自身护栏会吞掉不退出）就换端口重试。
async function startServer({ label, dataDir, token, corsOrigin }) {
  let lastLog = ''
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = 42000 + Math.floor(Math.random() * 2000)
    const env = { ...process.env, PORT: String(port), SERVERHUB_DATA_DIR: dataDir }
    // 显式增删，避免父进程环境（或 npm test 的调用环境）里残留的同名变量干扰
    if (token) env.SERVERHUB_TOKEN = token; else delete env.SERVERHUB_TOKEN
    if (corsOrigin) env.SERVERHUB_CORS_ORIGIN = corsOrigin; else delete env.SERVERHUB_CORS_ORIGIN
    const child = spawn(process.execPath, ['server/index.js'], {
      cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let log = ''
    child.stdout.on('data', d => { log += d.toString() })
    child.stderr.on('data', d => { log += d.toString() })
    const ready = await waitReady(child, () => log)
    if (ready) {
      console.log(`  · ${label} 后端子进程就绪：PORT=${port}（数据目录 ${path.basename(dataDir)}）`)
      return { child, port, log: () => log }
    }
    lastLog = log
    try { child.kill() } catch {}
    await waitExit(child, 3000)
    console.log(`  ⚠️ ${label} 第 ${attempt} 次启动未就绪，换端口重试…`)
  }
  throw new Error(`${label} 后端子进程启动失败，最后日志：\n${lastLog}`)
}

// ========== REST 请求助手（记录 CORS 相关响应头以便断言/取证） ==========
async function rest(pathname, { method = 'GET', headerToken, query, origin, body, preflight } = {}) {
  const u = new URL(BASE + pathname)
  for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, v)
  const headers = {}
  if (headerToken) headers['X-ServerHub-Token'] = headerToken
  if (origin) headers['Origin'] = origin
  if (preflight) {
    headers['Access-Control-Request-Method'] = 'GET'
    headers['Access-Control-Request-Headers'] = 'x-serverhub-token'
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 15000)
  try {
    const res = await fetch(u, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctrl.signal })
    const text = await res.text()
    let json
    try { json = JSON.parse(text) } catch { json = undefined }
    const corsHeaders = {}
    res.headers.forEach((v, k) => { if (k.startsWith('access-control-') || k === 'vary' || k === 'allow') corsHeaders[k] = v })
    return { status: res.status, json, text, acao: res.headers.get('access-control-allow-origin'), corsHeaders, headers: res.headers }
  } finally { clearTimeout(t) }
}

// 原生 http 请求：用于"头名大小写"这类必须看真实报文的断言（fetch/undici 会把头名小写化，
// 测不出服务端是否大小写不敏感——而 Node 的 http 客户端按给定原样发送）
function rawGet(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: BASE_PORT, path: pathname, method: 'GET', headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

// ========== WS 探针：等到 connected / 业务 error / close（拿 close code+reason）==========
// 注意：不把 'error' 事件当成终点——ws 客户端在 error 之后还会发 close，我们要的是 close code。
function wsProbe(pathWithQuery, { headerToken, timeoutMs = 10000 } = {}) {
  const url = `ws://127.0.0.1:${BASE_PORT}${pathWithQuery}`
  return new Promise((resolve) => {
    const out = { url, connected: false, errorMessage: null, closeCode: null, closeReason: '', transportError: null, timedOut: false, ws: null }
    let ws
    try {
      ws = headerToken ? new WebSocket(url, { headers: { 'X-ServerHub-Token': headerToken } }) : new WebSocket(url)
    } catch (e) { out.transportError = e.message; return resolve(out) }
    out.ws = ws
    openSockets.add(ws)
    let settled = false
    let graceTimer = null
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); if (graceTimer) clearTimeout(graceTimer); resolve(out) }
    const timer = setTimeout(() => { out.timedOut = true; finish() }, timeoutMs)
    ws.on('message', (d) => {
      let m = null
      try { m = JSON.parse(d.toString()) } catch { /* 忽略非 JSON */ }
      if (!m) return
      if (m.type === 'connected') { out.connected = true; finish() }
      else if (m.type === 'error') { out.errorMessage = m.message || '' }
    })
    ws.on('close', (code, reason) => {
      out.closeCode = code
      out.closeReason = reason ? reason.toString('utf8') : ''
      finish()
    })
    ws.on('error', (e) => {
      out.transportError = (e && e.message) || String(e)
      // 等 close 帧（正常情况紧随其后）；极端情况下 1.5s 兜底
      graceTimer = setTimeout(finish, 1500)
    })
  })
}
let BASE_PORT = 0

function closeWs(p) { try { if (p.ws) p.ws.close() } catch { /* 已关闭则忽略 */ } }

// =====================================================================
// 阶段 A：设置 SERVERHUB_TOKEN + SERVERHUB_CORS_ORIGIN
// =====================================================================
async function phaseA() {
  const srv = await startServer({ label: '【阶段A 令牌开启】', dataDir: dataDirOn, token: TOKEN, corsOrigin: CORS_ENV })
  BASE_PORT = srv.port
  BASE = `http://127.0.0.1:${srv.port}`

  console.log('\n[阶段A] REST 令牌鉴权（server/index.js:50-64 中间件挂在 /api 前缀上）')
  // —— 无凭据 → 401，且响应体是中文 { error }（前端 K1 修复后据此弹"请在地址后加 ?token="横幅）
  const noAuth = await rest('/api/servers')
  ok(noAuth.status === 401, 'GET /api/servers 不带任何凭据 → 401', `status=${noAuth.status} body=${noAuth.text.slice(0, 120)}`)
  ok(!!(noAuth.json && typeof noAuth.json.error === 'string' && /[\u4e00-\u9fff]/.test(noAuth.json.error)),
    '401 响应体是 { error } 且 error 为中文', `body=${noAuth.text.slice(0, 120)}`)
  ok(/未授权/.test((noAuth.json && noAuth.json.error) || ''), '401 的中文提示包含"未授权"', `error=${noAuth.json && noAuth.json.error}`)
  ok(!noAuth.text.includes(TOKEN), '401 响应体不回显真实令牌')

  // —— 正确凭据（头 / 查询参数）→ 200
  const byHeader = await rest('/api/servers', { headerToken: TOKEN })
  ok(byHeader.status === 200, 'GET /api/servers 带 X-ServerHub-Token 头 → 200', `status=${byHeader.status}`)
  ok(Array.isArray(byHeader.json), '带令牌的 200 响应体是数组（前端 loadsServers 不会拿到错误对象）',
    `body=${byHeader.text.slice(0, 120)}`)

  const byQuery = await rest('/api/servers', { query: { token: TOKEN } })
  ok(byQuery.status === 200, 'GET /api/servers 带 ?token= → 200', `status=${byQuery.status}`)

  // 令牌头名大小写不敏感：用原生 http 按【全大写】发头，服务端 req.headers 会小写化后比对
  const upperHeader = await rawGet('/api/servers', { 'X-SERVERHUB-TOKEN': TOKEN })
  ok(upperHeader.status === 200, '令牌头名大小写不敏感（原生 http 发 X-SERVERHUB-TOKEN 全大写）→ 200',
    `status=${upperHeader.status} body=${String(upperHeader.body).slice(0, 120)}`)

  // —— 错误令牌 → 401（头与查询参数两条路径）
  const badHeader = await rest('/api/servers', { headerToken: WRONG_TOKEN })
  ok(badHeader.status === 401, '错误令牌（头）→ 401', `status=${badHeader.status}`)
  const badQuery = await rest('/api/servers', { query: { token: WRONG_TOKEN } })
  ok(badQuery.status === 401, '错误令牌（?token=）→ 401', `status=${badQuery.status}`)

  // —— 中间件挂在 /api 前缀上：换个路由同样被挡
  const otherRoute = await rest('/api/servers/status')
  ok(otherRoute.status === 401, '其它 /api 路由同样受保护（GET /api/servers/status 无凭据 → 401）', `status=${otherRoute.status}`)

  console.log('\n[阶段A] 写接口（POST/DELETE）同样受保护——中间件不是只放行 GET')
  const fakeBody = { name: '阶段A假服务器', host: '127.0.0.1', port: 1, username: 'tester', password: 'x' }
  // 关键：body 是【合法】的（host/username 齐全，POST /api/servers:103-107 会返回 201），
  // 所以拿到 401 只可能是鉴权中间件挡下的，而不是参数校验失败
  const postNoAuth = await rest('/api/servers', { method: 'POST', body: fakeBody })
  ok(postNoAuth.status === 401, 'POST /api/servers 无凭据（合法 body）→ 401 而不是 201/400',
    `status=${postNoAuth.status} body=${postNoAuth.text.slice(0, 120)}`)
  const afterBlockedPost = await rest('/api/servers', { headerToken: TOKEN })
  ok(Array.isArray(afterBlockedPost.json) && !afterBlockedPost.json.some(s => s.name === fakeBody.name),
    '被 401 挡下的写请求没有落盘（数据目录里查不到这台假服务器）', `body=${afterBlockedPost.text.slice(0, 160)}`)

  const postByHeader = await rest('/api/servers', { method: 'POST', body: { ...fakeBody, name: '阶段A-头部令牌' }, headerToken: TOKEN })
  ok(postByHeader.status === 201 && !!(postByHeader.json && postByHeader.json.id),
    'POST /api/servers 带 X-ServerHub-Token 头 → 201', `status=${postByHeader.status} body=${postByHeader.text.slice(0, 160)}`)
  const postByQuery = await rest('/api/servers', { method: 'POST', body: { ...fakeBody, name: '阶段A-查询令牌' }, query: { token: TOKEN } })
  ok(postByQuery.status === 201, 'POST /api/servers 带 ?token= → 201', `status=${postByQuery.status}`)

  const cmds = await rest('/api/commands', { query: { scope: 'all', token: TOKEN } })
  ok(cmds.status === 200 && Array.isArray(cmds.json) && cmds.json.length >= 18,
    'GET /api/commands?scope=all 带令牌 → 200 且返回默认命令集（≥18 条）',
    `status=${cmds.status} len=${Array.isArray(cmds.json) ? cmds.json.length : 'n/a'}`)

  const delNoAuth = await rest(`/api/servers/${postByQuery.json.id}`, { method: 'DELETE' })
  ok(delNoAuth.status === 401, 'DELETE /api/servers/:id 无凭据 → 401', `status=${delNoAuth.status}`)
  const delOk = await rest(`/api/servers/${postByQuery.json.id}`, { method: 'DELETE', query: { token: TOKEN } })
  ok(delOk.status === 200 && delOk.json && delOk.json.success === true,
    'DELETE /api/servers/:id 带 ?token= → 200（查询参数在写接口上同样有效）', `status=${delOk.status} body=${delOk.text.slice(0, 120)}`)
  const listAfterDel = await rest('/api/servers', { headerToken: TOKEN })
  ok(Array.isArray(listAfterDel.json) && !listAfterDel.json.some(s => s.id === postByQuery.json.id),
    'DELETE 之后该服务器确实被删除')

  console.log('\n[阶段A] WebSocket 令牌鉴权（server/index.js:1046-1052 → close(1008)）')
  // 不带 token：连接建立后立即被 close(1008, '未授权：缺少或错误的访问令牌')
  const wNoToken = await wsProbe('/ws/terminal?serverId=no-such-server&session=s')
  ok(wNoToken.closeCode === 1008, '/ws/terminal 不带 token → close code 1008',
    `code=${wNoToken.closeCode} reason=${wNoToken.closeReason} err=${wNoToken.transportError}`)
  ok(/[\u4e00-\u9fff]/.test(wNoToken.closeReason) && /未授权/.test(wNoToken.closeReason),
    '1008 的 reason 是中文"未授权"提示（前端 L1/L4 会把它显示到终端）', `reason=${wNoToken.closeReason}`)

  const wBadToken = await wsProbe(`/ws/terminal?serverId=no-such-server&session=s&token=${encodeURIComponent(WRONG_TOKEN)}`)
  ok(wBadToken.closeCode === 1008, '/ws/terminal 带错误 token → close code 1008',
    `code=${wBadToken.closeCode} reason=${wBadToken.closeReason}`)

  // 带正确 token：不被 1008 拒；因为 serverId 不存在，会走业务异常分支（error 消息 + close 1011）
  const wOk = await wsProbe(`/ws/terminal?serverId=no-such-server&session=s&token=${encodeURIComponent(TOKEN)}`)
  ok(wOk.closeCode !== 1008 && !/未授权/.test(wOk.closeReason),
    '带正确 token 的 /ws/terminal 不会因鉴权被 1008 拒绝',
    `code=${wOk.closeCode} reason=${wOk.closeReason} err=${wOk.transportError} timedOut=${wOk.timedOut}`)
  ok(/服务器不存在/.test(wOk.errorMessage || ''),
    '带正确 token 的 /ws/terminal 已进入业务逻辑（收到"服务器不存在"错误消息，证明通过了鉴权）',
    `errorMessage=${wOk.errorMessage}`)
  closeWs(wOk)

  // WS 也能用请求头带令牌（isAuthorized 同时认头；浏览器 WebSocket API 无法自带头，但桌面/脚本客户端可以）
  const wHeader = await wsProbe('/ws/terminal?serverId=no-such-server&session=s', { headerToken: TOKEN })
  ok(wHeader.closeCode !== 1008 && /服务器不存在/.test(wHeader.errorMessage || ''),
    'WS 用 X-ServerHub-Token 头带令牌同样通过鉴权（未被 1008 拒）',
    `code=${wHeader.closeCode} errorMessage=${wHeader.errorMessage}`)
  closeWs(wHeader)

  // 存在但不可达的假服务器（127.0.0.1:1）：会真的尝试 SSH 并失败；断言点仍是"没被鉴权拒"，
  // 不把 SSH 失败当测试失败（SERVERHUB_TOKEN 正确时不应出现 1008）
  const wReal = await wsProbe(`/ws/terminal?serverId=${postByHeader.json.id}&session=s&token=${encodeURIComponent(TOKEN)}`)
  ok(wReal.closeCode !== 1008, '带正确 token 连一台不可达的服务器：未被鉴权拒绝（SSH 失败属预期，不算测试失败）',
    `code=${wReal.closeCode} err=${wReal.transportError} timedOut=${wReal.timedOut} msg=${wReal.errorMessage}`)
  closeWs(wReal)

  // /ws/local 的鉴权在 pathname 分流之前（1053-1057），所以本地终端同样被令牌保护
  const wLocalNoToken = await wsProbe('/ws/local?session=sec-a&cwd=' + encodeURIComponent(os.tmpdir()))
  ok(wLocalNoToken.closeCode === 1008, '/ws/local 不带 token → close code 1008（本地终端也被令牌保护）',
    `code=${wLocalNoToken.closeCode} reason=${wLocalNoToken.closeReason}`)
  const wLocalOk = await wsProbe(`/ws/local?session=sec-a2&cwd=${encodeURIComponent(os.tmpdir())}&token=${encodeURIComponent(TOKEN)}`)
  ok(wLocalOk.closeCode !== 1008 && !/未授权/.test(wLocalOk.closeReason),
    '带正确 token 的 /ws/local 不会被 1008 拒绝（会真的起一个本机 PowerShell，这里随即关闭）',
    `code=${wLocalOk.closeCode} reason=${wLocalOk.closeReason} connected=${wLocalOk.connected}`)
  closeWs(wLocalOk)
  await sleep(300) // 给后端 destroyLocalShell 一点时间收尾

  console.log(`\n[阶段A] CORS 白名单（SERVERHUB_CORS_ORIGIN="${CORS_ENV}" → server/index.js:43-48）`)
  // 命中白名单：cors@2.8.6 回显请求的 Origin（不是通配 *）
  const corsHit1 = await rest('/api/servers', { headerToken: TOKEN, origin: CORS_ALLOW_1 })
  ok(corsHit1.status === 200 && corsHit1.acao === CORS_ALLOW_1,
    `命中白名单来源 → access-control-allow-origin: ${CORS_ALLOW_1}`,
    `status=${corsHit1.status} acao=${corsHit1.acao} corsHeaders=${JSON.stringify(corsHit1.corsHeaders)}`)
  ok(corsHit1.acao !== '*', '白名单模式不是通配 *（收敛而非放开）', `acao=${corsHit1.acao}`)
  // 第二个来源（验证逗号分隔 + 空格 trim）
  const corsHit2 = await rest('/api/servers', { headerToken: TOKEN, origin: CORS_ALLOW_2 })
  ok(corsHit2.acao === CORS_ALLOW_2,
    `逗号分隔的第二个来源（配置里带空格）也被放行 → acao: ${CORS_ALLOW_2}`,
    `acao=${corsHit2.acao} corsHeaders=${JSON.stringify(corsHit2.corsHeaders)}`)
  // 未命中白名单：不下发 ACAO（浏览器侧即被拦），业务本身照常 200
  const corsMiss = await rest('/api/servers', { headerToken: TOKEN, origin: CORS_DENY })
  ok(corsMiss.acao !== CORS_DENY && corsMiss.acao === null,
    '未命中白名单的来源拿不到 access-control-allow-origin（浏览器会拦掉响应）',
    `status=${corsMiss.status} acao=${corsMiss.acao} corsHeaders=${JSON.stringify(corsMiss.corsHeaders)}`)
  // 预检：cors 中间件在鉴权中间件之前注册，OPTIONS 由它直接以 204 结束（不校验令牌）
  const preHit = await rest('/api/servers', { method: 'OPTIONS', origin: CORS_ALLOW_1, preflight: true })
  console.log(`  ℹ️ 预检(命中来源)实测：status=${preHit.status} ${JSON.stringify(preHit.corsHeaders)}`)
  ok(preHit.acao === CORS_ALLOW_1 && (preHit.status === 204 || preHit.status === 200),
    'OPTIONS 预检（命中来源）→ 回 ACAO 白名单来源 + 204/200',
    `status=${preHit.status} acao=${preHit.acao} corsHeaders=${JSON.stringify(preHit.corsHeaders)}`)
  ok(!!preHit.headers.get('access-control-allow-methods'),
    'OPTIONS 预检命中来源时回 access-control-allow-methods（浏览器才会放行真实请求）',
    `corsHeaders=${JSON.stringify(preHit.corsHeaders)}`)
  const preMiss = await rest('/api/servers', { method: 'OPTIONS', origin: CORS_DENY, preflight: true })
  console.log(`  ℹ️ 预检(未命中来源)实测：status=${preMiss.status} ${JSON.stringify(preMiss.corsHeaders)}`)
  ok(preMiss.acao !== CORS_DENY && preMiss.acao === null,
    'OPTIONS 预检（未命中来源）→ 不下发 ACAO（预检本身可能仍 204，但浏览器会判失败）',
    `status=${preMiss.status} acao=${preMiss.acao} corsHeaders=${JSON.stringify(preMiss.corsHeaders)}`)

  // 阶段 A 收尾：确认子进程没被令牌/CORS 相关代码打崩（server/index.js:36-41 的护栏只记录不退出）
  ok(srv.child.exitCode === null, '阶段A 结束后后端子进程仍存活')
  try { srv.child.kill() } catch {}
  await waitExit(srv.child, 5000)
}

// =====================================================================
// 阶段 B：什么都不设（不设 SERVERHUB_TOKEN / 不设 SERVERHUB_CORS_ORIGIN）= 行为不变
// =====================================================================
async function phaseB() {
  const srv = await startServer({ label: '【阶段B 无令牌】', dataDir: dataDirOff })
  BASE_PORT = srv.port
  BASE = `http://127.0.0.1:${srv.port}`

  console.log('\n[阶段B] 未设令牌 → REST 行为不变（server/index.js:55 未设令牌直接放行）')
  const list = await rest('/api/servers')
  ok(list.status === 200, 'GET /api/servers 不带任何凭据 → 200（不再是 401）', `status=${list.status} body=${list.text.slice(0, 120)}`)
  ok(Array.isArray(list.json), '响应体是数组（与设置令牌前一致）', `body=${list.text.slice(0, 120)}`)
  const postNoToken = await rest('/api/servers', { method: 'POST', body: { name: '阶段B假服务器', host: '127.0.0.1', port: 1, username: 'tester', password: 'x' } })
  ok(postNoToken.status === 201, 'POST /api/servers 不带凭据 → 201（写接口也不校验）', `status=${postNoToken.status}`)
  const withToken = await rest('/api/servers', { query: { token: '随便什么' } })
  ok(withToken.status === 200, '未设令牌时多余的 ?token= 参数被忽略（仍是 200）', `status=${withToken.status}`)

  console.log('\n[阶段B] 未设 SERVERHUB_CORS_ORIGIN → 默认同源（不下发任何 CORS 头）')
  // 实测：没有 cors 中间件时，OPTIONS 落到 Express 内置 OPTIONS 处理 → 200 + allow: GET,HEAD,POST，
  // 且没有任何 access-control-* 头（下面的 ℹ️ 会打印实测值）。断言只盯 ACAO：
  // 跨域浏览器请求能不能读到响应，取决于有没有 ACAO，而不是状态码。
  const corsOff = await rest('/api/servers', { origin: CORS_DENY })
  ok(corsOff.status === 200 && corsOff.acao === null,
    '带 Origin: http://evil.example 的请求拿不到 access-control-allow-origin',
    `status=${corsOff.status} acao=${corsOff.acao} corsHeaders=${JSON.stringify(corsOff.corsHeaders)}`)
  const preOff = await rest('/api/servers', { method: 'OPTIONS', origin: CORS_DENY, preflight: true })
  console.log(`  ℹ️ 未设 CORS 时的预检实测：status=${preOff.status} ${JSON.stringify(preOff.corsHeaders)}`)
  ok(preOff.acao === null, '未设 CORS 时 OPTIONS 预检也不下发 ACAO',
    `status=${preOff.status} acao=${preOff.acao} corsHeaders=${JSON.stringify(preOff.corsHeaders)}`)

  console.log('\n[阶段B] 未设令牌 → WS 不因鉴权被 1008 拒绝')
  const wTerm = await wsProbe('/ws/terminal?serverId=no-such-server&session=s')
  ok(wTerm.closeCode !== 1008 && !/未授权/.test(wTerm.closeReason),
    '/ws/terminal 不带 token → 不是 1008 鉴权拒绝',
    `code=${wTerm.closeCode} reason=${wTerm.closeReason} err=${wTerm.transportError} timedOut=${wTerm.timedOut}`)
  ok(/服务器不存在/.test(wTerm.errorMessage || ''),
    '/ws/terminal 不带 token 直接进入业务逻辑（收到"服务器不存在"，证明鉴权处于关闭状态）',
    `errorMessage=${wTerm.errorMessage}`)
  closeWs(wTerm)

  const wLocal = await wsProbe('/ws/local?session=sec-b&cwd=' + encodeURIComponent(os.tmpdir()))
  ok(wLocal.connected === true, '/ws/local 不带 token → 正常收到 connected（本机 PowerShell 不被误伤）',
    `connected=${wLocal.connected} code=${wLocal.closeCode} msg=${wLocal.errorMessage}`)
  closeWs(wLocal)
  await sleep(300)
  const wLocalTokened = await wsProbe('/ws/local?session=sec-b2&cwd=' + encodeURIComponent(os.tmpdir()) + '&token=' + encodeURIComponent(WRONG_TOKEN))
  ok(wLocalTokened.connected === true, '未设令牌时 /ws/local 带任意 token 参数也照常 connected（参数被忽略）',
    `connected=${wLocalTokened.connected} code=${wLocalTokened.closeCode}`)
  closeWs(wLocalTokened)
  await sleep(300)

  ok(srv.child.exitCode === null, '阶段B 结束后后端子进程仍存活')
  try { srv.child.kill() } catch {}
  await waitExit(srv.child, 5000)
}

// =====================================================================
// 主流程（即便中途抛错也保证：杀掉子进程 + 删除临时数据目录）
// =====================================================================
console.log('安全回归：令牌鉴权 / WS 1008 / CORS 白名单 / 未设令牌行为不变')
console.log(`临时数据目录：${rootDir}\n`)
try {
  await phaseA()
  await phaseB()
} catch (e) {
  fail++
  console.log('\n  ❌ 测试流程异常终止：', (e && e.stack) || e)
} finally {
  for (const s of openSockets) { try { s.terminate() } catch {} }
  for (const c of children) { try { c.kill() } catch {} }
  for (const c of children) await waitExit(c, 3000)
  for (const c of children) { if (c.exitCode === null) { try { c.kill('SIGKILL') } catch {} } }
  await sleep(300) // 等 Windows 释放文件句柄（本地终端的 ConPTY 子进程）
  for (const c of children) await waitExit(c, 2000)
  try {
    fs.rmSync(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    console.log(`\n临时数据目录已删除：${rootDir}`)
  } catch (e) {
    console.log(`\n  ⚠️ 临时数据目录删除失败（不影响断言结果）：${rootDir} —— ${e.message}`)
  }
}

console.log(`\n安全回归结果: ${pass} PASS / ${fail} FAIL（共 ${pass + fail} 条断言）`)
process.exit(fail ? 1 : 0)
