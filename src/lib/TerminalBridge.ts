// 终端桥:命令面板需要"在终端里直接执行"的命令注入到对应会话的 WS。
// Terminal 组件在 WS 就绪时 register(sessionId, sendInput),卸载/掉线时 unregister。
// 这样命令面板只需知道目标 sessionId 即可把命令"敲进"终端。
type SendInput = (text: string) => void
// 导出会话完整内容(sessionId -> 自连接以来收到的全部文本),用于右键导出 txt。
type GetContent = () => string
// 让终端获得焦点(命令点击后直接可以在终端输入)
type Focus = () => void

const registry = new Map<string, SendInput>()
const exporterRegistry = new Map<string, GetContent>()
const focusRegistry = new Map<string, Focus>()

export function registerTerminalSend(sessionId: string, fn: SendInput) {
  registry.set(sessionId, fn)
}

export function unregisterTerminalSend(sessionId: string) {
  registry.delete(sessionId)
}

/** 注册让某会话终端获得焦点的回调(供命令面板点击后自动聚焦,无需再点终端) */
export function registerTerminalFocus(sessionId: string, fn: Focus) {
  focusRegistry.set(sessionId, fn)
}

export function unregisterTerminalFocus(sessionId: string) {
  focusRegistry.delete(sessionId)
}

/** 让指定会话终端获得焦点;返回是否真的找到该终端 */
export function focusTerminal(sessionId: string): boolean {
  const fn = focusRegistry.get(sessionId)
  if (!fn) return false
  fn()
  return true
}

/** 注册会话内容的导出器(Terminal 在 WS 就绪时注册,卸载/掉线时注销) */
export function registerTerminalExporter(sessionId: string, fn: GetContent) {
  exporterRegistry.set(sessionId, fn)
}

export function unregisterTerminalExporter(sessionId: string) {
  exporterRegistry.delete(sessionId)
}

/** 取回某会话自连接以来的全部终端内容(供导出 txt);返回 null 表示无该会话内容 */
export function getTerminalContent(sessionId: string): string | null {
  const fn = exporterRegistry.get(sessionId)
  if (!fn) return null
  return fn()
}

/** 命令文本发送到指定会话终端(多行支持);返回是否真的有终端接住 */
export function sendToTerminal(sessionId: string, text: string): boolean {
  const fn = registry.get(sessionId)
  if (!fn) return false
  fn(text)
  return true
}
