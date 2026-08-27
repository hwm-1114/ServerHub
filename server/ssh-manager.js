import { Client } from 'ssh2'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 数据目录可用环境变量覆盖(打包后写向可写目录,如 Electron userData);默认在仓库 data/
const dataDir = process.env.SERVERHUB_DATA_DIR || path.join(__dirname, '..', 'data')
const serversFile = path.join(dataDir, 'servers.json')
const commandsFile = path.join(dataDir, 'commands.json')
const sessionsFile = path.join(dataDir, 'sessions.json')
const bookmarksFile = path.join(dataDir, 'bookmarks.json')

// 确保数据目录和文件存在
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true })
}
if (!fs.existsSync(serversFile)) {
  fs.writeFileSync(serversFile, '[]')
}
if (!fs.existsSync(sessionsFile)) {
  fs.writeFileSync(sessionsFile, '[]')
}
if (!fs.existsSync(bookmarksFile)) {
  fs.writeFileSync(bookmarksFile, '[]')
}
if (!fs.existsSync(commandsFile)) {
  // 预置一些常用命令
  const defaultCommands = [
    { id: 'cmd-1', name: '系统信息', command: 'uname -a', category: 'system', description: '查看系统内核版本' },
    { id: 'cmd-2', name: 'CPU 信息', command: 'lscpu | head -20', category: 'system', description: '查看 CPU 详细信息' },
    { id: 'cmd-3', name: '内存使用', command: 'free -h', category: 'system', description: '查看内存使用情况' },
    { id: 'cmd-4', name: '磁盘使用', command: 'df -h', category: 'system', description: '查看磁盘使用情况' },
    { id: 'cmd-5', name: '当前用户', command: 'whoami && id', category: 'system', description: '查看当前登录用户信息' },
    { id: 'cmd-6', name: '在线用户', command: 'who', category: 'system', description: '查看在线用户' },
    { id: 'cmd-7', name: '系统运行时间', command: 'uptime', category: 'system', description: '查看系统运行时间和负载' },
    { id: 'cmd-8', name: '进程 Top10', command: 'ps aux --sort=-%cpu | head -11', category: 'process', description: '查看 CPU 占用最高的进程' },
    { id: 'cmd-9', name: '网络连接', command: 'ss -tlnp', category: 'network', description: '查看监听端口' },
    { id: 'cmd-10', name: '网卡信息', command: 'ip addr show', category: 'network', description: '查看网络接口信息' },
    { id: 'cmd-11', name: '目录大小', command: 'du -sh /home/*', category: 'file', description: '查看 home 目录各子目录大小' },
    { id: 'cmd-12', name: '最近登录', command: 'last -10', category: 'system', description: '查看最近 10 次登录记录' },
    { id: 'cmd-13', name: '系统日志', command: 'journalctl -u sshd --no-pager -n 30', category: 'log', description: '查看 SSH 服务最近 30 条日志' },
    { id: 'cmd-14', name: 'Docker 容器', command: 'docker ps -a', category: 'docker', description: '查看所有 Docker 容器' },
    { id: 'cmd-15', name: 'Docker 镜像', command: 'docker images', category: 'docker', description: '查看所有 Docker 镜像' },
    { id: 'cmd-16', name: 'Python 版本', command: 'python3 --version', category: 'dev', description: '查看 Python 版本' },
    { id: 'cmd-17', name: 'Node 版本', command: 'node --version', category: 'dev', description: '查看 Node.js 版本' },
    { id: 'cmd-18', name: '定时任务', command: 'crontab -l', category: 'system', description: '查看当前用户的 crontab' },
  ]
  fs.writeFileSync(commandsFile, JSON.stringify(defaultCommands, null, 2))
}

// ========== 数据读写(容错 + 原子 + 串行) ==========
// 三个保障:
//  1. 读容错:JSON 损坏时把原文件备份为 *.bak 后返回默认值,而不是抛异常拖垮所有路由;
//  2. 原子写:先写临时文件再 rename,进程在写入中途崩溃/断电不会留下半个 JSON;
//  3. 串行化:同一文件的"读-改-写"按 Promise 链排队,并发请求(如同时建两个会话)
//     不会互相覆盖丢数据。
const jsonDefaults = {
  [serversFile]: () => [],
  [commandsFile]: () => [],
  [sessionsFile]: () => [],
  [bookmarksFile]: () => [],
}
const fileChains = new Map() // file -> Promise(写串行链)

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (err) {
    // 文件不存在属正常(尚未创建);内容损坏则备份留证,降级为默认值
    if (fs.existsSync(file)) {
      try { fs.copyFileSync(file, file + '.corrupt.bak') } catch {}
      console.error(`[data] ${path.basename(file)} 解析失败,已备份为 .corrupt.bak 并重置:`, err.message)
    }
    const def = jsonDefaults[file]
    return def ? def() : []
  }
}

