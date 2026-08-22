import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Star, Folder, ArrowUp, TerminalSquare, HardDrive, ChevronRight, X,
  GripVertical, File as FileIcon, Upload, Download, Loader2, Copy, FolderOpen, CheckSquare, Square,
} from 'lucide-react'
import { LocalFavorite } from '../types'
import { DND_MIME, makeDndData, readDndData, DndFile } from './DeviceFilePanel'
import { SIZE_UNITS, getSizeUnit, setSizeUnit, formatSize, SizeUnit } from '../lib/sizeFormat'

interface Props {
  /** 当前浏览目录(由 App 管理,空串表示磁盘根层) */
  browsePath: string
  onBrowsePathChange: (p: string) => void
  favorites: LocalFavorite[]
  /** 收藏/取消收藏当前目录 */
  onToggleFavorite: (path: string, name?: string) => void
  /** 在指定目录打开本地终端 */
  onOpenLocalTerminal: (path: string) => void
}

interface Entry { name: string; isDir: boolean; size?: number }

// 计算 Windows 路径的父目录:空 = 回到磁盘根层;磁盘根(C:\)的上级也为空
function parentOf(p: string): string {
  if (!p) return ''
  let s = p
  while (s.endsWith('\\')) s = s.slice(0, -1)
  if (/^[A-Za-z]:$/.test(s)) return '' // 已是盘符根
  const idx = s.lastIndexOf('\\')
  if (idx < 0) return ''
  const parent = s.slice(0, idx)
  return /^[A-Za-z]:$/.test(parent) ? parent + '\\' : parent
}

// 目录名用于收藏默认名称:磁盘根层显示盘符,否则取末级目录名
function dirName(p: string): string {
  if (!p) return '本机'
  let s = p
  while (s.endsWith('\\')) s = s.slice(0, -1)
  if (/^[A-Za-z]:$/.test(s)) return s
  const idx = s.lastIndexOf('\\')
  return idx < 0 ? s : s.slice(idx + 1)
}

// 把子目录叶子名拼接到当前目录,得到完整 Windows 路径(后端浏览只回叶子名)
function joinPath(parent: string, child: string): string {
  let p = parent
  while (p.endsWith('\\')) p = p.slice(0, -1)
  if (/^[A-Za-z]:$/.test(p)) return p + '\\' + child
  return p + '\\' + child
}

function copyText(text: string) {
  try { navigator.clipboard?.writeText(text) } catch {}
}

// 用 Windows 资源管理器打开一个本地目录
async function openInExplorer(path: string): Promise<string | null> {
  try {
    const r = await fetch('/api/local/open-dir', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    })
    const d = await r.json()
    if (!r.ok || !d.ok) return d.error || '打开失败'
    return null
  } catch {
    return '打开失败'
  }
}

