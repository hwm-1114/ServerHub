import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { FileEntry, Bookmark } from '../types'
import { startUpload, startDownload, whenSettled } from '../lib/TransferStore'
import { collectDroppedFiles } from '../lib/dragFiles'
import { ConfirmDialog } from './ConfirmDialog'
import { RemoteLocalPanel } from './RemoteLocalPanel'
import { apiFetch } from '../lib/api'
import { withWsToken } from '../lib/token'
import { DND_MIME, makeDndData, readDndData, DndFile } from './DeviceFilePanel'
import {
  Folder, File, ChevronRight, Home, ArrowUp, RefreshCw, Plug,
  FileText, Link2, Lock, ChevronLeft, X, Download, AlertTriangle,
  Trash2, Star, Upload, Bookmark as BookmarkIcon, Computer,
  CheckSquare, Square, Loader2, TerminalSquare,
  FolderPlus, Pencil, Save, Search,
} from 'lucide-react'

interface Props {
  serverId: string
  isConnected: boolean
  onConnect: () => void
  /** 在文件当前远程目录打开该服务器的新会话 */
  onOpenSessionInDir?: (serverId: string, dir: string) => void
  /** 会话「在当前目录打开文件」:请求定位到的目录(处理后上层应清空) */
  requestPath?: string | null
  /** 已处理 requestPath 后回调,用于上层清空状态 */
  onRequestHandled?: () => void
}

