// 离线回归:文件名编码 / 符号链接删除 / 新建目录语义 / 错误信息中文化 / 命令集导出导入与排序
// 全部用假 ssh2 + 内存文件系统驱动真实后端路由,不需要真服务器,可并入 npm test。
// 运行: node scripts/verify-fixes.mjs
import { createRequire } from 'module'
import { EventEmitter } from 'events'
import { Readable, Writable } from 'stream'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'

const require = createRequire(import.meta.url)

// ================= 内存文件系统(支持符号链接) =================
// 语义尽量贴近 OpenSSH 的 sftp-server:stat 跟随链接、lstat 不跟随、
// readdir 跟随链接、rmdir 不接受链接、mkdir 已存在返回 SSH_FX_FAILURE(4)、
// 父级不是目录返回 SSH_FX_NO_SUCH_FILE(2)。
const nodes = new Map() // path -> { type:'file'|'dir'|'symlink', content?, target?, children?:Set<string> }
function addFile(p, content = '') {
  const parent = p.slice(0, p.lastIndexOf('/')) || '/'
  nodes.set(p, { type: 'file', content })
  nodes.get(parent)?.children.add(p)
}
function addDir(p) {
  const parent = p.slice(0, p.lastIndexOf('/')) || '/'
  if (!nodes.has(p)) nodes.set(p, { type: 'dir', children: new Set() })
  nodes.get(parent)?.children?.add(p)
}
function addLink(p, target) {
  const parent = p.slice(0, p.lastIndexOf('/')) || '/'
  nodes.set(p, { type: 'symlink', target })
  nodes.get(parent)?.children.add(p)
}
function resolveLink(p, depth = 0) {
  if (depth > 10) return null
  const n = nodes.get(p)
  if (!n) return null
  if (n.type !== 'symlink') return { path: p, node: n }
  const target = n.target.startsWith('/') ? n.target : path.posix.join(path.posix.dirname(p), n.target)
  return resolveLink(target, depth + 1)
}
const sfxErr = (code, message) => Object.assign(new Error(message), { code })
function attrs(p, node) {
  return {
    size: node.type === 'file' ? Buffer.byteLength(node.content) : 0,
    mode: node.type === 'dir' ? 0o40755 : node.type === 'symlink' ? 0o120777 : 0o100644,
    mtime: 1700000000,
    isDirectory: () => node.type === 'dir',
    isFile: () => node.type === 'file',
    isSymbolicLink: () => node.type === 'symlink',
  }
}

