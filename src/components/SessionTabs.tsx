import { useState, useRef, useEffect } from 'react'
import { Plus, X, TerminalSquare, Server as ServerIcon, Copy, Trash2, Download } from 'lucide-react'
import { Session, Server, MAX_SESSIONS_PER_SERVER } from '../types'

interface Props {
  servers: Server[]
  sessions: Session[]
  activeSessionId: string | null
  onSelect: (sessionId: string) => void
  onCreate: (serverId: string) => void
  onRename: (session: Session, name: string) => void
  onClose: (session: Session) => void
  /** 复制会话:新会话保持相同名称与当前路径 */
  onDuplicate: (session: Session) => void
  /** 同服务器会话拖拽排序:回调该服务器重排后的会话 id 数组 */
  onReorder: (serverId: string, orderedIds: string[]) => void
  /** 后台会话仍在输出提醒:sessionId -> 是否在非激活期间产生过新输出 */
  busySessions?: Record<string, boolean>
  /** 导出会话完整内容为 txt */
  onExportSession: (session: Session) => void
}

// 会话标签栏:所有服务器的会话直接展示在终端上方。
// 同一服务器的会话排在同一层(行),不同服务器各占一行,点击任意标签直接切换。
export function SessionTabs({ servers, sessions, activeSessionId, onSelect, onCreate, onRename, onClose, onDuplicate, onReorder, busySessions, onExportSession }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  // 右键菜单:记录被点击的会话与菜单位置
  const [ctx, setCtx] = useState<{ session: Session; x: number; y: number } | null>(null)
  // 拖拽排序:记录拖拽中的会话与当前悬停目标
  const dragIdRef = useRef<string | null>(null)
  // 拖拽中的标签 id 同时存 state:ref 变化不触发渲染,半透明效果会不出现
  const [dragId, setDragId] = useState<string | null>(null)
  const [dragOverId, setDragOverId] = useState<string | null>(null)

  useEffect(() => {
    if (editingId) inputRef.current?.focus()
  }, [editingId])

  const startRename = (s: Session) => {
    setDraft(s.name)
    setEditingId(s.id)
  }

  const commitRename = (s: Session) => {
    const name = draft.trim()
    setEditingId(null)
    if (name && name !== s.name) onRename(s, name)
  }

  // 拖拽:把拖拽中的会话移动到目标会话的位置(仅同服务器行内)
  const handleDrop = (serverId: string, targetId: string, sses: Session[]) => {
    const dragged = dragIdRef.current
    dragIdRef.current = null
    setDragId(null)
    setDragOverId(null)
    if (!dragged || dragged === targetId) return
    const ids = sses.map(s => s.id)
    const from = ids.indexOf(dragged)
    const to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    ids.splice(from, 1)
    ids.splice(to, 0, dragged)
    onReorder(serverId, ids)
  }

  // 按服务器分组:每个服务器一层(行)。只展示至少有一个会话的服务器。
  const groups = servers
    .map(srv => ({ server: srv, sses: sessions.filter(s => s.serverId === srv.id) }))
    .filter(g => g.sses.length > 0)

  if (groups.length === 0) return null

  return (
    <>
    <div className="max-h-72 overflow-y-auto border-b border-slate-800 bg-bg-800/40">
      {groups.map(({ server, sses }) => {
        const atLimit = sses.length >= MAX_SESSIONS_PER_SERVER
        return (
          <div
            key={server.id}
            className="flex items-start gap-1.5 px-2 py-1 border-b border-slate-800/50 last:border-b-0"
          >
            {/* 服务器标识(独立名,标签可在下方换行) */}
            <span className="flex-shrink-0 flex items-center gap-1 text-[11px] font-medium text-sky-400 pr-1 pt-1">
              <ServerIcon size={11} className="text-sky-400/70" />
              <span className="truncate max-w-[7rem]">{server.name}</span>
            </span>

            {/* 该服务器的会话标签:一行放不下时换行成 2 行(不再横向滚动) */}
            <div className="flex items-center flex-wrap gap-1 flex-1 min-w-0">
              {sses.map(s => {
                const active = s.id === activeSessionId
                return (
                  <div
                    key={s.id}
                    onClick={() => onSelect(s.id)}
                    onDoubleClick={() => !editingId && startRename(s)}
                    onContextMenu={(e) => { e.preventDefault(); setCtx({ session: s, x: e.clientX, y: e.clientY }) }}
                    draggable={!editingId}
                    onDragStart={(e) => {
                      dragIdRef.current = s.id; setDragId(s.id)
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', s.id)
                    }}
                    onDragOver={(e) => {
                      if (!dragIdRef.current || dragIdRef.current === s.id) return
                      e.preventDefault()
                      setDragOverId(s.id)
                    }}
                    onDragLeave={() => setDragOverId(cur => (cur === s.id ? null : cur))}
                    onDrop={(e) => { e.preventDefault(); handleDrop(server.id, s.id, sses) }}
                    onDragEnd={() => { dragIdRef.current = null; setDragId(null); setDragOverId(null) }}
                    className={`group flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer border shrink-0 transition-all select-none ${
                      dragId === s.id ? 'opacity-40' : ''
                    } ${
                      dragOverId === s.id
                        ? 'border-accent-500/60 bg-accent-500/10 text-accent-300'
                        : active
                          ? 'bg-accent-500/15 text-accent-400 border-accent-500/30'
                          : 'text-slate-400 border-transparent hover:bg-bg-600 hover:text-slate-200'
                    }`}
                  >
                    <TerminalSquare size={12} className={active ? 'text-accent-400' : 'text-slate-500'} />
                    {/* 后台会话仍在输出:脉冲红点提醒 */}
                    {!active && busySessions?.[s.id] && (
                      <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" title="该会话正在后台输出" />
                    )}
                    {editingId === s.id ? (
                      <input
                        ref={inputRef}
                        value={draft}
                        onChange={e => setDraft(e.target.value)}
                        onBlur={() => commitRename(s)}
                        onKeyDown={e => {
                          if (e.key === 'Enter') commitRename(s)
                          if (e.key === 'Escape') setEditingId(null)
                        }}
                        onClick={e => e.stopPropagation()}
                        className="w-20 bg-bg-900 border border-accent-500/40 rounded px-1 py-0.5 text-accent-300 outline-none"
                      />
                    ) : (
                      <span className="truncate max-w-[9rem]">{s.name}</span>
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); onClose(s) }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-bg-600 text-slate-500 hover:text-red-400"
                      title="关闭会话"
                    >
                      <X size={11} />
                    </button>
                  </div>
                )
              })}
            </div>

            {/* 该服务器新建会话 */}
            <button
              onClick={() => onCreate(server.id)}
              disabled={atLimit}
              title={atLimit ? `每台服务器最多 ${MAX_SESSIONS_PER_SERVER} 个会话(受 sshd MaxSessions 限制)` : `新建 ${server.name} 的会话`}
              className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400 disabled:opacity-30 disabled:hover:text-slate-400 disabled:hover:bg-transparent shrink-0"
            >
              <Plus size={14} />
            </button>
            <span className="ml-1 text-[10px] text-slate-600 shrink-0">
              {sses.length}/{MAX_SESSIONS_PER_SERVER}
            </span>
          </div>
        )
      })}
    </div>

    {/* 右键菜单:复制会话 / 关闭会话 */}
    {ctx && (
      <>
        <div className="fixed inset-0 z-40" onClick={() => setCtx(null)} />
        <div
          className="fixed z-50 w-40 bg-bg-700 border border-slate-700 rounded-lg shadow-xl py-1 animate-fade-in"
          style={{ left: Math.min(ctx.x, window.innerWidth - 170), top: ctx.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={() => { onDuplicate(ctx.session); setCtx(null) }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-bg-600 text-left"
          >
            <Copy size={13} /> 复制会话
          </button>
          <button
            onClick={() => { onExportSession(ctx.session); setCtx(null) }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-bg-600 text-left border-t border-slate-700 mt-1 pt-2"
          >
            <Download size={13} /> 导出会话内容(txt)
          </button>
          <button
            onClick={() => { onClose(ctx.session); setCtx(null) }}
            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-bg-600 text-left border-t border-slate-700 mt-1 pt-2"
          >
            <Trash2 size={13} /> 关闭会话
          </button>
        </div>
      </>
    )}
    </>
  )
}
