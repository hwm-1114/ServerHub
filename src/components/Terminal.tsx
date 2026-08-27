import { useEffect, useRef, useState } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Plug, Copy, Check, History, Folder } from 'lucide-react'
import { FullHistoryViewer } from './FullHistoryViewer'
import { Session } from '../types'
import { registerTerminalSend, unregisterTerminalSend, registerTerminalExporter, unregisterTerminalExporter, registerTerminalFocus, unregisterTerminalFocus } from '../lib/TerminalBridge'
import { withWsToken } from '../lib/token'

interface Props {
  session: Session
  serverName: string
  isConnected: boolean
  /** 当前是否为可见(激活)会话:不可见时保持挂载、WS 不断,仅用 CSS 显隐 */
  active: boolean
  onConnect: () => void
  /** 会话在后台(非激活)收到输出时回调,用于标签页提醒 */
  onActivity?: (sessionId: string) => void
  /** 打开《文件》界面并定位到当前会话所在目录 */
  onOpenFilesAtSession?: (session: Session) => void
}

// ===== 终端字节流走 UTF-8 安全编解码 =====
// 后端把 SSH 原始字节(Buffer)base64 编码后下发,这里的解码必须还原成 UTF-8 字节,
// 否则多字节字符(如边框字符 ╭─│╰╯、█)会被逐个字节显示成 â/ââ 等乱码。
// 输出:base64 → 原始字节 Uint8Array(交给 xterm 按 UTF-8 解析)
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