const opLog = []
const writeStreams = [] // 记录创建过的上传写流,供"超时后是否销毁"断言
class FakeSftp extends EventEmitter {
  lstat(p, cb) {
    opLog.push(`lstat ${p}`)
    const n = nodes.get(p)
    setTimeout(() => (n ? cb(null, attrs(p, n)) : cb(sfxErr(2, 'No such file'))), 1)
  }
  stat(p, cb) {
    opLog.push(`stat ${p}`)
    const r = resolveLink(p)
    setTimeout(() => (r ? cb(null, attrs(r.path, r.node)) : cb(sfxErr(2, 'No such file'))), 1)
  }
  readdir(p, cb) {
    const r = resolveLink(p)
    if (!r || r.node.type !== 'dir') return setTimeout(() => cb(sfxErr(2, 'No such file')), 1)
    const list = [...r.node.children].map(child => {
      const n = nodes.get(child)
      return { filename: child.slice(child.lastIndexOf('/') + 1), longname: '', attrs: attrs(child, n) }
    })
    setTimeout(() => cb(null, list), 1)
  }
  unlink(p, cb) {
    opLog.push(`unlink ${p}`)
    const n = nodes.get(p)
    if (!n || n.type === 'dir') return setTimeout(() => cb(sfxErr(4, 'Failure')), 1)
    const parent = p.slice(0, p.lastIndexOf('/')) || '/'
    nodes.get(parent)?.children?.delete(p)
    nodes.delete(p)
    setTimeout(() => cb(null), 1)
  }
  rmdir(p, cb) {
    opLog.push(`rmdir ${p}`)
    const n = nodes.get(p)
    if (!n || n.type !== 'dir') return setTimeout(() => cb(sfxErr(4, 'Failure')), 1) // 链接不能 rmdir
    if (n.children.size) return setTimeout(() => cb(sfxErr(4, 'Failure')), 1)
    const parent = p.slice(0, p.lastIndexOf('/')) || '/'
    nodes.get(parent)?.children?.delete(p)
    nodes.delete(p)
    setTimeout(() => cb(null), 1)
  }
  mkdir(p, cb) {
    opLog.push(`mkdir ${p}`)
    if (nodes.has(p)) return setTimeout(() => cb(sfxErr(4, 'Failure')), 1)
    const parent = resolveLink(p.slice(0, p.lastIndexOf('/')) || '/')
    if (!parent || parent.node.type !== 'dir') return setTimeout(() => cb(sfxErr(2, 'No such file')), 1) // ENOTDIR → 2
    addDir(p)
    setTimeout(() => cb(null), 1)
  }
  createReadStream(p) {
    opLog.push(`read ${p}`)
    const r = resolveLink(p)
    if (!r || r.node.type !== 'file') {
      const rs = new Readable({ read() {} })
      setImmediate(() => rs.emit('error', sfxErr(2, 'No such file')))
      return rs
    }
    return Readable.from([Buffer.from(r.node.content)])
  }
  createWriteStream(p) {
    opLog.push(`write ${p}`)
    const self = this
    const chunks = []
    const ws = new Writable({ write(c, _e, cb) { chunks.push(c); cb() } })
    ws.on('finish', () => {
      const parent = resolveLink(p.slice(0, p.lastIndexOf('/')) || '/')
      if (parent && parent.node.type === 'dir') addFile(p, Buffer.concat(chunks).toString())
    })
    writeStreams.push(ws)
    self.on('noop', () => {})
    process.nextTick(() => ws.emit('open', 1))
    return ws
  }
  rename(a, b, cb) { opLog.push(`rename ${a} ${b}`); setTimeout(() => cb(null), 1) }
}

class FakeStream extends EventEmitter {
  constructor() { super(); this.stderr = new EventEmitter(); this.closed = false }
  write() { return true }
  setWindow() {}
  end() { this.close() }
  close() { if (this.closed) return; this.closed = true; this.emit('close') }
}
class FakeClient extends EventEmitter {
  connect() { setTimeout(() => this.emit('ready'), 5) }
  shell(_o, cb) { const s = new FakeStream(); setTimeout(() => cb(null, s), 2) }
  exec(_c, cb) { const s = new FakeStream(); setTimeout(() => cb(null, s), 2) }
  sftp(cb) { const s = new FakeSftp(); setTimeout(() => cb(null, s), 2); return s }
  end() { this.emit('close') }
}
const ssh2 = require('ssh2')
ssh2.Client = FakeClient

// ================= 启动后端(独立数据目录) =================
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'serverhub-fixes-'))
process.env.SERVERHUB_DATA_DIR = tmp
// 把传输看护阈值压到 2s/6s,便于在离线回归里验证"半开连接会被看护中止"
process.env.SERVERHUB_TRANSFER_IDLE_MS = '2000'
process.env.SERVERHUB_TRANSFER_TOTAL_MS = '6000'
fs.writeFileSync(path.join(tmp, 'servers.json'), JSON.stringify([
  { id: 'srv-t', name: 'fake', host: '127.0.0.1', port: 22, username: 'u', password: 'p' },
]))
process.env.PORT = '38140'
const { server } = await import('../server/index.js')
if (!server.listening) await new Promise(r => server.once('listening', r))
const BASE = 'http://127.0.0.1:38140'
const enc = encodeURIComponent
const list = (p) => fetch(`${BASE}/api/servers/srv-t/files?path=${enc(p)}`).then(async r => ({ status: r.status, body: await r.json() }))
const dl = (p) => fetch(`${BASE}/api/servers/srv-t/files/download?path=${enc(p)}`)
const del = (p) => fetch(`${BASE}/api/servers/srv-t/files?path=${enc(p)}`, { method: 'DELETE' }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))
const jpost = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ✅', label) } else { fail++; console.log('  ❌', label) }
  if (extra) console.log('     ', extra)
}

