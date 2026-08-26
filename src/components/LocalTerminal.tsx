import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { History } from 'lucide-react'
import { FullHistoryViewer } from './FullHistoryViewer'
import { registerTerminalSend, unregisterTerminalSend, registerTerminalExporter, unregisterTerminalExporter, registerTerminalFocus, unregisterTerminalFocus } from '../lib/TerminalBridge'
import { withWsToken } from '../lib/token'

interface Props {
  id: string
  name: string
  /** 本地会话工作目录(PowerShell 以该目录启动) */
  cwd: string
  /** 当前是否为可见(激活)会话:不可见时保持挂载、WS 不断,仅用 CSS 显隐 */
  active: boolean
  /** 会话在后台(非激活)收到输出时回调,用于标签页提醒 */
  onActivity?: (sessionId: string) => void
}

// ===== 终端字节流走 UTF-8 安全编解码(与 Terminal.tsx 一致) =====
// 后端把 node-pty 输出按 UTF-8 字节 base64 编码后下发,解码必须还原成原始字节,
// 否则多字节字符(中文/边框字符)会逐字节显示成乱码。
function decodeBase64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// 输入:文本 → UTF-8 字节 → base64(兼容中文/控制符/多字节输入)
function encodeInputBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin)
}

// 本地终端(本机 PowerShell,node-pty ConPTY):
// 镜像 Terminal.tsx 的结构,但连接 /ws/local?session=<id>&cwd=<dir>,无服务器连接前提。
// 终端实例常驻挂载(由 App 控制显隐),WS 断开有限次重连;
// 在 WS 就绪时按自身会话 id 注册进 TerminalBridge,供本地命令集注入/聚焦/导出。
export function LocalTerminal({ id, name, cwd, active, onActivity }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const retryRef = useRef(0) // 有限重连计数
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [retryTick, setRetryTick] = useState(0)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  // active 不进 WS effect 依赖(避免重连死循环),用 ref 反映是否可见,供后台提醒判断
  const activeRef = useRef(active)
  activeRef.current = active
  // 自连接以来收到的全部终端文本(供「查看完整历史」,不限大小;仅连接时累积)
  const fullContentRef = useRef('')

  // 是否停留在终端视口底部(写入后保持回到底部,避免跳到会话最上方)。
  // 容差 1 行:末行无换行(提示符/光标行)时 xterm 报告的"底部"比实际少 1 行,
  // 严格比较会把已在底部的会话误判为"不在底部",尺寸变化后不回粘底而"飘"到顶部
  const wasAtBottom = () => {
    const t = termRef.current
    if (!t || !t.buffer.active) return true
    return t.buffer.active.viewportY + t.rows >= t.buffer.active.length - 1
  }

  // 拟合并保持滚动位置:fit() 在部分 xterm 版本会重置 scrollTop,原本在底部则回到底部
  const fitPreserving = () => {
    const atBottom = wasAtBottom()
    try { fitRef.current?.fit() } catch {}
    if (atBottom) termRef.current?.scrollToBottom()
  }

  // 拟合并无条件定位到最底部(光标处):切回会话/从隐藏恢复时用,隐藏期间滚动
  // 位置可能已被重置,必须强制回底;补一帧对抗 fit 重排与滚动同步的竞态
  const fitAndGoBottom = () => {
    try { fitRef.current?.fit() } catch {}
    termRef.current?.scrollToBottom()
    requestAnimationFrame(() => { try { termRef.current?.scrollToBottom() } catch {} })
  }
  const fitAndGoBottomRef = useRef(fitAndGoBottom)
  fitAndGoBottomRef.current = fitAndGoBottom

  // 激活时重新拟合并回到光标处(隐藏时容器尺寸为 0,重新显示必须重算行列)
  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => fitAndGoBottomRef.current())
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // 初始化终端(只跑一次;WS 生命周期独立管理)
  useEffect(() => {
    if (!containerRef.current) return

    const term = new XTerm({
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      fontSize: 14,
      scrollback: 200000, // 可视缓冲适度增大;完整历史由「查看完整历史」全量展示
      theme: {
        background: '#0a0e14',
        foreground: '#c8d3e0',
        cursor: '#10b981',
        cursorAccent: '#0a0e14',
        selectionBackground: '#1c3a2e',
        black: '#0a0e14',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#3b82f6',
        magenta: '#ec4899',
        cyan: '#06b6d4',
        white: '#e2e8f0',
        brightBlack: '#475569',
        brightRed: '#f87171',
        brightGreen: '#34d399',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#f472b6',
        brightCyan: '#22d3ee',
        brightWhite: '#f8fafc',
      },
      cursorBlink: true,
      cursorStyle: 'bar',
      allowProposedApi: true,
      // 右键不选择单词,交给粘贴处理
      rightClickSelectsWord: false,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)
    termRef.current = term
    fitRef.current = fitAddon
    fitPreserving()

    // 左键选中即复制(非安全上下文 http://IP 下剪贴板 API 可能被拒,静默忽略)
    const selectionDisposable = term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (!sel) return
      navigator.clipboard?.writeText(sel).catch(() => {})
    })

    // 右键粘贴
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      term.focus()
      navigator.clipboard?.readText().then((text) => {
        if (text) term.paste(text)
      }).catch(() => {})
    }
    const el = containerRef.current
    el.addEventListener('contextmenu', onContextMenu)

    // 滚轮"滚不到真正底部"的补偿(与 Terminal.tsx 相同:末端附近向下滚时精确对齐底部)
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY <= 0) return
      const t = termRef.current
      if (!t || !t.buffer.active) return
      const buf = t.buffer.active
      if (buf.viewportY + t.rows >= buf.length - 1) {
        t.scrollToBottom()
      }
    }
    el.addEventListener('wheel', onWheel, { passive: true })

    // 容器尺寸变化即重算行列(隐藏/面板开合/窗口变化等场景)
    let ro: ResizeObserver | null = null
    // 从隐藏恢复(尺寸 0→非 0)时无条件回到底部;可见期间的高度变化才保持滚动位置
    let roHadSize = false
    try {
      ro = new ResizeObserver(() => {
        if (!el.clientWidth || !el.clientHeight) { roHadSize = false; return }
        const becameVisible = !roHadSize
        roHadSize = true
        if (becameVisible) fitAndGoBottomRef.current()
        else fitPreserving()
      })
      ro.observe(el)
    } catch {
      window.addEventListener('resize', fitPreserving)
    }

    return () => {
      ro?.disconnect()
      el.removeEventListener('contextmenu', onContextMenu)
      el.removeEventListener('wheel', onWheel)
      selectionDisposable?.dispose()
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      term.dispose()
      termRef.current = null
    }
  }, [])

  // 连接 /ws/local(本机 PowerShell)。依赖只用 [id, cwd, retryTick]:
  // connected/connecting 是纯 UI 状态,放进依赖会形成"断开→重连"死循环;
  // 单一连接由 wsRef 保证;retryTick 仅驱动有限次自动重连。
  useEffect(() => {
    // 已有连接(已打开或连接中)时不重复创建
    const existing = wsRef.current
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return
    }

    setConnecting(true)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = withWsToken(`${protocol}//${window.location.host}/ws/local?session=${encodeURIComponent(id)}&cwd=${encodeURIComponent(cwd || '')}`)
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    if (retryRef.current === 0) {
      termRef.current?.writeln(`\r\n\x1b[33m⏳ 正在启动本地 PowerShell(${cwd || '默认目录'})...\x1b[0m`)
    }

    ws.onopen = () => {
      setConnecting(false)
    }

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data)
        if (msg.type === 'connected') {
          retryRef.current = 0 // 连接成功,重置重连计数
          setConnected(true)
          termRef.current?.writeln(`\x1b[32m✓ 本地终端已就绪\x1b[0m\r\n`)
          // 发送初始大小
          if (fitRef.current && termRef.current) {
            const { cols, rows } = termRef.current
            ws.send(JSON.stringify({ type: 'resize', cols, rows }))
          }
          // 注册到终端桥:供本地命令集"在终端里执行" + 右键导出完整内容 + 自动聚焦
          registerTerminalSend(id, (text: string) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'input', data: encodeInputBase64(text) }))
            }
          })
          registerTerminalExporter(id, () => fullContentRef.current)
          registerTerminalFocus(id, () => { termRef.current?.focus() })
          fullContentRef.current = ''
        } else if (msg.type === 'data') {
          // 还原成 UTF-8 字节再写入,避免多字节字符乱码
          const bytes = decodeBase64ToBytes(msg.data)
          fullContentRef.current += new TextDecoder().decode(bytes)
          const atBottom = wasAtBottom()
          termRef.current?.write(bytes)
          if (atBottom) termRef.current?.scrollToBottom()
          // 后台会话仍在输出:上报给上层做标签页提醒(可见时不打扰)
          if (!activeRef.current) onActivity?.(id)
        } else if (msg.type === 'error') {
          termRef.current?.writeln(`\r\n\x1b[31m✗ 错误: ${msg.message}\x1b[0m`)
          setConnecting(false)
        }
      } catch {}
    }

    // 终端输入 → WebSocket
    const inputDisposable = termRef.current?.onData(data => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data: encodeInputBase64(data) }))
      }
    })

    // 终端大小变化 → WebSocket
    const resizeDisposable = termRef.current?.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }))
      }
    })

    ws.onclose = (ev: CloseEvent) => {
      // 仅当关闭的是当前 WS(不是被卸载清理掉的旧连接)时才提示并清引用
      if (wsRef.current === ws) {
        wsRef.current = null
        unregisterTerminalSend(id)
        unregisterTerminalExporter(id)
        unregisterTerminalFocus(id)
        setConnected(false)
        // 服务端在 node-pty 正常退出(exit/关闭标签)时以 1000+'shell-exit' 关闭:
        // 这不是故障,不重连(重连会拉起新的 PowerShell 僵尸进程)。
        // 其余断开(后端重启/网络异常)才有限退避重连:最多 3 次(1s/2s/3s)
        const shellExited = ev.code === 1000 && ev.reason === 'shell-exit'
        if (shellExited) {
          termRef.current?.writeln(`\r\n\x1b[90m(shell 已退出,如需继续可关闭本标签后重新打开)\x1b[0m`)
        } else if (retryRef.current < 3) {
          termRef.current?.writeln(`\r\n\x1b[33m⚠ 连接已断开,正在重连...\x1b[0m`)
          const delay = 1000 * (retryRef.current + 1)
          retryRef.current += 1
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null
            setRetryTick(t => t + 1) // 触发 effect 重新建立一条新连接
          }, delay)
        } else {
          termRef.current?.writeln(`\r\n\x1b[31m✗ 重连失败,请关闭标签后重新打开\x1b[0m`)
        }
      }
      setConnecting(false)
      inputDisposable?.dispose()
      resizeDisposable?.dispose()
    }

    ws.onerror = () => {
      // 不做额外输出(onclose 会统一提示)
      setConnecting(false)
    }

    return () => {
      // 卸载/切换时只关闭自己创建的这个 WS,不误关新连接
      if (wsRef.current === ws) {
        wsRef.current = null
        ws.close()
      }
      unregisterTerminalSend(id)
      unregisterTerminalExporter(id)
      unregisterTerminalFocus(id)
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      inputDisposable?.dispose()
      resizeDisposable?.dispose()
    }
  }, [id, cwd, retryTick])

  return (
    <div className="relative h-full bg-bg-900" style={{ display: active ? 'block' : 'none' }}>
      {/* 终端容器:始终渲染,保证 xterm 初始化时 containerRef 可用 */}
      <div ref={containerRef} className="h-full w-full" />

      {/* 顶部状态条 */}
      <div className="absolute top-2 right-3 z-10 flex items-center gap-2">
        <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
          connected
            ? 'text-accent-400 bg-accent-500/10 border-accent-500/20'
            : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
        }`}>
          {connected ? '● 终端就绪' : (connecting ? '● 启动中...' : '● 未连接')}
        </span>
        {connected && (
          <button
            onClick={() => { try { containerRef.current?.blur() } catch {}; setShowHistory(true) }}
            className="text-[10px] px-2 py-0.5 rounded-full border text-accent-400 bg-accent-500/10 border-accent-500/30 hover:bg-accent-500/20 flex items-center gap-1"
            title="查看该会话自连接以来的全部历史输出(不限大小)"
          >
            <History size={10} /> 查看完整历史
          </button>
        )}
      </div>

      {/* 全量历史查看器 */}
      {showHistory && (
        <FullHistoryViewer
          title={`${name || id} · 完整历史`}
          text={fullContentRef.current}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  )
}
