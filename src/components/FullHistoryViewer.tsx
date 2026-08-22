import { useState, useLayoutEffect, useRef, useMemo } from 'react'
import { X, ArrowDownToLine, ArrowUpToLine, History, FileCode } from 'lucide-react'
import { stripAnsi } from '../lib/ansi'
import { ansiToHtmlDocument } from '../lib/ansiToHtml'

// 全量历史查看器:展示终端"自连接以来"的全部输出(不限大小)。
// 因为终端 buffer 的 scrollback 受内存限制不可能无限大,这里直接读已累积的
// fullContentRef(所有字节)做展示,并用虚拟列表只渲染可视行,即使几十万行也流畅。
// 远端 Terminal 与本地 LocalTerminal 复用。

interface Props {
  title: string
  text: string
  onClose: () => void
}

const LINE_HEIGHT = 20 // 每行像素(与字体大小匹配保证不跳动)
const BUFFER = 12 // 可视区上下各多渲染的行数,减少滚动闪烁

export function FullHistoryViewer({ title, text, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)

  // 只在打开时切一次行,避免每次渲染都 split 巨大文本
  // 先剥离 ANSI 控制符(颜色/光标/括号粘贴等),否则会显示成 [?2004h [K 之类的乱码
  const lines = useMemo(() => stripAnsi(text || '').split(/\r\n|\r|\n/), [text])
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
          <span className="text-[11px] text-slate-500">全部历史 · {total.toLocaleString()} 行 · 实时无上限</span>
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
