import express from 'express'
import cors from 'cors'
import { WebSocketServer } from 'ws'
import http from 'http'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import {
  readServers, writeServers, readCommands, writeCommands,
  readSessions, writeSessions, readBookmarks, writeBookmarks,
  mutateServers, mutateSessions, mutateBookmarks, mutateCommands,
  connect, disconnect, getConnectionStatus, getClient,
  createShell, execCommand, listDirectory, readFileContent,
  createUploadStream, deletePath, renamePath, makeDirectory, writeFileContent,
  connections, retryAfterReconnect, destroyShell,
  captureShellCwd, isMeasuringCwd,
  ensureFileClient, getFileClient, getFileSftp, retryFileAfterReconnect, disconnectFile,
} from './ssh-manager.js'
import {
  readLocalDirs, writeLocalDirs, mutateLocalDirs, createLocalShell, getLocalShell,
  destroyLocalShell, resizeLocalShell, getDefaultLocalDir, browseDirectory,
  hdcFileSend, hdcFileRecv, hdcFileList, hdcListTargets, getDeviceState, connectDevice, disconnectDevice,
  getTransferState, saveTransferState, openLocalDir,
} from './local-exec.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server })

// ========== 全局进程级护栏:绝不让任何未捕获错误把整个应用干掉 ==========
// 桌面/服务进程里,单个库或边缘错误(如 node-pty 的 AttachConsole、ssh2 流的异常、
// async 竞态)不应导致整机退出。这里记录而非退出;记录带时间与堆栈以便事后定位,
// 同时保证已有会话/进程继续正常运行。
process.on('uncaughtException', (err) => {
  console.error('[crash-guard::uncaughtException]', new Date().toISOString(), err && err.stack ? err.stack : err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[crash-guard::unhandledRejection]', new Date().toISOString(), reason && reason.stack ? reason.stack : reason)
})

// CORS:默认同源(不开 cors 中间件,浏览器同源请求本就无需 CORS;开发期 Vite 代理 /
// Electron 同源加载也不受影响)。设置 SERVERHUB_CORS_ORIGIN(逗号分隔)则收敛为白名单。
const corsOrigins = (process.env.SERVERHUB_CORS_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean)
if (corsOrigins.length) {
  app.use(cors({ origin: corsOrigins }))
}

// 可选访问令牌:设置 SERVERHUB_TOKEN 后,REST 需带 X-ServerHub-Token 头(或 ?token=),
// WS 需带 token query;未设置则完全维持现状(本地/内网定位)。静态页面不校验,
// 否则连界面都进不去。前端通过 URL ?token=xxx 首次带入并存 localStorage,之后自动附加。
const ACCESS_TOKEN = process.env.SERVERHUB_TOKEN || ''
function isAuthorized(req) {
  if (!ACCESS_TOKEN) return true
  const header = req.headers['x-serverhub-token']
  if (header && header === ACCESS_TOKEN) return true
  const q = new URL(req.url || '/', 'http://localhost').searchParams.get('token')
  return q === ACCESS_TOKEN
}
app.use('/api', (req, res, next) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: '未授权:缺少或错误的访问令牌' })
  next()
})

// 上传接口走原始请求体流式写入,绝不能先被 express.json() 之类的 body 中间件消费掉。
// 否则上传 Content-Type 为 application/json 的文件(如 .json)时,json 解析器会把请求体
// 读空,导致下拉到文件的 req 流已耗尽,最终远端落盘 0 字节。故凡路径含 /files/upload 的
// 请求一律跳过 json 解析,让原始 body 原样流向 SFTP 写入流。
const jsonParser = express.json()
app.use((req, res, next) => {
  if (req.originalUrl.includes('/files/upload')) return next()
  return jsonParser(req, res, next)
})

// 复制会话时记录"新会话打开后要 cd 到的目录",供其 WS 连上建 shell 时使用
const pendingInitialDir = new Map() // sessionId -> 绝对路径

// 每台服务器会话上限(与前端 types.ts 的 MAX_SESSIONS_PER_SERVER 保持一致),
// 后端强制校验,避免绕过前端直连 API 无限建会话撑爆 sshd。
const MAX_SESSIONS_PER_SERVER = 20

// id 后缀:时间戳 + 随机段,避免同一毫秒并发创建(如批量建会话)时 id 碰撞
function genIdSuffix() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// ========== 静态文件 (有 dist 目录时自动服务) ==========
const distDir = path.join(__dirname, '..', 'dist')
const hasDist = fs.existsSync(distDir)
if (hasDist) {
  app.use(express.static(distDir))
}

// ========== 服务器管理 API ==========
app.get('/api/servers', (req, res) => {
  const servers = readServers()
  // 密码明文存储并明文返回(本地/内网工具定位,刻意设计——按要求不加密不掩码;
  // 需要暴露面收敛时用 SERVERHUB_TOKEN 访问令牌)
  res.json(servers)
})

app.post('/api/servers', async (req, res) => {
  const { name, host, port, username, password } = req.body
  if (!host || !username) {
    return res.status(400).json({ error: '缺少必填字段' })
  }
  const newServer = {
    id: `srv-${genIdSuffix()}`,
    name: name || `${host}`,
    host,
    port: port || 22,
    username,
    password: password || '',
    createdAt: new Date().toISOString(),
  }
  await mutateServers(list => { list.push(newServer); return list })
  res.status(201).json(newServer)
})