function writeJson(file, data) {
  const prev = fileChains.get(file) || Promise.resolve()
  const run = prev.catch(() => {}).then(() => {
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
    fs.renameSync(tmp, file)
  })
  // 链上记录本次(无论成败),使并发调用排队;错误抛给调用方
  fileChains.set(file, run.then(() => {}, () => {}))
  return run
}

// 事务性"读-改-写":整个读改写按文件互斥排队。只串行化写入不够——两个并发
// 请求同时读到同一份旧列表、各自追加、先后落盘时,后写会把先写的新记录覆盖掉
// (可靠性矩阵 R10 实测到:并发 40 建会话丢 1 条)。所有变更型路由必须走这里。
function mutateJson(file, mutator) {
  const prev = fileChains.get(file) || Promise.resolve()
  const run = prev.catch(() => {}).then(async () => {
    const cur = readJson(file)
    const next = await mutator(cur)
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, file)
    return next
  })
  fileChains.set(file, run.then(() => {}, () => {}))
  return run
}

export function readServers() {
  return readJson(serversFile)
}

export function writeServers(servers) {
  return writeJson(serversFile, servers)
}

export function readCommands() {
  return readJson(commandsFile)
}

export function writeCommands(commands) {
  return writeJson(commandsFile, commands)
}

// 会话(终端标签)仅持久化名称,屏幕内容随连接生命周期
export function readSessions() {
  return readJson(sessionsFile)
}

export function writeSessions(sessions) {
  return writeJson(sessionsFile, sessions)
}

// 路径收藏夹:每台服务器独立,存绝对路径 + 显示名
export function readBookmarks() {
  return readJson(bookmarksFile)
}

export function writeBookmarks(bookmarks) {
  return writeJson(bookmarksFile, bookmarks)
}

// 事务性读改写(供全部变更型路由使用,防并发丢更新)
export function mutateServers(fn) { return mutateJson(serversFile, fn) }
export function mutateSessions(fn) { return mutateJson(sessionsFile, fn) }
export function mutateBookmarks(fn) { return mutateJson(bookmarksFile, fn) }
export function mutateCommands(fn) { return mutateJson(commandsFile, fn) }

// ========== SSH 连接管理(终端连接池) ==========
// 原先是 serverId -> 单条 ssh2 连接。但 sshd MaxSessions 默认=10,限制的是"单条连接"上的
// 并发通道数;若把 20 个会话的 shell 全压一条连接,第 11 个就会报
// "(SSH) Channel open failure"。因此改为"连接池":每台服务器可维护多条终端连接,每条最多
// 放 SHELLS_PER_TERMINAL_CONNECTION 个 shell,新 shell 自动分摊到尚未满的连接上(必要时
// 新开一条)。这样 20 个并发会话在默认 MaxSessions=10 下也能全开,且一条连接出问题(通道
// 耗尽/断开)只会影响它自己名下的 shell,不会连累其他连接的会话 —— 会话稳定性由此保证。
const SHELLS_PER_TERMINAL_CONNECTION = 8 // 保守:默认 MaxSessions=10,留余量给 exec/捕获通道
const terminalConns = new Map() // serverId -> Array<{ client, status, shells: Set }>

export function getConnectionStatus(serverId) {
  const arr = terminalConns.get(serverId) || []
  if (arr.some(c => c.status === 'connected')) return 'connected'
  if (arr.length) return 'connecting'
  return 'disconnected'
}

// 返回第一条"已连接"的终端连接(供一次性命令 execCommand / status 等使用)
export function getClient(serverId) {
  const arr = terminalConns.get(serverId) || []
  const conn = arr.find(c => c.status === 'connected')
  return conn ? conn.client : null
}