export function Terminal({ session, serverName, isConnected, active, onConnect, onActivity, onOpenFilesAtSession }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const retryRef = useRef(0) // 有限重连计数
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [retryTick, setRetryTick] = useState(0)
  const [connected, setConnected] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'warn' } | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  // active 不在 WS effect 依赖里(避免重连死循环),这里用 ref 反映是否可见,供后台提醒判断
  const activeRef = useRef(active)
  activeRef.current = active
  // 自连接以来收到的全部终端文本(用于导出 txt,不限大小;仅连接时累积)
  const fullContentRef = useRef('')
  // 自连接以来收到的原始字节块(查看完整历史的"重建视图"回放用;TUI 程序输出
  // 只有经过终端状态机回放才能还原成可读内容)。含退出全屏前的抓屏快照。
  const fullBytesRef = useRef<Uint8Array[]>([])

  const showToast = (text: string, kind: 'ok' | 'warn' = 'ok') => {
    setToast({ text, kind })
  }

  // 短暂提示自动消失
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 1800)
    return () => clearTimeout(t)
  }, [toast])

  // 一键复制当前会话所在的绝对路径
  const copySessionCwd = async () => {
    try {
      const res = await fetch(`/api/servers/${session.serverId}/sessions/${session.id}/cwd`)
      const d = await res.json()
      if (!res.ok || !d.cwd) {
        // 显示真实错误,便于定位(如"该会话未打开" / 超时)
        showToast(d?.error ? `无法获取当前目录:${d.error}` : '无法获取当前目录', 'warn')
        return
      }
      navigator.clipboard?.writeText(d.cwd).then(() => showToast(`已复制路径 ${d.cwd}`)).catch(() => showToast('剪贴板不可用', 'warn'))
    } catch (e) {
      showToast(`获取失败:${e instanceof Error ? e.message : '无法获取当前目录'}`, 'warn')
    }
  }

  // 是否停留在终端视口底部(用于在 fit/写入后保持回到底部,避免跳到会话最上方)。
  // 容差 1 行:末行无换行(提示符/光标行)时 xterm 报告的"底部"会比实际少 1 行,
  // 严格比较会把已在底部的会话误判为"不在底部"——随后容器尺寸一变(传输条弹出/
  // 收起、面板开合、窗口缩放)触发 refit,fit 后不回粘底部,scrollTop 被 xterm
  // 重置到顶部,表现为"页面莫名其妙飘到最上方"。与滚轮补偿的判断保持一致。
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

  // 拟合并无条件定位到最底部(光标处)。切回会话/从隐藏恢复时用:隐藏期间的
  // fit 与尺寸变化可能已把滚动位置重置,wasAtBottom 判断不可靠,必须强制回底。
  // 再补一帧 scrollToBottom,对抗 fit 触发的视口重排与滚动同步之间的竞态。
  const fitAndGoBottom = () => {
    try { fitRef.current?.fit() } catch {}
    termRef.current?.scrollToBottom()
    requestAnimationFrame(() => { try { termRef.current?.scrollToBottom() } catch {} })
  }
  const fitAndGoBottomRef = useRef(fitAndGoBottom)
  fitAndGoBottomRef.current = fitAndGoBottom

  // 激活时重新拟合并回到光标处(隐藏时容器尺寸为 0,重新显示必须重新计算行列)
  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => fitAndGoBottomRef.current())
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  // 初始化终端
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

    // 左键选中即复制
    const selectionDisposable = term.onSelectionChange(() => {
      const sel = term.getSelection()
      if (!sel) return
      navigator.clipboard?.writeText(sel).then(() => {
        showToast(`已复制 ${sel.length} 字符`)
      }).catch(() => {
        // 非安全上下文(如 http://IP)剪贴板 API 可能被拒,静默忽略
      })
    })

    // 右键粘贴
    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault()
      term.focus()
      navigator.clipboard?.readText().then((text) => {
        if (text) term.paste(text)
      }).catch(() => {
        showToast('剪贴板不可用(需 localhost 或 https)', 'warn')
      })
    }
    const el = containerRef.current
    el.addEventListener('contextmenu', onContextMenu)

    // 滚轮"滚不到真正底部"的补偿:
    // 当会话末尾是提示符/光标行(末行无换行)时,xterm 滚轮向下滚到末端会停在
    // 真正底部之上 1 行(此时 wasAtBottom 为 false),表现为"鼠标已滚到底但内容
    // 还没到最下方",只有键入(如按回车,触发 xterm 原生跟随光标滚动)才能到底。
    // 这里在向下滚动且已滚到末端附近时,用 scrollToBottom() 精确对齐真正的底部。
    const onWheel = (e: WheelEvent) => {
      if (e.deltaY <= 0) return
      const t = termRef.current
      if (!t || !t.buffer.active) return
      const active = t.buffer.active
      if (active.viewportY + t.rows >= active.length - 1) {
        t.scrollToBottom()
      }
    }
    el.addEventListener('wheel', onWheel, { passive: true })

    // 用 ResizeObserver 监听容器尺寸变化,尺寸一变就重算行列。
    // 覆盖:隐藏(display:none)/未连接(容器 display:none)/面板展开收起/窗口大小变化
    // 等所有"终端没充满界面/只显示一小格"的场景。
    // ===== 全屏(备用屏幕)内容快照 =====
    // vim/htop/部分 AI agent(claude 等)切到备用屏幕绘制,退出时恢复主屏,其内容会
    // 从终端消失(实时终端与完整历史都看不到)。在"切回主屏"指令被处理前抓取整屏
    // 存入历史流,完整历史的重建视图/导出即可包含这部分内容。
    const snapshotAltScreen = () => {
      try {
        const buf = term.buffer
        if (buf.active !== buf.alternate) return // 只在"即将离开备用屏"时抓
        const b = buf.alternate
        const altLines: string[] = []
        for (let i = 0; i < b.length; i++) altLines.push(b.getLine(i)?.translateToString(true) ?? '')
        const content = altLines.join('\n').replace(/\s+$/, '')
        if (!content.trim()) return
        const journal = `\r\n\x1b[90m──── 全屏模式输出(退出时快照) ────\x1b[0m\r\n${content}\r\n\x1b[90m──── 全屏输出结束 ────\x1b[0m\r\n`
        fullBytesRef.current.push(new TextEncoder().encode(journal))
        fullContentRef.current += `\n──── 全屏模式输出(退出时快照) ────\n${content}\n──── 全屏输出结束 ────\n`
      } catch { /* 抓屏失败不影响终端正常工作 */ }
    }
    // xterm 的 CSI 钩子按 prefix+final 匹配(区分不了 h/l),params 在回调里自查;
    // 其余 DEC 私有模式(光标显隐等)也会走到这里,先用 params 短路保证开销可忽略
    const onDecPrivateMode = (params: (number | number[])[]) => {
      if (params.length === 1 && (params[0] === 1049 || params[0] === 1047 || params[0] === 47)) {
        snapshotAltScreen() // 仅当当前在备用屏(即将退出)时才会真正抓屏
      }
      return false // 不拦截,照常由 xterm 处理切换
    }
    const altScreenDisposables = ['h', 'l'].map((f) =>
      term.parser.registerCsiHandler({ prefix: '?', final: f }, onDecPrivateMode))

    let ro: ResizeObserver | null = null
    // 容器从无尺寸(display:none)恢复为可见时,隐藏期间滚动位置可能已被重置——
    // 此时无条件回到最底部(光标处);可见期间的高度变化(传输条弹出等)才走"保持位置"
    let roHadSize = false
    try {
      ro = new ResizeObserver(() => {
        // 容器无尺寸(display:none)时 fit() 会是 0,吞掉;有真实尺寸时正常重算
        if (!el.clientWidth || !el.clientHeight) { roHadSize = false; return }
        const becameVisible = !roHadSize
        roHadSize = true
        if (becameVisible) fitAndGoBottomRef.current()
        else fitPreserving()
      })
      ro.observe(el)
    } catch {
      // 老浏览器无 ResizeObserver 时退化为 window resize
      window.addEventListener('resize', fitPreserving)
    }

    return () => {
      altScreenDisposables.forEach(d => d.dispose())
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

  // 连接/断开 WebSocket 终端
  // 注意:依赖只用 [isConnected, session.id, session.serverId, retryTick]。
  // 不要用整个 session 对象作依赖:切换服务器时 loadSessions 会用新对象引用重建该服务器
  // 的会话,若依赖 session 对象,React 会先跑清理(关闭 WS)再重建 WS,从而把仍在运行的
  // 会话强制重连、中断正在执行的任务。session.id/serverId 是不变的字符串,用它们才稳定。
  // connected/connecting 是纯 UI 状态,放进依赖会让每次状态变化(如 onopen/onclose)
  // 都重建 WebSocket,形成"断开→重连→断开"的死循环,导致页面卡死并不断在
  // 远程服务器上打开新 shell。单一连接由 wsRef 保证;retryTick 仅用于受限的自动重连。
  useEffect(() => {
    if (!isConnected) {
      unregisterTerminalSend(session.id)
      unregisterTerminalExporter(session.id)
      unregisterTerminalFocus(session.id)
      fullContentRef.current = ''
      fullBytesRef.current = []
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      retryRef.current = 0
      setConnected(false)
      setConnecting(false)
      return
    }

    // 已有连接(已打开或连接中)时不重复创建
    const existing = wsRef.current
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return
    }

    setConnecting(true)
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = withWsToken(`${protocol}//${window.location.host}/ws/terminal?serverId=${session.serverId}&session=${session.id}`)
    const ws = new WebSocket(wsUrl)
    wsRef.current = ws

    if (retryRef.current === 0) {
      termRef.current?.writeln(`\r\n\x1b[33m⏳ 正在连接到 ${serverName}...\x1b[0m`)
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
          termRef.current?.writeln(`\x1b[32m✓ 已连接到 ${serverName}\x1b[0m`)
          termRef.current?.writeln(`\x1b[90m提示: 左键选中复制, 右键粘贴\x1b[0m\r\n`)
          // 发送初始大小
          if (fitRef.current && termRef.current) {
            const { cols, rows } = termRef.current
            ws.send(JSON.stringify({ type: 'resize', cols, rows }))
          }
          // 注册到终端桥:供命令面板"在终端里执行" + 供右键导出完整内容
          registerTerminalSend(session.id, (text: string) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'input', data: encodeInputBase64(text) }))
            }
          })
          registerTerminalExporter(session.id, () => fullContentRef.current)
          registerTerminalFocus(session.id, () => { termRef.current?.focus() })
          fullContentRef.current = ''
          fullBytesRef.current = []
        } else if (msg.type === 'data') {
          // 还原成 UTF-8 字节再写入,避免多字节字符(边框符等)乱码
          const bytes = decodeBase64ToBytes(msg.data)
          fullContentRef.current += new TextDecoder().decode(bytes) // 累积全部输出,导出不限大小
          fullBytesRef.current.push(bytes) // 原始字节留档,供完整历史重建视图回放
          const atBottom = wasAtBottom()
          termRef.current?.write(bytes)
          // 若原本停留在底部,写入后保持回到底部,避免回车/输出把界面跳到会话最上方
          if (atBottom) termRef.current?.scrollToBottom()
          // 后台会话仍在输出:上报给上层做标签页提醒(可见时不打扰)
          if (!activeRef.current) onActivity?.(session.id)
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

    ws.onclose = () => {
      // 仅当关闭的是当前 WS(即不是被热切换/卸载清理掉的旧连接)时才提示并清引用
      if (wsRef.current === ws) {
        wsRef.current = null
        unregisterTerminalSend(session.id)
        unregisterTerminalExporter(session.id)
        unregisterTerminalFocus(session.id)
        setConnected(false)
        termRef.current?.writeln(`\r\n\x1b[33m⚠ 连接已断开\x1b[0m`)
        // 有限退避重连:最多 3 次(1s/2s/3s),之后需要手动重连,避免死循环
        if (retryRef.current < 3) {
          const delay = 1000 * (retryRef.current + 1)
          retryRef.current += 1
          retryTimerRef.current = setTimeout(() => {
            retryTimerRef.current = null
            setRetryTick(t => t + 1) // 触发 effect 重新建立一条新连接
          }, delay)
        } else {
          termRef.current?.writeln(`\r\n\x1b[31m✗ 重连失败,请手动重新连接\x1b[0m`)
        }
      }
      setConnecting(false)
      inputDisposable?.dispose()
      resizeDisposable?.dispose()
    }

    ws.onerror = () => {
      // 不做额外输出(onclose 会统一提示),也避免误导性的"错误→重连"
      setConnecting(false)
    }

    return () => {
      // 卸载/切换时只关闭自己创建的这个 WS,不误关新连接
      if (wsRef.current === ws) {
        wsRef.current = null
        ws.close()
      }
      unregisterTerminalSend(session.id)
      unregisterTerminalExporter(session.id)
      unregisterTerminalFocus(session.id)
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current)
        retryTimerRef.current = null
      }
      inputDisposable?.dispose()
      resizeDisposable?.dispose()
    }
  }, [isConnected, session.id, session.serverId, retryTick])

  return (
    <div className="relative h-full bg-bg-900" style={{ display: active ? 'block' : 'none' }}>
      {/* 终端容器:始终渲染,保证 xterm 初始化时 containerRef 可用 */}
      <div ref={containerRef} className="h-full w-full" style={{ display: isConnected ? 'block' : 'none' }} />

      {/* 未连接遮罩 */}
      {!isConnected && (
        <div className="absolute inset-0 flex items-center justify-center bg-bg-900">
          <div className="text-center">
            <div className="w-16 h-16 rounded-full bg-bg-800 border border-slate-700 flex items-center justify-center mx-auto mb-3">
              <Plug size={24} className="text-slate-500" />
            </div>
            <p className="text-sm text-slate-400 mb-3">服务器未连接</p>
            <button onClick={onConnect} className="btn-primary">
              <Plug size={15} /> 连接服务器
            </button>
          </div>
        </div>
      )}

      {/* 顶部状态条 */}
      {isConnected && (
        <div className="absolute top-2 right-3 z-10 flex items-center gap-2">
          {toast && (
            <span className={`text-[10px] px-2 py-0.5 rounded-full border flex items-center gap-1 ${
              toast.kind === 'ok'
                ? 'text-accent-400 bg-accent-500/10 border-accent-500/20'
                : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
            }`}>
              {toast.kind === 'ok' ? <Check size={10} /> : <Copy size={10} />}
              {toast.text}
            </span>
          )}
          <span className={`text-[10px] px-2 py-0.5 rounded-full border ${
            connected
              ? 'text-accent-400 bg-accent-500/10 border-accent-500/20'
              : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
          }`}>
            {connected ? '● 终端就绪' : (connecting ? '● 连接中...' : '● 未连接')}
          </span>
          {connected && (
            <>
            <button
              onClick={() => copySessionCwd()}
              className="text-[10px] px-2 py-0.5 rounded-full border text-slate-300 bg-bg-800/60 border-slate-700 hover:text-accent-400 hover:border-accent-500/30 flex items-center gap-1"
              title="一键复制当前会话所在的绝对路径"
            >
              <Copy size={10} /> 复制路径
            </button>
            <button
              onClick={() => onOpenFilesAtSession?.(session)}
              className="text-[10px] px-2 py-0.5 rounded-full border text-slate-300 bg-bg-800/60 border-slate-700 hover:text-accent-400 hover:border-accent-500/30 flex items-center gap-1"
              title="打开《文件》界面并定位到当前会话所在目录"
            >
              <Folder size={10} /> 文件
            </button>
            <button
              onClick={() => { try { const el = containerRef.current; el?.blur() } catch {}; setShowHistory(true) }}
              className="text-[10px] px-2 py-0.5 rounded-full border text-accent-400 bg-accent-500/10 border-accent-500/30 hover:bg-accent-500/20 flex items-center gap-1"
              title="查看该会话自连接以来的全部历史输出(不限大小)"
            >
              <History size={10} /> 查看完整历史
            </button>
            </>
          )}
        </div>
      )}

      {/* 全量历史查看器 */}
      {showHistory && (
        <FullHistoryViewer
          title={`${session.name || session.id} · 完整历史`}
          text={fullContentRef.current}
          getRaw={() => {
            const chunks = fullBytesRef.current
            if (!chunks.length) return null
            let total = 0
            for (const c of chunks) total += c.length
            const out = new Uint8Array(total)
            let off = 0
            for (const c of chunks) { out.set(c, off); off += c.length }
            return out
          }}
          cols={termRef.current?.cols}
          onClose={() => setShowHistory(false)}
        />
      )}
    </div>
  )
}
