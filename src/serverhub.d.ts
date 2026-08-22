// electron/preload.cjs 通过 contextBridge 暴露的桌面能力(原生文件对话框)。
// 浏览器模式下 window.serverhub 为空,前端代码须做降级(走 Blob/<input type=file>)。
export {}

declare global {
  interface Window {
    serverhub?: {
      /** 弹出原生「另存为」对话框并写入文件;返回所选路径 */
      saveFile(opts: { defaultPath?: string; content?: string }): Promise<
        { canceled: boolean; filePath: string | null; error?: string }
      >
      /** 弹出原生「打开」对话框并读取文件内容 */
      openFile(opts: { filters?: { name: string; extensions: string[] }[] }): Promise<
        { canceled: boolean; filePath: string | null; content: string | null; error?: string }
      >
    }
  }
}