// 供再放一个 shell 的已连接连接(仍有容量);没有则 undefined
function getAvailableTerminalConn(serverId) {
  const arr = terminalConns.get(serverId) || []
  return arr.find(c => c.status === 'connected' && c.shells.size < SHELLS_PER_TERMINAL_CONNECTION)
}

function removeTerminalConn(serverId, entry) {
  const arr = terminalConns.get(serverId)
  if (!arr) return
  const i = arr.indexOf(entry)
  if (i !== -1) arr.splice(i, 1)
  if (arr.length === 0) terminalConns.delete(serverId)
}

// 某条终端连接 close/end:关闭它名下的所有 shell 并移出池,不影响其他连接
function onTerminalConnClose(serverId, entry) {
  entry.shells.forEach(shell => shell.close())
  entry.shells.clear()
  removeTerminalConn(serverId, entry)
}

// 新开一条终端连接并等待 ready,写入池
function openTerminalConn(serverId) {
  const server = readServers().find(s => s.id === serverId)
  if (!server) return Promise.reject(new Error('服务器不存在'))
  const arr = terminalConns.get(serverId) || []
  const entry = { client: new Client(), status: 'connecting', shells: new Set() }
  arr.push(entry)
  terminalConns.set(serverId, arr)
  return new Promise((resolve, reject) => {
    entry.client.on('ready', () => {
      entry.status = 'connected'
      resolve(entry)
    })
    entry.client.on('error', (err) => {
      // error 后通常还会触发 close,这里先移出并 reject,避免悬挂
      onTerminalConnClose(serverId, entry)
      reject(err)
    })
    entry.client.on('close', () => onTerminalConnClose(serverId, entry))
    entry.client.on('end', () => onTerminalConnClose(serverId, entry))
    const config = {
      host: server.host,
      port: server.port || 22,
      username: server.username,
      password: server.password,
      readyTimeout: 15000,
      keepaliveInterval: 30000,
    }
    // 如果有私钥
    if (server.privateKey) {
      config.privateKey = server.privateKey
      delete config.password
    }
    entry.client.connect(config)
  })
}

// 确保有"未满容量"的已连接连接可用;没有则新开一条。返回该连接(entry)
export async function connect(serverId) {
  const avail = getAvailableTerminalConn(serverId)
  if (avail) return avail
  return openTerminalConn(serverId)
}

export function disconnect(serverId) {
  const arr = terminalConns.get(serverId) || []
  terminalConns.delete(serverId)
  for (const entry of arr) {
    entry.shells.forEach(shell => shell.close())
    entry.shells.clear()
    try { entry.client.end() } catch {}
  }
}

// ========== 通道耗尽自愈 ==========
// sshd 默认 MaxSessions=10 限制的是"单条 SSH 连接"上并发的 session/channel 数。
// 若某条连接上残留的 shell/exec/sftp 通道超过上限,后续打开通道会报
// "(SSH) Channel open failure: open failed"。此时旧连接已不可用,主动断开重连
// (让远端释放全部 session),再重试一次,避免应用一直卡在失败状态。
const CHANNEL_FAIL_RE = /channel open failure/i

export function isChannelExhaustedError(err) {
  return !!err && CHANNEL_FAIL_RE.test(err.message || '')
}

export async function retryAfterReconnect(serverId, fn) {
  try {
    return await fn()
  } catch (err) {
    if (isChannelExhaustedError(err)) {
      disconnect(serverId)
      await connect(serverId)
      // 只重试一次,防止死循环
      return fn()
    }
    throw err
  }
}

// ========== 独立文件连接 ==========
// 关键稳定性设计:SFTP 文件操作(files 上传/下载/删除/列目录)与终端 shell **共享同一
// 条 ssh2 连接**时,每次操作都会在终端连接上额外打开 SFTP 通道,多个会话的 shell +
// 连续文件操作会耗尽 sshd MaxSessions,触发 "channel open failure";而 retryAfterReconnect
// 会 disconnect(serverId) 把**所有终端 shell 一起杀掉** —— 这就是"上传下载后切回会话
// 就中断重连"的根因。
// 因此这里给文件操作单独开一条 ssh2 连接(fileConnections),与终端连接完全隔离:
//  - 文件通道不占用终端连接的 MaxSessions;
//  - 文件连接通道耗尽时只重连文件连接,绝不动终端 shell,终端会话永远稳定。
const fileConnections = new Map() // serverId -> { client, status }

