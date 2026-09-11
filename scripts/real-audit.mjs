// 真机回归审计:用应用真实后端连一台真实 Linux 服务器,验证"离线 fake harness 测不出来"的部分
// (分片边界、符号链接语义、bash 回显、SFTP 错误码、真实 sshd 的 maxsessions 分摊)。
//
// 用法(凭据只走环境变量,不落盘、不进仓库):
//   $env:SH_HOST='1.2.3.4'; $env:SH_USER='root'; $env:SH_PASS='***'; node scripts/real-audit.mjs
// 未设置 SH_HOST/SH_USER/SH_PASS 时直接跳过(退出码 0),便于在无真机环境安全调用。
//
// 安全:只在自己的 scratch 目录(/root/serverhub-audit-<ts>)内增删,结束时删除;
//       不修改服务器任何配置,不安装任何东西。
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { WebSocket } = require('ws')

const HOST = process.env.SH_HOST, USER = process.env.SH_USER, PASS = process.env.SH_PASS
if (!HOST || !USER || !PASS) {
  console.log('[real-audit] 未设置 SH_HOST/SH_USER/SH_PASS,跳过真机审计')
  process.exit(0)
}
const DIR = `/root/serverhub-audit-${Date.now()}`

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'serverhub-real-'))
process.env.SERVERHUB_DATA_DIR = dataDir
fs.writeFileSync(path.join(dataDir, 'servers.json'), JSON.stringify([
  { id: 'srv-real', name: 'real', host: HOST, port: 22, username: USER, password: PASS },
]))
const PORT = Number(process.env.REAL_AUDIT_PORT || 38150)
process.env.PORT = String(PORT)
const { server } = await import('../server/index.js')
if (!server.listening) await new Promise(r => server.once('listening', r))
const BASE = `http://127.0.0.1:${PORT}`
const enc = encodeURIComponent
const sleep = ms => new Promise(r => setTimeout(r, ms))

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ✅', label) } else { fail++; console.log('  ❌', label) }
  if (extra) console.log('     ', extra)
}
const jpost = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))
const dl = (p) => fetch(`${BASE}/api/servers/srv-real/files/download?path=${enc(p)}`)
const del = (p) => fetch(`${BASE}/api/servers/srv-real/files?path=${enc(p)}`, { method: 'DELETE' }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))
const list = (p) => fetch(`${BASE}/api/servers/srv-real/files?path=${enc(p)}`).then(r => r.json())
const upload = (dir, name, buf) => fetch(`${BASE}/api/servers/srv-real/files/upload?path=${enc(dir)}&name=${enc(name)}`, { method: 'POST', body: buf, headers: { 'Content-Length': String(buf.length) } }).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }))
const sh = async (cmd) => (await jpost('/api/servers/srv-real/execute', { command: cmd })).body.stdout ?? ''
const mkSession = async () => (await jpost('/api/servers/srv-real/sessions', {})).body
const delSession = (id) => fetch(`${BASE}/api/servers/srv-real/sessions/${id}`, { method: 'DELETE' })

