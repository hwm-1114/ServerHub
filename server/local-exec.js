// 本地终端执行模块:在本机(运行后端的这台 Windows)上拉起 ConPTY 伪终端(powershell),
// 供"本地终端"功能使用。与 ssh-manager.js 一样是 ESM、只读/写与本机相关的持久化数据。
//
// 说明:
// - 用 node-pty + ConPTY 得到真伪终端,支持彩色 ANSI、箭头键、vim/htop、交互命令(hdc shell 等)。
// - 渲染进程被 contextIsolation 隔离,本地进程只能在 Node(后端/Electron main)侧 spawn,故放这里。
// - 每个本地终端会话一个 node-pty 实例,存于 localShells Map(会话 id -> { pty })。

import os from 'os'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { spawn as ptySpawn } from 'node-pty'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.SERVERHUB_DATA_DIR || path.join(__dirname, '..', 'data')
const localDirsFile = path.join(dataDir, 'local-dirs.json')

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
if (!fs.existsSync(localDirsFile)) fs.writeFileSync(localDirsFile, '[]')

// ========== 持久化:本地目录收藏 ==========
export function readLocalDirs() {
  try { return JSON.parse(fs.readFileSync(localDirsFile, 'utf-8')) } catch { return [] }
}
export function writeLocalDirs(list) {
  fs.writeFileSync(localDirsFile, JSON.stringify(list, null, 2))
}

// 事务性"读-改-写":整个读改写按文件互斥排队,防并发请求互相覆盖丢更新
// (与 ssh-manager 的 mutateJson 同思路)
let localDirsChain = Promise.resolve()
export function mutateLocalDirs(fn) {
  const run = localDirsChain.catch(() => {}).then(async () => {
    const cur = readLocalDirs()
    const next = await fn(cur)
    const tmp = localDirsFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2))
    fs.renameSync(tmp, localDirsFile)
    return next
  })
  localDirsChain = run.then(() => {}, () => {})
  return run
}

// ========== 本地 shell 管理 ==========
const localShells = new Map() // id -> { pty }

/**
 * 拉起一个本地伪终端 shell。
 * @param {string} id 会话 id(前端标签 id)
 * @param {{cwd?:string, cols?:number, rows?:number}} opts
 * @returns {{ pid:number }}
 */
export function createLocalShell(id, opts = {}) {
  const cwd = opts.cwd || os.homedir()
  const cols = opts.cols || 80
  const rows = opts.rows || 24
  // 按平台选择 shell:Windows 用 PowerShell,类 Unix 用 $SHELL(兜底 bash)。
  // 旧实现硬编码 powershell.exe,非 Windows 平台本地终端直接起不来。
  const isWin = process.platform === 'win32'
  const shellCmd = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/bash')
  const shellArgs = isWin ? ['-NoExit', '-NoProfile'] : []
  const pty = ptySpawn(shellCmd, shellArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: process.env,
  })
  localShells.set(id, { pty })
  return { pid: pty.pid }
}

export function getLocalShell(id) {
  const entry = localShells.get(id)
  return entry ? entry.pty : null
}

// 供注入 input/输出监听/尺寸/退出;返回 null 表示不存在
export function destroyLocalShell(id) {
  const entry = localShells.get(id)
  if (!entry) return
  try { entry.pty.kill() } catch {}
  localShells.delete(id)
}

export function resizeLocalShell(id, cols, rows) {
  const pty = getLocalShell(id)
  if (!pty || !cols || !rows) return
  try { pty.resize(cols, rows) } catch {}
}

// 本机默认目录:收藏中最近一次/用户主目录
export function getDefaultLocalDir() {
  try {
    const dirs = readLocalDirs()
    if (dirs.length) return dirs[dirs.length - 1].path
  } catch {}
  return os.homedir()
}