export function getFileClient(serverId) {
  const c = fileConnections.get(serverId)
  return c && c.status === 'connected' ? c.client : null
}

function getServerConfig(serverId) {
  const server = readServers().find((s) => s.id === serverId)
  if (!server) throw new Error('服务器不存在')
  const config = {
    host: server.host,
    port: server.port || 22,
    username: server.username,
    password: server.password,
    readyTimeout: 15000,
    keepaliveInterval: 30000,
  }
  if (server.privateKey) {
    config.privateKey = server.privateKey
    delete config.password
  }
  return config
}

// 确保某服务器的文件连接已建立并返回其 client
export async function ensureFileClient(serverId) {
  const existing = fileConnections.get(serverId)
  if (existing && existing.status === 'connected') return existing.client
  const config = getServerConfig(serverId)
  const client = new Client()
  fileConnections.set(serverId, { client, status: 'connecting' })
  await new Promise((resolve, reject) => {
    client.on('ready', () => {
      const c = fileConnections.get(serverId)
      if (c) c.status = 'connected'
      resolve()
    })
    client.on('error', (e) => { fileConnections.delete(serverId); fileSftps.delete(serverId); reject(e) })
    client.on('close', () => { fileConnections.delete(serverId); fileSftps.delete(serverId) })
    client.on('end', () => { fileConnections.delete(serverId); fileSftps.delete(serverId) })
    client.connect(config)
  })
  return client
}

// 断开某服务器的文件连接(不影响终端 shell)
export function disconnectFile(serverId) {
  const c = fileConnections.get(serverId)
  if (c) {
    try { c.client.end() } catch {}
    fileConnections.delete(serverId)
  }
  fileSftps.delete(serverId)
}

// 文件连接重试:通道耗尽只重连文件连接,绝不触碰终端 shell
export async function retryFileAfterReconnect(serverId, fn) {
  try {
    return await fn()
  } catch (err) {
    if (isChannelExhaustedError(err)) {
      disconnectFile(serverId)
      await ensureFileClient(serverId)
      return fn()
    }
    throw err
  }
}

// 关键:复用单个 sftp 会话,避免每次文件操作都 client.sftp() 新开一条 SFTP 通道。
// 反复跳转目录/上传下载会不断叠加通道直到 sshd MaxSessions 耗尽,报
// "(SSH) Channel open failure: open failed"。每条文件连接只建一个 sftp、全局复用。
const fileSftps = new Map() // serverId -> sftp

export async function getFileSftp(serverId) {
  await ensureFileClient(serverId)
  let sftp = fileSftps.get(serverId)
  if (!sftp) {
    sftp = await new Promise((resolve, reject) => {
      const c = fileConnections.get(serverId)
      if (!c || c.status !== 'connected') { reject(new Error('文件连接未就绪')); return }
      c.client.sftp((e, s) => (e ? reject(e) : resolve(s)))
    })
    fileSftps.set(serverId, sftp)
    // sftp 会话关闭时清理缓存,下次重建
    sftp.on('close', () => fileSftps.delete(serverId))
    sftp.on('end', () => fileSftps.delete(serverId))
  }
  return sftp
}

// 串行化同一服务器的 shell 创建:保证"挑连接(容量判断)+放置 shell"是原子操作。
// 否则 20 个会话同时连上时,并发地在"尚未满"的同一条连接上各自放置,会超容量。
// 串行后每次创建都能看到准确的已用数,自动分摊到多条连接(必要时新开),多连接因此可靠。
const shellCreateChains = new Map() // serverId -> Promise

export function createShell(serverId, sessionId, initialDir) {
  const prev = shellCreateChains.get(serverId) || Promise.resolve()
  const run = prev
    .catch(() => {})
    .then(() => doCreateShell(serverId, sessionId, initialDir))
  // 链上记录本次(无论成败),使并发调用排队
  shellCreateChains.set(serverId, run.then(() => {}, () => {}))
  return run
}