app.put('/api/servers/:id', async (req, res) => {
  const { id } = req.params
  const { name, host, port, username, password } = req.body
  try {
    await mutateServers(list => {
      const idx = list.findIndex(s => s.id === id)
      if (idx === -1) throw Object.assign(new Error('服务器不存在'), { statusCode: 404 })
      const u = { ...list[idx] }
      if (name !== undefined) u.name = name
      if (host !== undefined) u.host = host
      if (port !== undefined) u.port = port
      if (username !== undefined) u.username = username
      // 密码明文直接写入(本地/内网工具,刻意设计)
      if (password !== undefined) u.password = password
      list[idx] = u
      return list
    })
    const updated = readServers().find(x => x.id === id)
    res.json(updated)
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message })
  }
})

app.delete('/api/servers/:id', async (req, res) => {
  const { id } = req.params
  disconnect(id)
  disconnectFile(id) // 文件连接一并断开,避免残留
  await mutateServers(list => list.filter(s => s.id !== id))
  // 同时清理该服务器的会话记录与路径收藏(功能文档声明的行为;不清理会持续累积孤儿数据)
  await mutateSessions(list => list.filter(s => {
    if (s.serverId === id) { pendingInitialDir.delete(s.id); return false } // 待注入目录一并清理,防泄漏
    return true
  }))
  await mutateBookmarks(list => list.filter(b => b.serverId !== id))
  res.json({ success: true })
})

app.get('/api/servers/status', (req, res) => {
  const servers = readServers()
  const statusMap = {}
  for (const s of servers) {
    statusMap[s.id] = getConnectionStatus(s.id)
  }
  res.json(statusMap)
})

app.get('/api/servers/:id/status', (req, res) => {
  const status = getConnectionStatus(req.params.id)
  res.json({ status })
})

