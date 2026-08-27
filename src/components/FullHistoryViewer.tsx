import { useState, useLayoutEffect, useRef, useMemo, useEffect } from 'react'
import { X, ArrowDownToLine, ArrowUpToLine, History, FileCode, Loader2 } from 'lucide-react'
import { Terminal as XTerm } from '@xterm/xterm'
import { stripAnsi } from '../lib/ansi'
import { ansiToHtmlDocument } from '../lib/ansiToHtml'

// 全量历史查看器:展示终端"自连接以来"的全部输出(不限大小)。
// 两种视图:
//  - 重建视图(默认,提供 getRaw 时):把原始字节流回放进一个离屏 xterm(与真实终端
//    同一状态机),再读它的缓冲区——得到"终端实际显示过的内容"。全屏 TUI 程序
//    (vim/htop/AI agent 如 claude)靠光标定位/整屏重绘渲染,剥转义序列会糊成一团,
//    只有经过终端状态机重建才能还原成可读内容;全屏(备用屏幕)内容在退出时会被
//    程序清掉,由 Terminal 在退出前抓屏注入历史流(见其 parser 钩子)。
//  - 原始文本:剥 ANSI 后逐行展示(旧行为,保留作对照/兜底)。
// 远端 Terminal 与本地 LocalTerminal 复用。

interface Props {
  title: string
  text: string
  /** 取原始字节流(打开时调用一次);无则只有原始文本视图 */
  getRaw?: () => Uint8Array | null
  /** 重建视图使用的列宽(尽量与会话当前列宽一致,影响折行还原) */
  cols?: number
  onClose: () => void
}

const LINE_HEIGHT = 20 // 每行像素(与字体大小匹配保证不跳动)
const BUFFER = 12 // 可视区上下各多渲染的行数,减少滚动闪烁
const REPLAY_CHUNK = 512 * 1024 // 回放时每次写入的字节量
const MAX_REPLAY_BYTES = 128 * 1024 * 1024 // 超过此大小放弃重建(回放太重),回退原始文本