async function doCreateShell(serverId, sessionId, initialDir) {
  // 挑一条"未满容量"的连接,必要时新开一条;返回的 entry 必可再放一个 shell
  const entry = await connect(serverId)
  const client = entry.client
  try {
    const stream = await new Promise((resolve, reject) => {
      client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, s) => {
        if (err) return reject(err)
        resolve(s)
      })
    })
    // 打上会话标记,便于会话删除时精确关闭对应 shell
    if (sessionId) stream.sessionId = sessionId
    entry.shells.add(stream)
    // 必须监听流上的 'error':ssh2 的流若 error 无人监听,Nodarman 抛出未捕获异常直接崩溃
    stream.on('error', () => { void 0 })
    stream.on('close', () => {
      entry.shells.delete(stream)
    })
    // 复制会话/指定目录:新 shell 打开后立即 cd 到目标目录
    if (initialDir) {
      const quoted = `'${String(initialDir).replace(/'/g, `'\\''`)}'`
      try { stream.write(`cd ${quoted}\r`) } catch {}
    }
    return stream
  } catch (err) {
    // 该条连接通道耗尽:丢弃这条连接(只影响它自己),换一条/新开后重试一次,不连累其他连接
    if (isChannelExhaustedError(err)) {
      removeTerminalConn(serverId, entry)
      try { entry.client.end() } catch {}
      return doCreateShell(serverId, sessionId, initialDir)
    }
    throw err
  }
}

// ========== 复制会话:保持相同路径 ==========
// 交互式 shell 的当前目录无法从逐字符的输入里可靠解析,也无法用 exec('pwd') 得到
// (exec 新通道都是从登录目录起)。所以这里直接往目标会话的 shell 注入 pwd,读取返回的
// 第一行作为该会话当前路径。被测量会话的 WS 转发会被 isMeasuringCwd 暂时屏蔽,避免
// 用户终端上闪现 pwd 及其输出。
const measuringCwd = new Set()

export function isMeasuringCwd(sessionId) {
  return !!sessionId && measuringCwd.has(sessionId)
}

// 返回某会话 shell 的当前绝对路径;拿不到(未连/未开 shell/失败)则 reject
export function captureShellCwd(serverId, sessionId) {
  const arr = terminalConns.get(serverId) || []
  if (!arr.length) {
    return Promise.reject(new Error('服务器未连接'))
  }
  let shell = null
  for (const entry of arr) {
    for (const s of entry.shells) if (s.sessionId === sessionId) { shell = s; break }
    if (shell) break
  }
  if (!shell) return Promise.reject(new Error('该会话未打开'))

  return new Promise((resolve, reject) => {
    // 用首尾唯一标记包裹 pwd;一旦收到"结束标记"(说明 pwd 及其后的提示符都已回显),
    // 立刻解析路径并结束测量 —— 屏蔽窗口从"最长 200ms+10s 兜底"压到"约一个往返",
    // 大幅减少对用户实时终端输出/回显的吞没。兜底仍保留为短超时(如吞掉也尽快恢复)。
    const tag = 'SCWD_' + sessionId + '_' + Date.now()
    const endTag = 'SCWD_END_' + tag
    measuringCwd.add(sessionId)
    let buf = ''
    let done = false
    let timer = null

    // 去掉缓冲区里的 ANSI 颜色/控制码(彩色提示符会污染行匹配)
    const stripAnsiTxt = (t) => t.replace(/\x1b\[[0-9;:<=>?]*[ -\/]*[@-~]/g, '').replace(/\x1b/g, '')
    // 清理一行路径:去掉尾部常见的提示符粘连($/#/> 等)与空白
    const cleanLine = (line) => {
      let t = line.trim()
      t = t.replace(/[\s]*[$#>].*$/, '') // 去掉跟在路径后的提示符
      return t.trim()
    }
    const pickPath = () => {
      // 从结束标记处截取,保证只解析 pwd 那段输出,不受用户此后新输入影响
      const idx = buf.indexOf(endTag)
      const seg = idx >= 0 ? buf.slice(0, idx) : buf
      const clean = stripAnsiTxt(seg)
      const line = clean.split(/\r?\n/).find(x => x.trim() && x.trim().startsWith('/'))
      return line === undefined ? null : cleanLine(line)
    }

    const cleanup = () => {
      if (done) return
      done = true
      if (timer) clearTimeout(timer)
      measuringCwd.delete(sessionId)
      shell.removeListener('data', onData)
      shell.removeListener('close', onClose)
    }
    const onData = (data) => {
      buf += data.toString()
      // 收到结束标记 → pwd 输出与随后提示符已回显,立即解析并结束
      if (buf.includes(endTag)) {
        const got = pickPath()
        cleanup()
        resolve(got || '')
      }
    }
    const onClose = () => { cleanup(); reject(new Error('会话已关闭')) }
    shell.on('data', onData)
    shell.on('close', onClose)
    // printf 先打开始标记,然后 pwd,再打结束标记(\r 促成回显缓冲 flush)
    try { shell.write(`printf '${tag}'; pwd; printf '${endTag}\r'` + '\r') } catch (err) { cleanup(); reject(err); return }
    // 兜底:慢速/高负载远端也可能拿不到标记,短超时后尽力取路径并结束测量,
    // 避免一直屏蔽转发(不再需要 10s,3s 内正常情况下早已通过标记返回)。
    timer = setTimeout(() => {
      if (!done) {
        const line = pickPath()
        cleanup()
        resolve(line || '')
      }
    }, 3000)
  })
}

// 按会话 id 关闭对应 shell(会话删除时兜底,避免 WS 外还有残留的远程 session 占着 channel)
export function destroyShell(serverId, sessionId) {
  if (!sessionId) return
  const arr = terminalConns.get(serverId) || []
  for (const entry of arr) {
    for (const stream of entry.shells) {
      if (stream.sessionId === sessionId) {
        try { stream.close() } catch {}
        entry.shells.delete(stream)
        return
      }
    }
  }
}

// 默认执行超时（秒）与输出上限（字节），防止持续输出的命令挂死进程/撑爆内存
// (归档时这两个常量的定义行丢失,按文档记载的 30s / 5MB 补回)
const DEFAULT_EXEC_TIMEOUT = 30_000
const MAX_EXEC_OUTPUT = 5 * 1024 * 1024

// client 可显式传入(如 execute 路由走独立文件连接的 client),缺省用终端连接池。
// 注意:经 HTTP /execute 的命令一律走文件连接,通道耗尽时只重连文件连接,
// 绝不能像旧的 retryAfterReconnect 那样 disconnect 整个终端连接池(会杀光所有会话)。
export function execCommand(serverId, command, { client = null, timeout = DEFAULT_EXEC_TIMEOUT, maxOutput = MAX_EXEC_OUTPUT } = {}) {
  const cli = client || getClient(serverId)
  if (!cli) throw new Error('服务器未连接')

  return new Promise((resolve, reject) => {
    cli.exec(command, (err, stream) => {
      if (err) {
        reject(err)
        return
      }

      // 用原始字节累积,末尾一次性以 UTF-8 解码;字节截断时修剪末尾残缺多字节序列,
      // 避免截断半个 UTF-8 字符产生乱码(�)。
      let stdout = Buffer.alloc(0)
      let stderrBuf = Buffer.alloc(0)
      let exitCode = null
      let timedOut = false
      let settled = false

      const decodeTrimmed = (buf) => {
        // 去掉末尾残缺的多字节 UTF-8 序列再解码。
        // 从末尾向前找"最后一个完整序列"的边界:末字节若是续字节(0x80-0xBF),
        // 它要么属于一个完整字符的尾部,要么是被截断的不完整字符的残段。
        // 从后往前数连续续字节找到序列首字节,再按首字节判断确实需要的字节数。
        let end = buf.length
        if (end > 0) {
          let start = end - 1
          while (start > 0 && (buf[start] & 0xc0) === 0x80) start--
          const b0 = buf[start]
          if ((b0 & 0xc0) === 0xc0) {
            let need = 1
            if ((b0 & 0xf8) === 0xf0) need = 4
            else if ((b0 & 0xf0) === 0xe0) need = 3
            else if ((b0 & 0xe0) === 0xc0) need = 2
            if (end - start < need) end = start // 序列不完整,裁掉残段
          }
        }
        return buf.subarray(0, end).toString('utf8')
      }

      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        let outText = decodeTrimmed(stdout)
        let errText = decodeTrimmed(stderrBuf)
        if (timedOut) {
          errText += (errText ? '\n' : '') + `[执行超时：超过 ${Math.round(timeout / 1000)} 秒，已强制终止]`
        }
        resolve({ stdout: outText, stderr: errText, code: exitCode, timedOut })
      }

      // 超时后关闭通道，让 close 事件触发 finish
      const timer = setTimeout(() => {
        timedOut = true
        try { stream.close() } catch {}
      }, timeout)

      const onData = (target, side) => (data) => {
        // 按字节上限截断,不再追加溢出部分
        if (side === 'stdout' && stdout.length < maxOutput) {
          const take = Math.min(data.length, maxOutput - stdout.length)
          stdout = Buffer.concat([stdout, data.subarray(0, take)])
        } else if (side === 'stderr' && stderrBuf.length < maxOutput) {
          const take = Math.min(data.length, maxOutput - stderrBuf.length)
          stderrBuf = Buffer.concat([stderrBuf, data.subarray(0, take)])
        }
      }

      stream.on('data', onData('stdout', 'stdout'))
      stream.stderr.on('data', onData('stderr', 'stderr'))
      stream.on('close', (code) => {
        exitCode = code === undefined ? null : code
        finish()
      })
      stream.on('error', (e) => {
        try { stderrBuf = Buffer.concat([stderrBuf, Buffer.from(`[流错误] ${e.message}`, 'utf8')]) } catch {}
        finish()
      })
    })
  })
}

export async function listDirectory(serverId, dirPath) {
  // 独立文件连接上的单个复用 sftp,不占用终端连接通道、也不叠加 SFTP 通道
  return retryFileAfterReconnect(serverId, async () => {
    const sftp = await getFileSftp(serverId)
    return new Promise((resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) {
          // SFTP 读取失败（常见于权限不足），回退用 ls 拿原始输出，并把原因告诉前端。
          // ls 走文件连接的 exec 通道,同样用 retryFileAfterReconnect 兜底通道耗尽。
          const sftpError = err
          retryFileAfterReconnect(serverId, async () => {
            const client = getFileClient(serverId)
            if (!client) throw new Error('文件连接未就绪')
            await new Promise((resolveLs, rejectLs) => {
              // 路径用单引号包裹并转义内部单引号:JSON.stringify 产生的是双引号字符串,
              // 双引号内 $/反引号会被 shell 展开,路径可注入命令;单引号内无任何展开
              const quoted = `'${String(dirPath).replace(/'/g, `'\\''`)}'`
              client.exec(`ls -la --time-style=long-iso ${quoted}`, (e, stream) => {
                if (e) { rejectLs(e); return }
                let output = ''
                stream.on('data', (data) => { output += data.toString() })
                stream.stderr.on('data', (data) => { output += data.toString() })
                stream.on('close', () => resolveLs(output))
                stream.on('error', rejectLs)
              })
            }).then((output) => {
              resolve({ raw: output, entries: [], note: `SFTP 读取失败（${sftpError.message}），已回退至 ls 输出` })
            }).catch(reject)
          })
          return
        }
        const entries = list.map(item => ({
          filename: item.filename,
          longname: item.longname,
          type: getFileType(item.attrs),
          size: item.attrs.size,
          mode: item.attrs.mode,
          mtime: item.attrs.mtime,
          isDirectory: item.attrs.isDirectory(),
          isFile: item.attrs.isFile(),
          isSymlink: item.attrs.isSymbolicLink(),
        }))
        resolve({ entries, raw: null, note: null })
      })
    })
  })
}

