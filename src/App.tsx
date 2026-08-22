import { useState, useEffect, useCallback, useRef } from 'react'
import { Sidebar } from './components/Sidebar'
import { ServerModal } from './components/ServerModal'
import { Terminal } from './components/Terminal'
import { FileBrowser } from './components/FileBrowser'
import { SessionTabs } from './components/SessionTabs'
import { TransferBar } from './components/TransferBar'
import { LocalTerminal } from './components/LocalTerminal'
import { DeviceFilePanel } from './components/DeviceFilePanel'
import { getTerminalContent } from './lib/TerminalBridge'
import { stripAnsi } from './lib/ansi'
import { Server, ConnectionStatus, Session, LocalFavorite, MAX_SESSIONS_PER_SERVER } from './types'
import { Terminal as TerminalIcon, FolderTree, Server as ServerIcon, Plus, X, TerminalSquare, Copy, Check, Smartphone } from 'lucide-react'

type Tab = 'terminal' | 'files'
type SidebarView = 'servers' | 'commands' | 'local'

function App() {
  const [servers, setServers] = useState<Server[]>([])
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, ConnectionStatus>>({})
  const [sessions, setSessions] = useState<Session[]>([])
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null)
  // 后台会话仍在输出提醒:值为 true 表示该会话在非激活期间产生过新输出
  const [busySessions, setBusySessions] = useState<Record<string, boolean>>({})
  const [showModal, setShowModal] = useState(false)
  const [editingServer, setEditingServer] = useState<Server | null>(null)
  const [activeTab, setActiveTab] = useState<Tab>('terminal')
  // 会话「在当前目录打开文件」:请求文件页定位到某服务器某目录
  const [filesRequestPath, setFilesRequestPath] = useState<{ serverId: string; path: string } | null>(null)
  // ===== 本地终端工作区状态 =====
  const [sidebarView, setSidebarView] = useState<SidebarView>('servers')
  const [localSessions, setLocalSessions] = useState<Session[]>([])
  const [activeLocalSessionId, setActiveLocalSessionId] = useState<string | null>(null)
  const [localFavorites, setLocalFavorites] = useState<LocalFavorite[]>([])
  /** 侧栏"本地终端"视图当前浏览的目录(空串 = 磁盘根层) */
  const [browsePath, setBrowsePath] = useState<string>('')
  // 左侧栏宽度(px),可拖拽分隔线调整并持久化
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('serverhub:sidebarWidth'))
    return saved >= 200 && saved <= 1200 ? saved : 288
  })
  const resizingRef = useRef<{ startX: number; startW: number } | null>(null)
  const sidebarWidthRef = useRef(sidebarWidth)
  // 设备文件面板宽度(本地视图,与终端之间的分隔线可拖拽),持久化
  const [devicePanelWidth, setDevicePanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('serverhub:devicePanelWidth'))
    return saved >= 160 && saved <= 640 ? saved : 300
  })
  const deviceResizeRef = useRef<{ startX: number; startW: number } | null>(null)
  const devicePanelWidthRef = useRef(devicePanelWidth)
  // 设备目录栏是否显示(本地终端界面,由顶部按钮一键开/关)。默认收起,避免一直刷新卡顿。
  const [devicePanelOpen, setDevicePanelOpen] = useState<boolean>(() => {
    return localStorage.getItem('serverhub:devicePanelOpen') === '1'
  })
  // 本地终端标签拖拽排序:拖拽中的标签 id 与当前悬停目标
  const localDragIdRef = useRef<string | null>(null)
  const [localDragOverId, setLocalDragOverId] = useState<string | null>(null)
  // 拖拽中的标签 id 同存 state:ref 变化不触发渲染,半透明效果不出现
  const [localDragId, setLocalDragId] = useState<string | null>(null)
  // 已复制路径的本地标签 id(显示 ✓ 反馈)
  const [copiedLocalId, setCopiedLocalId] = useState<string | null>(null)

  const fetchServers = useCallback(async () => {
    const res = await fetch('/api/servers')
    const data = await res.json()
    setServers(data)
  }, [])

  const fetchStatuses = useCallback(async () => {
    try {
      const res = await fetch('/api/servers/status')
      const statusMap = await res.json()
      setStatuses(statusMap)
    } catch {
      // 忽略轮询异常,保持上次状态
    }
  }, [])

  useEffect(() => {
    fetchServers()
  }, [fetchServers])

  useEffect(() => {
    fetchStatuses()
    const interval = setInterval(fetchStatuses, 5000)
    return () => clearInterval(interval)
  }, [fetchStatuses])

  // 加载本地目录收藏
  const fetchLocalFavorites = useCallback(async () => {
    try {
      const res = await fetch('/api/local/favorites')
      setLocalFavorites(await res.json())
    } catch {}
  }, [])

  useEffect(() => {
    fetchLocalFavorites()
  }, [fetchLocalFavorites])

  // ========== 会话逻辑 ==========
  // 合并某服务器最新会话到本地状态,并确保 active 属于该服务器
  const loadSessions = useCallback(async (serverId: string, preferAutoCreate: boolean) => {
    const res = await fetch(`/api/servers/${serverId}/sessions`)
    let list: Session[] = await res.json()
    if (preferAutoCreate && list.length === 0) {
      const created = await fetch(`/api/servers/${serverId}/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      const s = await created.json()
      list = [s]
    }
    setSessions(prev => [...prev.filter(x => x.serverId !== serverId), ...list])
    setActiveSessionId(prev => {
      const belongs = list.some(s => s.id === prev)
      return belongs ? prev : (list[0]?.id ?? null)
    })
  }, [])

  // 选中服务器:加载其会话(不自动创建,让用户决定);切换 active 到该服务器首个会话
  useEffect(() => {
    if (!selectedServerId) {
      setActiveSessionId(null)
      return
    }
    loadSessions(selectedServerId, false)
  }, [selectedServerId, loadSessions])

  // 只要存在会话就自动激活第一个,让终端区/顶部栏直接可用(无需先在左侧点击服务器)
  useEffect(() => {
    if (!activeSessionId && sessions.length > 0) {
      const first = sessions[0]
      setSelectedServerId(first.serverId)
      setActiveSessionId(first.id)
    }
  }, [sessions, activeSessionId])

  const handleCreateSession = async (serverId: string, dir?: string) => {
    const count = sessions.filter(s => s.serverId === serverId).length
    // 满员时仍发请求,把后端 400 的具体原因(每台服务器最多 20 个会话)提示给用户;
    // 旧实现在此静默 return,用户点 + 毫无反馈
    if (count >= MAX_SESSIONS_PER_SERVER) {
      alert(`每台服务器最多 ${MAX_SESSIONS_PER_SERVER} 个会话,请先关闭部分会话`)
      return
    }
    const res = await fetch(`/api/servers/${serverId}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // dir: 文件界面「在当前目录打开会话」时指定新会话的初始工作目录
      body: JSON.stringify(dir ? { dir } : {}),
    })
    const s = await res.json()
    if (!res.ok) { alert(s?.error || '创建会话失败'); return }
    setSelectedServerId(serverId)
    setSessions(prev => [...prev, s])
    setActiveSessionId(s.id)
    setActiveTab('terminal')
    // 服务器未连接时自动连接(连接成功后 ensure 会话已存在,不会再重复建)
    if (statuses[serverId] !== 'connected') {
      handleConnect(serverId)
    }
  }


  // 文件界面:在当前远程目录打开该服务器的新会话(新 shell 自动 cd 到 dir)
  const handleOpenSessionInDir = (serverId: string, dir: string) => {
    handleCreateSession(serverId, dir)
  }

  // 终端会话「在当前目录打开文件」:读取该会话当前目录,切到文件页并定位
  const handleOpenFilesAtSession = async (s: Session) => {
    if (statuses[s.serverId] !== 'connected') await handleConnect(s.serverId)
    try {
      const res = await fetch(`/api/servers/${s.serverId}/sessions/${s.id}/cwd`)
      const d = await res.json()
      if (d.cwd) setFilesRequestPath({ serverId: s.serverId, path: d.cwd })
    } catch {}
    // 即使拿不到 cwd 也切到文件页(停在默认目录)
    setActiveTab('files')
  }

  const handleRenameSession = async (s: Session, name: string) => {
    const res = await fetch(`/api/servers/${s.serverId}/sessions/${s.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    const updated = await res.json()
    setSessions(prev => prev.map(x => (x.id === s.id ? updated : x)))
  }

  const handleDuplicateSession = async (s: Session) => {
    try {
      const res = await fetch(`/api/servers/${s.serverId}/sessions/${s.id}/duplicate`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      const dup: Session = data
      // 新会话会在 WS 连上时自动 cd 到原会话当前目录(服务端 pendingInitialDir 处理)
      setSelectedServerId(dup.serverId)
      setSessions(prev => [...prev, dup])
      setActiveSessionId(dup.id)
      setActiveTab('terminal')
    } catch (err) {
      alert(`复制会话失败: ${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  // 导出会话完整内容为 txt(去掉 ANSI 颜色转义),不限大小
  const handleExportSession = (s: Session) => {
    const content = getTerminalContent(s.id)
    const text = content == null ? '' : content
    if (!text) { alert('该会话暂无内容(可能尚未连接)'); return }
    // 去除 ANSI 转义序列,只留可读文本(与完整历史查看器共用 stripAnsi)
    // \r 也作为换行规范化,保证 TUI 全屏输出的内容在 txt 里可读(否则压成一行)
    const clean = stripAnsi(text).split(/\r\n|\r|\n/).join('\n')
    const blob = new Blob([clean], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${s.name || s.id}.txt`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 3000)
  }

  const handleDeleteSession = async (s: Session) => {
    await fetch(`/api/servers/${s.serverId}/sessions/${s.id}`, { method: 'DELETE' })
    const remaining = sessions.filter(x => x.serverId === s.serverId && x.id !== s.id)
    setSessions(prev => prev.filter(x => x.id !== s.id))
    if (activeSessionId === s.id) {
      setActiveSessionId(remaining.length ? remaining[0].id : null)
    }
  }

  const handleSelectSession = (s: Session) => {
    setSelectedServerId(s.serverId)
    setActiveSessionId(s.id)
    setActiveTab('terminal')
    // 切回该会话时清除后台输出提醒
    setBusySessions(prev => {
      if (!prev[s.id]) return prev
      const next = { ...prev }
      delete next[s.id]
      return next
    })
    if (statuses[s.serverId] !== 'connected') {
      handleConnect(s.serverId)
    }
  }

  // 后台会话输出提醒:标记该会话有新输出(仅标记,切回时清除)
  const handleSessionActivity = useCallback((sessionId: string) => {
    setBusySessions(prev => (prev[sessionId] ? prev : { ...prev, [sessionId]: true }))
  }, [])

  // 同服务器会话拖拽排序:本地就位重排 + 持久化顺序
  const handleReorderSessions = async (serverId: string, orderedIds: string[]) => {
    setSessions(prev => {
      const idxs = prev.map((s, i) => (s.serverId === serverId ? i : -1)).filter(i => i >= 0)
      const next = [...prev]
      orderedIds.forEach((id, k) => {
        const src = prev.findIndex(s => s.id === id)
        if (src !== -1 && idxs[k] !== undefined) next[idxs[k]] = prev[src]
      })
      return next
    })
    try {
      await fetch(`/api/servers/${serverId}/sessions/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: orderedIds }),
      })
    } catch { /* 顺序保存失败不阻塞 UI */ }
  }

  // ========== 本地终端(本机 PowerShell) ==========
  // 在指定目录打开本地终端:同目录已存在则仅激活,不重复创建
  const openLocalTerminal = (cwd: string) => {
    const existing = localSessions.find(s => s.local && s.cwd === cwd)
    if (existing) { setActiveLocalSessionId(existing.id); return }
    const id = 'loc-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
    // 会话名取目录末级名,磁盘根层用"本地"
    const parts = cwd.split('\\').filter(Boolean)
    const name = parts.length ? parts[parts.length - 1] : '本地'
    const s: Session = { id, serverId: '__local__', name, local: true, cwd }
    setLocalSessions(prev => [...prev, s])
    setActiveLocalSessionId(id)
  }

  const selectLocalSession = (id: string) => {
    setActiveLocalSessionId(id)
    // 切换到本地会话时,侧栏目录自动定位到该会话的 cwd
    const s = localSessions.find(x => x.id === id)
    if (s?.cwd) setBrowsePath(s.cwd)
  }

  const closeLocalSession = (id: string) => {
    const idx = localSessions.findIndex(s => s.id === id)
    const rest = localSessions.filter(s => s.id !== id)
    setLocalSessions(rest)
    if (activeLocalSessionId === id) {
      setActiveLocalSessionId(rest.length ? rest[Math.min(idx, rest.length - 1)].id : null)
    }
  }

  // 一键复制本地会话地址(cwd)到剪贴板
  const copyLocalPath = (id: string, cwd: string) => {
    try {
      navigator.clipboard?.writeText(cwd)
      setCopiedLocalId(id)
      setTimeout(() => setCopiedLocalId(cur => (cur === id ? null : cur)), 1500)
    } catch {}
  }

  // 本地终端标签拖拽排序:仅调整本地状态顺序(不持久化)
  const reorderLocalSession = (orderedIds: string[]) => {
    setLocalSessions(prev => {
      const next: Session[] = []
      for (const id of orderedIds) {
        const s = prev.find(x => x.id === id)
        if (s) next.push(s)
      }
      // 追加未涉及(理论上不会发生)的会话,保持稳定
      for (const s of prev) if (!next.some(x => x.id === s.id)) next.push(s)
      return next
    })
  }

  // 收藏/取消收藏当前目录(POST 自动去重,已有则 DELETE)
  const toggleLocalFavorite = async (path: string, name?: string) => {
    try {
      const existing = localFavorites.find(f => f.path === path)
      if (existing) {
        await fetch(`/api/local/favorites/${existing.id}`, { method: 'DELETE' })
      } else {
        await fetch('/api/local/favorites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, name }),
        })
      }
      fetchLocalFavorites()
    } catch {}
  }

  // ========== 服务器与常规交互 ==========
  const handleConnect = async (serverId: string) => {
    setStatuses(prev => ({ ...prev, [serverId]: 'connecting' }))
    try {
      const res = await fetch(`/api/servers/${serverId}/connect`, { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setStatuses(prev => ({ ...prev, [serverId]: 'connected' }))
      // 已连接但没有会话时自动补一个默认会话
      await loadSessions(serverId, true)
    } catch (err) {
      setStatuses(prev => ({ ...prev, [serverId]: 'disconnected' }))
      alert(`连接失败: ${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  const handleDisconnect = async (serverId: string) => {
    await fetch(`/api/servers/${serverId}/disconnect`, { method: 'POST' })
    setStatuses(prev => ({ ...prev, [serverId]: 'disconnected' }))
  }

  const handleSaveServer = async (server: Server) => {
    if (editingServer) {
      await fetch(`/api/servers/${server.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(server),
      })
      // 编辑可能改了 host/端口/密码:断开旧连接,让新配置下次生效
      await handleDisconnect(server.id)
    } else {
      await fetch('/api/servers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(server),
      })
    }
    await fetchServers()
    setShowModal(false)
    setEditingServer(null)
  }

  const handleDeleteServer = async (serverId: string) => {
    await fetch(`/api/servers/${serverId}`, { method: 'DELETE' })
    // 一并移除该服务器的会话与激活状态
    setSessions(prev => prev.filter(s => s.serverId !== serverId))
    if (selectedServerId === serverId) setSelectedServerId(null)
    if (sessions.some(s => s.serverId === serverId && s.id === activeSessionId)) setActiveSessionId(null)
    await fetchServers()
  }

  // ========== 左侧栏宽度拖拽调整 ==========
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = { startX: e.clientX, startW: sidebarWidth }
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      const w = Math.min(1200, Math.max(200, resizingRef.current.startW + (ev.clientX - resizingRef.current.startX)))
      sidebarWidthRef.current = w
      setSidebarWidth(w)
    }
    const onUp = () => {
      resizingRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      try { localStorage.setItem('serverhub:sidebarWidth', String(sidebarWidthRef.current)) } catch {}
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 设备文件面板宽度拖拽调整(本地视图:设备面板与终端之间)
  const startDeviceResize = (e: React.MouseEvent) => {
    e.preventDefault()
    deviceResizeRef.current = { startX: e.clientX, startW: devicePanelWidth }
    const onMove = (ev: MouseEvent) => {
      if (!deviceResizeRef.current) return
      const w = Math.min(640, Math.max(160, deviceResizeRef.current.startW + (ev.clientX - deviceResizeRef.current.startX)))
      devicePanelWidthRef.current = w
      setDevicePanelWidth(w)
    }
    const onUp = () => {
      deviceResizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      try { localStorage.setItem('serverhub:devicePanelWidth', String(devicePanelWidthRef.current)) } catch {}
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 本地终端工作区:当前活跃本地会话(顶部栏显示其 cwd)
  const activeLocalSession = localSessions.find(s => s.id === activeLocalSessionId) || null
  // 顶部栏/文件页跟随当前激活会话所属的服务器;无激活会话时回退到选中服务器
  const activeSession = sessions.find(s => s.id === activeSessionId) || null
  const activeServerId = activeSession?.serverId ?? selectedServerId ?? null
  const activeServer = servers.find(s => s.id === activeServerId) || null
  const isConnected = activeServerId ? statuses[activeServerId] === 'connected' : false
  // 所有服务器的会话都直接展示在终端区,只要有任意会话就渲染主界面
  const hasSessions = sessions.length > 0

  const tabs = [
    { id: 'terminal' as Tab, label: '终端', icon: TerminalIcon },
    { id: 'files' as Tab, label: '文件', icon: FolderTree },
  ]

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      {/* 侧边栏 */}
      <Sidebar
        servers={servers}
        statuses={statuses}
        sessions={sessions}
        activeSessionId={activeSessionId}
        selectedServerId={selectedServerId}
        onSelectServer={(id) => { setSelectedServerId(id) }}
        onAddServer={() => { setEditingServer(null); setShowModal(true) }}
        onEditServer={(s) => { setEditingServer(s); setShowModal(true) }}
        onDeleteServer={handleDeleteServer}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        onSelectSession={handleSelectSession}
        onCreateSession={handleCreateSession}
        onRenameSession={handleRenameSession}
        onDeleteSession={handleDeleteSession}
        busySessions={busySessions}
        width={sidebarWidth}
        // 本地终端视图
        view={sidebarView}
        onViewChange={setSidebarView}
        localSessions={localSessions}
        activeLocalSessionId={activeLocalSessionId}
        onSelectLocalSession={selectLocalSession}
        onCloseLocalSession={closeLocalSession}
        onOpenLocalTerminal={openLocalTerminal}
        localFavorites={localFavorites}
        onToggleLocalFavorite={toggleLocalFavorite}
        browsePath={browsePath}
        onBrowsePathChange={setBrowsePath}
      />

      {/* 侧栏/主区 拖拽分界线 */}
      <div
        onMouseDown={startResize}
        className="w-1.5 flex-shrink-0 cursor-col-resize bg-slate-800 hover:bg-accent-500/40 active:bg-accent-500/70 transition-colors"
        title="拖动调整侧栏宽度"
      />

      {/* 主内容区 */}
      <div className="flex-1 relative flex flex-col bg-bg-900 min-w-0">
        {/* 本地终端工作区:始终挂载(与远程一致),仅在本地视图显示,来回切换不中断本地会话 */}
        <div className={`absolute inset-0 flex flex-col bg-bg-900 min-w-0 ${sidebarView === 'local' ? '' : 'hidden'}`}>
            {/* 顶部栏:本地终端 + 当前活跃会话 cwd */}
            <div className="h-12 border-b border-slate-800 flex items-center gap-3 px-4 bg-bg-800/50 backdrop-blur">
              <div className="flex items-center gap-2">
                <TerminalSquare size={16} className="text-accent-400" />
                <span className="text-sm font-semibold text-slate-200">本地终端</span>
              </div>
              <span className="text-xs text-slate-500 truncate flex-1">{activeLocalSession?.cwd ?? '本机 PowerShell'}</span>
              {/* 一键打开/关闭设备目录栏 */}
              <button
                onClick={() => {
                  setDevicePanelOpen(o => {
                    const next = !o
                    try { localStorage.setItem('serverhub:devicePanelOpen', next ? '1' : '0') } catch {}
                    return next
                  })
                }}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                  devicePanelOpen
                    ? 'text-accent-400 bg-accent-500/10 border-accent-500/30'
                    : 'text-slate-400 bg-bg-800/60 border-slate-700 hover:border-slate-600 hover:text-slate-200'
                }`}
                title={devicePanelOpen ? '隐藏设备目录栏' : '打开设备目录栏'}
              >
                <Smartphone size={13} />
                {devicePanelOpen ? '设备目录' : '打开设备面板'}
              </button>
            </div>

            {/* 中间/右侧:设备文件面板 + 终端(分隔线可拖拽) */}
            <div className="flex-1 min-h-0 flex relative">
              {/* 设备文件面板(hdc):左侧本地目录里的文件可拖入上传,其文件可拖出下载(可一键开/关) */}
              {devicePanelOpen && (
                <>
                  <DeviceFilePanel width={devicePanelWidth} />

                  {/* 设备面板与终端 拖拽分界线 */}
                  <div
                    onMouseDown={startDeviceResize}
                    className="w-1.5 flex-shrink-0 cursor-col-resize bg-slate-800 hover:bg-accent-500/40 active:bg-accent-500/70 transition-colors"
                    title="拖动调整设备面板宽度"
                  />
                </>
              )}

              {/* 终端列 */}
              <div className="flex-1 min-w-0 flex flex-col">
            {/* 本地会话标签条 */}
            <div className="flex items-center gap-1.5 px-2 py-1 border-b border-slate-800 bg-bg-800/40 overflow-x-auto shrink-0">
              {localSessions.length === 0 && (
                <span className="text-[11px] text-slate-500 px-2 py-1">在左侧选择一个目录,点击「在此目录打开终端」</span>
              )}
              {localSessions.map((s) => {
                const active = s.id === activeLocalSessionId
                return (
                  <div
                    key={s.id}
                    onClick={() => selectLocalSession(s.id)}
                    draggable
                    onDragStart={(e) => {
                      localDragIdRef.current = s.id; setLocalDragId(s.id)
                      e.dataTransfer.effectAllowed = 'move'
                      e.dataTransfer.setData('text/plain', s.id)
                    }}
                    onDragOver={(e) => {
                      if (!localDragIdRef.current || localDragIdRef.current === s.id) return
                      e.preventDefault()
                      setLocalDragOverId(s.id)
                    }}
                    onDragLeave={() => setLocalDragOverId(cur => (cur === s.id ? null : cur))}
                    onDrop={(e) => {
                      e.preventDefault()
                      const dragged = localDragIdRef.current
                      localDragIdRef.current = null
                      setLocalDragId(null)
                      setLocalDragOverId(null)
                      if (!dragged || dragged === s.id) return
                      const ids = localSessions.map(x => x.id)
                      const from = ids.indexOf(dragged)
                      const to = ids.indexOf(s.id)
                      if (from === -1 || to === -1) return
                      ids.splice(from, 1)
                      ids.splice(to, 0, dragged)
                      reorderLocalSession(ids)
                    }}
                    onDragEnd={() => { localDragIdRef.current = null; setLocalDragId(null); setLocalDragOverId(null) }}
                    className={`group flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium cursor-pointer border shrink-0 transition-all select-none ${
                      localDragId === s.id ? 'opacity-40' : ''
                    } ${
                      localDragOverId === s.id
                        ? 'border-accent-500/60 bg-accent-500/10 text-accent-300'
                        : active
                          ? 'bg-accent-500/15 text-accent-400 border-accent-500/30'
                          : 'text-slate-400 border-transparent hover:bg-bg-600 hover:text-slate-200'
                    }`}
                    title={s.cwd}
                  >
                    <TerminalSquare size={12} className={active ? 'text-accent-400' : 'text-slate-500'} />
                    <span className="truncate max-w-[8rem]">{s.name}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); copyLocalPath(s.id, s.cwd || '') }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-bg-600 text-slate-500 hover:text-accent-400"
                      title={copiedLocalId === s.id ? '已复制' : '复制此会话地址'}
                    >
                      {copiedLocalId === s.id ? <Check size={11} className="text-accent-400" /> : <Copy size={11} />}
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); closeLocalSession(s.id) }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-bg-600 text-slate-500 hover:text-red-400"
                      title="关闭本地会话"
                    >
                      <X size={11} />
                    </button>
                  </div>
                )
              })}
            </div>

            {/* 持久终端层:所有本地会话常驻挂载,切换标签不中断 WS/进程 */}
            <div className="relative flex-1 min-h-0">
              {localSessions.map(s => (
                <LocalTerminal
                  key={s.id}
                  id={s.id}
                  name={s.name}
                  cwd={s.cwd!}
                  active={s.id === activeLocalSessionId}
                  onActivity={handleSessionActivity}
                />
              ))}
            </div>
              </div>
            </div>
          </div>

        {/* 远程工作区:始终挂载,切到本地视图仅用 CSS 隐藏(WS/进程不断,远程任务不中断) */}
        {hasSessions && (
          <div className={`absolute inset-0 flex flex-col ${sidebarView === 'local' ? 'hidden' : ''}`}>
            {/* 顶部栏 */}
            <div className="h-12 border-b border-slate-800 flex items-center justify-between px-4 bg-bg-800/50 backdrop-blur">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <ServerIcon size={16} className="text-accent-400" />
                  <span className="text-sm font-semibold text-slate-200">{activeServer?.name ?? '未选择服务器'}</span>
                </div>
                <span className="text-xs text-slate-500">{activeServer ? `${activeServer.host}:${activeServer.port}` : ''}</span>
                <span className={`text-xs font-medium ${
                  isConnected ? 'status-connected' : 'status-disconnected'
                }`}>
                  ● {isConnected ? '已连接' : (activeServerId ? (statuses[activeServerId] || '断开') : '')}
                </span>
              </div>

              {/* Tab 切换 */}
              <div className="flex items-center gap-1 bg-bg-900/80 rounded-lg p-1 border border-slate-800">
                {tabs.map(tab => {
                  const Icon = tab.icon
                  const active = activeTab === tab.id
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id)}
                      className={`px-3 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-all ${
                        active
                          ? 'bg-accent-500/15 text-accent-400 shadow-sm'
                          : 'text-slate-400 hover:text-slate-300 hover:bg-bg-600'
                      }`}
                    >
                      <Icon size={14} />
                      {tab.label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 内容区 */}
            <div className="flex-1 overflow-hidden relative">
              {/* 持久终端层:所有服务器的全部会话常驻挂载,WS 不断;非激活仅隐藏 */}
              <div className={`absolute inset-0 flex flex-col ${activeTab === 'terminal' ? '' : 'hidden'}`}>
                <SessionTabs
                  servers={servers}
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  onSelect={(id) => {
                    const s = sessions.find(x => x.id === id)
                    if (s) handleSelectSession(s)
                  }}
                  onCreate={(serverId) => handleCreateSession(serverId)}
                  onRename={handleRenameSession}
                  onClose={handleDeleteSession}
                  onDuplicate={handleDuplicateSession}
                  onReorder={handleReorderSessions}
                  busySessions={busySessions}
                  onExportSession={handleExportSession}
                />
                <div className="relative flex-1 min-h-0">
                  {sessions.map(s => {
                    const visible = s.id === activeSessionId
                    return (
                      <div key={s.id} className={`absolute inset-0 ${visible ? '' : 'hidden'}`}>
                        <Terminal
                          session={s}
                          serverName={servers.find(x => x.id === s.serverId)?.name || s.serverId}
                          isConnected={statuses[s.serverId] === 'connected'}
                          active={visible}
                          onConnect={() => handleConnect(s.serverId)}
                          onActivity={handleSessionActivity}
                          onOpenFilesAtSession={handleOpenFilesAtSession}
                        />
                      </div>
                    )
                  })}
                </div>
              </div>

              {/* 文件页 */}
              {activeTab === 'files' && (
                <div className="absolute inset-0">
                  <FileBrowser
                    serverId={activeServerId!}
                    isConnected={isConnected}
                    onConnect={() => handleConnect(activeServerId!)}
                    onOpenSessionInDir={(id, dir) => handleOpenSessionInDir(id, dir)}
                    requestPath={filesRequestPath && filesRequestPath.serverId === activeServerId ? filesRequestPath.path : null}
                    onRequestHandled={() => setFilesRequestPath(null)}
                  />
                </div>
              )}
            </div>

            {/* 全局传输条(常驻,跨标签/服务器不中断) */}
            <TransferBar
              serverNameById={(id) => servers.find(x => x.id === id)?.name || id}
            />
          </div>
        )}

        {/* 空状态 */}
        {sidebarView !== 'local' && !hasSessions && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-sm">
              <div className="w-20 h-20 rounded-2xl bg-bg-800 border border-slate-800 flex items-center justify-center mx-auto mb-4 relative">
                <ServerIcon size={36} className="text-slate-600" />
                <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-accent-500/10 border border-accent-500/30 flex items-center justify-center">
                  <span className="text-accent-400 text-lg font-bold">+</span>
                </div>
              </div>
              <h2 className="text-lg font-semibold text-slate-300 mb-1">开始管理你的服务器</h2>
              <p className="text-sm text-slate-500 mb-4">
                在左侧添加服务器,填入 IP、用户名、密码即可连接。<br/>
                支持多会话终端、文件浏览、命令预设三大功能。
              </p>
              <button
                onClick={() => { setEditingServer(null); setShowModal(true) }}
                className="btn-primary"
              >
                + 添加服务器
              </button>
            </div>
          </div>
        )}
      </div>

      {/* 添加/编辑服务器弹窗 */}
      {showModal && (
        <ServerModal
          server={editingServer}
          onSave={handleSaveServer}
          onClose={() => { setShowModal(false); setEditingServer(null) }}
        />
      )}
    </div>
  )
}

export default App