export function FileBrowser({ serverId, isConnected, onConnect, onOpenSessionInDir, requestPath, onRequestHandled }: Props) {
  const [currentPath, setCurrentPath] = useState('~')
  // 目录 ref:上传完成回调触发时读"当时"的目录,而非闭包捕获的旧目录
  const currentPathRef = useRef(currentPath)
  currentPathRef.current = currentPath
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [rawOutput, setRawOutput] = useState<string | null>(null)
  const [warning, setWarning] = useState('')
  const [history, setHistory] = useState<string[]>(['~'])
  const [historyIndex, setHistoryIndex] = useState(0)
  const [fileContent, setFileContent] = useState<{ path: string; content: string } | null>(null)
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [deleteTarget, setDeleteTarget] = useState<{ kind: 'file' | 'dir'; path: string; name: string } | null>(null)
  const [showDangerConfirm, setShowDangerConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [sortKey, setSortKey] = useState<'name' | 'size' | 'mtime'>('name')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
  const fileInputRef = useRef<HTMLInputElement>(null)
  // 拖拽上传/下载视觉状态
  const [dragOverDepth, setDragOverDepth] = useState(0)
  const [dlZoneOver, setDlZoneOver] = useState(false)
  const dragDepthRef = useRef(0)
  const isDraggingOver = dragOverDepth > 0
  const [notice, setNotice] = useState('')
  // 本机(Windows)目录面板:开关 + 宽度(分隔线可拖拽)
  const [showLocalPanel, setShowLocalPanel] = useState(false)
  const [localPanelWidth, setLocalPanelWidth] = useState<number>(() => {
    const saved = Number(localStorage.getItem('serverhub:localPanelWidth'))
    return saved >= 160 && saved <= 600 ? saved : 280
  })
  const localResizeRef = useRef<{ startX: number; startW: number } | null>(null)
  const localPanelWidthRef = useRef(localPanelWidth)
  // 本机面板当前目录 + 远程文件批量勾选(下载选中到本机)
  const [localPanelPath, setLocalPanelPath] = useState('')
  // 本机面板刷新信号:批量下载完成后通知面板重新列目录
  const [localPanelRefresh, setLocalPanelRefresh] = useState(0)
  const [selRemote, setSelRemote] = useState<Set<string>>(new Set())
  const [downloading, setDownloading] = useState(false)
  // 远程目录批量勾选模式:由工具栏开关控制,不再随"打开本机面板"自动出现
  const [selectMode, setSelectMode] = useState(false)
  // Shift 连续选择锚点:记录最后一次(非 shift)点击的列表索引
  const selAnchorRef = useRef(-1)
  // 目录加载请求序号:仅最新一次 loadDir 的响应允许写入 state(防快速导航竞态)
  const loadSeqRef = useRef(0)

  // 批量下载选中远程文件到本机当前目录(串行,聚合每文件失败原因)
  const downloadSelectedLocal = async () => {
    const files = Array.from(selRemote)
    if (files.length === 0 || !localPanelPath) { setNotice('请勾选远程文件,且本机面板需进入一个目录'); return }
    setDownloading(true)
    let ok = 0
    const fails: string[] = []
    for (const p of files) {
      const name = p.split('/').filter(Boolean).pop() || ''
      try {
        const r = await fetch(`/api/servers/${serverId}/files/remote-to-local`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ remotePath: p, localDir: localPanelPath }),
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
        ok++
      } catch (err) {
        fails.push(`${name}: ${err instanceof Error ? err.message : '未知错误'}`)
      }
    }
    setDownloading(false)
    setSelRemote(new Set())
    // 通知本机面板刷新:旧实现只刷远端列表,新下载的文件在本机面板里看不到
    setLocalPanelRefresh(n => n + 1)
    if (fails.length === 0) setNotice(`已下载 ${ok}/${files.length} 个文件到 ${localPanelPath}`)
    else {
      const head = fails.slice(0, 2).join('；')
      setNotice(`已下载 ${ok}/${files.length} 个文件,失败: ${head}${fails.length > 2 ? ` 等 ${fails.length} 项` : ''}`)
    }
  }

  // 切换单个文件选中,并更新 shift 锚点
  const toggleSelRemote = (p: string, idx: number) => {
    setSelRemote(prev => {
      const n = new Set(prev)
      if (n.has(p)) n.delete(p); else n.add(p)
      return n
    })
    selAnchorRef.current = idx
  }

  // 文件行点击:shift 时按锚点做连续区间选择;否则普通切换
  const handleSelectClick = (e: React.MouseEvent, p: string, idx: number) => {
    if (e.shiftKey) {
      const anchor = selAnchorRef.current >= 0 ? selAnchorRef.current : idx
      const a = Math.min(anchor, idx)
      const b = Math.max(anchor, idx)
      setSelRemote(prev => {
        const n = new Set(prev)
        for (let k = a; k <= b; k++) {
          const row = sortedEntries[k]
          if (row && !row.isDirectory) {
            const full = currentPath.endsWith('/') ? currentPath + row.filename : currentPath + '/' + row.filename
            n.add(full)
          }
        }
        return n
      })
      return
    }
    toggleSelRemote(p, idx)
  }

  const loadDir = useCallback(async (dirPath: string) => {
    if (!isConnected) return
    // 请求序号防竞态:快速连续导航时,旧请求的响应若晚于新请求返回,直接丢弃,
    // 避免过期数据覆盖 entries / 把 currentPath 定回旧目录
    const seq = ++loadSeqRef.current
    setLoading(true)
    setError('')
    setRawOutput(null)
    setWarning('')
    setSearchResults(null) // 导航/刷新即退出搜索结果视图
    try {
      // 先通过 exec 解析 ~ 为绝对路径
      let resolvedPath = dirPath
      if (dirPath.startsWith('~')) {
        const res = await fetch(`/api/servers/${serverId}/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'echo $HOME' }),
        })
        const data = await res.json()
        if (seq !== loadSeqRef.current) return
        const home = data.stdout?.trim()
        if (home) {
          resolvedPath = dirPath.replace('~', home)
        }
      }

      const res = await fetch(`/api/servers/${serverId}/files?path=${encodeURIComponent(resolvedPath)}`)
      const data = await res.json()
      if (seq !== loadSeqRef.current) return
      if (!res.ok) throw new Error(data.error)

      if (data.entries && data.entries.length > 0) {
        // 排序：目录在前，按名称排序
        const sorted = data.entries.sort((a: FileEntry, b: FileEntry) => {
          if (a.isDirectory && !b.isDirectory) return -1
          if (!a.isDirectory && b.isDirectory) return 1
          return a.filename.localeCompare(b.filename)
        })
        setEntries(sorted)
        setRawOutput(null)
        setWarning('')
      } else if (data.raw) {
        // 用 ls 输出回退（如权限不足），原样展示而不是误报"空目录"
        setEntries([])
        setRawOutput(data.raw)
        setWarning(data.note || '')
      } else {
        setEntries([])
        setRawOutput(null)
        setWarning('')
      }
      setCurrentPath(resolvedPath)
    } catch (err) {
      if (seq === loadSeqRef.current) setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [serverId, isConnected])

  // 连接或切换服务器时重置并重新加载;若带 requestPath(会话「在当前目录打开文件」)
  // 则直接定位到该目录,避免与默认跳 ~ 的两次加载竞态导致路径不一致。
  useEffect(() => {
    if (!isConnected) return
    const target = requestPath || '~'
    setCurrentPath(target)
    setHistory([target])
    setHistoryIndex(0)
    setEntries([])
    setFileContent(null)
    setRawOutput(null)
    setWarning('')
    setError('')
    loadDir(target)
    if (requestPath) onRequestHandled?.() // 已采用该定位,通知上层清空请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId, isConnected, loadDir])

  // 已连接期间收到新的定位请求(终端「在当前目录打开文件」)→ 单独导航。
  // 上面的重置 effect 依赖里没有 requestPath(加上会在消费置 null 时把目录拉回 ~),
  // 所以在这里补:只在 requestPath 变为新的非空值时动作。
  const requestPathRef = useRef(requestPath)
  useEffect(() => {
    const prev = requestPathRef.current
    requestPathRef.current = requestPath
    if (!requestPath || requestPath === prev || !isConnected) return
    setCurrentPath(requestPath)
    setHistory([requestPath])
    setHistoryIndex(0)
    setFileContent(null)
    loadDir(requestPath)
    onRequestHandled?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestPath])

  const navigateTo = (newPath: string) => {
    if (newPath === currentPath) return
    setHistory(prev => [...prev.slice(0, historyIndex + 1), newPath])
    setHistoryIndex(prev => prev + 1)
    loadDir(newPath)
  }

  const goBack = () => {
    if (historyIndex > 0) {
      const newIndex = historyIndex - 1
      setHistoryIndex(newIndex)
      loadDir(history[newIndex])
    }
  }

  const goForward = () => {
    if (historyIndex < history.length - 1) {
      const newIndex = historyIndex + 1
      setHistoryIndex(newIndex)
      loadDir(history[newIndex])
    }
  }

  const goUp = () => {
    if (currentPath === '/' || currentPath === '') return
    const parts = currentPath.split('/').filter(Boolean)
    parts.pop()
    navigateTo('/' + parts.join('/'))
  }

  const handleEntryClick = (entry: FileEntry) => {
    if (entry.isDirectory) {
      const newPath = currentPath.endsWith('/')
        ? currentPath + entry.filename
        : currentPath + '/' + entry.filename
      navigateTo(newPath)
    } else if (entry.isSymlink) {
      const newPath = currentPath.endsWith('/')
        ? currentPath + entry.filename
        : currentPath + '/' + entry.filename
      navigateTo(newPath)
    } else {
      // 查看小文件内容
      const filePath = currentPath.endsWith('/')
        ? currentPath + entry.filename
        : currentPath + '/' + entry.filename
      viewFile(filePath)
    }
  }

  const viewFile = async (filePath: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/servers/${serverId}/files/content?path=${encodeURIComponent(filePath)}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setFileContent({ path: filePath, content: data.content })
      setEditDraft(data.content)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取失败')
    } finally {
      setLoading(false)
    }
  }

  // ========== 收藏夹 ==========
  const fetchBookmarks = useCallback(async () => {
    try {
      const list = await apiFetch(`/api/servers/${serverId}/bookmarks`)
      // 失败时保持空列表;错误体不是数组会导致下方 bookmarks.some 崩溃
      setBookmarks(Array.isArray(list) ? list : [])
    } catch { /* 加载失败保持现状 */ }
  }, [serverId])

  useEffect(() => {
    fetchBookmarks()
  }, [fetchBookmarks, isConnected])

  const addBookmark = async () => {
    if (!currentPath || currentPath === '~') return
    const res = await fetch(`/api/servers/${serverId}/bookmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: currentPath }),
    })
    if (res.ok) fetchBookmarks()
  }

  const removeBookmark = async (id: string) => {
    await fetch(`/api/servers/${serverId}/bookmarks/${id}`, { method: 'DELETE' })
    fetchBookmarks()
  }

  const isCurrentBookmarked = bookmarks.some(b => b.path === currentPath)

  // ========== 文件管理补齐:新建目录 / 重命名 / 递归搜索 / 在线编辑保存 ==========
  // 远端路径拼接(currentPath 已在 loadDir 时解析为绝对路径)
  const joinRemote = (dir: string, name: string) => `${dir.replace(/\/+$/, '')}/${name}`
  const [newDirName, setNewDirName] = useState<string | null>(null) // 非 null = 弹窗开启
  const [renameTarget, setRenameTarget] = useState<{ name: string; draft: string } | null>(null)
  const [fsBusy, setFsBusy] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState<{ results: string[]; truncated: boolean } | null>(null)
  const [searching, setSearching] = useState(false)
  // 在线编辑(与预览共用 512KB 上限,后端强制)
  const [editing, setEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [saving, setSaving] = useState(false)

  const doMkdir = async () => {
    const name = (newDirName || '').trim()
    if (!name) return
    setFsBusy(true)
    try {
      await apiFetch(`/api/servers/${serverId}/files/mkdir`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: joinRemote(currentPath, name) }),
      })
      setNewDirName(null)
      loadDir(currentPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : '新建目录失败')
      setNewDirName(null)
    } finally { setFsBusy(false) }
  }

  const doRename = async () => {
    if (!renameTarget) return
    const draft = renameTarget.draft.trim()
    if (!draft || draft === renameTarget.name) { setRenameTarget(null); return }
    setFsBusy(true)
    try {
      await apiFetch(`/api/servers/${serverId}/files/rename`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: joinRemote(currentPath, renameTarget.name), newPath: joinRemote(currentPath, draft) }),
      })
      setRenameTarget(null)
      loadDir(currentPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : '重命名失败')
      setRenameTarget(null)
    } finally { setFsBusy(false) }
  }

  const doSearch = async () => {
    const q = searchQ.trim()
    if (!q) { setSearchResults(null); return }
    setSearching(true)
    try {
      const d = await apiFetch<{ results: string[]; truncated: boolean }>(
        `/api/servers/${serverId}/files/search?path=${encodeURIComponent(currentPath)}&q=${encodeURIComponent(q)}`)
      setSearchResults(d)
    } catch (err) {
      setError(err instanceof Error ? err.message : '搜索失败')
    } finally { setSearching(false) }
  }

  const saveEdit = async () => {
    if (!fileContent) return
    setSaving(true)
    try {
      await apiFetch(`/api/servers/${serverId}/files/content`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: fileContent.path, content: editDraft }),
      })
      setFileContent({ ...fileContent, content: editDraft })
      setEditing(false)
      loadDir(currentPathRef.current)
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally { setSaving(false) }
  }

  // ========== 上传 ==========
  const onPickFiles = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || [])
    if (files.length === 0) return
    const ids = files.map(f => startUpload(serverId, currentPath, f))
    // 清空 value,保证再次选择同一文件也能触发
    e.target.value = ''
    // 这批真正传完后才刷新(定时 800ms 会在大文件未传完时刷出缺文件的列表)
    whenSettled(ids, () => { loadDir(currentPathRef.current); fetchBookmarks() })
  }

  // ========== 删除(文件单确认;目录二次确认) ==========
  const startDelete = (entry: FileEntry) => {
    const full = currentPath.endsWith('/')
      ? currentPath + entry.filename
      : currentPath + '/' + entry.filename
    if (entry.isDirectory || entry.isSymlink) {
      setDeleteTarget({ kind: 'dir', path: full, name: entry.filename })
      setShowDangerConfirm(false) // 先第一层
    } else {
      setDeleteTarget({ kind: 'file', path: full, name: entry.filename })
    }
  }

  const doDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      const res = await fetch(`/api/servers/${serverId}/files?path=${encodeURIComponent(deleteTarget.path)}`, { method: 'DELETE' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setDeleteTarget(null)
      setShowDangerConfirm(false)
      loadDir(currentPath)
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
      setDeleteTarget(null)
      setShowDangerConfirm(false)
    } finally {
      setDeleting(false)
    }
  }

  // ========== 拖拽上传(本地文件/文件夹 → 当前远程目录) ==========
  const onRootDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onRootDragEnter = (e: React.DragEvent) => {
    // 仅当拖的是文件/目录时激活上传遮罩
    if (e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      dragDepthRef.current += 1
      setDragOverDepth(dragDepthRef.current)
    }
  }
  const onRootDragLeave = (e: React.DragEvent) => {
    // 与 enter 的判定对称(enter 只对 Files 类型计数):非文件拖拽的 leave 不减,
    // 否则计数会偏低、上传遮罩提前消失
    if (!(e.dataTransfer.types && e.dataTransfer.types.includes('Files'))) return
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    setDragOverDepth(dragDepthRef.current)
  }
  const onUploadDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragOverDepth(0)
    if (!e.dataTransfer || !isConnected) return
    const dropped = await collectDroppedFiles(e.dataTransfer)
    if (dropped.length === 0) return
    const ids: string[] = []
    for (const d of dropped) {
      // 目标目录 = 当前目录(或加相对子路径)
      const base = currentPath === '~' ? '~' : currentPath
      const targetDir = d.relPath.includes('/')
        ? `${base.replace(/\/+$/, '')}/${d.relPath.substring(0, d.relPath.lastIndexOf('/'))}`
        : base
      ids.push(startUpload(serverId, targetDir, d.file))
    }
    setNotice(`已添加 ${dropped.length} 个文件到上传队列`)
    // 全部传完后刷新(用目录 ref,避免闭包捕获拖放瞬间的旧目录)
    whenSettled(ids, () => { loadDir(currentPathRef.current); fetchBookmarks() })
  }

  // ========== 拖拽下载(远程文件 → 系统文件夹 / 界面内下载区) ==========
  const onRowDragStart = (e: React.DragEvent, entry: FileEntry) => {
    if (entry.isDirectory) return
    const full = currentPath.endsWith('/')
      ? currentPath + entry.filename
      : currentPath + '/' + entry.filename
    e.dataTransfer.effectAllowed = 'copy'
    // Chrome 支持拖出到系统文件夹直接保存;访问令牌需走 URL 参数
    // (原生拖出是浏览器直接拉取,不带 X-ServerHub-Token 头)
    try {
      const dlUrl = withWsToken(`/api/servers/${serverId}/files/download?path=${encodeURIComponent(full)}`)
      e.dataTransfer.setData('DownloadURL', `application/octet-stream:${entry.filename}:${window.location.origin}${dlUrl}`)
    } catch {}
    // 界面内下载区识别
    e.dataTransfer.setData('application/x-sdh-dl', full)
    // 本机(Windows)目录面板识别(拖过去=下载到本机)
    e.dataTransfer.setData(DND_MIME, makeDndData('server', full, entry.filename, false))
  }
  const onDlZoneDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDlZoneOver(false)
    const paths = e.dataTransfer.getData('application/x-sdh-dl')?.split('\n').filter(Boolean)
    if (paths && paths.length) {
      for (const p of paths) startDownload(serverId, p)
      setNotice(`已开始下载 ${paths.length} 个文件`)
    }
  }

  // 本机(Windows)面板宽度拖拽调整
  const startLocalPanelResize = (e: React.MouseEvent) => {
    e.preventDefault()
    localResizeRef.current = { startX: e.clientX, startW: localPanelWidth }
    const onMove = (ev: MouseEvent) => {
      if (!localResizeRef.current) return
      // 向右拖=本地面板变宽(分隔线右移,左侧面板随之变宽)
      const w = Math.min(600, Math.max(160, localResizeRef.current.startW + (ev.clientX - localResizeRef.current.startX)))
      localPanelWidthRef.current = w
      setLocalPanelWidth(w)
    }
    const onUp = () => {
      localResizeRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      try { localStorage.setItem('serverhub:localPanelWidth', String(localPanelWidthRef.current)) } catch {}
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 接收从本机面板拖入的本地文件 → 上传远端当前目录(串行,聚合每文件失败原因)
  const onLocalToRemoteDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragOverDepth(0)
    if (!e.dataTransfer || !isConnected) return
    const data = readDndData(e)
    if (!data || data.kind !== 'local') return
    const all: DndFile[] = Array.isArray(data.files) && data.files.length ? data.files : [data as DndFile]
    const items = all.filter((f: DndFile) => !f.isDir)
    const skippedDirs = all.length - items.length
    if (items.length === 0) { setNotice('目录暂不支持传输,已跳过'); return }
    let ok = 0
    const fails: string[] = []
    for (const f of items) {
      try {
        const r = await fetch(`/api/servers/${serverId}/files/local-to-remote`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ localPath: f.path, remoteDir: currentPath }),
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
        ok++
      } catch (err) {
        fails.push(`${f.name}: ${err instanceof Error ? err.message : '未知错误'}`)
      }
    }
    const skipNote = skippedDirs ? `(已跳过 ${skippedDirs} 个目录)` : ''
    if (fails.length === 0) setNotice(`已上传 ${ok}/${items.length} 个文件 → ${currentPath}${skipNote}`)
    else {
      const head = fails.slice(0, 2).join('；')
      setNotice(`已上传 ${ok}/${items.length} 个文件${skipNote},失败: ${head}${fails.length > 2 ? ` 等 ${fails.length} 项` : ''}`)
    }
    setTimeout(() => { loadDir(currentPath); fetchBookmarks() }, 600)
  }

  // 操作提示(上传/下载)短暂显示
  useEffect(() => {
    if (!notice) return
    const t = setTimeout(() => setNotice(''), 2200)
    return () => clearTimeout(t)
  }, [notice])

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  const formatTime = (mtime: number) => {
    const d = new Date(mtime * 1000)
    return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  const pathSegments = currentPath.split('/').filter(Boolean)

  // 排序:目录优先,组内再按所选列排序
  const sortedEntries = useMemo(() => {
    const arr = [...entries]
    arr.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      let cmp = 0
      if (sortKey === 'name') cmp = a.filename.localeCompare(b.filename, undefined, { numeric: true })
      else if (sortKey === 'size') cmp = a.size - b.size
      else cmp = (a.mtime || 0) - (b.mtime || 0)
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [entries, sortKey, sortDir])

  const toggleSort = (key: 'name' | 'size' | 'mtime') => {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sortArrow = (key: 'name' | 'size' | 'mtime') =>
    sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center h-full bg-bg-900">
        <div className="text-center">
          <div className="w-16 h-16 rounded-full bg-bg-800 border border-slate-700 flex items-center justify-center mx-auto mb-3">
            <Plug size={24} className="text-slate-500" />
          </div>
          <p className="text-sm text-slate-400 mb-3">连接服务器后可浏览文件</p>
          <button onClick={onConnect} className="btn-primary">
            <Plug size={15} /> 连接服务器
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className="flex h-full bg-bg-900 relative"
      onDragOver={onRootDragOver}
      onDragEnter={onRootDragEnter}
      onDragLeave={onRootDragLeave}
      onDrop={(e) => {
        // 落点在本机面板内的拖拽不作为上传:面板自身处理 DND_MIME(已 stopPropagation),
        // 这里兜住"系统文件拖到本机面板"——用户意图是存本机,浏览器做不到,明确提示
        if ((e.target as HTMLElement).closest?.('[data-localpanel]')) {
          e.preventDefault()
          if (e.dataTransfer.types.includes('Files')) setNotice('系统文件请拖到右侧远程区域上传;本机面板只接收远程文件的拖入下载')
          return
        }
        // 来自本机(Windows)面板的拖拽 → 上传远端;来自系统文件 → 普通上传
        if (e.dataTransfer.types.includes(DND_MIME)) { onLocalToRemoteDrop(e); return }
        onUploadDrop(e)
      }}
    >
      {/* 本机(Windows)目录面板:可开关,与远程文件之间互相拖拽上传下载 */}
      {showLocalPanel && (
        <>
          <RemoteLocalPanel serverId={serverId} width={localPanelWidth} remoteDir={currentPath} onPathChange={setLocalPanelPath} refreshSignal={localPanelRefresh} />
          <div
            onMouseDown={startLocalPanelResize}
            className="w-1.5 flex-shrink-0 cursor-col-resize bg-slate-800 hover:bg-accent-500/40 active:bg-accent-500/70 transition-colors"
            title="拖动调整本机面板宽度"
          />
        </>
      )}

      {/* 拖拽上传遮罩 */}
      {isDraggingOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-accent-500/20 backdrop-blur-[2px] pointer-events-none">
          <div className="px-6 py-3 rounded-xl bg-bg-800/90 border-2 border-dashed border-accent-500 text-accent-300 text-sm">
            松开以上传到当前目录
            <div className="text-[11px] text-slate-400 mt-0.5">{currentPath}</div>
          </div>
        </div>
      )}

      {/* 操作提示 */}
      {notice && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-30 px-3 py-1 rounded-full bg-accent-500/15 border border-accent-500/30 text-accent-300 text-xs">
          {notice}
        </div>
      )}

      {/* 文件列表区 */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* 工具栏 */}
        <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 bg-bg-800/50">
          <button onClick={goBack} disabled={historyIndex === 0}
            className="p-1.5 rounded hover:bg-bg-600 disabled:opacity-30 text-slate-400">
            <ChevronLeft size={16} />
          </button>
          <button onClick={goForward} disabled={historyIndex >= history.length - 1}
            className="p-1.5 rounded hover:bg-bg-600 disabled:opacity-30 text-slate-400">
            <ChevronRight size={16} />
          </button>
          <button onClick={goUp} className="p-1.5 rounded hover:bg-bg-600 text-slate-400" title="上一级">
            <ArrowUp size={16} />
          </button>
          <button onClick={() => loadDir(currentPath)} className="p-1.5 rounded hover:bg-bg-600 text-slate-400" title="刷新">
            <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          </button>

          {/* 本机(Windows)目录面板开关:可与远程文件互相拖拽上传下载 */}
          <button
            onClick={() => setShowLocalPanel(p => {
              // 关闭时清空父级记录的本机目录:旧实现路径残留,批量下载会写进
              // 一个看不见的旧目录
              if (p) setLocalPanelPath('')
              return !p
            })}
            className={`p-1.5 rounded hover:bg-bg-600 ${showLocalPanel ? 'text-accent-400 bg-accent-500/10' : 'text-slate-400 hover:text-accent-400'}`}
            title={showLocalPanel ? '关闭本机目录面板' : '打开本机(Windows)目录面板(可与远程互拖上传下载)'}
          >
            <Computer size={16} />
          </button>

          {/* 远程目录进入批量勾选模式(与"打开本机面板"解耦) */}
          <button
            onClick={() => setSelectMode(m => { if (m) { setSelRemote(new Set()); selAnchorRef.current = -1 } return !m })}
            className={`p-1.5 rounded hover:bg-bg-600 ${selectMode ? 'text-accent-400 bg-accent-500/10' : 'text-slate-400 hover:text-accent-400'}`}
            title={selectMode ? '退出批量勾选(清除选择)' : '批量勾选远程文件(Shift 可连续选择)'}
          >
            {selectMode ? <CheckSquare size={16} /> : <Square size={16} />}
          </button>

          {/* 在当前远程目录打开该服务器的新会话 */}
          <button
            onClick={() => onOpenSessionInDir?.(serverId, currentPath)}
            className="p-1.5 rounded hover:bg-bg-600 text-accent-400 hover:text-accent-300"
            title="在当前目录打开该服务器的新会话"
          >
            <TerminalSquare size={16} />
          </button>

          {/* 批量下载选中远程文件到本机(currentPath 为远程目录) */}
          {selRemote.size > 0 && (
            <button
              onClick={downloadSelectedLocal}
              disabled={downloading || !localPanelPath}
              className="px-2 py-1 rounded-md text-[11px] font-medium bg-accent-500/15 text-accent-400 border border-accent-500/30 hover:bg-accent-500/25 disabled:opacity-40"
              title={localPanelPath ? `下载选中的 ${selRemote.size} 个远程文件到本机 ${localPanelPath}` : '请先在本机面板进入一个目录'}
            >
              {downloading ? <Loader2 size={11} className="animate-spin inline" /> : <Download size={11} className="inline" />} 下载选中到本机({selRemote.size})
            </button>
          )}

          {/* 收藏当前路径 */}
          <button
            onClick={addBookmark}
            disabled={!currentPath || currentPath === '~' || isCurrentBookmarked}
            className={`p-1.5 rounded hover:bg-bg-600 disabled:opacity-30 disabled:hover:bg-transparent ${
              isCurrentBookmarked ? 'text-amber-400' : 'text-slate-400'
            }`}
            title={isCurrentBookmarked ? '已收藏当前路径' : '收藏当前路径'}
          >
            <Star size={16} />
          </button>

          {/* 上传 */}
          <button onClick={() => fileInputRef.current?.click()} className="p-1.5 rounded hover:bg-bg-600 text-accent-400" title="上传文件">
            <Upload size={16} />
          </button>
          <input ref={fileInputRef} type="file" multiple hidden onChange={onPickFiles} />

          {/* 新建文件夹 */}
          <button
            onClick={() => setNewDirName('')}
            disabled={!isConnected || currentPath === '~'}
            className="p-1.5 rounded hover:bg-bg-600 text-accent-400 disabled:opacity-30"
            title="在当前目录新建文件夹(递归创建)"
          >
            <FolderPlus size={16} />
          </button>

          {/* 递归搜索当前目录 */}
          <div className="flex items-center gap-1 ml-1">
            <input
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') doSearch() }}
              placeholder="搜索当前目录"
              className="w-28 bg-bg-900 border border-slate-700 rounded px-2 py-1 text-[11px] text-slate-300 outline-none focus:border-accent-500/60"
            />
            <button
              onClick={doSearch}
              disabled={searching || !isConnected || !searchQ.trim()}
              className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400 disabled:opacity-30"
              title="递归搜索当前目录(默认 5 层,最多 2000 条)"
            >
              {searching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
            </button>
            {searchResults && (
              <button
                onClick={() => { setSearchResults(null); setSearchQ('') }}
                className="p-1 rounded hover:bg-bg-600 text-slate-500 hover:text-slate-300"
                title="退出搜索结果"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* 下载拖拽区: 拖远程文件到这里即下载 */}
          <div
            onDragOver={(e) => { e.preventDefault(); setDlZoneOver(true) }}
            onDragLeave={() => setDlZoneOver(false)}
            onDrop={onDlZoneDrop}
            className={`flex items-center gap-1 px-2 py-1 rounded border text-slate-400 border-dashed transition-colors ${dlZoneOver ? "border-accent-500 text-accent-300 bg-accent-500/10" : "border-slate-700"}`}
            title="把远程文件拖到这里下载"
          >
            <Download size={13} /> <span className="text-[11px] hidden sm:inline">拖拽下载</span>
          </div>

          {/* 面包屑路径 */}
          <div className="flex-1 flex items-center gap-1 text-sm overflow-x-auto whitespace-nowrap mx-2">
            <button onClick={() => navigateTo('/')} className="text-slate-500 hover:text-accent-400">
              <Home size={14} />
            </button>
            {pathSegments.map((seg, i) => {
              const path = '/' + pathSegments.slice(0, i + 1).join('/')
              const isLast = i === pathSegments.length - 1
              return (
                <div key={i} className="flex items-center gap-1">
                  <ChevronRight size={12} className="text-slate-600" />
                  <button
                    onClick={() => navigateTo(path)}
                    className={isLast ? 'text-accent-400 font-medium' : 'text-slate-400 hover:text-slate-200'}
                  >
                    {seg}
                  </button>
                </div>
              )
            })}
          </div>

          <span className="text-xs text-slate-500">{entries.length} 项</span>
        </div>

        {/* 收藏夹 */}
        {bookmarks.length > 0 && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800 bg-bg-900/40 overflow-x-auto">
            <BookmarkIcon size={12} className="text-amber-400/80 flex-shrink-0" />
            {bookmarks.map(b => (
              <span
                key={b.id}
                className={`group flex items-center gap-1 px-2 py-0.5 rounded border text-xs cursor-pointer whitespace-nowrap ${
                  b.path === currentPath
                    ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
                    : 'border-slate-700 text-slate-400 hover:border-accent-500/30 hover:text-accent-300'
                }`}
                onClick={() => navigateTo(b.path)}
                title={b.path}
              >
                {b.name}
                <button
                  onClick={(e) => { e.stopPropagation(); removeBookmark(b.id) }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-bg-600 text-slate-500 hover:text-red-400"
                  title="移除收藏"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}

        {/* 错误提示 */}
        {error && (
          <div className="px-3 py-2 bg-red-500/10 border-b border-red-500/20 text-xs text-red-400 flex items-center gap-2">
            <Lock size={13} /> {error}
          </div>
        )}

        {/* 回退警告 */}
        {warning && (
          <div className="px-3 py-2 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-400 flex items-center gap-2">
            <AlertTriangle size={13} /> {warning}
          </div>
        )}

        {/* 文件列表 */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw size={20} className="animate-spin text-slate-600" />
            </div>
          ) : searchResults ? (
            <div className="p-3 space-y-1">
              <div className="text-[11px] text-slate-500 mb-2">
                搜索「{searchQ}」命中 {searchResults.results.length} 条{searchResults.truncated ? '(结果过多已截断)' : ''} · 点击条目跳转到所在目录
              </div>
              {searchResults.results.length === 0 && (
                <div className="text-center py-8 text-sm text-slate-500">无匹配结果</div>
              )}
              {searchResults.results.map((p) => (
                <div
                  key={p}
                  onClick={() => {
                    const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) || '/' : currentPath
                    navigateTo(dir)
                  }}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md text-xs text-slate-300 hover:bg-bg-700 cursor-pointer"
                  title={p}
                >
                  {p.endsWith('/') ? <Folder size={13} className="text-blue-400" /> : <FileText size={13} className="text-slate-500" />}
                  <span className="truncate font-mono">{p}</span>
                </div>
              ))}
            </div>
          ) : rawOutput ? (
            <pre className="p-4 text-xs font-mono text-slate-300 whitespace-pre-wrap break-all">{rawOutput}</pre>
          ) : entries.length === 0 && !error ? (
            <div className="text-center py-12 text-sm text-slate-500">空目录</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-bg-800 border-b border-slate-800">
                <tr className="text-xs text-slate-500">
                  <th className="text-left font-medium px-4 py-2">
                    <button onClick={() => toggleSort('name')} className="hover:text-slate-300 inline-flex items-center gap-1">
                      名称{sortArrow('name')}
                    </button>
                  </th>
                  <th className="text-right font-medium px-4 py-2">
                    <button onClick={() => toggleSort('size')} className="hover:text-slate-300 inline-flex items-center gap-1">
                      大小{sortArrow('size')}
                    </button>
                  </th>
                  <th className="text-right font-medium px-4 py-2 hidden md:table-cell">
                    <button onClick={() => toggleSort('mtime')} className="hover:text-slate-300 inline-flex items-center gap-1">
                      修改时间{sortArrow('mtime')}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {sortedEntries.map((entry, i) => {
                  const Icon = entry.isDirectory ? Folder : entry.isSymlink ? Link2 : File
                  const iconColor = entry.isDirectory ? 'text-blue-400' : entry.isSymlink ? 'text-cyan-400' : 'text-slate-500'
                  return (
                    <tr
                      key={i}
                      draggable={!entry.isDirectory && (selectMode ? selRemote.size > 0 : true)}
                      onDragStart={(e) => { if (entry.isDirectory) return; if (selectMode) { if (selRemote.size === 0) { e.preventDefault(); return } const files: DndFile[] = Array.from(selRemote).map(q => ({ kind: 'server', path: q, name: q.split('/').filter(Boolean).pop() || q, isDir: false })); e.dataTransfer.effectAllowed = 'copy'; e.dataTransfer.setData(DND_MIME, makeDndData('server', '', '', false, files)); return } onRowDragStart(e, entry) }}
                      onClick={(e) => { if (selectMode && !entry.isDirectory) { const full = currentPath.endsWith('/') ? currentPath + entry.filename : currentPath + '/' + entry.filename; handleSelectClick(e, full, i); return } handleEntryClick(entry) }}
                      className={`border-b border-slate-800/50 hover:bg-bg-700/50 transition-colors group ${showLocalPanel && !entry.isDirectory ? 'cursor-pointer' : 'cursor-pointer'}`}
                    >
                      {selectMode && !entry.isDirectory && (
                        <td className="px-2 py-2 w-8">
                          <span className="text-accent-400">
                            {selRemote.has(currentPath.endsWith('/') ? currentPath + entry.filename : currentPath + '/' + entry.filename) ? <CheckSquare size={14}/> : <Square size={14}/>}
                          </span>
                        </td>
                      )}
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-2.5">
                          <Icon size={16} className={iconColor + ' flex-shrink-0'} />
                          <span className={`truncate ${entry.isDirectory ? 'text-slate-200 font-medium' : 'text-slate-400 group-hover:text-slate-200'}`}>
                            {entry.filename}
                          </span>
                          {entry.isSymlink && <span className="text-xs text-slate-600">→</span>}
                        </div>
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-slate-500 font-mono">
                        {entry.isDirectory ? '—' : formatSize(entry.size)}
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-slate-600 hidden md:table-cell">
                        {entry.mtime ? formatTime(entry.mtime) : '-'}
                      </td>
                      <td className="px-2 py-2 w-16">
                        <div className="flex items-center justify-end gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); setRenameTarget({ name: entry.filename, draft: entry.filename }) }}
                            className="p-1.5 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400"
                            title="重命名/移动"
                          >
                            <Pencil size={14} />
                          </button>
                          {!entry.isDirectory && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                const full = currentPath.endsWith('/')
                                  ? currentPath + entry.filename
                                  : currentPath + '/' + entry.filename
                                startDownload(serverId, full)
                              }}
                              className="p-1.5 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400"
                              title="下载"
                            >
                              <Download size={14} />
                            </button>
                          )}
                          <button
                            onClick={(e) => { e.stopPropagation(); startDelete(entry) }}
                            className="p-1.5 rounded hover:bg-bg-600 text-slate-400 hover:text-red-400"
                            title="删除"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* 文件预览侧栏(可切换在线编辑) */}
      {fileContent && (
        <div className="w-[45%] border-l border-slate-800 flex flex-col bg-bg-800">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-800 bg-bg-700/50">
            <div className="flex items-center gap-2 min-w-0">
              <FileText size={14} className="text-accent-400 flex-shrink-0" />
              <span className="text-xs text-slate-300 truncate font-mono">{fileContent.path}</span>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              {editing ? (
                <>
                  <span className={`text-[10px] ${editDraft !== fileContent.content ? 'text-amber-400' : 'text-slate-600'}`}>
                    {editDraft !== fileContent.content ? '已修改' : '未修改'}
                  </span>
                  <button
                    onClick={saveEdit}
                    disabled={saving}
                    className="p-1.5 rounded hover:bg-bg-600 text-accent-400 disabled:opacity-40"
                    title="保存到远端(512KB 以内)"
                  >
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                  </button>
                  <button
                    onClick={() => { setEditDraft(fileContent.content); setEditing(false) }}
                    className="p-1.5 rounded hover:bg-bg-600 text-slate-400"
                    title="放弃修改"
                  >
                    <X size={14} />
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setEditing(true)}
                    className="p-1.5 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400"
                    title="在线编辑此文件"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={() => startDownload(serverId, fileContent.path)}
                    className="p-1.5 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400"
                    title="下载"
                  >
                    <Download size={14} />
                  </button>
                  <button onClick={() => { setEditing(false); setFileContent(null) }} className="p-1.5 rounded hover:bg-bg-600 text-slate-400">
                    <X size={14} />
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="flex-1 overflow-auto p-3">
            {editing ? (
              <textarea
                value={editDraft}
                onChange={(e) => setEditDraft(e.target.value)}
                spellCheck={false}
                className="w-full h-full min-h-[200px] bg-bg-900 border border-slate-700 rounded p-2 text-xs font-mono text-slate-300 outline-none focus:border-accent-500/60 resize-none"
              />
            ) : (
              <pre className="text-xs font-mono text-slate-300 whitespace-pre-wrap break-all">
                {fileContent.content}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* 删除确认(文件:单层;目录:两层,第二层需输入名称) */}
      <ConfirmDialog
        open={!!deleteTarget && !showDangerConfirm}
        title="确认删除"
        message={deleteTarget ? `确定删除「${deleteTarget.name}」吗?\n${deleteTarget.path}` : ''}
        danger={false}
        confirmText="删除"
        onConfirm={() => {
          // 目录之间进入第二层二次确认;文件直接删
          if (deleteTarget?.kind === 'dir') setShowDangerConfirm(true)
          else doDelete()
        }}
        onCancel={() => setDeleteTarget(null)}
      />
      <ConfirmDialog
        open={!!deleteTarget && showDangerConfirm}
        title="递归删除目录"
        danger
        typeText={deleteTarget?.name || ''}
        message={`即将递归删除目录及其全部内容:\n${deleteTarget?.path}\n\n此操作不可恢复!`}
        confirmText={deleting ? '删除中...' : '永久删除'}
        onConfirm={doDelete}
        onCancel={() => { setDeleteTarget(null); setShowDangerConfirm(false) }}
      />

      {/* 新建目录 / 重命名 输入弹窗 */}
      <PromptDialog
        open={newDirName !== null}
        title="新建文件夹"
        placeholder="目录名(可含多级,如 logs/2026)"
        value={newDirName || ''}
        onChange={setNewDirName}
        busy={fsBusy}
        confirmText="创建"
        onConfirm={doMkdir}
        onCancel={() => setNewDirName(null)}
      />
      <PromptDialog
        open={!!renameTarget}
        title="重命名 / 移动"
        placeholder="新名称(同目录内改名;填相对路径可移动)"
        value={renameTarget?.draft || ''}
        onChange={(v) => setRenameTarget(t => (t ? { ...t, draft: v } : t))}
        busy={fsBusy}
        confirmText="确定"
        onConfirm={doRename}
        onCancel={() => setRenameTarget(null)}
      />
    </div>
  )
}

// 轻量输入弹窗:新建目录/重命名共用(标题 + 单行输入 + 确认)
function PromptDialog({ open, title, placeholder, value, onChange, busy, confirmText, onConfirm, onCancel }: {
  open: boolean
  title: string
  placeholder: string
  value: string
  onChange: (v: string) => void
  busy: boolean
  confirmText: string
  onConfirm: () => void
  onCancel: () => void
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center animate-fade-in" onClick={onCancel}>
      <div className="w-[400px] bg-bg-800 border border-slate-700 rounded-2xl shadow-2xl animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200">{title}</h2>
          <button onClick={onCancel} className="p-1 rounded-lg hover:bg-bg-600 text-slate-400"><X size={16} /></button>
        </div>
        <div className="px-5 py-4">
          <input
            autoFocus
            className="input font-mono"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && value.trim() && !busy) onConfirm() }}
            placeholder={placeholder}
          />
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-700">
          <button onClick={onCancel} className="btn-ghost">取消</button>
          <button onClick={onConfirm} disabled={!value.trim() || busy} className="btn-primary disabled:opacity-40">
            {busy ? <Loader2 size={13} className="animate-spin inline" /> : null} {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