// 文件预览大小上限（字节）：只允许预览小文本文件，避免读入超大/二进制文件
const MAX_PREVIEW_BYTES = 512 * 1024

export async function readFileContent(serverId, filePath, maxBytes = MAX_PREVIEW_BYTES) {
  const sftp = await getFileSftp(serverId)

  return new Promise((resolve, reject) => {
    // 先拿文件大小，超限直接拒绝，避免把超大/二进制文件全部读进内存
    sftp.stat(filePath, (statErr, stat) => {
        if (statErr) { reject(statErr); return }
        if (stat.size > maxBytes) {
          reject(new Error(`文件过大（${stat.size} 字节），仅支持预览 ${maxBytes} 字节以内的文件，请下载查看`))
          return
        }
        const readStream = sftp.createReadStream(filePath)
        let content = ''
        readStream.on('data', (data) => { content += data.toString('utf8') })
        readStream.on('end', () => resolve(content))
        readStream.on('error', reject)
      })
    })
}

// ========== 上传 / 删除 ==========

// 打开远端写入流,前端把请求 body 直接 pipe 进来(内存恒定,支持大文件)
// 返回 { writeStream, sftp }:路由在上传完成后用 sftp.stat 核对远端真实大小,
// 防止 SFTP 服务器少写字节导致"静默变小的文件"(SFTP 无端到端字节核对)。
export async function createUploadStream(serverId, remotePath) {
  const sftp = await getFileSftp(serverId)

  return new Promise((resolve, reject) => {
    const writeStream = sftp.createWriteStream(remotePath)
    writeStream.on('error', reject)
    // 只 resolve 一次;写完成后由路由侧监听 close/finish
    writeStream.on('open', () => resolve({ writeStream, sftp }))
  })
}