// 侧栏"本地终端"视图的目录浏览 + 收藏面板:
// - 显示当前目录下的目录与文件(不只有目录);
// - 支持 hdc 设备上传/下载(记住上一次使用的设备/本地目录);
// - 目录列表与收藏之间可拖拽分隔线调整高度。
export function LocalDirBrowser({ browsePath, onBrowsePathChange, favorites, onToggleFavorite, onOpenLocalTerminal }: Props) {
  const [entries, setEntries] = useState<Entry[]>([])
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  // 目录列表占比(0-100),用于目录列表与收藏之间的可拖拽分隔
  const [dirPct, setDirPct] = useState(60)
  const resizing = useRef<{ startY: number; startPct: number } | null>(null)
  // hdc 上传/下载弹窗
  const [showSend, setShowSend] = useState(false)
  const [showRecv, setShowRecv] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // 'send' | 'recv' | null
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'warn' } | null>(null)
  // 记住上一次操作的地址
  const [lastDevicePath, setLastDevicePath] = useState('')
  // 文件大小显示单位(默认字节)
  const [unit, setUnitState] = useState<SizeUnit>(() => getSizeUnit())
  // 设备文件拖入下载:高亮的目标本地目录(空串=当前目录根部)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const dropDirRef = useRef<string | null>('')
  // 批量选择本地文件 → 上传到设备;Shift 支持连续选择
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const selAnchorRef = useRef(-1)
  const [batchDevicePath, setBatchDevicePath] = useState('')
  const [batchBusy, setBatchBusy] = useState(false)

  const fetchBrowse = useCallback(async (path: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/local/browse?path=${encodeURIComponent(path)}`)
      const data = await res.json()
      setEntries(data.entries || [])
      setNote(data.note || '')
    } catch {
      setEntries([])
      setNote('浏览失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchBrowse(browsePath)
  }, [browsePath, fetchBrowse])

  // 加载记住的 hdc 传输地址
  useEffect(() => {
    ;(async () => {
      try {
        const res = await fetch('/api/local/transfer-state')
        const s = await res.json()
        if (s) {
          setLastDevicePath(s.devicePath || '')
        }
      } catch {}
    })()
  }, [])

  const showToast = (t: string, kind: 'ok' | 'warn' = 'ok') => setToast({ text: t, kind })
  useEffect(() => {
    if (!toast) return
    const tm = setTimeout(() => setToast(null), 2200)
    return () => clearTimeout(tm)
  }, [toast])

  const isFav = favorites.some(f => f.path === browsePath)

  // 上级导航 / 选择目录:
  // - 磁盘根层(空路径)的条目是盘符("C:\"),直接设为完整路径;
  // - 子层条目是叶子名,需拼上当前父目录构成完整路径,否则后端无法访问。
  const enter = (p: string) => {
    if (!browsePath) onBrowsePathChange(p)
    else onBrowsePathChange(joinPath(browsePath, p))
  }
  const up = () => { const p = parentOf(browsePath); onBrowsePathChange(p) }

  // 拖拽分隔线:调整目录列表高度占比
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    resizing.current = { startY: e.clientY, startPct: dirPct }
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return
      // 以约 400px 高度换算,拖动 10px ≈ 2.5%
      const dy = ev.clientY - resizing.current.startY
      setDirPct(Math.min(85, Math.max(15, resizing.current.startPct + (dy / 400) * 100)))
    }
    const onUp = () => {
      resizing.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ========== hdc 上传/下载 ==========
  const saveState = async (extra: { devicePath?: string; localDir?: string }) => {
    try {
      await fetch('/api/local/transfer-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(extra),
      })
    } catch {}
  }

  const doSend = async () => {
    const file = localFileRef.current?.files?.[0]
    if (!file) { showToast('请先选择要上传的本地文件', 'warn'); return }
    if (!lastDevicePathRef.current.trim()) { showToast('请填写设备目标路径', 'warn'); return }
    // 纯浏览器环境的 File 没有 path 属性(拿不到本机绝对路径),file.name 兜底发给
    // 后端必然失败且报错难懂——直接提示改用桌面版或拖拽上传
    const localPath = (file as unknown as { path?: string }).path
    if (!localPath) {
      showToast('浏览器环境无法获取本地文件路径,请使用桌面版(Electron),或把文件拖到设备面板上传', 'warn')
      return
    }
    setBusy('send')
    try {
      const r = await fetch('/api/local/hdc-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath, devicePath: lastDevicePathRef.current.trim() }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || '上传失败')
      setLastDevicePath(lastDevicePathRef.current.trim())
      saveState({ devicePath: lastDevicePathRef.current.trim() })
      showToast(`已上传 ${file.name} → 设备`)
      setShowSend(false)
    } catch (err) {
      showToast(`上传失败: ${err instanceof Error ? err.message : '未知错误'}`, 'warn')
    } finally {
      setBusy(null)
    }
  }

  const doRecv = async () => {
    const devPath = lastDevicePathRef.current.trim()
    const localDir = recvLocalDirRef.current.trim() || browsePath
    if (!devPath) { showToast('请填写设备文件路径', 'warn'); return }
    if (!localDir) { showToast('请选择下载到本地的目录', 'warn'); return }
    setBusy('recv')
    try {
      const r = await fetch('/api/local/hdc-recv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devicePath: devPath, localDir }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || '下载失败')
      setLastDevicePath(devPath)
      saveState({ devicePath: devPath, localDir })
      showToast(`已从设备下载到 ${localDir}`)
      setShowRecv(false)
      fetchBrowse(browsePath)
    } catch (err) {
      showToast(`下载失败: ${err instanceof Error ? err.message : '未知错误'}`, 'warn')
    } finally {
      setBusy(null)
    }
  }

  // ref 引用(上传文件选择框/设备路径/下载本地目录)
  const localFileRef = useRef<HTMLInputElement | null>(null)
  const lastDevicePathRef = useRef(lastDevicePath)
  const recvLocalDirRef = useRef<string>('')
  useEffect(() => { lastDevicePathRef.current = lastDevicePath }, [lastDevicePath])
  // 勾选模式默认填写上次使用的设备目标目录
  useEffect(() => { if (lastDevicePath && !batchDevicePath) setBatchDevicePath(lastDevicePath) }, [lastDevicePath, batchDevicePath])

  // 下载:设备文件 → 本地目录(拖拽触发)
  const doDownload = async (devicePath: string, name: string, targetDir: string) => {
    setBusy('recv')
    try {
      const r = await fetch('/api/local/hdc-recv', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devicePath, localDir: targetDir }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '下载失败')
      saveState({ devicePath, localDir: targetDir })
      setLastDevicePath(devicePath)
      showToast(`已从设备下载 ${name} → ${targetDir}`)
    } catch (err) {
      showToast(`下载失败: ${err instanceof Error ? err.message : '未知错误'}`, 'warn')
    } finally {
      setBusy(null)
    }
  }

  const handleLocalListDrop = async (e: React.DragEvent) => {
    setDropDir(null)
    if (e.dataTransfer.types.includes(DND_MIME)) {
      e.preventDefault()
      const data = readDndData(e)
      if (!data || data.kind !== 'device') return
      const target = dropDirRef.current || browsePath
      // 批量下载串行执行:并发会让 busy 计数互相覆盖提前结束,刷新也会竞态
      if (Array.isArray(data.files) && data.files.length) {
        for (const f of data.files) { if (!f.isDir) await doDownload(f.path, f.name, target) }
        return
      }
      if (!data.isDir) await doDownload(data.path, data.name, target)
    }
  }

  // ===== 批量选择本地文件 → 上传到设备(hdc-send) =====
  const toggleLocalSelect = (path: string, i: number) => {
    setSelected(prev => {
      const n = new Set(prev)
      if (n.has(path)) n.delete(path); else n.add(path)
      return n
    })
    selAnchorRef.current = i
  }
  // 文件行点击:shift 连续区间选择(只选文件);否则普通切换
  const handleLocalSelect = (e: React.MouseEvent, path: string, i: number) => {
    if (e.shiftKey) {
      const anchor = selAnchorRef.current >= 0 ? selAnchorRef.current : i
      const a = Math.min(anchor, i)
      const b = Math.max(anchor, i)
      setSelected(prev => {
        const n = new Set(prev)
        for (let k = a; k <= b; k++) {
          const row = entries[k]
          if (row && !row.isDir) n.add(joinPath(browsePath, row.name))
        }
        return n
      })
      return
    }
    toggleLocalSelect(path, i)
  }

  // 批量上传选中本地文件到设备
  const uploadSelectedToDevice = async () => {
    const files = Array.from(selected)
    const target = batchDevicePath.trim()
    if (files.length === 0 || !target) { showToast('请选择文件,并填写设备目标目录', 'warn'); return }
    setBatchBusy(true)
    let ok = 0
    for (const p of files) {
      try {
        const r = await fetch('/api/local/hdc-send', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ localPath: p, devicePath: target }),
        })
        const d = await r.json()
        if (r.ok && !d.error) ok++
      } catch {}
    }
    setBatchBusy(false)
    setSelected(new Set())
    setSelectMode(false)
    setLastDevicePath(target)
    saveState({ devicePath: target })
    showToast(`已上传 ${ok}/${files.length} 个文件到设备`)
  }

  // 打开上传弹窗时默认回到记住的设备路径
  const openSend = () => { lastDevicePathRef.current = lastDevicePath; setShowSend(true) }
  const openRecv = () => {
    lastDevicePathRef.current = lastDevicePath
    recvLocalDirRef.current = browsePath
    setShowRecv(true)
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col px-2 py-2 overflow-hidden">
      {/* 当前目录显示 + 上级 + 收藏 + 打开终端 */}
      <div className="mb-1.5 space-y-1.5 shrink-0">
        <div className="flex items-center gap-1.5">
          <HardDrive size={13} className="text-slate-500 flex-shrink-0" />
          <span className="text-[11px] font-medium text-slate-300 truncate flex-1" title={browsePath}>
            {browsePath || '本机磁盘'}
          </span>
          {browsePath && (
            <>
              <button
                onClick={() => { copyText(browsePath); showToast('已复制路径') }}
                className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400"
                title="复制当前目录路径"
              >
                <Copy size={11} />
              </button>
              <button
                onClick={async () => {
                  const err = await openInExplorer(browsePath)
                  if (err) showToast(`打开失败: ${err}`, 'warn')
                  else showToast('已用资源管理器打开')
                }}
                className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400"
                title="用资源管理器打开当前目录"
              >
                <FolderOpen size={11} />
              </button>
            </>
          )}
          <select
            value={unit}
            onChange={(e) => { setUnitState(e.target.value as SizeUnit); setSizeUnit(e.target.value as SizeUnit) }}
            className="bg-bg-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-400 outline-none focus:border-accent-500/60"
            title="选择文件大小单位"
          >
            {SIZE_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={up}
            disabled={!browsePath}
            className="p-1.5 rounded-md hover:bg-bg-600 text-slate-400 hover:text-slate-200 disabled:opacity-30 disabled:hover:bg-transparent"
            title="上级目录"
          >
            <ArrowUp size={13} />
          </button>
          <button
            onClick={() => onToggleFavorite(browsePath, dirName(browsePath))}
            disabled={!browsePath}
            className={`p-1.5 rounded-md hover:bg-bg-600 disabled:opacity-30 disabled:hover:bg-transparent ${isFav ? 'text-amber-400' : 'text-slate-400 hover:text-amber-400'}`}
            title={isFav ? '取消收藏当前目录' : '收藏当前目录'}
          >
            <Star size={13} fill={isFav ? 'currentColor' : 'none'} />
          </button>
          <button
            onClick={() => setSelectMode(m => { if (m) { setSelected(new Set()); selAnchorRef.current = -1 } return !m })}
            className={`p-1.5 rounded-md hover:bg-bg-600 ${selectMode ? 'text-accent-400 bg-accent-500/15' : 'text-slate-400 hover:text-accent-400'}`}
            title={selectMode ? '退出批量选择' : '批量选择本地文件(上传到设备)'}
          >
            {selectMode ? <CheckSquare size={13} /> : <Square size={13} />}
          </button>
          <button
            onClick={() => onOpenLocalTerminal(browsePath)}
            disabled={!browsePath}
            className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium bg-accent-500/15 text-accent-400 border border-accent-500/30 hover:bg-accent-500/25 disabled:opacity-30 disabled:hover:bg-accent-500/15"
            title="在此目录打开本地终端"
          >
            <TerminalSquare size={12} /> 在此目录打开终端
          </button>
        </div>
        {/* hdc 设备传输 */}
        <div className="flex items-center gap-1">
          <button
            onClick={openSend}
            disabled={busy !== null}
            className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium bg-accent-500/15 text-accent-400 border border-accent-500/30 hover:bg-accent-500/25 disabled:opacity-40"
            title="上传本地文件到 hdc 设备"
          >
            <Upload size={12} /> 上传到设备
          </button>
          <button
            onClick={openRecv}
            disabled={busy !== null}
            className="flex-1 flex items-center justify-center gap-1 px-2 py-1.5 rounded-md text-xs font-medium bg-accent-500/15 text-accent-400 border border-accent-500/30 hover:bg-accent-500/25 disabled:opacity-40"
            title="从 hdc 设备下载到本地"
          >
            <Download size={12} /> 从设备下载
          </button>
        </div>
        {note && <div className="text-[11px] text-slate-600">{note}</div>}
      </div>

      {/* 上传/下载进行中提示 */}
      {busy && (
        <div className="flex items-center gap-2 px-2 py-1 rounded-md bg-accent-500/10 border border-accent-500/20 text-[11px] text-accent-400 mb-1 shrink-0">
          <Loader2 size={12} className="animate-spin" />
          {busy === 'send' ? '正在上传到设备…' : '正在从设备下载…'}
        </div>
      )}

      {/* 目录 + 文件列表(占比可拖拽):文件可拖到设备面板上传;也是设备文件拖入下载的目标 */}
      <div
        className={`flex-1 min-h-0 overflow-y-auto space-y-0.5 border-t border-slate-800/50 pt-1.5 transition-colors ${
          dropDir === '' ? 'bg-accent-500/5 ring-1 ring-inset ring-accent-500/40' : ''
        }`}
        style={{ flexBasis: `${dirPct}%` }}
        onDragOver={(ev) => {
          // 用 types 判断(与 DeviceFilePanel 上传一致),避免某些浏览器 dragover 时 getData 为空
          if (!ev.dataTransfer.types.includes(DND_MIME)) return
          if ((ev.target as HTMLElement).closest('[data-dirdrop]')) return // 目录行的拖放由其自身处理
          ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; dropDirRef.current = ''; setDropDir('')
        }}
        onDragLeave={(ev) => {
          if (!ev.currentTarget.contains(ev.relatedTarget as Node)) setDropDir(null)
        }}
        onDrop={handleLocalListDrop}
      >
        {loading && entries.length === 0 ? (
          <div className="text-[11px] text-slate-600 px-2 py-3 text-center">加载中…</div>
        ) : entries.length === 0 ? (
          <div className="text-[11px] text-slate-600 px-2 py-3 text-center">此目录为空</div>
        ) : (
          entries.map((e, i) => {
            const isTarget = dropDir === joinPath(browsePath, e.name)
            return e.isDir ? (
              <div
                key={`${e.name}-${i}`}
                data-dirdrop
                onClick={() => enter(e.name)}
                onDragOver={(ev) => {
                  if (ev.dataTransfer.types.includes(DND_MIME)) { ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'copy'; dropDirRef.current = joinPath(browsePath, e.name); setDropDir(joinPath(browsePath, e.name)) }
                }}
                onDragLeave={() => setDropDir(cur => (cur === joinPath(browsePath, e.name) ? null : cur))}
                onDrop={(ev) => {
                  ev.stopPropagation()
                  const data = readDndData(ev)
                  if (data && data.kind === 'device') {
                    ev.preventDefault()
                    const target = joinPath(browsePath, e.name)
                    dropDirRef.current = target
                    setDropDir(null)
                    if (Array.isArray(data.files) && data.files.length) {
                      for (const f of data.files) if (!f.isDir) doDownload(f.path, f.name, target)
                    } else if (!data.isDir) {
                      doDownload(data.path, data.name, target)
                    }
                  }
                }}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-xs ${
                  isTarget
                    ? 'bg-accent-500/15 outline outline-1 outline-accent-500/50 text-accent-300'
                    : 'hover:bg-bg-700 text-slate-400 hover:text-slate-200'
                }`}
                title={e.name}
              >
                <Folder size={12} className="text-sky-400/70 flex-shrink-0" />
                <span className="truncate flex-1">{e.name}</span>
                {isTarget ? <Download size={11} className="text-accent-400 flex-shrink-0" /> : <ChevronRight size={12} className="text-slate-600 flex-shrink-0" />}
              </div>
            ) : (
              <div
                key={`${e.name}-${i}`}
                draggable={selectMode ? selected.size > 0 : true}
                onDragStart={(ev) => {
                  if (selectMode) {
                    if (selected.size === 0) { ev.preventDefault(); return }
                    const files: DndFile[] = Array.from(selected).map(q => ({ kind: 'local', path: q, name: q.split(/[\\/]/).filter(Boolean).pop() || q, isDir: false }))
                    ev.dataTransfer.effectAllowed = 'copy'
                    ev.dataTransfer.setData(DND_MIME, makeDndData('local', '', '', false, files))
                    return
                  }
                  ev.dataTransfer.effectAllowed = 'copy'
                  ev.dataTransfer.setData(DND_MIME, makeDndData('local', joinPath(browsePath, e.name), e.name, false))
                }}
                onClick={selectMode ? ((ev) => handleLocalSelect(ev, joinPath(browsePath, e.name), i)) : undefined}
                className={`group flex items-center gap-2 px-2 py-1.5 rounded-md text-xs ${selectMode ? 'cursor-pointer' : 'cursor-grab'} ${selected.has(joinPath(browsePath, e.name)) ? 'bg-accent-500/15 text-accent-300' : 'text-slate-500 hover:bg-bg-700/40'}`}
                title={selectMode ? `勾选 ${e.name}` : `${e.name} (拖到设备面板上传)`}
              >
                {selectMode && (
                  <span className="text-accent-400 flex-shrink-0">
                    {selected.has(joinPath(browsePath, e.name)) ? <CheckSquare size={12}/> : <Square size={12}/>}
                  </span>
                )}
                <FileIcon size={12} className="text-slate-600 flex-shrink-0" />
                <span className="truncate flex-1">{e.name}</span>
                {formatSize(e.size ?? 0, unit, false) && (
                  <span className="text-[10px] text-slate-600 flex-shrink-0">{formatSize(e.size ?? 0, unit, false)}</span>
                )}
                {!selectMode && <Upload size={11} className="text-slate-500 opacity-0 group-hover:opacity-100 flex-shrink-0" />}
              </div>
            )
          })
        )}
      </div>

      {/* 批量选择本地文件上传到设备 */}
      {selectMode && (
        <div className="shrink-0 px-2 py-1.5 border-t border-slate-800/60 bg-accent-500/5 space-y-1.5">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-slate-500 whitespace-nowrap">设备目录</span>
            <input
              value={batchDevicePath}
              onChange={e => setBatchDevicePath(e.target.value)}
              placeholder="/sdcard/xxx"
              className="flex-1 min-w-0 bg-bg-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-300 outline-none focus:border-accent-500/60 font-mono"
            />
          </div>
          {batchBusy ? (
            <div className="flex items-center gap-2 text-[11px] text-accent-400"><Loader2 size={12} className="animate-spin" /> 正在上传到设备…</div>
          ) : (
            <button
              onClick={uploadSelectedToDevice}
              disabled={selected.size === 0}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium bg-accent-500/15 text-accent-400 border border-accent-500/30 hover:bg-accent-500/25 disabled:opacity-40"
              title={batchDevicePath.trim() ? `上传选中的 ${selected.size} 个本地文件到设备 ${batchDevicePath}` : '请填写设备目标目录'}
            >
              <Upload size={12} /> 上传选中到设备{selected.size > 0 ? ` (${selected.size})` : ''}
            </button>
          )}
          {selected.size > 0 && (
            <button onClick={() => setSelected(new Set())} className="w-full text-center text-[10px] text-slate-500 hover:text-slate-300">清除选择</button>
          )}
        </div>
      )}

      {/* 可拖拽分隔线:调整目录列表与收藏的高度占比 */}
      <div
        onMouseDown={startResize}
        className="flex items-center justify-center py-0.5 cursor-row-resize text-slate-600 hover:text-accent-400 shrink-0 select-none"
        title="拖动调整目录与收藏高度"
      >
        <GripVertical size={12} />
      </div>

              {/* 收藏列表 */}
        <div className="flex-1 min-h-0 flex flex-col border-t border-slate-800/50 pt-1.5" style={{ flexBasis: `${100 - dirPct}%` }}>
          <div className="px-2 pb-1 text-[11px] font-medium text-slate-500 flex items-center gap-1 shrink-0">
            <Star size={11} className="text-amber-400/70" /> 收藏目录
            <span className="text-slate-600">({favorites.length})</span>
          </div>
          {favorites.length === 0 ? (
            <div className="text-[11px] text-slate-600 px-2 py-1">暂无收藏,点击 ★ 收藏当前目录</div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto space-y-0.5">
              {favorites.map(f => (
                <div key={f.id} className="group flex items-center gap-1">
                  <button
                    onClick={() => onOpenLocalTerminal(f.path)}
                    className="flex-1 flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-left text-xs text-slate-400 hover:bg-bg-700 hover:text-slate-200 min-w-0"
                    title={f.path}
                  >
                    <Folder size={12} className="text-amber-400/60 flex-shrink-0" />
                    <span className="truncate">{f.name || dirName(f.path)}</span>
                    <span className="text-slate-600 truncate flex-1 hidden md:inline">{f.path}</span>
                  </button>
                  <button
                    onClick={() => onToggleFavorite(f.path)}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-bg-600 text-slate-500 hover:text-red-400"
                    title="取消收藏"
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 提示 toast */}
        {toast && (
          <div className={`absolute left-2 right-2 bottom-2 z-20 px-2 py-1 rounded-md text-[11px] border ${
            toast.kind === 'ok' ? 'text-accent-400 bg-accent-500/10 border-accent-500/20' : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
          }`}>
            {toast.text}
          </div>
        )}

        {/* 上传弹窗:选本地文件 + 设备目标路径 */}
        {showSend && (
          <TransferModal
            title="上传到 hdc 设备"
            icon={<Upload size={16} />}
            busy={busy === 'send'}
            onCancel={() => setShowSend(false)}
            onConfirm={doSend}
            body={
              <div className="space-y-3">
                <div>
                  <label className="label">选择本地文件</label>
                  <input
                    ref={localFileRef}
                    type="file"
                    className="block w-full text-[11px] text-slate-400 file:mr-2 file:rounded file:border-0 file:bg-accent-500/15 file:px-2 file:py-1 file:text-[11px] file:text-accent-400 file:hover:bg-accent-500/25"
                  />
                </div>
                <div>
                  <label className="label">设备目标路径</label>
                  <input
                    defaultValue={lastDevicePath}
                    onChange={e => { lastDevicePathRef.current = e.target.value }}
                    placeholder="如 /data/local/tmp 或 /sdcard/xxx.txt"
                    className="input font-mono"
                  />
                  <p className="text-[11px] text-slate-600 mt-1">上次使用:{lastDevicePath || '无'}</p>
                </div>
              </div>
            }
          />
        )}

        {/* 下载弹窗:设备文件路径 + 本地保存目录 */}
        {showRecv && (
          <TransferModal
            title="从 hdc 设备下载"
            icon={<Download size={16} />}
            busy={busy === 'recv'}
            onCancel={() => setShowRecv(false)}
            onConfirm={doRecv}
            body={
              <div className="space-y-3">
                <div>
                  <label className="label">设备文件路径</label>
                  <input
                    defaultValue={lastDevicePath}
                    onChange={e => { lastDevicePathRef.current = e.target.value }}
                    placeholder="如 /sdcard/xxx.txt"
                    className="input font-mono"
                  />
                  <p className="text-[11px] text-slate-600 mt-1">上次使用:{lastDevicePath || '无'}</p>
                </div>
                <div>
                  <label className="label">下载到本地目录</label>
                  <input
                    defaultValue={browsePath}
                    onChange={e => { recvLocalDirRef.current = e.target.value }}
                    placeholder="本地保存目录"
                    className="input font-mono"
                  />
                  <p className="text-[11px] text-slate-600 mt-1">默认当前浏览目录</p>
                </div>
              </div>
            }
          />
        )}
    </div>
  )
}

// 统一的传输弹窗外壳
function TransferModal({ title, icon, busy, onCancel, onConfirm, body }: {
  title: string
  icon: React.ReactNode
  busy: boolean
  onCancel: () => void
  onConfirm: () => void
  body: React.ReactNode
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center animate-fade-in" onClick={onCancel}>
      <div className="w-[400px] bg-bg-800 border border-slate-700 rounded-2xl shadow-2xl animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">{icon} {title}</h2>
          <button onClick={onCancel} className="p-1 rounded-lg hover:bg-bg-600 text-slate-400"><X size={16} /></button>
        </div>
        <div className="px-5 py-4">{body}</div>
        <div className="flex justify-end gap-2 px-5 pb-4">
          <button type="button" onClick={onCancel} className="btn-ghost">取消</button>
          <button type="button" onClick={onConfirm} disabled={busy} className="btn-primary flex items-center gap-1.5">
            {busy && <Loader2 size={13} className="animate-spin" />}
            确定
          </button>
        </div>
      </div>
    </div>
  )
}
