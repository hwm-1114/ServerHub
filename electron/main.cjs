// ServerHub 桌面应用主进程(Electron)
// 两种模式:
//  - 生产(release/win-unpacked/ServerHub.exe):启动内置的 Express+WS 后端,加载其 UI。
//  - 开发(ELECTRON_START_URL 已设置,见 `npm run app:dev`):不启动后端,
//    直接加载 Vite 开发服务器(HMR),后端由 nodemon 单独提供 —— 改代码即时生效。
// 所有前端功能(SSH 终端/WS、SFTP、命令预设等)通过相对路径 /api、/ws 走同一 http 源,原样可用。

const { app, BrowserWindow, shell, dialog, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')

app.setName('ServerHub')

// 开发模式:ELECTRON_START_URL 例如 http://localhost:5173
const DEV_URL = process.env.ELECTRON_START_URL || ''
const isDev = !!DEV_URL

// 打包后 asar 只读,数据必须写到可写目录(Electron userData,如 %APPDATA%/ServerHub)。
// 开发模式后端(nodemon)会读到该 env,同样写到这里,保持一致。
process.env.SERVERHUB_DATA_DIR = app.getPath('userData')

let win = null

// ========== 记住上次导入/导出目录 ==========
// 存到 userData/ui-prefs.json,后续打开/保存对话框默认跳到该目录,免重复导航。
const PREFS_FILE = () => path.join(app.getPath('userData'), 'ui-prefs.json')

function readPrefs() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_FILE(), 'utf-8')) || {}
  } catch {
    return {}
  }
}

function writePrefs(patch) {
  try {
    const cur = readPrefs()
    fs.writeFileSync(PREFS_FILE(), JSON.stringify({ ...cur, ...patch }, null, 2), 'utf-8')
  } catch {}
}

function getLastDir(fallback) {
  const dir = readPrefs().lastDir
  // 已记住的目录可能被删除,存在性校验后使用
  if (dir && fs.existsSync(dir)) return dir
  return fallback
}

function rememberLastDir(filePath) {
  if (!filePath) return
  const dir = path.dirname(filePath)
  try {
    if (fs.existsSync(dir)) writePrefs({ lastDir: dir })
  } catch {}
}

// 注册原生文件对话框的 IPC(记住上次目录)
function registerFileDialogs() {
  ipcMain.handle('serverhub:saveFile', async (_evt, opts = {}) => {
    const win2 = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const def = opts.defaultPath || '命令行导出.txt'
    const { canceled, filePath } = await dialog.showSaveDialog(win2, {
      title: '导出命令',
      defaultPath: path.join(getLastDir(path.dirname(def)), path.basename(def)),
      filters: opts.filters || [{ name: '文本文件', extensions: ['txt'] }],
    })
    if (canceled || !filePath) return { canceled: true, filePath: null }
    rememberLastDir(filePath)
    try {
      fs.writeFileSync(filePath, String(opts.content ?? ''), 'utf-8')
    } catch (err) {
      return { canceled: false, filePath, error: String(err && err.message || err) }
    }
    return { canceled: false, filePath }
  })

  ipcMain.handle('serverhub:openFile', async (_evt, opts = {}) => {
    const win2 = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0]
    const { canceled, filePaths } = await dialog.showOpenDialog(win2, {
      title: '导入命令',
      defaultPath: getLastDir(app.getPath('documents')),
      properties: ['openFile'],
      filters: opts.filters || [{ name: '命令文件', extensions: ['txt', 'json'] }],
    })
    if (canceled || !filePaths || !filePaths[0]) return { canceled: true, filePath: null, content: null }
    const filePath = filePaths[0]
    rememberLastDir(filePath)
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      return { canceled: false, filePath, content }
    } catch (err) {
      return { canceled: false, filePath, content: null, error: String(err && err.message || err) }
    }
  })
}

function waitForServer(server) {
  if (server.listening) return Promise.resolve()
  return new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
}

// 开发时 Vite 可能还没起来,带重试地加载,直到成功
async function loadWithRetry(win2, url, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      await win2.loadURL(url)
      return
    } catch (err) {
      await new Promise(r => setTimeout(r, 500))
    }
  }
  throw new Error(`无法加载 ${url}(开发服务器未就绪)`)
}

// ========== 导航守卫 ==========
// 取 URL 的源(协议+主机+端口);无法解析(含 file://,其 origin 为 "null")返回空串。
function urlOrigin(target) {
  try {
    return new URL(target).origin
  } catch {
    return ''
  }
}

// 只允许导航到应用自身源(开发为 Vite 地址,生产为内置后端地址)。
// 修复背景:把本地文件拖到没有投放处理的区域(侧栏/顶栏/终端空白处)时,浏览器默认
// 行为是"打开该文件",在 Electron 里就是整窗导航到 file:///C:/... —— SPA 被替换、
// 全部活动 SSH 会话丢失,而 autoHideMenuBar 下连返回入口都没有。
function isAllowedNavigation(target, appOrigin) {
  if (!appOrigin) return false
  return urlOrigin(target) === appOrigin
}

function createWindow() {
  // 应用自身源:开发模式取 ELECTRON_START_URL(Vite),生产模式取内置后端地址。
  // PORT 在 whenReady 里才赋值,所以必须在这里(createWindow 内)读取。
  const appOrigin = isDev
    ? urlOrigin(DEV_URL)
    : urlOrigin(`http://localhost:${process.env.PORT || '33120'}`)
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 600,
    title: 'ServerHub',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
  })
  // 页面里的外链用系统浏览器打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // 除应用自身源外的导航一律拦下:外部 http(s) 交给系统浏览器,file:// 等直接丢弃。
  // 同源导航(SPA 内跳转、查询串变化)照常放行;刷新(F5 / reload)不触发本事件,不受影响。
  const guardNavigation = (event, url) => {
    if (isAllowedNavigation(url, appOrigin)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) shell.openExternal(url)
  }
  win.webContents.on('will-navigate', guardNavigation)
  // 3xx 重定向同样可能把窗口带离应用,拦截逻辑保持一致
  win.webContents.on('will-redirect', guardNavigation)
  return win
}

app.whenReady().then(async () => {
  try {
    // 单实例锁:第二次双击快捷方式时不再启动第二个进程。
    // 否则第二个进程会去抢内置后端的 33120 端口(EADDRINUSE → 弹英文堆栈错误框后退出),
    // 极端时序下 listen 的错误还可能被 server/index.js 的 crash-guard 只记录不退出,
    // 于是留下"没有窗口却常驻"的僵尸进程,反复双击会越积越多。
    if (!app.requestSingleInstanceLock()) {
      app.quit()
      return
    }
    app.on('second-instance', () => {
      // 把已有窗口拉到前台(用户以为"没打开",实际只是被别的窗口挡住了)
      const existing = BrowserWindow.getAllWindows()[0]
      if (existing) {
        if (existing.isMinimized()) existing.restore()
        existing.show()
        existing.focus()
      }
    })
    registerFileDialogs()
    if (isDev) {
      // 开发:只加载 Vite(HMR),后端由 nodemon 提供
      win = createWindow()
      await loadWithRetry(win, DEV_URL)
    } else {
      // 生产:启动内置后端
      process.env.PORT = process.env.PORT || '33120'
      const mod = await import('../server/index.js')
      await waitForServer(mod.server)
      win = createWindow()
      await win.loadURL(`http://localhost:${process.env.PORT}`)
    }
  } catch (err) {
    dialog.showErrorBox('ServerHub 启动失败', String((err && err.stack) || err))
    app.quit()
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) app.quit()
})