// 递归删除(不跟随符号链接:符号链接只删链接本身),失败链式抛出
export async function deletePath(serverId, remotePath, { recursive = true } = {}) {
  const sftp = await getFileSftp(serverId)

  return new Promise((resolve, reject) => {
    removeRecursive(sftp, remotePath, recursive).then(resolve).catch(reject)
  })
}

// ========== 文件管理补齐:重命名/移动、新建目录、在线编辑保存 ==========
// 全部走独立文件连接的单个复用 sftp,与列目录/上传下载同一套自愈机制,
// 绝不占用终端连接通道。

// 重命名/移动(sftp.rename 支持同一路径空间内跨目录移动)
export async function renamePath(serverId, fromPath, toPath) {
  const sftp = await getFileSftp(serverId)
  return new Promise((resolve, reject) => {
    sftp.rename(fromPath, toPath, (err) => (err ? reject(err) : resolve(true)))
  })
}

// 新建目录(递归:逐级 mkdir,已存在的层级跳过;整个路径已存在则报错)
export async function makeDirectory(serverId, dirPath) {
  const sftp = await getFileSftp(serverId)
  const target = String(dirPath).replace(/\/+$/, '')
  // 已存在(文件或目录)直接报错,避免静默覆盖语义
  const exists = await new Promise((resolve) => {
    sftp.stat(target, (err, st) => resolve(!err && !!st))
  })
  if (exists) throw new Error('已存在同名文件或目录')
  const parts = target.split('/').filter(Boolean)
  let cur = ''
  for (const part of parts) {
    cur += '/' + part
    await new Promise((resolve, reject) => {
      sftp.mkdir(cur, (err) => {
        // SSH_FX_FAILURE(4)常见于"目录已存在",逐级创建时忽略;其余(权限等)报错
        if (err && err.code !== 4) return reject(err)
        resolve()
      })
    })
  }
  return true
}