// ================= 夹具 =================
addDir('/'); addDir('/data')
addFile('/data/50%off.txt', 'PERCENT-RAW')
addFile('/data/100%25.txt', 'PERCENT-25')
addFile('/data/100%.txt', 'DECOY')
addDir('/data/target'); addFile('/data/target/important.txt', 'IMPORTANT'); addDir('/data/target/sub'); addFile('/data/target/sub/deep.txt', 'DEEP')
addLink('/data/link-to-dir', '/data/target')
addLink('/data/link-to-file', '/data/target/important.txt')
addLink('/data/link-dangling', '/data/nope')
addFile('/data/afile', 'IAMFILE')

console.log('\n【1】文件名含 % :下载/删除必须打到同一个文件(不能再二次解码)')
{
  const r1 = await dl('/data/50%off.txt')
  const t1 = await r1.text()
  ok(r1.status === 200 && t1 === 'PERCENT-RAW', '下载 50%off.txt 成功且内容正确', `HTTP ${r1.status} body=${JSON.stringify(t1.slice(0, 60))}`)

  const r2 = await dl('/data/100%25.txt')
  const t2 = await r2.text()
  ok(r2.status === 200 && t2 === 'PERCENT-25', '下载 100%25.txt 拿到的是它自己的内容(不是 100%.txt)', `HTTP ${r2.status} body=${JSON.stringify(t2)}`)

  opLog.length = 0
  const d2 = await del('/data/100%25.txt')
  ok(d2.status === 200 && opLog.some(l => l === 'unlink /data/100%25.txt') && nodes.has('/data/100%.txt'),
    '删除 100%25.txt 删的是它自己,诱饵文件 100%.txt 仍在',
    `HTTP ${d2.status} 操作=${JSON.stringify(opLog)} 诱饵仍在=${nodes.has('/data/100%.txt')}`)

  const d1 = await del('/data/50%off.txt')
  ok(d1.status === 200 && !nodes.has('/data/50%off.txt'), '删除 50%off.txt 成功(不再 500 URI malformed)', `HTTP ${d1.status} ${JSON.stringify(d1.body)}`)
}

console.log('\n【2】符号链接删除:只删链接,绝不穿透到目标(真机曾把目标目录内容删空)')
{
  opLog.length = 0
  const d = await del('/data/link-to-dir')
  const targetOk = nodes.has('/data/target/important.txt') && nodes.has('/data/target/sub/deep.txt')
  ok(d.status === 200 && !nodes.has('/data/link-to-dir') && targetOk,
    '删除指向目录的链接:链接消失、目标目录内容完好',
    `HTTP ${d.status} 链接仍在=${nodes.has('/data/link-to-dir')} 目标完好=${targetOk} 操作=${JSON.stringify(opLog.slice(0, 3))}...`)
  ok(!opLog.some(l => l.startsWith('readdir') || l.startsWith('rmdir')), '未对链接做任何目录遍历/rmdir', JSON.stringify(opLog))

  const d2 = await del('/data/link-dangling')
  ok(d2.status === 200 && !nodes.has('/data/link-dangling'), '删除悬空链接成功(旧实现 stat ENOENT → 永远删不掉)', `HTTP ${d2.status} ${JSON.stringify(d2.body)}`)

  addLink('/data/link-to-file2', '/data/target/important.txt')
  const d3 = await del('/data/link-to-file2')
  ok(d3.status === 200 && !nodes.has('/data/link-to-file2') && nodes.has('/data/target/important.txt'),
    '删除指向文件的链接:只删链接', `HTTP ${d3.status} 目标仍在=${nodes.has('/data/target/important.txt')}`)

  const d4 = await del('/data/target')
  ok(d4.status === 200 && !nodes.has('/data/target'), '真实目录仍可正常递归删除', `HTTP ${d4.status}`)
}