app.post('/api/servers/:id/connect', async (req, res) => {
  try {
    await connect(req.params.id)
    res.json({ status: 'connected' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/servers/:id/disconnect', (req, res) => {
  disconnect(req.params.id)
  res.json({ status: 'disconnected' })
})

app.post('/api/servers/:id/execute', async (req, res) => {
  try {
    const { command } = req.body
    if (!command) return res.status(400).json({ error: '缺少 command 参数' })

    // exec 一律走独立文件连接(与 SFTP 一致):通道耗尽时 retryFileAfterReconnect
    // 只重连文件连接。旧实现用终端侧 retryAfterReconnect,耗尽时会 disconnect 整个
    // 终端连接池,把该服务器所有会话一起杀掉 —— 与"文件操作绝不牵连终端"的设计矛盾。
    await ensureFileClient(req.params.id)
    const client = getFileClient(req.params.id)
    const result = await retryFileAfterReconnect(req.params.id, () => execCommand(req.params.id, command, { client }))
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ========== 文件浏览 API ==========
app.get('/api/servers/:id/files', async (req, res) => {
  try {
    const dirPath = req.query.path || '~'
    // 文件列目录走独立文件连接,避免占用终端连接通道、也绝不触发终端 disconnect
    await ensureFileClient(req.params.id)
    const result = await retryFileAfterReconnect(req.params.id, () => listDirectory(req.params.id, dirPath))
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.get('/api/servers/:id/files/content', async (req, res) => {
  try {
    const filePath = req.query.path
    if (!filePath) return res.status(400).json({ error: '缺少 path 参数' })
    await ensureFileClient(req.params.id)
    const content = await retryFileAfterReconnect(req.params.id, () => readFileContent(req.params.id, filePath))
    res.json({ content })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
// 流式下载远程文件，避免二进制内容经 JSON/字符串传输被损坏
app.get('/api/servers/:id/files/download', async (req, res) => {
  const filePath = req.query.path
  if (!filePath) return res.status(400).json({ error: '缺少 path 参数' })
  try {
    // 走独立文件连接(ensureFileClient+getFileSftp),复用单个 sftp 会话并带通道耗尽自愈,
    // 绝不占用终端连接通道,也不触发终端 disconnect —— 与列目录/读文件保持一致。
    await ensureFileClient(req.params.id)
    const sftp = await retryFileAfterReconnect(req.params.id, () => getFileSftp(req.params.id))
    const fileName = decodeURIComponent(filePath).split('/').filter(Boolean).pop() || 'file'
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    // 先取文件大小,成功则设置 Content-Length 以便前端显示下载进度;
    // 取不到(权限等)就流式传输,进度显示"…"
    sftp.stat(decodeURIComponent(filePath), (statErr, stat) => {
      if (!statErr && stat && stat.size != null) {
        try { res.setHeader('Content-Length', String(stat.size)) } catch {}
      }
      const rs = sftp.createReadStream(decodeURIComponent(filePath))
      rs.on('error', (e) => {
        if (!res.headersSent) res.status(500).json({ error: e.message })
        res.destroy()
      })
      rs.pipe(res)
    })
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})
// local-to-remote:本机(Windows)文件 → 远端目录(与 remote-to-local 对称,双面板拖拽上传用)。
// 归档时该路由的声明与参数解析行丢失,此处按 remote-to-local 的对称结构补回:
// 本机 fs 读流直接 pipe 到独立文件连接的 SFTP 写流(恒定内存,支持大文件)。
app.post('/api/servers/:id/files/local-to-remote', async (req, res) => {
  const { localPath, remoteDir } = req.body || {}
  if (!localPath || !remoteDir) return res.status(400).json({ error: '缺少 localPath/remoteDir' })
  const name = String(localPath).split(/[\\/]/).filter(Boolean).pop()
  if (!name) return res.status(500).json({ error: '无效的本地路径' })
  const remotePath = `${String(remoteDir).replace(/\/+$/, '')}/${name}`
  const { createReadStream } = await import('fs')
  try {
    await ensureFileClient(req.params.id) // 独立文件连接,不占用终端连接的通道
    const { writeStream } = await retryFileAfterReconnect(req.params.id, () => createUploadStream(req.params.id, remotePath))
    const rs = createReadStream(String(localPath))
    rs.on('error', (e) => { res.status(500).json({ error: `读取本地文件失败: ${e.message}` }) })
    rs.pipe(writeStream)
    await new Promise((resolve, reject) => {
      writeStream.on('close', () => resolve())
      writeStream.on('error', (e) => reject(e))
    })
    res.json({ success: true })
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

// remote-to-local:SFTP 读远端文件 → 本机 fs 写本地目录
// 打开 SFTP 读流用 retryAfterReconnect 包裹:多次拖拽传输会把单条 SSH 连接上的
// session/channel 用完(sshd MaxSessions),出现 "(SSH) channel open failure" 时自动
// 重连再试。createWriteStream 默认 'w' 标志即覆盖已存在的同名本地文件。
app.post('/api/servers/:id/files/remote-to-local', async (req, res) => {
  const { remotePath, localDir } = req.body || {}
  if (!remotePath || !localDir) return res.status(400).json({ error: '缺少 remotePath/localDir' })
  const { createWriteStream, mkdirSync, existsSync } = await import('fs')
  const name = String(remotePath).split('/').filter(Boolean).pop()
  if (!name) return res.status(500).json({ error: '无效的远端路径' })
  // path.join 按平台拼分隔符(旧实现硬编码 \\,后端跑在 Linux/macOS 上会拼出错误路径)
  const localPath = path.join(String(localDir), name)
  try {
    await ensureFileClient(req.params.id) // 独立文件连接,不占用终端连接通道
    if (!existsSync(String(localDir))) mkdirSync(String(localDir), { recursive: true })
    // 在独立文件连接上复用同一个 sftp 读流;通道耗尽只重连文件连接,绝不动终端 shell
    const rs = await retryFileAfterReconnect(req.params.id, async () => {
      const s = await getFileSftp(req.params.id)
      return s.createReadStream(String(remotePath))
    })
    const ws = createWriteStream(localPath) // 默认 'w',覆盖已存在文件
    rs.on('error', (e) => { if (!res.headersSent) res.status(500).json({ error: `读取远端失败: ${e.message}` }) })
    ws.on('error', (e) => { if (!res.headersSent) res.status(500).json({ error: `写本地失败: ${e.message}` }) })
    rs.pipe(ws)
    await new Promise((resolve, reject) => {
      ws.on('close', () => resolve())
      ws.on('error', (e) => reject(e))
    })
    res.json({ success: true, savePath: localPath })
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

// ========== 上传 / 删除 API ==========
// 上传:请求 body 直接流式写入远端(内存恒定,支持大文件),零新依赖
app.post('/api/servers/:id/files/upload', async (req, res) => {
  const dir = String(req.query.path || '').trim()
  const name = String(req.query.name || '').split('/').pop().split('\\').pop()
  if (!dir || !name) return res.status(400).json({ error: '缺少 path/name 参数' })
  // 远端 SFTP 不认 ~;带 ~ 的目录必须由前端先解析成绝对路径(旧实现 replace(/~.*/)
  // 会把路径中段的 ~ 之后整段截断,导致文件落到错误目录)
  if (dir.startsWith('~')) return res.status(400).json({ error: '上传目录必须是绝对路径(不支持 ~)' })
  const remotePath = `${dir.replace(/\/+$/, '')}/${name}`

  try {
    // 上传走独立文件连接,不依赖终端连接;ensureFileClient 会建/复用文件连接
    await ensureFileClient(req.params.id)
    const { writeStream, sftp } = await retryFileAfterReconnect(req.params.id, () => createUploadStream(req.params.id, remotePath))
    // 客户端报的头里的字节数;缺失(如分块传输)时为 null
    const expected = req.headers['content-length'] ? Number(req.headers['content-length']) : null

    // SFTP 没有端到端字节核对,ssh2 的 WriteStream 在 Node 18+ 上 'finish' 不可靠,
    // 只能以 'close'(远端句柄已关闭)为完成信号。真正的完整性校验是写入完成后
    // 用 sftp.stat 核对远端真实大小与 Content-Length:若服务器少写了字节,文件就会
    // "静默变小",此时必须删除半成品并报错,而不是悄悄返回成功。
    await new Promise((resolve, reject) => {
      const fail = (e) => { try { writeStream.destroy() } catch {}; reject(e) }
      req.on('error', fail)
      writeStream.on('error', fail)
      req.on('end', () => writeStream.end())
      writeStream.on('close', async () => {
        try {
          const { size } = await new Promise((res2, rej2) => {
            sftp.stat(remotePath, (statErr, stat) => statErr ? rej2(statErr) : res2(stat))
          })
          if (expected !== null && size !== expected) {
            reject(new Error(`上传不完整:远端 ${size} 字节,预期 ${expected} 字节,可能被服务器截断`))
            return
          }
          resolve()
        } catch (statErr) {
          reject(new Error(`无法校验上传结果: ${statErr.message}`))
        }
      })
      req.pipe(writeStream)
    })

    res.status(201).json({ success: true, name, path: remotePath })
  } catch (err) {
    // 传输失败/截断:清理远端残留的半成品,再返回错误
    try { await deletePath(req.params.id, remotePath) } catch {}
    if (!res.headersSent) res.status(500).json({ error: err.message })
    else res.end()
  }
})

// 删除文件/目录(目录默认递归;前端已二次确认)
app.delete('/api/servers/:id/files', async (req, res) => {
  const filePath = req.query.path
  if (!filePath) return res.status(400).json({ error: '缺少 path 参数' })
  try {
    // 删除走独立文件连接,不依赖终端连接
    await ensureFileClient(req.params.id)
    const recursive = req.query.recursive !== 'false'
    const result = await retryFileAfterReconnect(req.params.id, () => deletePath(req.params.id, decodeURIComponent(filePath), { recursive }))
    res.json({ success: true, result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ========== 文件管理补齐:重命名/移动、新建目录、编辑保存、递归搜索 ==========
// 全部走独立文件连接(ensureFileClient + retryFileAfterReconnect),不占用终端通道。

// 重命名/移动:body { path, newPath }(newPath 为完整目标路径,跨目录即移动)
app.post('/api/servers/:id/files/rename', async (req, res) => {
  const { path: from, newPath } = req.body || {}
  if (!from || !newPath) return res.status(400).json({ error: '缺少 path/newPath' })
  try {
    await ensureFileClient(req.params.id)
    await retryFileAfterReconnect(req.params.id, () => renamePath(req.params.id, String(from), String(newPath)))
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 新建目录:body { path }(完整目录路径,递归创建,已存在报错)
app.post('/api/servers/:id/files/mkdir', async (req, res) => {
  const { path: dir } = req.body || {}
  if (!dir) return res.status(400).json({ error: '缺少 path' })
  try {
    await ensureFileClient(req.params.id)
    await retryFileAfterReconnect(req.params.id, () => makeDirectory(req.params.id, String(dir)))
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 在线编辑保存:body { path, content }。复用预览的 512KB 上限——超过的文件
// 本就不该在线编辑;写入前后各核一次大小,防止编辑期间远端被替换成大文件。
app.put('/api/servers/:id/files/content', async (req, res) => {
  const { path: file, content } = req.body || {}
  if (!file || content === undefined) return res.status(400).json({ error: '缺少 path/content' })
  const text = String(content)
  if (Buffer.byteLength(text, 'utf8') > 512 * 1024) {
    return res.status(400).json({ error: '内容超过 512KB 上限,请下载后本地编辑' })
  }
  try {
    await ensureFileClient(req.params.id)
    const sftp = await retryFileAfterReconnect(req.params.id, () => getFileSftp(req.params.id))
    // 已存在的文件:校验类型与大小;不存在的视为新建(父目录必须已在)
    const stat = await new Promise((resolve, reject) => {
      sftp.stat(String(file), (e, st) => {
        if (e) {
          // SSH_FX_NO_SUCH_FILE(2):新建文件,放行
          if (e.code === 2) return resolve(null)
          return reject(e)
        }
        resolve(st)
      })
    })
    if (stat) {
      if (!stat.isFile()) return res.status(400).json({ error: '只能编辑普通文件' })
      if (stat.size > 512 * 1024) return res.status(400).json({ error: '文件超过 512KB 上限,请下载后本地编辑' })
    }
    await retryFileAfterReconnect(req.params.id, () => writeFileContent(req.params.id, String(file), text))
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// 递归搜索:find 走文件连接的 exec 通道(单引号转义防注入),输出受 exec 的
// 5MB/超时上限约束;条数截到 2000 条,防止把前端列表撑爆。
app.get('/api/servers/:id/files/search', async (req, res) => {
  const base = req.query.path
  const q = req.query.q
  if (!base || !q) return res.status(400).json({ error: '缺少 path/q 参数' })
  try {
    await ensureFileClient(req.params.id)
    const client = getFileClient(req.params.id)
    if (!client) throw new Error('文件连接未就绪')
    const depth = Math.max(1, Math.min(Number(req.query.maxdepth) || 5, 10))
    const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
    const cmd = `find ${shq(String(base))} -maxdepth ${depth} -iname ${shq('*' + String(q) + '*')} 2>/dev/null | head -n 2001`
    const result = await retryFileAfterReconnect(req.params.id, () => execCommand(req.params.id, cmd, { client, timeout: 20000 }))
    const lines = String(result.stdout || '').split('\n').filter(Boolean)
    const truncated = lines.length > 2000 || result.timedOut
    res.json({ results: lines.slice(0, 2000), truncated, timedOut: result.timedOut })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ========== 收藏夹 API(每服务器路径收藏,持久化) ==========
app.get('/api/servers/:id/bookmarks', (req, res) => {
  const bookmarks = readBookmarks().filter(b => b.serverId === req.params.id)
  res.json(bookmarks)
})

app.post('/api/servers/:id/bookmarks', async (req, res) => {
  const serverId = req.params.id
  if (!req.body || !req.body.path) return res.status(400).json({ error: '缺少 path 参数' })
  const path = String(req.body.path)
  const mkName = () => String(req.body.name || '').trim() || path.split('/').filter(Boolean).pop() || path
  const bk = {
    id: `bm-${genIdSuffix()}`,
    serverId,
    path,
    name: mkName(),
    createdAt: new Date().toISOString(),
  }
  // 去重:同一服务器同一路径只留一个(事务内判定,防并发重复)
  const saved = await mutateBookmarks(list => {
    const existing = list.find(b => b.serverId === serverId && b.path === path)
    return existing ? list : (list.push(bk), list)
  }).then(list => list.find(b => b.serverId === serverId && b.path === path))
  res.status(saved.id === bk.id ? 201 : 200).json(saved)
})

app.delete('/api/servers/:id/bookmarks/:bid', async (req, res) => {
  const { id, bid } = req.params
  await mutateBookmarks(list => list.filter(b => !(b.id === bid && b.serverId === id)))
  res.json({ success: true })
})

// ========== 命令预设 API ==========
// 公共命令 = serverId 缺省 / null / 'common'
function isCommonCommand(c) {
  // 公共命令:无 serverId 且非本地终端命令(scope 缺省/undefined = 远程命令集)
  return !c.serverId && c.scope !== 'local'
}

// 命令按 scope 分为两套互不共享:远程命令集(缺省/'server')与本地终端命令集('local')
app.get('/api/commands', (req, res) => {
  let commands = readCommands()
  // ?scope=local / ?local=1:只返回本地终端命令
  if (req.query.local === '1' || req.query.scope === 'local') {
    return res.json(commands.filter(c => c.scope === 'local'))
  }
  // 远程命令集:排除本地命令
  commands = commands.filter(c => c.scope !== 'local')
  // ?serverId= 只返回公共 + 该服务器专属;不带参数返回全部远程命令(管理用)
  const serverId = req.query.serverId
  if (serverId) {
    commands = commands.filter(c => isCommonCommand(c) || c.serverId === serverId)
  }
  res.json(commands)
})

app.post('/api/commands', async (req, res) => {
  const { name, command, category, description } = req.body
  if (!name || !command) return res.status(400).json({ error: '缺少必填字段' })
  const newCmd = {
    id: `cmd-${genIdSuffix()}`,
    name,
    command,
    category: category || 'custom',
    description: description || '',
  }
  // 归属:serverId 缺省/空/'common' 视为公共(不写该字段),否则写专属服务器
  if (req.body.serverId && req.body.serverId !== 'common') {
    newCmd.serverId = req.body.serverId
  }
  // 命令集:scope='local' 为本地终端命令(远程命令集缺省/不写)
  if (req.body.scope === 'local') newCmd.scope = 'local'
  // 执行方式:false=手动(仅敲入命令,用户按回车执行);缺省/true=直接执行
  if (req.body.autoRun !== undefined) newCmd.autoRun = !!req.body.autoRun
  await mutateCommands(list => { list.push(newCmd); return list })
  res.status(201).json(newCmd)
})

app.put('/api/commands/:id', async (req, res) => {
  const { id } = req.params
  const { name, command, category, description } = req.body
  try {
    const updated = await mutateCommands(list => {
      const idx = list.findIndex(c => c.id === id)
      if (idx === -1) throw Object.assign(new Error('命令不存在'), { statusCode: 404 })
      if (name !== undefined) list[idx].name = name
      if (command !== undefined) list[idx].command = command
      if (category !== undefined) list[idx].category = category
      if (description !== undefined) list[idx].description = description
      if (req.body.autoRun !== undefined) list[idx].autoRun = !!req.body.autoRun
      // 命令集:scope='local' 为本地终端命令;缺省/删除时清理成远程命令集
      if (req.body.scope !== undefined) {
        if (req.body.scope === 'local') list[idx].scope = 'local'
        else delete list[idx].scope
      }
      // 归属:serverId 缺省/null/'common' → 公共(不写该字段,以便旧数据兼容)
      if (req.body.serverId !== undefined) {
        if (req.body.serverId && req.body.serverId !== 'common') {
          list[idx].serverId = req.body.serverId
        } else {
          delete list[idx].serverId
        }
      }
      return list
    }).then(list => list.find(c => c.id === id))
    res.json(updated)
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message })
  }
})

app.delete('/api/commands/:id', async (req, res) => {
  await mutateCommands(list => list.filter(c => c.id !== req.params.id))
  res.json({ success: true })
})

// 调整命令顺序:按传入的 ids 顺序重排整份命令数组(用于同命令集内拖拽排序)
app.post('/api/commands/order', async (req, res) => {
  const { ids } = req.body
  if (!Array.isArray(ids)) return res.status(400).json({ error: '缺少 ids' })
  const result = await mutateCommands(list => {
    const byId = new Map(list.map(c => [c.id, c]))
    const used = new Set()
    const out = []
    for (const id of ids) {
      if (byId.has(id) && !used.has(id)) { out.push(byId.get(id)); used.add(id) }
    }
    // 未出现在 ids 里的命令保持原有相对顺序,附加到末尾
    for (const c of list) if (!used.has(c.id)) out.push(c)
    return out
  })
  res.json(result)
})

// 覆盖导入命令:整体替换命令列表(用于从 .txt 导回)
app.post('/api/commands/import', async (req, res) => {
  const list = Array.isArray(req.body) ? req.body : (Array.isArray(req.body && req.body.commands) ? req.body.commands : null)
  if (!list) return res.status(400).json({ error: '格式不正确:需要命令数组' })
  const now = Date.now()
  const normalized = list.map((c, i) => {
    const { name, command, category, description, serverId, autoRun, scope } = c || {}
    return {
      id: (c && c.id) ? String(c.id) : `cmd-${now}-${i}`,
      name: String(name ?? ''),
      command: String(command ?? ''),
      category: category ? String(category) : 'custom',
      description: description ? String(description) : '',
      ...(scope === 'local' ? { scope: 'local' } : {}),
      ...(serverId && serverId !== 'common' ? { serverId: String(serverId) } : {}),
      ...(autoRun !== undefined ? { autoRun: !!autoRun } : {}),
    }
  })
  // 非法条目(缺名称或命令)直接滤掉,避免导入后全是空命令
  const valid = normalized.filter(c => c.name && c.command)
  await mutateCommands(() => valid)
  res.json({ success: true, count: valid.length })
})

// ========== 会话 API(每个服务器的终端标签;仅持久化名称) ==========
app.get('/api/servers/:id/sessions', (req, res) => {
  const sessions = readSessions().filter(s => s.serverId === req.params.id)
  res.json(sessions)
})

app.post('/api/servers/:id/sessions', async (req, res) => {
  const serverId = req.params.id
  // 校验服务器存在
  if (!readServers().find(s => s.id === serverId)) {
    return res.status(404).json({ error: '服务器不存在' })
  }
  try {
    // 上限校验放进同一事务:并发创建时不会两个请求都读到"19 条"而双双通过。
    // mutator 的返回值即落盘内容,必须是数组;新会话对象经闭包带出
    let newSession = null
    await mutateSessions(list => {
      const serverSessions = list.filter(s => s.serverId === serverId)
      if (serverSessions.length >= MAX_SESSIONS_PER_SERVER) {
        throw Object.assign(new Error(`每台服务器最多 ${MAX_SESSIONS_PER_SERVER} 个会话(${MAX_SESSIONS_PER_SERVER} 个),请先关闭部分会话`), { statusCode: 400 })
      }
      newSession = {
        id: `ses-${genIdSuffix()}`,
        serverId,
        name: req.body.name || `会话 ${serverSessions.length + 1}`,
        createdAt: new Date().toISOString(),
      }
      list.push(newSession)
      return list
    })
    // 可选 dir:在指定目录打开远程会话(文件界面「在当前目录打开会话」)
    // 复用 duplicate 的初始终端目录机制 → 该会话 WS 建 shell 后自动 cd 到 dir
    if (req.body.dir && newSession) pendingInitialDir.set(newSession.id, req.body.dir)
    res.status(201).json(newSession)
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message })
  }
})

app.put('/api/servers/:id/sessions/:sessionId', async (req, res) => {
  const { id, sessionId } = req.params
  try {
    const updated = await mutateSessions(list => {
      const idx = list.findIndex(s => s.id === sessionId && s.serverId === id)
      if (idx === -1) throw Object.assign(new Error('会话不存在'), { statusCode: 404 })
      if (req.body.name !== undefined) list[idx].name = req.body.name
      return list
    }).then(list => list.find(x => x.id === sessionId))
    res.json(updated)
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message })
  }
})

app.delete('/api/servers/:id/sessions/:sessionId', async (req, res) => {
  const { id, sessionId } = req.params
  // 关闭可能仍在线的对应 shell,释放远端 session
  destroyShell(id, sessionId)
  pendingInitialDir.delete(sessionId) // 会话从未连 WS 时清掉待注入目录,防泄漏
  await mutateSessions(list => list.filter(s => !(s.id === sessionId && s.serverId === id)))
  res.json({ success: true })
})

// 调整会话顺序:按传入的该服务器 ids 顺序重排该服务器会话(用于同服务器会话拖拽排序)
app.post('/api/servers/:id/sessions/order', async (req, res) => {
  const serverId = req.params.id
  const { ids } = req.body
  if (!Array.isArray(ids)) return res.status(400).json({ error: '缺少 ids' })
  let reordered = null
  await mutateSessions(list => {
    const serverSessions = list.filter(s => s.serverId === serverId)
    const byId = new Map(serverSessions.map(s => [s.id, s]))
    const used = new Set()
    const ro = []
    for (const id of ids) {
      if (byId.has(id) && !used.has(id)) { ro.push(byId.get(id)); used.add(id) }
    }
    for (const s of serverSessions) if (!used.has(s.id)) ro.push(s)
    // 重建整份数组:该服务器的会话按新顺序,其他服务器的会话保持原有位置
    const result = []
    let inserted = false
    for (const s of list) {
      if (s.serverId === serverId) {
        if (!inserted) { result.push(...ro); inserted = true }
      } else {
        result.push(s)
      }
    }
    if (!inserted) result.push(...ro)
    reordered = ro // 闭包带出响应用的新顺序
    return result // 落盘的必须是数组
  })
  res.json(reordered)
})

// 复制会话:新会话沿用原名称,并尽量保持相同的当前工作目录
app.post('/api/servers/:id/sessions/:sessionId/duplicate', async (req, res) => {
  const { id, sessionId } = req.params
  const orig = readSessions().find(s => s.id === sessionId && s.serverId === id)
  if (!orig) return res.status(404).json({ error: '会话不存在' })

  // 确保已连接(复制会话需要操作已有 shell)
  if (!getClient(id)) {
    try { await connect(id) } catch (err) { return res.status(500).json({ error: `连接失败: ${err.message}` }) }
  }

  // 读取原会话当前目录;拿不到(未打开/失败)则新会话落到默认登录目录
  let cwd = null
  try { cwd = await captureShellCwd(id, sessionId) } catch { cwd = null }

  // 上限校验入事务(并发复制/创建不会双双通过);新会话对象经闭包带出
  try {
    let newSession = null
    await mutateSessions(list => {
      if (list.filter(s => s.serverId === id).length >= MAX_SESSIONS_PER_SERVER) {
        throw Object.assign(new Error(`每台服务器最多 ${MAX_SESSIONS_PER_SERVER} 个会话,请先关闭部分会话`), { statusCode: 400 })
      }
      newSession = {
        id: `ses-${genIdSuffix()}`,
        serverId: id,
        // 名称与原会话保持一致
        name: orig.name,
        createdAt: new Date().toISOString(),
      }
      list.push(newSession)
      return list
    })
    if (cwd && newSession) pendingInitialDir.set(newSession.id, cwd)
    res.status(201).json(newSession)
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message })
  }
})

// 获取某会话 shell 的当前工作目录(文件界面「在当前目录打开文件」用)
app.get('/api/servers/:id/sessions/:sessionId/cwd', async (req, res) => {
  const { id, sessionId } = req.params
  try {
    const cwd = await captureShellCwd(id, sessionId)
    res.json({ cwd })
  } catch (err) {
    res.status(400).json({ error: (err && err.message) || '无法获取当前目录' })
  }
})

// ========== 本地终端 API(本机目录/收藏) ==========
// 本机目录浏览:path 为空返回盘符列表
app.get('/api/local/browse', (req, res) => {
  const dir = req.query.path ? String(req.query.path) : null
  res.json(browseDirectory(dir))
})

// 用 Windows 资源管理器打开一个本地目录
app.post('/api/local/open-dir', async (req, res) => {
  res.json(await openLocalDir((req.body || {}).path))
})

// 本机默认目录(收藏里最近一个,否则用户主目录)
app.get('/api/local/default-dir', (req, res) => {
  res.json({ path: getDefaultLocalDir() })
})

// 本地目录收藏
app.get('/api/local/favorites', (req, res) => {
  res.json(readLocalDirs())
})

app.post('/api/local/favorites', async (req, res) => {
  const p = String((req.body && req.body.path) || '').trim()
  if (!p) return res.status(400).json({ error: '缺少 path' })
  const fav = { id: `lfd-${genIdSuffix()}`, path: p, name: (req.body && req.body.name) || p }
  // 去重判定入事务,防并发重复收藏
  const saved = await mutateLocalDirs(list => {
    const existing = list.find((f) => f.path === p)
    return existing ? list : (list.push(fav), list)
  }).then(list => list.find((f) => f.path === p))
  res.status(saved.id === fav.id ? 201 : 200).json(saved)
})

app.delete('/api/local/favorites/:id', async (req, res) => {
  await mutateLocalDirs(list => list.filter((f) => f.id !== req.params.id))
  res.json({ success: true })
})

// ---------- hdc 设备文件传输 ----------
// 记住上一次使用的设备目录/本地目录
app.get('/api/local/transfer-state', (req, res) => {
  res.json(getTransferState())
})

app.post('/api/local/transfer-state', (req, res) => {
  saveTransferState(req.body || {})
  res.json(getTransferState())
})

// 上传:本地文件 → 设备。body { localPath, devicePath, serial? }
app.post('/api/local/hdc-send', async (req, res) => {
  const { localPath, devicePath, serial } = req.body || {}
  if (!localPath || !devicePath) return res.status(400).json({ error: '缺少 localPath/devicePath' })
  saveTransferState({ devicePath })
  // 大文件传输放宽到 30 分钟(runHostCommand 默认 60s 会把慢速传输中途杀掉)
  const r = await hdcFileSend(String(localPath), String(devicePath), serial, 30 * 60 * 1000)
  if (!r.ok) return res.status(500).json({ error: r.error || '上传失败', detail: r.output })
  res.json({ success: true, detail: r.output })
})

// 下载:设备 → 本地目录。body { devicePath, localDir, serial? }
app.post('/api/local/hdc-recv', async (req, res) => {
  const { devicePath, localDir, serial } = req.body || {}
  if (!devicePath || !localDir) return res.status(400).json({ error: '缺少 devicePath/localDir' })
  saveTransferState({ devicePath, localDir })
  const r = await hdcFileRecv(String(devicePath), String(localDir), serial, 30 * 60 * 1000)
  if (!r.ok) return res.status(500).json({ error: r.error || '下载失败', detail: r.output })
  res.json({ success: true, detail: r.output })
})

// 列出已连接设备(hdc list targets)
app.get('/api/local/hdc-targets', async (req, res) => {
  res.json(await hdcListTargets())
})

// hdc 设备连接状态 / 连接 / 断开(后端维护,不依赖本地终端)
app.get('/api/local/hdc-state', (req, res) => {
  res.json(getDeviceState())
})

app.post('/api/local/hdc-connect', (req, res) => {
  const serial = (req.body || {}).serial
  res.json(connectDevice(serial))
})

app.post('/api/local/hdc-disconnect', (req, res) => {
  res.json(disconnectDevice())
})

// 列出设备目录(供下载时选择)
app.get('/api/local/hdc-list', async (req, res) => {
  const p = req.query.path ? String(req.query.path) : ''
  const serial = req.query.serial ? String(req.query.serial) : ''
  res.json(await hdcFileList(p, serial))
})

// ========== WebSocket 终端 ==========
wss.on('connection', async (ws, req) => {
  const url = new URL(req.url, 'http://localhost')
  // 设置了访问令牌时,WS 与 REST 一并校验(?token=)
  if (!isAuthorized(req)) {
    ws.close(1008, '未授权:缺少或错误的访问令牌')
    return
  }
  // 本地终端与本机 PowerShell:按 pathname 分流
  if (url.pathname === '/ws/local') {
    handleLocalWs(ws, url)
    return
  }
  const serverId = url.searchParams.get('serverId')

  if (!serverId) {
    ws.close(1008, '缺少 serverId 参数')
    return
  }

  try {
    // 会话 id(前端会话标签),用于标记/精确关闭对应 shell
    const sessionId = url.searchParams.get('session') || null

    // 会话数上限同样约束直连 WS:REST 侧的限制只挡 POST /sessions,
    // 不校验这里等于允许绕过前端无限开 shell 撑爆远端
    if (sessionId) {
      const serverSessions = readSessions().filter(s => s.serverId === serverId)
      if (serverSessions.length >= MAX_SESSIONS_PER_SERVER && !serverSessions.some(s => s.id === sessionId)) {
        ws.close(1008, `每台服务器最多 ${MAX_SESSIONS_PER_SERVER} 个会话,请先关闭部分会话`)
        return
      }
    }

    // 指定目录打开会话(请求 5)时带初始目录:新 shell 打开后自动 cd 到该目录
    const initialDir = sessionId ? pendingInitialDir.get(sessionId) : null
    if (initialDir) pendingInitialDir.delete(sessionId)

    // 打开 shell。createShell 内部已走多连接分摊:按容量挑一条终端连接(必要时新开),
    // 通道耗尽时只重试自身那条连接,不连累其他连接的会话 —— 比旧的整池断连更稳。
    const shell = await createShell(serverId, sessionId, initialDir)

    // 发送连接成功消息
    ws.send(JSON.stringify({ type: 'connected' }))

    // SSH shell 输出 → WebSocket
    shell.on('data', (data) => {
      // 复制会话期间正在测量 cwd 的会话,其输出被暂存屏蔽,避免用户终端闪现 pwd
      if (ws.readyState === ws.OPEN && !isMeasuringCwd(sessionId)) {
        ws.send(JSON.stringify({ type: 'data', data: data.toString('base64') }))
      }
    })

    // shell 关闭(exit/被 destroyShell 主动关闭/远端断开)→ 同步关闭 WS,
    // 避免出现"shell 已没了但 WS 仍挂着"的孤儿连接
    shell.on('close', () => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
        ws.close()
      }
    })

    // WebSocket → SSH shell 输入
    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString())
        if (parsed.type === 'input') {
          shell.write(Buffer.from(parsed.data, 'base64'))
        } else if (parsed.type === 'resize') {
          shell.setWindow(parsed.rows, parsed.cols, 480, 640)
        }
      } catch (e) {
        // 忽略解析错误
      }
    })

    ws.on('close', () => {
      shell.close()
    })

    ws.on('error', () => {
      shell.close()
    })
  } catch (err) {
    ws.send(JSON.stringify({ type: 'error', message: err.message }))
    ws.close(1011, err.message)
  }
})

// ========== WebSocket 本地终端(本机 PowerShell, ConPTY) ==========
// 与 /ws/terminal 共用一个 WebSocketServer,按 pathname 分流。
// 消息协议复用(connected/data/error/input/resize, data/input 均 base64)。
function handleLocalWs(ws, url) {
  const sessionId = url.searchParams.get('session') || `loc-${Date.now()}`
  const cwd = url.searchParams.get('cwd') || getDefaultLocalDir()

  try {
    createLocalShell(sessionId, { cwd })
    const pty = getLocalShell(sessionId)
    if (!pty) throw new Error('本地终端启动失败')

    ws.send(JSON.stringify({ type: 'connected' }))

    // node-pty 输出 → WebSocket(base64)。onData 产出的是带 ANSI 的字符串。
    const onData = (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'data', data: Buffer.from(data, 'utf8').toString('base64') }))
      }
    }
    // node-pty 退出 → 关闭 WS。带明确 code/reason,让前端能区分"shell 正常退出"
    // 与"连接异常断开":前者不应触发自动重连(否则会拉起新的 PowerShell 僵尸进程)。
    const onExit = () => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000, 'shell-exit')
    }
    pty.onData(onData)
    pty.onExit(onExit)

    ws.on('message', (msg) => {
      try {
        const parsed = JSON.parse(msg.toString())
        if (parsed.type === 'input') {
          pty.write(Buffer.from(parsed.data, 'base64').toString('utf8'))
        } else if (parsed.type === 'resize') {
          resizeLocalShell(sessionId, parsed.cols, parsed.rows)
        }
      } catch { /* 忽略解析错误 */ }
    })
    ws.on('close', () => { pty.removeListener('data', onData); pty.removeListener('exit', onExit); destroyLocalShell(sessionId) })
    ws.on('error', () => { destroyLocalShell(sessionId) })
  } catch (err) {
    try { ws.send(JSON.stringify({ type: 'error', message: err.message })) } catch {}
    ws.close(1011, err.message)
  }
}

// SPA fallback: 非API请求统一返回 index.html
if (hasDist) {
  app.get('*', (req, res) => {
    res.sendFile(path.join(distDir, 'index.html'))
  })
}

const PORT = process.env.PORT || 3120

server.listen(PORT, () => {
  console.log(`\n  🚀 ServerHub 启动成功！`)
  console.log(`  📡 API:     http://localhost:${PORT}/api`)
  console.log(`  🔌 WebSocket: ws://localhost:${PORT}/ws/terminal`)
  if (hasDist) {
    console.log(`  🌐 Web UI:   http://localhost:${PORT}\n`)
  } else {
    console.log(`  🌐 Web UI:   http://localhost:5173 (Vite dev)\n`)
  }
})

// 供 Electron 主进程等待服务就绪后加载 UI(也保持直接用 node 运行的兼容性)
export { server, app }
