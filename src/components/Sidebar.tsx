import { Server, ConnectionStatus, Session, LocalFavorite } from '../types'
import { Plus, Settings, Trash2, Wifi, WifiOff, Server as ServerIcon, Terminal, Activity, ChevronRight, ChevronDown, TerminalSquare, MoreVertical, FolderKanban, X, Folder, Copy, Palette } from 'lucide-react'
import { useState, useEffect } from 'react'
import { CommandPanel } from './CommandPanel'
import { LocalDirBrowser } from './LocalDirBrowser'

export type SidebarView = 'servers' | 'commands' | 'local'

interface Props {
  servers: Server[]
  statuses: Record<string, ConnectionStatus>
  sessions: Session[]
  activeSessionId: string | null
  selectedServerId: string | null
  onSelectServer: (id: string) => void
  onAddServer: () => void
  /** 打开动态特效皮肤选择器 */
  onOpenSkins?: () => void
  onEditServer: (s: Server) => void
  onDeleteServer: (id: string) => void
  onConnect: (id: string) => void
  onDisconnect: (id: string) => void
  onSelectSession: (session: Session) => void
  onCreateSession: (serverId: string) => void
  onRenameSession: (session: Session, name: string) => void
  onDeleteSession: (session: Session) => void
  /** 后台会话仍在输出提醒:sessionId -> 是否在非激活期间产生过新输出 */
  busySessions?: Record<string, boolean>
  /** 侧栏宽度(px),由父组件控制拖拽 */
  width?: number
  // ===== 本地终端视图 =====
  /** 侧栏视图(由 App 控制,主内容区据此切换) */
  view: SidebarView
  onViewChange: (v: SidebarView) => void
  /** 已打开的本地会话 */
  localSessions: Session[]
  activeLocalSessionId: string | null
  onSelectLocalSession: (id: string) => void
  onCloseLocalSession: (id: string) => void
  onOpenLocalTerminal: (path: string) => void
  localFavorites: LocalFavorite[]
  onToggleLocalFavorite: (path: string, name?: string) => void
  /** 侧栏目录浏览的当前目录(由 App 管理) */
  browsePath: string
  onBrowsePathChange: (p: string) => void
}

