// 安装包(NSIS)验证:静默安装 → 启动已安装的应用 → 种入数据 → 覆盖安装 → 数据仍在 → 静默卸载。
// 用 --user-data-dir 把 userData 指到临时目录,避免碰真实的 %APPDATA%/ServerHub。
// 用法: npm run dist:nsis   (先出包;等价于 npx electron-builder --win nsis --publish never)
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'

const relDir = path.join(process.cwd(), 'release')
// 出包中途会生成临时卸载器 `ServerHub Setup <ver>.__uninstaller.exe`,打包失败时会残留;
// 它的文件名同样匹配 "ServerHub Setup *.exe",必须排除。版本号优先取 package.json 里的当前版本
// (release/ 里躺着旧版本 exe 时,"取最新 mtime"仍可能挑错),取不到再退回最新的一个。
const curVersion = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8')).version
const candidates = fs.readdirSync(relDir)
  .filter(f => /^ServerHub Setup .*\.exe$/.test(f) && !f.includes('__uninstaller'))
  .map(f => ({ f, mtime: fs.statSync(path.join(relDir, f)).mtimeMs }))
const installer = (candidates.find(c => c.f === `ServerHub Setup ${curVersion}.exe`) ?? candidates.sort((a, b) => b.mtime - a.mtime)[0])?.f
if (!installer) { console.error('release/ 下没有安装包,请先运行 npm run dist:nsis'); process.exit(2) }
const INSTALLER = path.join(relDir, installer)
const INSTALL_DIR = path.join(os.tmpdir(), `sh-install-${Date.now()}`)
const DATA_DIR = path.join(os.tmpdir(), `sh-appdata-${Date.now()}`)
const APP_EXE = path.join(INSTALL_DIR, 'ServerHub.exe')
const UNINST = path.join(INSTALL_DIR, 'Uninstall ServerHub.exe')
const APP_PORT = 33120

let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log('  ✅', label) } else { fail++; console.log('  ❌', label) }
  if (extra) console.log('     ', extra)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// NSIS 静默安装:/S 静默,/D= 必须最后且不加引号