// ========== 目录浏览 ==========
/** 列出目录内容(Windows:根路径或空返回盘符)。返回 { entries, note } */
// 全异步 fs.promises:旧实现 readdirSync + 逐文件 statSync 会把大目录(System32 几千条)
// 的遍历变成同步阻塞,期间整个后端事件循环(含所有终端 WS)卡顿几十~几百 ms
export async function browseDirectory(dirPath) {
  // 无路径或空 → 返回盘符
  if (!dirPath) return { entries: listDrives(), note: '' }

  let stat
  try {
    stat = await fs.promises.stat(dirPath)
  } catch {
    return { entries: [], note: '无法访问:路径不存在或无权访问' }
  }
  if (!stat.isDirectory()) {
    return { entries: [], note: '不是目录' }
  }
  let names
  try {
    names = await fs.promises.readdir(dirPath, { withFileTypes: true })
  } catch (e) {
    return { entries: [], note: `无法读取: ${e.message}` }
  }
  // 顺序 stat(非阻塞):与旧同步实现工作量相同,但不再卡事件循环
  const entries = []
  for (const d of names) {
    let size = 0
    if (d.isFile()) {
      try { size = (await fs.promises.stat(path.join(dirPath, d.name))).size } catch { size = 0 }
    }
    entries.push({ name: d.name, isDir: d.isDirectory(), size })
  }
  // 目录优先排序,再按名称
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  return { entries, note: '' }
}

// 用系统文件管理器打开一个本地目录(Windows 资源管理器 / macOS open / Linux xdg-open)。
// 注意:spawn 的失败是异步 'error' 事件,同步 try/catch 抓不到,若只看 spawn 返回值
// 即使没真正打开也会误报成功。这里规范化路径(去掉结尾反斜杠,盘符根保留 E:\,
// 避免 explorer 对带尾斜杠路径误判),并等待 'error' 事件如实返回失败。
export function openLocalDir(dirPath) {
  const p = String(dirPath || '').trim()
  if (!p) return Promise.resolve({ ok: false, error: '缺少目录路径' })
  // 盘符根保留 "E:\",其余去掉结尾反斜杠
  let target = p
  if (/^[A-Za-z]:\\?$/.test(target)) {
    target = target.replace(/\\+$/, '') + '\\'
  } else {
    while (target.length > 3 && target.endsWith('\\')) target = target.slice(0, -1)
  }
  const opener = process.platform === 'win32' ? 'explorer.exe'
    : (process.platform === 'darwin' ? 'open' : 'xdg-open')
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(opener, [target], { windowsHide: true })
    } catch (e) {
      resolve({ ok: false, error: e.message })
      return
    }
    proc.on('error', (e) => resolve({ ok: false, error: e.message }))
    // 打开器立即返回;稍等片刻再判成功,避免误报
    proc.on('spawn', () => setTimeout(() => resolve({ ok: true }), 400))
  })
}

function listDrives() {
  const drives = []
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  for (const l of letters) {
    const root = `${l}:\\`
    try {
      fs.accessSync(root)
      drives.push({ name: root, isDir: true })
    } catch { /* 盘符不存在跳过 */ }
  }
  return drives
}

// ========== hdc 设备文件传输 ==========
// 在本机与 hdc 连接的设备之间传文件:host 侧运行 `hdc file send|recv` 命令。
// 记住上一次使用的设备目录与本地目录,方便下次默认。

const transferStateFile = path.join(dataDir, 'local-transfer.json')

function readTransferState() {
  try { return JSON.parse(fs.readFileSync(transferStateFile, 'utf-8')) } catch { return { devicePath: '', localDir: '' } }
}
function writeTransferState(state) {
  try { fs.writeFileSync(transferStateFile, JSON.stringify(state, null, 2)) } catch {}
}

export function getTransferState() {
  return readTransferState()
}
// 写入按文件互斥排队:并发保存(如上传/下载几乎同时记住各自目录)旧实现是
// 裸"读-改-写",后写的会用旧快照覆盖先写的字段,造成丢更新
let transferStateChain = Promise.resolve()
export function saveTransferState(state) {
  const run = transferStateChain.catch(() => {}).then(() => {
    const cur = readTransferState()
    writeTransferState({
      devicePath: validateString(state.devicePath) ?? cur.devicePath ?? '',
      localDir: validateString(state.localDir) ?? cur.localDir ?? '',
    })
  })
  transferStateChain = run
  return run
}
function validateString(v) {
  return typeof v === 'string' ? v : null
}

// 运行一条 host 命令,收集 stdout/stderr 后 resolve;超时(默认 60s)结束。
function runHostCommand(cmd, args, timeout = 60000) {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(cmd, args, { windowsHide: true })
    } catch (e) {
      resolve({ ok: false, error: e.message })
      return
    }
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => { out += d.toString('utf-8') })
    proc.stderr.on('data', (d) => { err += d.toString('utf-8') })
    const timer = setTimeout(() => { try { proc.kill() } catch {} }, timeout)
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }) })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ ok: true, output: out, error: '' })
      else resolve({ ok: false, output: out, error: err || `hdc 退出码 ${code}` })
    })
  })
}

