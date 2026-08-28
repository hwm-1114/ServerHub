import { useState, useEffect, useCallback, useRef } from 'react'
import { Folder, File as FileIcon, ArrowUp, HardDrive, Star, X, ChevronRight, Loader2, RefreshCw, Copy, Upload, Download, Computer, FolderOpen, CheckSquare, Square } from 'lucide-react'
import { LocalFavorite } from '../types'
import { DND_MIME, makeDndData, readDndData, DndFile } from './DeviceFilePanel'
import { SIZE_UNITS, getSizeUnit, setSizeUnit, formatSize, SizeUnit } from '../lib/sizeFormat'

interface Props {
  serverId: string
  /** 面板宽度 */
  width: number
  /** 远程当前目录(批量上传到远端的目标目录) */
  remoteDir?: string
  /** 本地浏览路径上报给父组件(批量下载到本机时用) */
  onPathChange?: (p: string) => void
  /** 变化时刷新本机目录列表(父组件批量下载完成后通知) */
  refreshSignal?: number
}

interface Entry { name: string; isDir: boolean; size?: number }

function dirName(p: string): string {
  if (!p) return '本机'
  let s = p
  while (s.endsWith('\\')) s = s.slice(0, -1)
  if (/^[A-Za-z]:$/.test(s)) return s
  const idx = s.lastIndexOf('\\')
  return idx < 0 ? s : s.slice(idx + 1)
}
function parentOf(p: string): string {
  if (!p) return ''
  let s = p
  while (s.endsWith('\\')) s = s.slice(0, -1)
  if (/^[A-Za-z]:$/.test(s)) return ''
  const idx = s.lastIndexOf('\\')
  if (idx < 0) return ''
  const parent = s.slice(0, idx)
  return /^[A-Za-z]:$/.test(parent) ? parent + '\\' : parent
}
function joinPath(parent: string, child: string): string {
  let p = parent
  while (p.endsWith('\\')) p = p.slice(0, -1)
  if (/^[A-Za-z]:$/.test(p)) return p + '\\' + child
  return p + '\\' + child
}