export function Sidebar({
  servers, statuses, sessions, activeSessionId, selectedServerId, onOpenSkins,
  onSelectServer, onAddServer, onEditServer, onDeleteServer,
  onConnect, onDisconnect, onSelectSession, onCreateSession,
  onRenameSession, onDeleteSession, busySessions, width,
  view, onViewChange, localSessions, activeLocalSessionId,
  onSelectLocalSession, onCloseLocalSession, onOpenLocalTerminal,
  localFavorites, onToggleLocalFavorite, browsePath, onBrowsePathChange,
}: Props) {
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null)
  const [expandedServers, setExpandedServers] = useState<Record<string, boolean>>({})
  const [renaming, setRenaming] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')

  const connectedCount = Object.values(statuses).filter(s => s === 'connected').length

  // ===== 连接健康摘要 =====
  // 已连接的服务器每 30s 采一次负载与内存(走 /execute,即文件连接,不占终端通道)。
  // 解析用 uptime + /proc/meminfo,比 top 的输出格式跨发行版更稳。失败则不显示。
  const [health, setHealth] = useState<Record<string, { load: string; mem: string } | null>>({})
  const connectedIds = servers.filter(s => (statuses[s.id] || 'disconnected') === 'connected').map(s => s.id).join(',')
  useEffect(() => {
    if (!connectedIds) return
    let alive = true
    const ids = connectedIds.split(',')
    const poll = async () => {
      await Promise.all(ids.map(async (id) => {
        try {
          const r = await fetch(`/api/servers/${id}/execute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              command: "uptime | awk -F'load average:' '{print $2}'; awk '/MemTotal/{t=$2}/MemAvailable/{a=$2}END{printf \"%dMB/%dMB\", (t-a)/1024, t/1024}' /proc/meminfo",
            }),
          })
          const d = await r.json()
          if (!alive || !r.ok || !d.stdout) return
          const lines = String(d.stdout).trim().split('\n')
          const load = (lines[0] || '').trim()
          const mem = (lines[1] || '').trim()
          if (!load || !mem) return
          setHealth(prev => ({ ...prev, [id]: { load, mem } }))
        } catch {
          setHealth(prev => (prev[id] ? { ...prev, [id]: null } : prev))
        }
      }))
    }
    poll()
    const t = setInterval(poll, 30000)
    return () => { alive = false; clearInterval(t) }
  }, [connectedIds])

  const toggleExpand = (serverId: string) => {
    setExpandedServers(prev => ({ ...prev, [serverId]: !prev[serverId] }))
  }

  const serverSessions = (serverId: string) => sessions.filter(s => s.serverId === serverId)

  const startRename = (s: Session) => {
    setRenameDraft(s.name)
    setRenaming(s.id)
  }

  const commitRename = (s: Session) => {
    const name = renameDraft.trim()
    setRenaming(null)
    if (name && name !== s.name) onRenameSession(s, name)
  }

  return (
    <div className="h-full bg-bg-800 border-r border-slate-800 flex flex-col flex-shrink-0" style={{ width: width ?? 288 }}>
      {/* Logo + 皮肤入口 */}
      <div className="h-12 flex items-center gap-2.5 px-4 border-b border-slate-800">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-accent-400 to-accent-600 flex items-center justify-center shadow-lg shadow-accent-500/20">
          <Terminal size={16} className="text-white" />
        </div>
        <div>
          <div className="text-sm font-bold text-slate-200 leading-tight">ServerHub</div>
          <div className="text-[10px] text-slate-500 leading-tight">Linux 管理工具</div>
        </div>
        <span className="flex-1" />
        <button
          onClick={() => onOpenSkins?.()}
          className="p-1.5 rounded-lg hover:bg-bg-600 text-slate-500 hover:text-accent-400"
          title="动态特效皮肤"
        >
          <Palette size={15} />
        </button>
      </div>

      {/* 视图切换:远程服务器 / 命令集 / 本地终端 */}
      <div className="flex items-center gap-1 px-2 py-2 border-b border-slate-800/50">
        <button
          onClick={() => onViewChange('servers')}
          className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-all ${
            view === 'servers' ? 'bg-accent-500/15 text-accent-400' : 'text-slate-400 hover:text-slate-300 hover:bg-bg-700/40'
          }`}
        >
          <ServerIcon size={13} /> 远程服务器
        </button>
        <button
          onClick={() => onViewChange('commands')}
          className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-all ${
            view === 'commands' ? 'bg-accent-500/15 text-accent-400' : 'text-slate-400 hover:text-slate-300 hover:bg-bg-700/40'
          }`}
        >
          <FolderKanban size={13} /> 命令集
        </button>
        <button
          onClick={() => onViewChange('local')}
          className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-all ${
            view === 'local' ? 'bg-accent-500/15 text-accent-400' : 'text-slate-400 hover:text-slate-300 hover:bg-bg-700/40'
          }`}
        >
          <TerminalSquare size={13} /> 本地终端
        </button>
      </div>

      {/* ===== 远程服务器 视图 ===== */}
      {view === 'servers' && (
        <>
          {/* 统计栏 */}
          <div className="px-4 py-3 border-b border-slate-800/50">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-500">服务器</span>
              <div className="flex items-center gap-3">
                <span className="text-slate-400">{servers.length} 台</span>
                <span className="flex items-center gap-1 text-accent-400">
                  <Activity size={11} />
                  {connectedCount} 在线
                </span>
              </div>
            </div>
          </div>

          {/* 服务器列表 */}
          <div className="flex-1 overflow-y-auto py-2">
        {servers.length === 0 ? (
          <div className="text-center py-8 px-4">
            <p className="text-xs text-slate-500">还没有服务器<br/>点击下方按钮添加</p>
          </div>
        ) : (
          <div className="space-y-1 px-2">
            {servers.map(server => {
              const status = statuses[server.id] || 'disconnected'
              const isSelected = selectedServerId === server.id
              const isMenuOpen = menuOpenId === `srv:${server.id}`
              const expanded = expandedServers[server.id]
              const sesses = serverSessions(server.id)
              return (
                <div key={server.id} className="relative group">
                  <div className={`rounded-lg ${isSelected ? 'bg-accent-500/10 border border-accent-500/20' : 'border border-transparent'}`}>
                    <div
                      onClick={() => onSelectServer(server.id)}
                      className={`flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-all hover:bg-bg-700`}
                    >
                      {/* 展开箭头 */}
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleExpand(server.id) }}
                        className="p-0.5 rounded hover:bg-bg-600 text-slate-500 hover:text-slate-300"
                      >
                        {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                      </button>

                      {/* 状态点 */}
                      <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        status === 'connected' ? 'bg-accent-400 shadow-sm shadow-accent-400/50 status-connected' :
                        status === 'connecting' ? 'bg-amber-400 status-connecting' :
                        'bg-slate-600'
                      }`} />

                      {/* 服务器信息 */}
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-medium truncate text-left ${isSelected ? 'text-accent-400' : 'text-slate-300'}`}>
                          {server.name}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate text-left">
                          {server.username}@{server.host}:{server.port}
                        </div>
                        {/* 健康摘要(仅已连接且采集成功时显示) */}
                        {status === 'connected' && health[server.id] && (
                          <div className="text-[10px] text-slate-600 truncate text-left">
                            load {health[server.id]!.load} · 内存 {health[server.id]!.mem}
                          </div>
                        )}
                      </div>

                      {/* 一键新建会话(无需点开设置菜单) */}
                      <button
                        onClick={(e) => { e.stopPropagation(); onCreateSession(server.id) }}
                        title={`新建 ${server.name} 的会话`}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400"
                      >
                        <Plus size={14} />
                      </button>

                      {/* 菜单按钮 */}
                      <button
                        onClick={(e) => { e.stopPropagation(); setMenuOpenId(isMenuOpen ? null : `srv:${server.id}`) }}
                        className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-bg-600"
                      >
                        <Settings size={14} className="text-slate-400" />
                      </button>
                    </div>

                    {/* 服务器下拉菜单 */}
                    {isMenuOpen && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={() => setMenuOpenId(null)} />
                        <div className="absolute right-2 top-12 z-50 w-52 bg-bg-700 border border-slate-700 rounded-lg shadow-xl py-1 animate-fade-in">
                          {status === 'connected' ? (
                            <button
                              onClick={(e) => { e.stopPropagation(); onDisconnect(server.id); setMenuOpenId(null) }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-bg-600 text-left"
                            >
                              <WifiOff size={13} /> 断开连接
                            </button>
                          ) : (
                            <button
                              onClick={(e) => { e.stopPropagation(); onConnect(server.id); setMenuOpenId(null) }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-accent-400 hover:bg-bg-600 text-left"
                            >
                              <Wifi size={13} /> 连接服务器
                            </button>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); onCreateSession(server.id); setMenuOpenId(null) }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-bg-600 text-left"
                          >
                            <Plus size={13} /> 新建会话
                          </button>
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              navigator.clipboard?.writeText(
                                `IP: ${server.host}\n端口: ${server.port}\n用户名: ${server.username}\n密码: ${server.password || '(空)'}`
                              )
                              setMenuOpenId(null)
                            }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-bg-600 text-left"
                            title="复制 IP、端口、用户名、密码"
                          >
                            <Copy size={13} /> 复制连接信息
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); onEditServer(server); setMenuOpenId(null) }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-bg-600 text-left"
                          >
                            <Settings size={13} /> 编辑配置
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); onDeleteServer(server.id); setMenuOpenId(null) }}
                            className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-bg-600 text-left border-t border-slate-700 mt-1 pt-2"
                          >
                            <Trash2 size={13} /> 删除服务器
                          </button>
                        </div>
                      </>
                    )}
                  </div>

                  {/* 会话列表 */}
                  {expanded && (
                    <div className="ml-6 mt-0.5 space-y-0.5 border-l border-slate-800 pl-2">
                      {sesses.length === 0 && (
                        <div className="text-[11px] text-slate-600 py-1 pl-1">暂无会话</div>
                      )}
                      {sesses.map(s => {
                        const activeSession = s.id === activeSessionId
                        return (
                          <div
                            key={s.id}
                            onClick={() => onSelectSession(s)}
                            className={`group/ses flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer transition-all ${
                              activeSession ? 'bg-accent-500/10 text-accent-300' : 'text-slate-400 hover:bg-bg-700 hover:text-slate-200'
                            }`}
                          >
                            <TerminalSquare size={12} className={activeSession ? 'text-accent-400' : 'text-slate-600'} />
                            {/* 后台会话仍在输出:脉冲红点提醒 */}
                            {!activeSession && busySessions?.[s.id] && (
                              <span className="w-2 h-2 rounded-full bg-red-400 animate-pulse flex-shrink-0" title="该会话正在后台输出" />
                            )}
                            <span className="flex-1 min-w-0">
                              {renaming === s.id ? (
                                <input
                                  value={renameDraft}
                                  onChange={e => setRenameDraft(e.target.value)}
                                  onBlur={() => commitRename(s)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') commitRename(s)
                                    if (e.key === 'Escape') setRenaming(null)
                                  }}
                                  onClick={e => e.stopPropagation()}
                                  className="w-full bg-bg-900 border border-accent-500/40 rounded px-1 py-0.5 text-[11px] text-accent-300 outline-none"
                                />
                              ) : (
                                <span className="text-xs truncate block">{s.name}</span>
                              )}
                            </span>
                            <button
                              onClick={(e) => { e.stopPropagation(); setMenuOpenId(isMenuOpen ? null : `ses:${s.id}`) }}
                              className="opacity-0 group-hover/ses:opacity-100 p-0.5 rounded hover:bg-bg-600"
                            >
                              <MoreVertical size={12} className="text-slate-500" />
                            </button>
                          </div>
                        )
                      })}
                    </div>
                  )}

                  {/* 会话菜单 */}
                  {menuOpenId?.startsWith('ses:') && (
                    (() => {
                      const sid = menuOpenId.slice(4)
                      const s = sesses.find(x => x.id === sid)
                      if (!s) return null
                      return (
                        <>
                          <div className="fixed inset-0 z-40" onClick={() => setMenuOpenId(null)} />
                          <div className="absolute right-2 z-50 w-40 bg-bg-700 border border-slate-700 rounded-lg shadow-xl py-1 animate-fade-in">
                            <button
                              onClick={(e) => { e.stopPropagation(); startRename(s); setMenuOpenId(null) }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-300 hover:bg-bg-600 text-left"
                            >
                              <Settings size={13} /> 重命名
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); onDeleteSession(s); setMenuOpenId(null) }}
                              className="w-full flex items-center gap-2 px-3 py-2 text-xs text-red-400 hover:bg-bg-600 text-left border-t border-slate-700 mt-1 pt-2"
                            >
                              <Trash2 size={13} /> 关闭会话
                            </button>
                          </div>
                        </>
                      )
                    })()
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

          {/* 底部添加按钮 */}
          <div className="p-3 border-t border-slate-800">
            <button
              onClick={onAddServer}
              className="w-full btn-secondary justify-center hover:border-accent-500/30 hover:text-accent-400"
            >
              <Plus size={16} /> 添加服务器
            </button>
          </div>
        </>
      )}

      {/* ===== 命令集 视图 ===== */}
      {view === 'commands' && (
        <div className="flex-1 min-h-0 flex flex-col px-2 py-2">
          <CommandPanel
            embedded
            serverId={selectedServerId}
            isConnected={selectedServerId ? statuses[selectedServerId] === 'connected' : false}
            activeSessionId={activeSessionId}
          />
        </div>
      )}

      {/* ===== 本地终端 视图 ===== */}
      {view === 'local' && (
        <LocalView
          browsePath={browsePath}
          onBrowsePathChange={onBrowsePathChange}
          favorites={localFavorites}
          onToggleFavorite={onToggleLocalFavorite}
          onOpenLocalTerminal={onOpenLocalTerminal}
          activeLocalSessionId={activeLocalSessionId}
        />
      )}
    </div>
  )
}

// ===== 本地终端侧栏内容 =====
// 目录结构与命令分开显示(用户要求不要上下堆叠):顶部子标签切换「目录」/「命令」,
// 选中「目录」时显示目录浏览 + 本地会话列表;选中「命令」时只显示本地命令面板。
function LocalView({ browsePath, onBrowsePathChange, favorites, onToggleFavorite, onOpenLocalTerminal, activeLocalSessionId }: {
  browsePath: string
  onBrowsePathChange: (p: string) => void
  favorites: LocalFavorite[]
  onToggleFavorite: (path: string, name?: string) => void
  onOpenLocalTerminal: (path: string) => void
  activeLocalSessionId: string | null
}) {
  // 子标签:dirs=目录结构;commands=本地命令
  const [panel, setPanel] = useState<'dirs' | 'commands'>('dirs')

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* 目录 / 命令 子切换 */}
      <div className="flex items-center gap-1 px-2 py-2 border-b border-slate-800/50">
        <button
          onClick={() => setPanel('dirs')}
          className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-all ${
            panel === 'dirs' ? 'bg-accent-500/15 text-accent-400' : 'text-slate-400 hover:text-slate-300 hover:bg-bg-700/40'
          }`}
        >
          <Folder size={13} /> 目录
        </button>
        <button
          onClick={() => setPanel('commands')}
          className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-all ${
            panel === 'commands' ? 'bg-accent-500/15 text-accent-400' : 'text-slate-400 hover:text-slate-300 hover:bg-bg-700/40'
          }`}
        >
          <FolderKanban size={13} /> 命令
        </button>
      </div>

      {panel === 'dirs' ? (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* 目录浏览 + 收藏(关闭本地会话请在右侧标签条操作) */}
          <LocalDirBrowser
            browsePath={browsePath}
            onBrowsePathChange={onBrowsePathChange}
            favorites={favorites}
            onToggleFavorite={onToggleFavorite}
            onOpenLocalTerminal={onOpenLocalTerminal}
          />
        </div>
      ) : (
        /* 命令子标签:只显示本地命令面板(独立命令集,注入到活跃本地终端) */
        <div className="flex-1 min-h-0 flex flex-col">
          <CommandPanel
            embedded
            localMode
            activeLocalSessionId={activeLocalSessionId}
            serverId={undefined}
            isConnected={false}
            activeSessionId={null}
          />
        </div>
      )}
    </div>
  )
}