console.log('\n【3】新建目录语义(existOk)与父级不是目录时的中文报错')
{
  const c1 = await jpost('/api/servers/srv-t/files/mkdir', { path: '/data/new/a/b' })
  ok(c1.status === 200 && nodes.has('/data/new/a/b'), '递归新建目录成功', `HTTP ${c1.status}`)

  const c2 = await jpost('/api/servers/srv-t/files/mkdir', { path: '/data/new' })
  ok(c2.status !== 200, '默认不允许多次创建同一目录(建目录对话框语义)', `HTTP ${c2.status} ${JSON.stringify(c2.body)}`)

  const c3 = await jpost('/api/servers/srv-t/files/mkdir', { path: '/data/new', existOk: true })
  ok(c3.status === 200, 'existOk=true 时已存在目录视为成功(mkdir -p 语义,供拖入文件夹上传前补建)', `HTTP ${c3.status} ${JSON.stringify(c3.body)}`)

  const c4 = await jpost('/api/servers/srv-t/files/mkdir', { path: '/data/afile/sub' })
  ok(c4.status !== 200 && /不是目录|已存在/.test(c4.body.error || ''), '父级是文件时给出中文原因(不再是英文 "No such file")', `HTTP ${c4.status} ${JSON.stringify(c4.body)}`)
}

console.log('\n【4】下载错误信息中文化(目录 / 不存在)')
{
  const r1 = await dl('/data/new')
  ok(r1.status === 400 && /目录/.test((await r1.json()).error), '下载目录 → 400 中文提示', `HTTP ${r1.status}`)
  const r2 = await dl('/data/not-here.txt')
  ok(r2.status === 404 && /不存在/.test((await r2.json()).error), '下载不存在的文件 → 404 中文提示', `HTTP ${r2.status}`)
}

console.log('\n【5】命令集:导出必须包含本地命令(scope=all)+ 导入往返不丢 + 排序不动无关命令')
{
  await jpost('/api/commands', { name: '远程命令A', command: 'echo A', category: 'custom' })
  await jpost('/api/commands', { name: '本地命令B', command: 'dir', category: 'custom', scope: 'local' })
  const all = (await (await fetch(`${BASE}/api/commands?scope=all`)).json())
  ok(all.some(c => c.scope === 'local'), 'GET /api/commands?scope=all 返回本地命令集', `共 ${all.length} 条,本地 ${all.filter(c => c.scope === 'local').length} 条`)

  const exported = JSON.parse(JSON.stringify(all))
  const imp = await jpost('/api/commands/import', { commands: exported })
  const localAfter = await (await fetch(`${BASE}/api/commands?scope=local`)).json()
  ok(imp.status === 200 && localAfter.length === 1, '导出→导入 往返后本地命令集仍在(旧实现被整表覆盖清空)', `导入 ${imp.body.count} 条,本地剩余 ${localAfter.length} 条`)

  // 排序:未提交的命令必须保持原位(旧实现会被整段挪到数组末尾)
  fs.writeFileSync(path.join(tmp, 'commands.json'), JSON.stringify([
    { id: 'k1', name: '公共1', command: 'x', category: 'sys' },
    { id: 'o1', name: '别的服务器命令', command: 'x', category: 'sys', serverId: 'srv-OTHER' },
    { id: 'l1', name: '本地终端命令', command: 'x', category: 'sys', scope: 'local' },
    { id: 'a1', name: '部署A', command: 'x', category: 'deploy', serverId: 'srv-t' },
    { id: 'b1', name: '日志X', command: 'x', category: 'log', serverId: 'srv-t' },
    { id: 'a2', name: '部署B', command: 'x', category: 'deploy', serverId: 'srv-t' },
  ]))
  const before = await (await fetch(`${BASE}/api/commands?serverId=srv-t`)).json()
  // 复刻前端新逻辑:按"面板显示顺序"提交(分区内按命令集分组,组内保持当前顺序)
  const displayOrdered = (l) => {
    const cats = Array.from(new Set(l.map(c => c.category)))
    return cats.flatMap(cat => l.filter(c => c.category === cat).map(c => c.id))
  }
  const common = before.filter(c => !c.serverId), server = before.filter(c => c.serverId === 'srv-t')
  const visible = [...displayOrdered(common), ...displayOrdered(server)]
  const next = [...visible]
  next.splice(next.indexOf('a1'), 1)
  next.splice(next.indexOf('a2'), 0, 'a1')
  await jpost('/api/commands/order', { ids: next })
  const after = await (await fetch(`${BASE}/api/commands?scope=all`)).json()
  const order = after.map(c => c.id)
  const serverPart = after.filter(c => c.serverId === 'srv-t')
  const cats = Array.from(new Set(serverPart.map(c => c.category)))
  ok(order.indexOf('o1') === 1 && order.indexOf('l1') === 2, '未提交的命令(别的服务器/本地)位置不变', `数组顺序=${order.join(',')}`)
  ok(cats.join(',') === 'deploy,log', '同一分区内命令集的显示顺序不被拖拽打乱', `分组顺序=${cats.join(',')}`)
  ok(serverPart.map(c => c.name).join(',') === '部署A,部署B,日志X', '被拖命令在自己命令集内保持预期顺序', `${serverPart.map(c => c.name).join(',')}`)

  // 真正的组内移动:把 部署B 拖到 部署A 之前 → 组内顺序应变化,而分组顺序与无关命令仍不变
  const before2 = await (await fetch(`${BASE}/api/commands?serverId=srv-t`)).json()
  const c2 = before2.filter(c => !c.serverId), s2 = before2.filter(c => c.serverId === 'srv-t')
  const vis2 = [...displayOrdered(c2), ...displayOrdered(s2)]
  const next2 = [...vis2]
  next2.splice(next2.indexOf('a2'), 1)
  next2.splice(next2.indexOf('a1'), 0, 'a2')
  await jpost('/api/commands/order', { ids: next2 })
  const after2 = await (await fetch(`${BASE}/api/commands?scope=all`)).json()
  const sPart2 = after2.filter(c => c.serverId === 'srv-t')
  const cats2 = Array.from(new Set(sPart2.map(c => c.category)))
  ok(sPart2.map(c => c.name).join(',') === '部署B,部署A,日志X', '组内拖拽真的生效(部署B 移到 部署A 之前)', `${sPart2.map(c => c.name).join(',')}`)
  ok(cats2.join(',') === 'deploy,log' && after2.map(c => c.id).indexOf('o1') === 1 && after2.map(c => c.id).indexOf('l1') === 2,
    '组内移动后分组顺序与无关命令位置仍不变', `分组=${cats2.join(',')} 数组=${after2.map(c => c.id).join(',')}`)
}