// 多设备场景下 hdc 需要 `-t <serial>` 指定目标设备;serial 为空则用默认设备(不传 -t)
function targetArgs(serial) {
  return serial && String(serial).trim() ? ['-t', String(serial).trim()] : []
}

// 列出已连接设备(hdc list targets),返回 [{ serial, state }] 供前端选择
export function hdcListTargets() {
  return runHostCommand('hdc', ['list', 'targets']).then((r) => {
    if (!r.ok) return { targets: [], error: r.error || 'hdc list targets 失败', detail: r.output }
    const targets = r.output
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const p = line.split(/\s+/)
        return { serial: p[0], state: p.slice(1).join(' ') || 'connected' }
      })
    return { targets, error: '', detail: r.output }
  })
}

// 上传:把本地文件发送到设备路径(设备侧可为文件路径或目录)
export async function hdcFileSend(localPath, devicePath, serial, timeout) {
  const r = await runHostCommand('hdc', [...targetArgs(serial), 'file', 'send', localPath, devicePath], timeout)
  return r
}

// 下载:从设备路径取回文件到本地目录(本地目录不存在则自动创建)
export async function hdcFileRecv(devicePath, localDir, serial, timeout) {
  const dir = String(localDir || '')
  try { if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }) } catch {}
  const r = await runHostCommand('hdc', [...targetArgs(serial), 'file', 'recv', String(devicePath), dir || '.'], timeout)
  return r
}

// 列出设备某目录内容。该 hdc 版本的 `file` 子命令只支持 send/recv,**没有 file list**,
// 因此改用 shell 通道执行 `ls -la <path>` 再解析输出为 {name,isDir} 数组。
export async function hdcFileList(devicePath, serial) {
  const r = await runHostCommand('hdc', [...targetArgs(serial), 'shell', 'ls', '-la', devicePath])
  if (!r.ok) return { entries: [], error: r.error, details: r.output }
  const entries = []
  const lines = r.output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  for (const line of lines) {
    // 只处理"看起来像 ls 列表行"的行(权限串开头),跳过 total、ls: 错误提示等噪声
    if (!/^[-dlbcps]/.test(line) && !/<DIR>/i.test(line)) continue
    const isDir = /^d/.test(line) || /<DIR>/i.test(line)
    const perm = line.match(/^[-dlbcps][rwxsStT\-]{9}/)
    // 名字 = 行末最后一段(兼容完整与精简的 ls -l 两种列数)
    const tail = perm ? line.slice(perm[0].length) : line
    const parts = tail.trim().split(/\s+/).filter(Boolean)
    const name = parts.pop()
    // 大小 = 日期(token 形如 2023-01-01 或 01-01 10:00)前一个纯数字 token;取不到则 0
    let size = 0
    const dateIdx = parts.findIndex((t) => /^\d{2,4}[-/]\d{1,2}[-/]\d{1,2}/.test(t))
    if (dateIdx > 0 && /^\d+$/.test(parts[dateIdx - 1])) size = parseInt(parts[dateIdx - 1], 10)
    if (name && name !== '.' && name !== '..') entries.push({ name, isDir, size })
  }
  return { entries, error: '', details: r.output }
}

// ========== hdc 设备连接状态 ==========
// 应用维护一个"当前连接的设备":前端的 连接/断开 按钮调用这里,不依赖本地终端。
// - 连接:记录目标设备 serial,此后 hdc file list/send/recv 都定向到该设备;
// - 断开:清除连接,不再浏览设备目录。
const deviceConn = { connected: false, serial: '' }

export function getDeviceState() {
  return { connected: deviceConn.connected, serial: deviceConn.serial }
}

export function connectDevice(serial) {
  deviceConn.serial = serial && String(serial).trim() ? String(serial).trim() : ''
  deviceConn.connected = true
  return { ok: true, state: getDeviceState() }
}

export function disconnectDevice() {
  deviceConn.connected = false
  deviceConn.serial = ''
  return { ok: true, state: getDeviceState() }
}