export function FullHistoryViewer({ title, text, getRaw, cols, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)
  // 重建视图:lines 为 null 表示不可用/未完成;progress 为重建进度提示
  const [rebuilt, setRebuilt] = useState<string[] | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [replayProgress, setReplayProgress] = useState('')
  const [mode, setMode] = useState<'render' | 'raw'>('render')

  // 打开时异步回放原始字节流,重建"终端实际显示过的内容"
  useEffect(() => {
    if (!getRaw) return
    let disposed = false
    let term: XTerm | null = null
    ;(async () => {
      let raw: Uint8Array | null = null
      try { raw = getRaw() } catch { raw = null }
      if (!raw || !raw.length || raw.length > MAX_REPLAY_BYTES) {
        setMode('raw')
        return
      }
      setRebuilding(true)
      try {
        // 离屏(不 open)实例:只跑状态机与缓冲区,无渲染开销。
        // allowProposedApi 必须开:term.buffer 属 proposed API,否则读取缓冲区直接抛错
        term = new XTerm({ scrollback: 200000, cols: Math.max(20, cols || 120), rows: 24, allowProposedApi: true })
        const totalMB = Math.max(1, Math.round(raw.length / 1048576))
        for (let i = 0; i < raw.length; i += REPLAY_CHUNK) {
          if (disposed) return
          term.write(raw.subarray(i, i + REPLAY_CHUNK))
          setReplayProgress(`${Math.min(totalMB, Math.round(i / 1048576) + 1)}/${totalMB} MB`)
          // 让出主线程,大流量会话回放期间界面不冻结
          await new Promise(r => setTimeout(r, 0))
        }
        // 空写入 + 回调 = 等待全部解析落缓冲
        await new Promise<void>(r => term!.write('', () => r()))
        if (disposed) return
        const b = term.buffer.normal
        const out: string[] = []
        for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '')
        // 去掉末尾连续空行(备用屏幕切换常留大段空白),保留至少一行
        let last = out.length
        while (last > 1 && out[last - 1].trim() === '') last--
        let first = 0
        while (first < last - 1 && out[first].trim() === '') first++
        const lines2 = out.slice(first, last)
        if (lines2.length === 0) {
          setMode('raw') // 回放异常兜底
        } else {
          setRebuilt(lines2)
        }
      } catch {
        setMode('raw')
      } finally {
        if (!disposed) setRebuilding(false)
        try { term?.dispose() } catch { /* 已销毁 */ }
      }
    })()
    return () => { disposed = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 当前视图的行数据
  const lines = useMemo(
    () => (mode === 'render' && rebuilt ? rebuilt : stripAnsi(text || '').split(/\r\n|\r|\n/)),
    [mode, rebuilt, text],
  )
  const total = lines.length

  useLayoutEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => { setViewportH(el.clientHeight || 600) }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    // 默认滚到最底部(最新输出)
    el.scrollTop = el.scrollHeight
    setScrollTop(el.scrollTop)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const first = Math.max(0, Math.floor(scrollTop / LINE_HEIGHT) - BUFFER)
  const visibleCount = Math.ceil(viewportH / LINE_HEIGHT) + BUFFER * 2
  const slice = lines.slice(first, first + visibleCount)
  const offsetPx = first * LINE_HEIGHT
  const isAtBottom = scrollTop + viewportH >= total * LINE_HEIGHT - 4

  const scrollToBottom = () => {
    const el = containerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }
  const scrollToTop = () => {
    const el = containerRef.current
    if (!el) return
    el.scrollTop = 0
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center backdrop-blur-sm animate-fade-in" onClick={onClose}>
      <div className="w-[92vw] h-[88vh] bg-bg-800 border border-slate-700 rounded-2xl shadow-2xl flex flex-col animate-slide-up" onClick={e => e.stopPropagation()}>
        {/* 标题栏 */}
        <div className="flex items-center gap-2 px-4 h-11 border-b border-slate-700 shrink-0">
          <History size={15} className="text-accent-400" />
          <span className="text-sm font-semibold text-slate-200">{title}</span>
          {rebuilding ? (
            <span className="text-[11px] text-accent-400 flex items-center gap-1">
              <Loader2 size={11} className="animate-spin" /> 重建终端视图 {replayProgress}
            </span>
          ) : (
            <span className="text-[11px] text-slate-500">全部历史 · {total.toLocaleString()} 行{mode === 'render' && rebuilt ? ' · 与终端显示一致' : ' · 原始文本'}</span>
          )}
          {/* 视图切换:TUI 程序(claude 等)必须用重建视图;原始文本保留作对照 */}
          {getRaw && !rebuilding && (
            <span className="flex items-center rounded-md border border-slate-700 overflow-hidden text-[10px]">
              <button
                onClick={() => setMode('render')}
                disabled={!rebuilt}
                className={`px-2 py-0.5 ${mode === 'render' ? 'bg-accent-500/15 text-accent-400' : 'text-slate-500 hover:text-slate-300'} disabled:opacity-40`}
                title="回放字节流重建的终端实际显示内容(推荐,TUI 程序唯一可读)"
              >重建视图</button>
              <button
                onClick={() => setMode('raw')}
                className={`px-2 py-0.5 ${mode === 'raw' ? 'bg-accent-500/15 text-accent-400' : 'text-slate-500 hover:text-slate-300'}`}
                title="剥离 ANSI 转义后的原始文本流"
              >原始文本</button>
            </span>
          )}
          <span className="flex-1" />
          <button
            onClick={() => {
              // 导出为 HTML(保留终端颜色),与导出 txt(纯文本)互补
              const doc = ansiToHtmlDocument(title, text)
              const blob = new Blob([doc], { type: 'text/html;charset=utf-8' })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = `${(title || '终端历史').split(' · ')[0]}.html`
              document.body.appendChild(a)
              a.click()
              a.remove()
              setTimeout(() => URL.revokeObjectURL(url), 3000)
            }}
            className="p-1.5 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400 flex items-center gap-1"
            title="导出为 HTML(保留颜色)"
          >
            <FileCode size={14} />
          </button>
          <button onClick={scrollToTop} className="p-1.5 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400" title="回到顶部"><ArrowUpToLine size={14} /></button>
          <button onClick={scrollToBottom} className="p-1.5 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400" title="回到底部"><ArrowDownToLine size={14} /></button>
          <button onClick={onClose} className="p-1.5 rounded hover:bg-bg-600 text-slate-400 hover:text-red-400" title="关闭"><X size={16} /></button>
        </div>

        {/* 内容:虚拟列表 */}
        <div ref={containerRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          className="relative flex-1 overflow-auto bg-black/50 font-mono text-xs text-slate-300 px-1">
          {total === 0 ? (
            <div className="p-4 text-slate-600">暂无输出</div>
          ) : (
            <div style={{ height: total * LINE_HEIGHT, position: 'relative' }}>
              <div style={{ position: 'absolute', top: offsetPx, left: 0, right: 0 }}>
                {slice.map((line, i) => (
                  <div key={first + i} style={{ height: LINE_HEIGHT, lineHeight: `${LINE_HEIGHT}px`, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {line || ' '}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 底部状态 */}
        <div className="px-4 h-8 border-t border-slate-700 flex items-center gap-2 text-[11px] text-slate-500 shrink-0">
          {isAtBottom ? '已到最新输出底部' : `向上滚动查看更多历史 · 第 ${Math.floor(scrollTop / LINE_HEIGHT).toLocaleString()} / ${total.toLocaleString()} 行`}
          <span className="ml-auto text-accent-400">关闭即返回实时终端</span>
        </div>
      </div>
    </div>
  )
}