console.log('\n【6】上传中途"半开连接":看护超时必须中止并清理(SERVERHUB_TRANSFER_IDLE_MS=2000)')
{
  const before = writeStreams.length
  const body = Buffer.alloc(512 * 1024, 0x41)
  const result = await new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port: 38140,
      path: `/api/servers/srv-t/files/upload?path=${enc('/data')}&name=stall.bin`,
      method: 'POST', headers: { 'Content-Length': String(body.length) },
    }, (res) => {
      let t = ''
      res.on('data', d => t += d)
      res.on('end', () => resolve({ status: res.statusCode, body: t }))
    })
    req.on('error', (e) => resolve({ status: -1, body: e.message }))
    req.write(body.subarray(0, 32 * 1024)) // 只发一小段,然后【不发 end 也不断开】——模拟链路静默中断
  })
  const ws6 = writeStreams[writeStreams.length - 1]
  ok(writeStreams.length > before, '上传创建了 SFTP 写流(前置条件)')
  ok(result.status === 500 && /上传超时中止/.test(result.body),
    '空闲超时后请求被中止并返回中文原因(旧实现永久挂住)',
    `HTTP ${result.status} ${String(result.body).slice(0, 120)}`)
  ok(ws6 && ws6.destroyed === true, '超时后写流被销毁(不泄漏 SFTP 通道)',
    `destroyed=${ws6 && ws6.destroyed}`)
  ok(!nodes.has('/data/stall.bin'), '超时后远端无半成品残留', `远端文件=${nodes.has('/data/stall.bin') ? '残留' : '已清理/未创建'}`)
}

console.log('\n' + '='.repeat(52))
console.log(`缺陷回归结果: ${pass} PASS / ${fail} FAIL`)
console.log('='.repeat(52))

server.close()
fs.rmSync(tmp, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
