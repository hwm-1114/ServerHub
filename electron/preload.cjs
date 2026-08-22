// 预加载脚本:在隔离上下文中向渲染进程暴露受控的桌面能力。
// 当前仅用于「命令导入/导出」的原生保存/打开对话框 + 记住上次目录。
// contextIsolation 开启,渲染进程只能通过 window.serverhub 访问这些封装好的方法,
// 拿不到 Node 的能力,避免安全风险。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('serverhub', {
  /**
   * 弹出原生「另存为」对话框并写入文件。
   * @param {object} opts
   * @param {string} [opts.defaultPath] 建议的保存路径(默认目录 + 文件名)
   * @param {string} [opts.content] 要写入的文件内容(取消对话框则忽略)
   * @returns {Promise<{ canceled: boolean, filePath: string | null }>}
   */
  saveFile: (opts = {}) => ipcRenderer.invoke('serverhub:saveFile', opts),

  /**
   * 弹出原生「打开」对话框并读取文件内容。
   * @param {object} opts
   * @param {Array<{name: string, extensions: string[]}>} [opts.filters] 文件类型过滤器
   * @returns {Promise<{ canceled: boolean, filePath: string | null, content: string | null }>}
   */
  openFile: (opts = {}) => ipcRenderer.invoke('serverhub:openFile', opts),
})