function silentInstall() {
  const r = spawnSync(INSTALLER, ['/S', `/D=${INSTALL_DIR}`], { windowsHide: true, timeout: 180000 })
  return r.status
}
async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${APP_PORT}/api/servers/status`)
      if (r.ok) return true
    } catch { /* 还没起来 */ }
    await sleep(1000)
  }
  return false
}
async function launchAndProbe() {
  const p = spawn(APP_EXE, [`--user-data-dir=${DATA_DIR}`], { detached: false, stdio: 'ignore', windowsHide: true })
  const up = await waitUp()
  return { proc: p, up }
}
function killApp() {
  spawnSync('taskkill', ['/IM', 'ServerHub.exe', '/F'], { windowsHide: true })
}

console.log(`\n安装包验证: ${installer}\n安装目录: ${INSTALL_DIR}\n数据目录: ${DATA_DIR}`)
try {
  console.log('\n【1】静默安装')
  {
    const code = silentInstall()
    ok(code === 0, '静默安装退出码为 0', `exit=${code}`)
    await sleep(2500) // 安装器可能有收尾动作
    killApp()         // runAfterFinish 可能已把应用拉起来
    await sleep(1000)
    ok(fs.existsSync(APP_EXE), '安装目录里出现 ServerHub.exe', APP_EXE)
    ok(fs.existsSync(UNINST), '生成卸载程序')
    const size = fs.existsSync(APP_EXE) ? (fs.statSync(path.join(INSTALL_DIR, 'resources', 'app.asar')).size / 1024 / 1024).toFixed(1) : '?'
    ok(fs.existsSync(path.join(INSTALL_DIR, 'resources', 'app.asar')), 'asar 已就位', `app.asar ${size} MB`)
    ok(fs.existsSync(path.join(INSTALL_DIR, 'resources', 'app.asar.unpacked', 'node_modules', 'node-pty')), 'node-pty 已 asarUnpack(本地终端依赖)')
  }

  console.log('\n【2】启动已安装的应用 + 种入数据')
  {
    const { proc, up } = await launchAndProbe()
    ok(up, '已安装的应用能启动并让内置后端在 33120 就绪', `pid=${proc.pid}`)
    const created = await fetch(`http://127.0.0.1:${APP_PORT}/api/servers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '覆盖安装留存测试', host: '10.9.9.9', port: 22, username: 'root', password: 'keepme' }),
    }).then(r => r.json()).catch(() => null)
    ok(!!created?.id, '通过 API 写入一条服务器记录', JSON.stringify(created))
    const sess = await fetch(`http://127.0.0.1:${APP_PORT}/api/servers/${created.id}/sessions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then(r => r.json()).catch(() => null)
    ok(!!sess?.id, '写入一条会话记录', JSON.stringify(sess))
    ok(fs.existsSync(path.join(DATA_DIR, 'servers.json')), '数据落在 userData(--user-data-dir 指向的目录)')
    killApp()
    await sleep(2000)
    ok(!(await fetch(`http://127.0.0.1:${APP_PORT}/api/servers/status`).then(() => true).catch(() => false)), '关闭应用后端口已释放')
  }

  console.log('\n【3】覆盖安装后数据保留(用户强要求)')
  {
    const code = silentInstall()
    ok(code === 0, '第二次(覆盖)静默安装成功', `exit=${code}`)
    await sleep(2500)
    killApp()
    await sleep(1000)
    const { up } = await launchAndProbe()
    ok(up, '覆盖安装后应用仍能启动')
    const list = await fetch(`http://127.0.0.1:${APP_PORT}/api/servers`).then(r => r.json()).catch(() => null)
    const keptServer = Array.isArray(list) && list.some(s => s.host === '10.9.9.9' && s.password === 'keepme')
    ok(keptServer, '服务器记录(含明文密码)在覆盖安装后仍在', JSON.stringify(list))
    const sid = list?.[0]?.id
    const sessions = sid ? await fetch(`http://127.0.0.1:${APP_PORT}/api/servers/${sid}/sessions`).then(r => r.json()).catch(() => null) : null
    ok(Array.isArray(sessions) && sessions.length === 1, '会话记录也保留', JSON.stringify(sessions))
    killApp()
    await sleep(2000)
  }

  console.log('\n【4】静默卸载:程序删掉、数据保留(deleteAppDataOnUninstall:false)')
  {
    const r = spawnSync(UNINST, ['/S'], { windowsHide: true, timeout: 180000 })
    ok(r.status === 0, '卸载程序退出码为 0', `exit=${r.status}`)
    // NSIS 卸载器会把自己复制到临时目录执行,等它把安装目录收尾清掉
    for (let i = 0; i < 30 && fs.existsSync(APP_EXE); i++) await sleep(1000)
    ok(!fs.existsSync(APP_EXE), '安装目录里的 ServerHub.exe 已删除')
    ok(fs.existsSync(path.join(DATA_DIR, 'servers.json')), 'userData 数据未被卸载删除', fs.existsSync(path.join(DATA_DIR, 'servers.json')) ? 'servers.json 仍在' : '被删了')
    const list = fs.existsSync(path.join(DATA_DIR, 'servers.json')) ? JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'servers.json'), 'utf8')) : []
    ok(list.some(s => s.host === '10.9.9.9'), '卸载后数据内容完整')
  }
} finally {
  killApp()
  await sleep(1000)
  try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
  try { fs.rmSync(INSTALL_DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
}
console.log('\n' + '='.repeat(52))
console.log(`安装包验证结果: ${pass} PASS / ${fail} FAIL`)
console.log('='.repeat(52))
process.exit(fail ? 1 : 0)