// FileBrowser 左侧的本机(Windows)目录面板:
// - 本机文件可拖到右侧远程文件列表=上传(读本机→SFTP 写远端);
// - 也是远程文件拖入的目标=下载(SFTP 读→写本机);可收藏本机目录。
export function RemoteLocalPanel({ serverId, width, remoteDir, onPathChange, refreshSignal }: Props) {
  const [browsePath, setBrowsePathState] = useState('')
  // 切换目录时既更新本地状态,也上报给父组件(批量下载到本机时用)
  const setBrowsePath = useCallback((p: string) => {
    setBrowsePathState(p)
    onPathChange?.(p)
  }, [onPathChange])
  const [entries, setEntries] = useState<Entry[]>([])
  const [note, setNote] = useState('')
  const [loading, setLoading] = useState(false)
  const [favorites, setFavorites] = useState<LocalFavorite[]>([])
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'warn' } | null>(null)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const dropDirRef = useRef<string | null>('')
  // 文件大小显示单位(默认字节)
  const [unit, setUnitState] = useState<SizeUnit>(() => getSizeUnit())
  // 批量选择:勾选本地文件后一次性上传到远程当前目录
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [uploading, setUploading] = useState(false)
  // Shift 连续选择锚点:记录最后一次(非 shift)点击的列表索引
  const selAnchorRef = useRef(-1)

  const showToast = (t: string, kind: 'ok' | 'warn' = 'ok') => setToast({ text: t, kind })
  useEffect(() => { if (!toast) return; const tm = setTimeout(() => setToast(null), 2200); return () => clearTimeout(tm) }, [toast])

  const fetchBrowse = useCallback(async (path: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/local/browse?path=${encodeURIComponent(path)}`)
      const d = await res.json()
      setEntries(d.entries || []); setNote(d.note || '')
      // 成功进入的目录同步上报父组件:批量"下载选中到本机"用的是父级记录的路径,
      // 初始挂载/手动刷新也走这里,避免父级残留陈旧目录
      onPathChange?.(path)
    } catch { setEntries([]); setNote('浏览失败') } finally { setLoading(false) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => { fetchBrowse(browsePath) }, [browsePath, fetchBrowse])
  // 父组件批量下载完成后的刷新通知:只看 refreshSignal 变化,browsePath 取闭包当前值
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (refreshSignal) fetchBrowse(browsePath) }, [refreshSignal])

  // 批量上传选中到远程当前目录(串行,聚合每文件失败原因)
  const uploadSelected = async () => {
    const files = Array.from(selected)
    if (files.length === 0 || !remoteDir) { showToast('请选择文件,且需先进入远程目录', 'warn'); return }
    setUploading(true)
    let ok = 0
    const fails: string[] = []
    for (const p of files) {
      const name = p.split(/[\\/]/).filter(Boolean).pop() || ''
      try {
        const r = await fetch(`/api/servers/${serverId}/files/local-to-remote`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ localPath: p, remoteDir }),
        })
        const d = await r.json().catch(() => ({}))
        if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
        ok++
      } catch (err) {
        fails.push(`${name}: ${err instanceof Error ? err.message : '未知错误'}`)
      }
    }
    setUploading(false)
    setSelected(new Set())
    setSelectMode(false)
    reportBatch('已上传', ok, files.length, fails, remoteDir)
  }

  // 切换单个文件选中,并更新 shift 锚点
  const toggleSelect = (path: string, i: number) => {
    setSelected(prev => {
      const n = new Set(prev)
      if (n.has(path)) n.delete(path); else n.add(path)
      return n
    })
    selAnchorRef.current = i
  }

  // 文件行点击:shift 时按锚点做连续区间选择(只对文件);否则普通切换
  const handleSelectClick = (e: React.MouseEvent, path: string, i: number) => {
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
    toggleSelect(path, i)
  }

  const fetchFavs = useCallback(async () => {
    try { setFavorites(await (await fetch('/api/local/favorites')).json()) } catch {}
  }, [])
  useEffect(() => { fetchFavs() }, [fetchFavs])

  const isFav = favorites.some(f => f.path === browsePath)
  const toggleFav = async () => {
    try {
      const existing = favorites.find(f => f.path === browsePath)
      if (existing) { await fetch(`/api/local/favorites/${existing.id}`, { method: 'DELETE' }) }
      else { await fetch('/api/local/favorites', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: browsePath, name: dirName(browsePath) }) }) }
      fetchFavs()
    } catch {}
  }

  const copyPath = () => { try { navigator.clipboard?.writeText(browsePath); showToast('已复制路径') } catch {} }

  // 用 Windows 资源管理器打开当前本地目录
  const openInExplorer = async () => {
    if (!browsePath) { showToast('请先进入一个本地目录', 'warn'); return }
    try {
      const r = await fetch('/api/local/open-dir', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: browsePath }),
      })
      const d = await r.json()
      if (!r.ok || !d.ok) throw new Error(d.error || '打开失败')
      showToast('已用资源管理器打开')
    } catch (err) {
      showToast(`打开失败: ${err instanceof Error ? err.message : '未知错误'}`, 'warn')
    }
  }

  // 核心:单个 远程→本机 传输,返回错误文本而不直接弹提示(单次与批量共用)
  const transferRemoteToLocal = async (remotePath: string, targetDir: string): Promise<string | null> => {
    try {
      const r = await fetch(`/api/servers/${serverId}/files/remote-to-local`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remotePath, localDir: targetDir }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
      return null
    } catch (err) {
      return err instanceof Error ? err.message : '未知错误'
    }
  }

  // 批量结果汇总:成功整批报喜;有失败列出前几条原因(旧实现 catch{} 丢弃原因,只报 N/M)
  const reportBatch = (verb: string, ok: number, total: number, fails: string[], target: string) => {
    if (fails.length === 0) { showToast(`${verb} ${ok}/${total} 个文件 → ${target}`); return }
    const head = fails.slice(0, 2).join('；')
    showToast(`${verb} ${ok}/${total} 个文件,失败: ${head}${fails.length > 2 ? ` 等 ${fails.length} 项` : ''}`, 'warn')
  }

  // 下载:远程文件 → 本机目录(拖拽单个)
  const doRemoteToLocal = async (remotePath: string, name: string, targetDir: string) => {
    setBusy(true)
    const err = await transferRemoteToLocal(remotePath, targetDir)
    setBusy(false)
    if (err) { showToast(`下载失败: ${err}`, 'warn'); return }
    showToast(`已下载 ${name} → ${targetDir}`)
    fetchBrowse(browsePath)
  }

  // 拖拽批量下载:串行执行,聚合结果,完成后刷新一次列表
  const downloadBatch = async (files: DndFile[], targetDir: string) => {
    const list = files.filter(f => !f.isDir)
    const skippedDirs = files.length - list.length
    if (list.length === 0) {
      showToast(skippedDirs ? '目录暂不支持传输,已跳过' : '没有可下载的文件', 'warn')
      return
    }
    setBusy(true)
    let ok = 0
    const fails: string[] = []
    for (const f of list) {
      const err = await transferRemoteToLocal(f.path, targetDir)
      if (err) fails.push(`${f.name}: ${err}`); else ok++
    }
    setBusy(false)
    reportBatch('已下载', ok, list.length, fails, targetDir)
    if (skippedDirs) showToast(`另有 ${skippedDirs} 个目录暂不支持传输,已跳过`, 'warn')
    fetchBrowse(browsePath)
  }

  const handleDrop = async (e: React.DragEvent, targetDir: string) => {
    setDropDir(null)
    if (e.dataTransfer.types.includes(DND_MIME)) {
      // 本机面板是封闭投放区:DND_MIME 拖拽一律在此终结。旧实现非本面板的拖拽
      // 只 return 不阻断冒泡,事件会冒到 FileBrowser 根层被当成"本地→远程上传"
      // ——本地文件掉在本机面板上就静默传到远程并覆盖同名文件
      e.preventDefault()
      e.stopPropagation()
      const data = readDndData(e)
      if (!data) return
      if (data.kind !== 'server') {
        showToast(data.kind === 'local' ? '本地文件请拖到右侧远程列表上传' : '仅支持从远程列表拖入下载', 'warn')
        return
      }
      if (Array.isArray(data.files) && data.files.length) { await downloadBatch(data.files, targetDir); return }
      if (data.isDir) { showToast('目录暂不支持传输,已跳过', 'warn'); return }
      await doRemoteToLocal(data.path, data.name, targetDir)
    }
  }

  return (
    <div data-localpanel className="flex flex-col bg-bg-900 border-r border-slate-800 min-h-0 shrink-0" style={{ width }}>
      {/* 标题 */}
      <div className="h-10 border-b border-slate-800/60 px-3 flex items-center gap-2 shrink-0">
        <Computer size={14} className="text-accent-400" />
        <span className="text-xs font-semibold text-slate-200">本机目录</span>
        <span className="text-[10px] text-slate-500">大小</span>
        <select
          value={unit}
          onChange={(e) => { setUnitState(e.target.value as SizeUnit); setSizeUnit(e.target.value as SizeUnit) }}
          className="bg-bg-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-300 outline-none focus:border-accent-500/60"
          title="选择文件大小单位"
        >
          {SIZE_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
        </select>
        <button onClick={copyPath} className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400" title="复制路径"><Copy size={12} /></button>
        <button onClick={openInExplorer} className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400" title="用资源管理器打开当前目录"><FolderOpen size={12} /></button>
        <button onClick={() => fetchBrowse(browsePath)} className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400" title="刷新"><RefreshCw size={12} /></button>
        <button
          onClick={() => setSelectMode(m => !m)}
          className={`p-1 rounded hover:bg-bg-600 ${selectMode ? 'text-accent-400 bg-accent-500/10' : 'text-slate-400 hover:text-accent-400'}`}
          title={selectMode ? '退出批量选择' : '批量选择(勾选后上传到远程当前目录)'}
        >
          {selectMode ? <CheckSquare size={12} /> : <Square size={12} />}
        </button>
      </div>

      {/* 路径 + 上级 + 收藏 */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-slate-800/40 shrink-0">
        <button onClick={() => setBrowsePath(parentOf(browsePath))} disabled={!browsePath}
          className="p-1 rounded hover:bg-bg-600 text-slate-400 disabled:opacity-30" title="上级"><ArrowUp size={12} /></button>
        <button onClick={toggleFav} disabled={!browsePath}
          className={`p-1 rounded hover:bg-bg-600 disabled:opacity-30 ${isFav ? 'text-amber-400' : 'text-slate-400 hover:text-amber-400'}`} title={isFav ? '取消收藏' : '收藏本机目录'}>
          <Star size={12} fill={isFav ? 'currentColor' : 'none'} />
        </button>
        <span className="text-[11px] text-slate-300 truncate flex-1" title={browsePath}>{browsePath || '本机磁盘'}</span>
      </div>

      {busy && <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-accent-400 shrink-0"><Loader2 size={12} className="animate-spin" /> 正在传输…</div>}
      {note && <div className="text-[11px] text-slate-600 px-3 py-1 shrink-0">{note}</div>}

      {/* 列表 */}
      <div
        className={`flex-1 min-h-0 overflow-y-auto space-y-0.5 px-1.5 py-1.5 transition-colors ${dropDir === '' ? 'bg-accent-500/5 ring-1 ring-inset ring-accent-500/40' : ''}`}
        onDragOver={(ev) => {
          // 只用 types 判断:浏览器规范规定 dragover 期间 getData 恒为空,
          // 旧实现在这里 readDndData 判 kind 恒失败,拖入高亮从不出现
          if (!ev.dataTransfer.types.includes(DND_MIME)) return
          if ((ev.target as HTMLElement).closest('[data-dirdrop]')) return
          ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; dropDirRef.current = ''; setDropDir('')
        }}
        onDragLeave={(ev) => { if (!ev.currentTarget.contains(ev.relatedTarget as Node)) setDropDir(null) }}
        onDrop={(ev) => handleDrop(ev, browsePath)}
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
                onClick={() => setBrowsePath(browsePath ? joinPath(browsePath, e.name) : e.name)}
                onDragOver={(ev) => { if (ev.dataTransfer.types.includes(DND_MIME)) { ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'copy'; dropDirRef.current = joinPath(browsePath, e.name); setDropDir(joinPath(browsePath, e.name)) } }}
                onDragLeave={() => setDropDir(cur => (cur === joinPath(browsePath, e.name) ? null : cur))}
                onDrop={(ev) => { ev.stopPropagation(); handleDrop(ev, joinPath(browsePath, e.name)) }}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-xs ${isTarget ? 'bg-accent-500/15 outline outline-1 outline-accent-500/50 text-accent-300' : 'hover:bg-bg-700 text-slate-400 hover:text-slate-200'}`}
                title={e.name}
              >
                <Folder size={12} className="text-sky-400/70 flex-shrink-0" />
                <span className="truncate flex-1">{e.name}</span>
                {isTarget ? <Download size={11} className="text-accent-400 flex-shrink-0" /> : <ChevronRight size={12} className="text-slate-600 flex-shrink-0" />}
              </div>
            ) : (
              <div key={`${e.name}-${i}`} draggable={selectMode ? selected.size > 0 : true}
                onDragStart={(ev) => { if (selectMode) { if (selected.size === 0) { ev.preventDefault(); return } const files: DndFile[] = Array.from(selected).map(q => ({ kind: 'local', path: q, name: q.split(/[\\/]/).filter(Boolean).pop() || q, isDir: false })); ev.dataTransfer.effectAllowed = 'copy'; ev.dataTransfer.setData(DND_MIME, makeDndData('local', '', '', false, files)); return } ev.dataTransfer.effectAllowed = 'copy'; ev.dataTransfer.setData(DND_MIME, makeDndData('local', joinPath(browsePath, e.name), e.name, false)) }}
                onClick={selectMode ? ((ev) => handleSelectClick(ev, joinPath(browsePath, e.name), i)) : undefined}
                className={`group flex items-center gap-2 px-2 py-1.5 rounded-md text-xs ${selectMode ? 'cursor-pointer' : 'cursor-grab'} ${selected.has(joinPath(browsePath, e.name)) ? 'bg-accent-500/15 text-accent-300' : 'text-slate-500 hover:bg-bg-700/40'}`}
                title={selectMode ? `勾选 ${e.name}` : `${e.name} (拖到右侧远程目录上传)`}
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

      {/* 批量上传选中到远程 */}
      {selectMode && (
        <div className="px-2 py-1.5 border-t border-slate-800/60 shrink-0 bg-accent-500/5">
          {uploading ? (
            <div className="flex items-center gap-2 text-[11px] text-accent-400"><Loader2 size={12} className="animate-spin" /> 正在上传选中文件…</div>
          ) : (
            <button
              onClick={uploadSelected}
              disabled={selected.size === 0}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium bg-accent-500/15 text-accent-400 border border-accent-500/30 hover:bg-accent-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
              title={remoteDir ? `上传选中的 ${selected.size} 个文件到 ${remoteDir}` : '需要先进入远程目录'}
            >
              <Upload size={12} /> 上传选中到远程{selected.size > 0 ? ` (${selected.size})` : ''}
            </button>
          )}
          {selected.size > 0 && (
            <button onClick={() => setSelected(new Set())} className="w-full text-center text-[10px] text-slate-500 hover:text-slate-300 mt-1">清除选择</button>
          )}
        </div>
      )}

      {/* 收藏 */}
      {favorites.length > 0 && (
        <div className="border-t border-slate-800/60 shrink-0">
          <div className="px-2 pb-0.5 pt-1 text-[10px] font-medium text-slate-500 flex items-center gap-1"><Star size={10} className="text-amber-400/70" /> 收藏</div>
          <div className="max-h-28 overflow-y-auto space-y-0.5 px-1 pb-1">
            {favorites.map(f => (
              <div key={f.id} className="group flex items-center gap-1">
                <button onClick={() => setBrowsePath(f.path)} className="flex-1 flex items-center gap-2 px-1.5 py-1 rounded text-left text-[11px] text-slate-400 hover:bg-bg-700 hover:text-slate-200 min-w-0" title={f.path}>
                  <Folder size={11} className="text-amber-400/60 flex-shrink-0" />
                  <span className="truncate">{f.name || dirName(f.path)}</span>
                </button>
                <button onClick={() => { fetch(`/api/local/favorites/${f.id}`, { method: 'DELETE' }).then(fetchFavs) }} className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-bg-600 text-slate-500 hover:text-red-400" title="移除收藏"><X size={10} /></button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="px-2 py-1.5 border-t border-slate-800/60 text-[10px] text-slate-600 shrink-0 flex items-center gap-1">
        <Upload size={10} />拖入文件=上传 <span className="flex-1" /> <Download size={10} />拖出=下载
      </div>

      {toast && (
        <div className={`absolute left-2 right-2 bottom-10 z-30 px-2 py-1 rounded-md text-[11px] border ${toast.kind === 'ok' ? 'text-accent-400 bg-accent-500/10 border-accent-500/20' : 'text-amber-400 bg-amber-500/10 border-amber-500/20'}`}>{toast.text}</div>
      )}
    </div>
  )
}