// 写入文件全部内容(在线编辑保存):一次性 end 缓冲,复用预览的 512KB 上限,
// 由路由层校验大小后调用
export async function writeFileContent(serverId, filePath, content) {
  const sftp = await getFileSftp(serverId)
  const buf = Buffer.from(String(content), 'utf8')
  return new Promise((resolve, reject) => {
    const ws = sftp.createWriteStream(filePath)
    ws.on('error', reject)
    ws.on('close', () => resolve(true))
    ws.end(buf)
  })
}

function removeRecursive(sftp, target, recursive) {
  return new Promise((resolve, reject) => {
    sftp.stat(target, (statErr, stat) => {
      if (statErr) { reject(statErr); return }
      if (!stat.isDirectory()) {
        // 文件或符号链接:直接 unlink(链接本身)
        sftp.unlink(target, (uErr) => uErr ? reject(uErr) : resolve(true))
        return
      }
      if (!recursive) {
        reject(new Error('目录非空,请先清空内容(或使用递归删除)'))
        return
      }
      sftp.readdir(target, (rErr, list) => {
        if (rErr) { reject(rErr); return }
        const children = (list || []).map(item => `${target.replace(/\/+$/, '')}/${item.filename}`)
        const chain = children.reduce(
          (p, child) => p.then(() => removeRecursive(sftp, child, recursive)),
          Promise.resolve()
        )
        chain
          .then(() => sftp.rmdir(target, (mErr) => mErr ? reject(mErr) : resolve(true)))
          .catch(reject)
      })
    })
  })
}

function getFileType(attrs) {
  if (attrs.isDirectory()) return 'directory'
  if (attrs.isFile()) return 'file'
  if (attrs.isSymbolicLink()) return 'symlink'
  return 'other'
}

// 兼容导出:终端连接池(index.js 虽导入但未直接使用,shape 变化不影响)
export const connections = terminalConns