console.log(`\n真机审计 ${USER}@${HOST}  scratch=${DIR}`)
try {

// 夹具:中文大输出用于分片边界测试。
// 长度必须正好是"一行 19 字节(6 个汉字 18 字节 + 换行)"的整数倍,否则文件自身就以
// 半个汉字结尾,cat 出来必然有 1 个 U+FFFD,会把断言变成假阳性。19 × 157894 = 2999986。
await sh(`mkdir -p '${DIR}/tricky' '${DIR}/target/sub' '${DIR}/sub' '${DIR}/dir with space'
cd '${DIR}/tricky' && printf 'PERCENT-RAW' > '50%off.txt' && printf 'PERCENT-25' > '100%25.txt' && printf 'DECOY' > '100%.txt' && printf 'SPACE' > 'a b.txt' && printf 'QUOTE' > "it's.txt" && printf 'UNICODE' > '中文名.txt'
printf 'IMPORTANT' > '${DIR}/target/important.txt'; printf 'DEEP' > '${DIR}/target/sub/deep.txt'
ln -sfn '${DIR}/target' '${DIR}/link-to-dir'; ln -sfn '${DIR}/target/important.txt' '${DIR}/link-to-file'; ln -sfn '${DIR}/nope' '${DIR}/link-dangling'
yes '中文输出测试' | head -c 2999986 > '${DIR}/cn.txt'; wc -c < '${DIR}/cn.txt'`)

// ---------- 1. 文件名含 % ----------
console.log('\n【1】文件名含 % :下载/删除必须打到同一个文件')
{
  const l = await list(`${DIR}/tricky`)
  ok((l.entries || []).length === 6, '列目录正常', `entries=${(l.entries || []).length}`)

  const r1 = await dl(`${DIR}/tricky/50%off.txt`)
  const t1 = await r1.text()
  ok(r1.status === 200 && t1 === 'PERCENT-RAW', '下载 50%off.txt 成功(旧实现 500 URI malformed)', `HTTP ${r1.status} body=${JSON.stringify(t1.slice(0, 40))}`)

  const r2 = await dl(`${DIR}/tricky/100%25.txt`)
  const t2 = await r2.text()
  ok(r2.status === 200 && t2 === 'PERCENT-25', '下载 100%25.txt 拿到自己的内容(旧实现拿到 100%.txt 的 DECOY)', `HTTP ${r2.status} body=${JSON.stringify(t2)}`)

  const before = await sh(`ls -1 '${DIR}/tricky' | sort | tr '\\n' ' '`)
  const d2 = await del(`${DIR}/tricky/100%25.txt`)
  const after = await sh(`ls -1 '${DIR}/tricky' | sort | tr '\\n' ' '`)
  const gone = before.split(/\s+/).filter(x => x && !after.split(/\s+/).includes(x))
  ok(d2.status === 200 && gone.length === 1 && gone[0] === '100%25.txt', '删除 100%25.txt 删的是它自己(旧实现删掉 100%.txt)', `HTTP ${d2.status} 实际消失=${JSON.stringify(gone)}`)

  const d1 = await del(`${DIR}/tricky/50%off.txt`)
  const still = (await sh(`test -e '${DIR}/tricky/50%off.txt' && echo YES || echo NO`)).trim()
  ok(d1.status === 200 && still === 'NO', '删除 50%off.txt 成功(旧实现 500 且文件仍在)', `HTTP ${d1.status} 仍在=${still}`)

  for (const [name, expect] of [['a b.txt', 'SPACE'], ["it's.txt", 'QUOTE'], ['中文名.txt', 'UNICODE']]) {
    const r = await dl(`${DIR}/tricky/${name}`)
    ok(r.status === 200 && (await r.text()) === expect, `对照:下载 ${name} 正常`)
  }
}

// ---------- 2. 符号链接删除(真机 P0)----------
console.log('\n【2】符号链接删除:只删链接,绝不穿透目标')
{
  const d = await del(`${DIR}/link-to-dir`)
  const linkGone = (await sh(`test -L '${DIR}/link-to-dir' && echo NO || echo YES`)).trim()
  const targetOk = (await sh(`test -f '${DIR}/target/important.txt' && test -f '${DIR}/target/sub/deep.txt' && echo YES || echo NO`)).trim()
  ok(d.status === 200 && linkGone === 'YES' && targetOk === 'YES',
    '删除指向目录的链接:链接消失 + 目标内容完好(旧实现清空目标内容并报 500)',
    `HTTP ${d.status} 链接已删=${linkGone} 目标完好=${targetOk}`)

  const d2 = await del(`${DIR}/link-dangling`)
  const dg = (await sh(`test -L '${DIR}/link-dangling' && echo NO || echo YES`)).trim()
  ok(d2.status === 200 && dg === 'YES', '删除悬空链接成功(旧实现永远删不掉)', `HTTP ${d2.status}`)

  const d3 = await del(`${DIR}/link-to-file`)
  const t3 = (await sh(`test -f '${DIR}/target/important.txt' && echo YES || echo NO`)).trim()
  ok(d3.status === 200 && t3 === 'YES', '删除指向文件的链接:目标文件完好', `HTTP ${d3.status}`)

  const d4 = await del(`${DIR}/target`)
  ok(d4.status === 200, '真实目录仍可递归删除', `HTTP ${d4.status}`)
}

// ---------- 3. cwd 采集(真机 P1:复制路径/复制会话)----------
console.log('\n【3】cwd 采集:正确性 + 不误执行用户半截输入 + 兜底不挂死')
{
  const s1 = await mkSession()
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal?serverId=srv-real&session=${s1.id}`)
  const buf = []
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'data') buf.push(Buffer.from(m.data, 'base64')) })
  await new Promise(r => ws.on('message', d => JSON.parse(d.toString()).type === 'connected' && r()))
  const send = t => ws.send(JSON.stringify({ type: 'input', data: Buffer.from(t).toString('base64') }))
  const text = () => Buffer.concat(buf).toString('utf8').replace(/\x1b\[[0-9;:<=>?]*[ -\/]*[@-~]/g, '').replace(/\x1b/g, '')

  send(`cd '${DIR}/dir with space'\r`)
  await sleep(1500)
  const g1 = await fetch(`${BASE}/api/servers/srv-real/sessions/${s1.id}/cwd`).then(r => r.json())
  ok(g1.cwd === `${DIR}/dir with space`, '含空格路径的 cwd 测量正确(旧实现恒为空)', `返回 ${JSON.stringify(g1.cwd)}`)

  // 半截输入 + 测量:注入前 Ctrl-U 会清掉半截输入(刻意取舍),但绝不能把半截输入
  // 与注入命令拼接成畸形命令去执行(旧实现会执行成 "HELprintf ..." → command not found)
  buf.length = 0
  send('echo HEL')
  await sleep(600)
  const g2 = await fetch(`${BASE}/api/servers/srv-real/sessions/${s1.id}/cwd`).then(r => r.json())
  await sleep(1200)
  const seen = text()
  // 只判定"注入痕迹"与"半截输入被拼接执行";不把任何 command not found 当失败
  // (测试自身后续发的裸字符串也会产生 command not found,那是测试输入而非缺陷)
  const polluted = /SCWD_/.test(seen)
  const concatenated = /HELprintf/.test(seen)
  ok(!polluted && !concatenated && g2.cwd === `${DIR}/dir with space`,
    '测量 cwd 不会把用户半截输入拼进注入命令里执行(旧实现会执行成 HELprintf ...)',
    `cwd=${JSON.stringify(g2.cwd)} 注入痕迹=${polluted} 拼接痕迹=${concatenated}`)

  buf.length = 0
  send('echo AFTER-MEASURE-OK\r')
  await sleep(1500)
  ok(/AFTER-MEASURE-OK/.test(text()), '测量后会话仍能正常执行命令', JSON.stringify(text().slice(-100)))

  send('sleep 4\r')
  await sleep(400)
  const t0 = Date.now()
  const g3 = await fetch(`${BASE}/api/servers/srv-real/sessions/${s1.id}/cwd`).then(r => r.json())
  const ms = Date.now() - t0
  ok(ms < 8000, '前台被 sleep 占用时 cwd 请求及时兜底返回(不挂死)', `耗时 ${ms}ms 返回=${JSON.stringify(g3.cwd)}`)
  await sleep(4000)
  try { ws.close() } catch {}
  await delSession(s1.id)
  await sleep(300)
}

// ---------- 4. 拖入文件夹:mkdir -p 后写入嵌套目录 ----------
console.log('\n【4】拖入含子目录的文件夹(前端会先 mkdir -p 再上传)')
{
  const buf = Buffer.from('NESTED-OK')
  const bad = await upload(`${DIR}/sub/not-exist`, 'x.txt', buf)
  ok(bad.status !== 201, '直接上传到不存在的子目录仍失败(父目录未创建)', `HTTP ${bad.status} ${JSON.stringify(bad.body).slice(0, 110)}`)

  const mk = await jpost('/api/servers/srv-real/files/mkdir', { path: `${DIR}/sub/not-exist`, existOk: true })
  ok(mk.status === 200, 'existOk=true 的 mkdir 补建父目录成功', `HTTP ${mk.status} ${JSON.stringify(mk.body)}`)

  const mk2 = await jpost('/api/servers/srv-real/files/mkdir', { path: `${DIR}/sub/not-exist`, existOk: true })
  ok(mk2.status === 200, 'existOk 幂等:重复补建仍成功', `HTTP ${mk2.status}`)

  const good = await upload(`${DIR}/sub/not-exist`, 'x.txt', buf)
  const content = (await sh(`cat '${DIR}/sub/not-exist/x.txt' 2>/dev/null || echo MISSING`)).trim()
  ok(good.status === 201 && content === 'NESTED-OK', '补建父目录后上传成功且内容正确', `HTTP ${good.status} 内容=${content}`)

  const dup = await jpost('/api/servers/srv-real/files/mkdir', { path: `${DIR}/sub/not-exist` })
  ok(dup.status !== 200, '不带 existOk 时建已存在目录仍报错(建目录对话框语义)', `HTTP ${dup.status} ${JSON.stringify(dup.body)}`)

  const bad2 = await jpost('/api/servers/srv-real/files/mkdir', { path: `${DIR}/sub/not-exist/x.txt/deep` })
  ok(bad2.status !== 200 && /不是目录|已存在/.test(bad2.body.error || ''), '父级是文件时给出中文原因', `HTTP ${bad2.status} ${JSON.stringify(bad2.body)}`)
}

// ---------- 5. 错误信息中文化 ----------
console.log('\n【5】下载错误信息')
{
  const r1 = await dl(`${DIR}/sub`)
  const b1 = await r1.json()
  ok(r1.status === 400 && /目录/.test(b1.error || ''), '下载目录 → 中文提示(旧实现 "Failure")', `HTTP ${r1.status} ${JSON.stringify(b1).slice(0, 90)}`)
  const r2 = await dl(`${DIR}/nope.txt`)
  const b2 = await r2.json()
  ok(r2.status === 404 && /不存在/.test(b2.error || ''), '下载不存在的文件 → 中文提示', `HTTP ${r2.status} ${JSON.stringify(b2).slice(0, 90)}`)
}

// ---------- 6. 命令集导出/导入往返(scope=all)----------
console.log('\n【6】命令集:导出含本地命令 + 导入往返不丢')
{
  await jpost('/api/commands', { name: '真机远程命令', command: 'echo r', category: 'custom' })
  await jpost('/api/commands', { name: '真机本地命令', command: 'dir', category: 'custom', scope: 'local' })
  const all = await (await fetch(`${BASE}/api/commands?scope=all`)).json()
  ok(all.some(c => c.scope === 'local'), 'scope=all 返回本地命令集', `共 ${all.length} 条`)
  const imp = await jpost('/api/commands/import', { commands: JSON.parse(JSON.stringify(all)) })
  const localAfter = await (await fetch(`${BASE}/api/commands?scope=local`)).json()
  ok(imp.status === 200 && localAfter.length === 1, '导出→导入往返后本地命令集仍在', `导入 ${imp.body.count} 条 本地剩余 ${localAfter.length} 条`)
}

// ---------- 7. UTF-8 分片 + 流式解码 ----------
console.log('\n【7】中文大输出的 WS 分片:流式解码结果必须无乱码(修复后的前端行为)')
{
  const s2 = await mkSession()
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal?serverId=srv-real&session=${s2.id}`)
  const frames = []
  ws.on('message', d => { const m = JSON.parse(d.toString()); if (m.type === 'data') frames.push(Buffer.from(m.data, 'base64')) })
  await new Promise(r => ws.on('message', d => JSON.parse(d.toString()).type === 'connected' && r()))
  await sleep(400)
  frames.length = 0
  // 哨兵必须"远端拼出来":直接写在命令里的哨兵会被终端回显,回显先到就会提前退出等待
  // (与应用捕获 cwd 时踩的是同一个坑)。printf 'REAL%s\n' '-AUDIT-DONE' 的回显里只有
  // REAL%s 与 -AUDIT-DONE,只有输出里才出现完整哨兵。
  ws.send(JSON.stringify({ type: 'input', data: Buffer.from(`cat '${DIR}/cn.txt'; printf 'REAL%s\\n' '-AUDIT-DONE'\r`).toString('base64') }))
  const decodeAll = (streaming) => {
    if (!streaming) return frames.map(f => new TextDecoder().decode(f)).join('')
    const d = new TextDecoder('utf-8')
    let out = ''
    for (const f of frames) out += d.decode(f, { stream: true })
    return out + d.decode()
  }
  let streamed = ''
  for (let i = 0; i < 120 && !streamed.includes('REAL-AUDIT-DONE'); i++) {
    await sleep(500)
    streamed = decodeAll(true)
  }
  const perFrame = decodeAll(false)
  const mid = frames.filter(f => { const l = f[f.length - 1]; return (l & 0xc0) === 0xc0 || (l & 0xe0) === 0xc0 || (l & 0xf0) === 0xe0 }).length
  const badStream = (streamed.match(/\uFFFD/g) || []).length
  const badPerFrame = (perFrame.match(/\uFFFD/g) || []).length
  ok(badStream === 0 && badPerFrame > 50 && streamed.includes('中文输出测试'),
    '真机分片确实切在多字节字符中间,而流式解码结果无乱码且内容正确',
    `${frames.length} 帧 / ${frames.reduce((a, f) => a + f.length, 0)} 字节;末尾切在字符中间的帧 ${mid} 个;流式 U+FFFD=${badStream},逐帧 U+FFFD=${badPerFrame}(后者是修复前的行为)`)
  try { ws.close() } catch {}
  await delSession(s2.id)
  await sleep(300)
}

} finally {
  try { await sh(`rm -rf '${DIR}'`) } catch {}
  server.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
console.log('\n' + '='.repeat(52))
console.log(`真机审计结果: ${pass} PASS / ${fail} FAIL`)
console.log('='.repeat(52))
process.exit(fail ? 1 : 0)
