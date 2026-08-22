import { useState, useEffect, useCallback, useRef } from 'react'
import { Folder, File as FileIcon, ArrowUp, Smartphone, ChevronRight, Loader2, RefreshCw, Copy, Upload, Download, Check, PlugZap, Unplug, CheckSquare, Square } from 'lucide-react'
import { SIZE_UNITS, getSizeUnit, setSizeUnit, formatSize, SizeUnit } from '../lib/sizeFormat'

interface Props {
  /** 面板宽度(由父组件通过拖拽分隔线控制) */
  width: number
}

interface FileInfo { name: string; isDir: boolean; size?: number }
interface Target { serial: string; state: string }

// 拖拽数据标记
export const DND_MIME = 'application/x-serverhub-file'
/** 一次拖拽可能携带单个文件(kind/path/name/isDir)或一批文件(files 数组,批量勾选后拖拽) */
export interface DndFile { kind: 'local' | 'device' | 'server'; path: string; name: string; isDir: boolean }
export function makeDndData(kind: 'local' | 'device' | 'server', path: string, name: string, isDir: boolean, files?: DndFile[]) {
  return JSON.stringify({ kind, path, name, isDir, files })
}
export function readDndData(e: React.DragEvent) {
  try { return JSON.parse(e.dataTransfer.getData(DND_MIME)) } catch { return null }
}

// 设备路径是 Linux 风格,以 / 分隔
function joinDev(parent: string, child: string): string {
  if (!parent || parent === '/') return '/' + child
  return parent.replace(/\/+$/, '') + '/' + child
}
function parentDev(p: string): string {
  const s = (p || '').replace(/\/+$/, '')
  if (!s || s === '/') return '/'
  const idx = s.lastIndexOf('/')
  return idx <= 0 ? '/' : s.slice(0, idx)
}

// 右侧设备文件面板:浏览 hdc 连接设备的目录与文件。
// - 文件可拖拽(拖到本地面板=下载);也是本地文件拖入的目标(上传)。
export function DeviceFilePanel({ width }: Props) {
  const [devicePath, setDevicePath] = useState('/')
  const [entries, setEntries] = useState<FileInfo[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ text: string; kind: 'ok' | 'warn' } | null>(null)
  const [targets, setTargets] = useState<Target[]>([])
  // 拖拽高亮:当前成为投放目标(落点)的目录路径;'' 表示面板根部
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [serial, setSerial] = useState<string>('')
  const [connected, setConnected] = useState(false)
  const [refreshTick, setRefreshTick] = useState(0)
  // 批量下载到本机时默认用上次使用的本机目录
  useEffect(() => {
    ;(async () => {
      try {
        const s = await (await fetch('/api/local/transfer-state')).json()
        if (s?.localDir) setBatchLocalDir(prev => prev || s.localDir)
      } catch {}
    })()
  }, [])
  // 文件大小显示单位(默认字节)
  const [unit, setUnitState] = useState<SizeUnit>(() => getSizeUnit())
  const dropDirRef = useRef<string | null>(null)
  // 批量选择设备文件 → 下载到本机;Shift 连续选择
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const selAnchorRef = useRef(-1)
  const [batchLocalDir, setBatchLocalDir] = useState('')
  const [batchBusy, setBatchBusy] = useState(false)

  const showToast = (t: string, kind: 'ok' | 'warn' = 'ok') => setToast({ text: t, kind })
  useEffect(() => {
    if (!toast) return
    const tm = setTimeout(() => setToast(null), 2200)
    return () => clearTimeout(tm)
  }, [toast])

  // 列出已连接设备,默认选第一个;返回 targets 供初始化判断
  const loadTargets = useCallback(async () => {
    try {
      const d = await (await fetch('/api/local/hdc-targets')).json()
      const t = d.targets || []
      setTargets(t)
      setSerial(cur => cur || t[0]?.serial || '')
      return t
    } catch { return [] }
  }, [])

  // 刚打开面板时自动识别设备并连接一次(即"打开的时候才用"):
  // - 有设备就连上并读取一次目录;
  // - 之后不再轮询/自动重连,由用户手动 连接/断开/刷新 控制,避免一直刷新导致卡顿。
  const autoInitRef = useRef(false)
  useEffect(() => {
    (async () => {
      if (autoInitRef.current) return
      autoInitRef.current = true
      const t = await loadTargets()
      if (t.length) { setConnected(true); setRefreshTick(x => x + 1) }
    })()
  }, [loadTargets])

  const load = useCallback(async (p: string) => {
    setLoading(true); setError('')
    try {
      const q = serial ? `&serial=${encodeURIComponent(serial)}` : ''
      const r = await fetch(`/api/local/hdc-list?path=${encodeURIComponent(p)}${q}`)
      const d = await r.json()
      // 失败时清空列表:残留旧 entries 会与错误提示并存,误导用户以为还是设备当前内容
      if (d.error) { setError(d.error); setEntries([]); return }
      setEntries(d.entries || [])
    } catch {
      setError('无法获取设备目录')
      setEntries([])
    } finally {
      setLoading(false)
    }
  }, [serial])

  // 有设备且已连接时读取目录;serial/devicePath/refreshTick 变化都会刷新(不做周期轮询)
  useEffect(() => { if (connected && serial) load(devicePath) }, [devicePath, serial, connected, refreshTick, load])

  // 连接/断开:直接把当前设备设为连接打开/关闭目录浏览
  const toggleHdc = async () => {
    if (connected) {
      await fetch('/api/local/hdc-disconnect', { method: 'POST' })
      setConnected(false); setEntries([]); setError(''); setDevicePath('/')
      showToast('已断开设备')
    } else {
      if (!serial) { showToast('未检测到设备,请先在 hdc 上连接设备', 'warn'); return }
      await fetch('/api/local/hdc-connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serial }),
      })
      setConnected(true); setDevicePath('/')
      setRefreshTick(t => t + 1)
      showToast(`已连接 ${serial},正在读取目录…`)
      loadTargets()
    }
  }

  const copyPath = () => {
    try { navigator.clipboard?.writeText(devicePath); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }

  // 是否正拖拽的是"本地文件"(上传到设备)
  const isLocalDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(DND_MIME)

  // 上传:本地文件 → 设备(目标目录)
  const doUpload = async (localPath: string, name: string, targetDir: string) => {
    setBusy(true)
    try {
      const r = await fetch('/api/local/hdc-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localPath, devicePath: targetDir, serial }),
      })
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || '上传失败')
      showToast(`已上传 ${name} → ${targetDir}`)
      load(devicePath)
    } catch (err) {
      showToast(`上传失败: ${err instanceof Error ? err.message : '未知错误'}`, 'warn')
    } finally {
      setBusy(false)
    }
  }

  const handleDrop = async (e: React.DragEvent, dirTarget: string) => {
    e.preventDefault()
    e.stopPropagation()
    setDropTarget(null)
    const data = readDndData(e)
    if (!data || data.kind !== 'local') return
    // 批量上传串行执行:并发会互相触发 load() 刷新竞态,busy 状态也会互相覆盖
    if (Array.isArray(data.files) && data.files.length) {
      for (const f of data.files) { if (!f.isDir) await doUpload(f.path, f.name, dirTarget) }
      return
    }
    if (!data.isDir) await doUpload(data.path, data.name, dirTarget)
  }

  // ===== 批量选择设备文件 → 下载到本机(hdc-recv) =====
  const toggleSelect = (path: string, i: number) => {
    setSelected(prev => {
      const n = new Set(prev)
      if (n.has(path)) n.delete(path); else n.add(path)
      return n
    })
    selAnchorRef.current = i
  }
  // 文件行点击:shift 连续区间选择(只选文件);否则普通切换
  const handleSelect = (e: React.MouseEvent, path: string, i: number) => {
    if (e.shiftKey) {
      const anchor = selAnchorRef.current >= 0 ? selAnchorRef.current : i
      const a = Math.min(anchor, i)
      const b = Math.max(anchor, i)
      setSelected(prev => {
        const n = new Set(prev)
        for (let k = a; k <= b; k++) {
          const row = entries[k]
          if (row && !row.isDir) n.add(joinDev(devicePath, row.name))
        }
        return n
      })
      return
    }
    toggleSelect(path, i)
  }

  // 批量下载选中设备文件到本机
  const downloadSelectedToLocal = async () => {
    const files = Array.from(selected)
    const dir = batchLocalDir.trim()
    if (files.length === 0 || !dir) { showToast('请选择文件,并填写本机保存目录', 'warn'); return }
    setBatchBusy(true)
    let ok = 0
    for (const devPath of files) {
      try {
        const r = await fetch('/api/local/hdc-recv', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ devicePath: devPath, localDir: dir }),
        })
        const d = await r.json()
        if (r.ok && !d.error) ok++
      } catch {}
    }
    setBatchBusy(false)
    setSelected(new Set())
    setSelectMode(false)
    try {
      await fetch('/api/local/transfer-state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ localDir: dir }) })
    } catch {}
    showToast(`已下载 ${ok}/${files.length} 个文件到本机`)
    load(devicePath)
  }

  return (
    <div
      className="flex flex-col bg-bg-900 border-r border-slate-800 min-h-0 shrink-0"
      style={{ width }}
      onDragEnter={() => setDropTarget(cur => (cur === null ? '' : cur))}
      onDragOver={(e) => {
        if (isLocalDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }
      }}
      onDragLeave={(e) => {
        // 只有离开面板根部才清除
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropTarget(null)
      }}
      onDrop={(e) => handleDrop(e, devicePath)}
    >
      {/* 标题 */}
      <div className="h-10 border-b border-slate-800/60 px-3 flex items-center gap-2 shrink-0">
        <Smartphone size={14} className="text-accent-400" />
        <span className="text-xs font-semibold text-slate-200">设备文件</span>
        <span className="text-[10px] text-slate-500">(hdc)</span>
        <span className="flex-1" />
        <button onClick={copyPath} className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400" title="复制设备路径">
          {copied ? <Check size={12} className="text-accent-400" /> : <Copy size={12} />}
        </button>
        <button onClick={() => load(devicePath)} className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400" title="刷新">
          <RefreshCw size={12} />
        </button>
        <button
          onClick={() => setSelectMode(m => { if (m) { setSelected(new Set()); selAnchorRef.current = -1 } return !m })}
          className={`p-1 rounded hover:bg-bg-600 ${selectMode ? 'text-accent-400 bg-accent-500/10' : 'text-slate-400 hover:text-accent-400'}`}
          title={selectMode ? '退出批量选择' : '批量选择设备文件(下载到本机)'}
        >
          {selectMode ? <CheckSquare size={12} /> : <Square size={12} />}
        </button>
      </div>

      {/* 设备选择 + 连接开关 */}
      <div className="flex flex-col gap-1 px-2 py-1.5 border-b border-slate-800/40 shrink-0">
        <div className="flex items-center gap-1">
          <select
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            className="flex-1 min-w-0 bg-bg-800 border border-slate-700 rounded-md px-1.5 py-1 text-[11px] text-slate-200 outline-none focus:border-accent-500/60"
            title="选择要操作的设备"
          >
            {targets.length === 0 && <option value="">未检测到设备(hdc list targets)</option>}
            {targets.map((t) => (
              <option key={t.serial} value={t.serial}>{t.serial} ({t.state})</option>
            ))}
            {targets.length > 0 && <option value="">默认设备</option>}
          </select>
          <button onClick={() => loadTargets()} className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400" title="刷新设备列表">
            <RefreshCw size={12} />
          </button>
          <select
            value={unit}
            onChange={(e) => { setUnitState(e.target.value as SizeUnit); setSizeUnit(e.target.value as SizeUnit) }}
            className="bg-bg-800 border border-slate-700 rounded px-1 py-0.5 text-[10px] text-slate-400 outline-none focus:border-accent-500/60"
            title="选择文件大小单位"
          >
            {SIZE_UNITS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
        </div>
        <button
          onClick={toggleHdc}
          className={`flex items-center justify-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium border transition-colors ${
            connected
              ? 'text-red-400 bg-red-500/10 border-red-500/30 hover:bg-red-500/20'
              : 'text-accent-400 bg-accent-500/10 border-accent-500/30 hover:bg-accent-500/20'
          }`}
          title={connected ? '断开 hdc 设备连接' : '打开 hdc 设备连接'}
        >
          {connected ? <Unplug size={12} /> : <PlugZap size={12} />}
          {connected ? '断开设备' : '连接设备'}
        </button>
      </div>

      {/* 路径 + 上级 */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-slate-800/40 shrink-0">
        <button
          onClick={() => setDevicePath(parentDev(devicePath))}
          disabled={devicePath === '/'}
          className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-slate-200 disabled:opacity-30"
          title="上级"
        >
          <ArrowUp size={12} />
        </button>
        <span className="text-[11px] text-slate-300 truncate flex-1 font-mono" title={devicePath}>{devicePath}</span>
      </div>

      {busy && (
        <div className="flex items-center gap-2 px-3 py-1 text-[11px] text-accent-400 shrink-0">
          <Loader2 size={12} className="animate-spin" /> 正在传输…
        </div>
      )}

      {/* 列表 */}
      <div
        className={`flex-1 min-h-0 overflow-y-auto space-y-0.5 px-1.5 py-1.5 transition-colors ${
          dropTarget === '' ? 'bg-accent-500/5 ring-1 ring-inset ring-accent-500/40' : ''
        }`}
      >
        {error && (
          <div className="text-[11px] text-amber-400 px-2 py-2">
            {error.includes('退出码') || error.includes('hdc') ? `hdc: ${error}` : error}
            <div className="text-slate-600 mt-1">请确认已执行 hdc shell 连接设备</div>
          </div>
        )}
        {loading && entries.length === 0 ? (
          <div className="text-[11px] text-slate-600 px-2 py-3 text-center flex items-center justify-center gap-1"><Loader2 size={11} className="animate-spin" /> 加载中…</div>
        ) : entries.length === 0 && !error ? (
          <div className="text-[11px] text-slate-600 px-2 py-3 text-center">设备目录为空</div>
        ) : (
          entries.map((e, i) => (
            <div
              key={`${e.name}-${i}`}
              onClick={e.isDir ? () => setDevicePath(joinDev(devicePath, e.name)) : (selectMode ? (ev) => handleSelect(ev, joinDev(devicePath, e.name), i) : undefined)}
              onDragOver={(ev) => {
                if (isLocalDrag(ev) && e.isDir) { ev.preventDefault(); ev.stopPropagation(); ev.dataTransfer.dropEffect = 'copy'; setDropTarget(joinDev(devicePath, e.name)) }
              }}
              onDragLeave={() => setDropTarget(cur => (cur === joinDev(devicePath, e.name) ? null : cur))}
              onDrop={(ev) => { if (e.isDir) handleDrop(ev, joinDev(devicePath, e.name)) }}
              draggable={!e.isDir && (selectMode ? selected.size > 0 : true)}
              onDragStart={(ev) => {
                if (e.isDir) return
                if (selectMode) {
                  if (selected.size === 0) { ev.preventDefault(); return }
                  const files: DndFile[] = Array.from(selected).map(q => ({ kind: 'device', path: q, name: q.split('/').filter(Boolean).pop() || q, isDir: false }))
                  ev.dataTransfer.effectAllowed = 'copy'
                  ev.dataTransfer.setData(DND_MIME, makeDndData('device', '', '', false, files))
                  return
                }
                ev.dataTransfer.effectAllowed = 'copy'
                ev.dataTransfer.setData(DND_MIME, makeDndData('device', joinDev(devicePath, e.name), e.name, false))
              }}
              className={`group flex items-center gap-2 px-2 py-1.5 rounded-md text-xs cursor-pointer ${
                dropTarget === joinDev(devicePath, e.name)
                  ? 'bg-accent-500/15 outline outline-1 outline-accent-500/50'
                  : e.isDir
                    ? 'hover:bg-bg-700 text-slate-400 hover:text-slate-200'
                    : selectMode
                      ? (selected.has(joinDev(devicePath, e.name)) ? 'bg-accent-500/15 text-accent-300' : 'text-slate-500 hover:bg-bg-700/40')
                      : 'text-slate-500 hover:bg-bg-700/40 cursor-grab'
              }`}
              title={e.name}
            >
              {e.isDir ? (
                <Folder size={12} className="text-sky-400/70 flex-shrink-0" />
              ) : selectMode ? (
                <span className="text-accent-400 flex-shrink-0">
                  {selected.has(joinDev(devicePath, e.name)) ? <CheckSquare size={12}/> : <Square size={12}/>}
                </span>
              ) : (
                <FileIcon size={12} className="text-slate-600 flex-shrink-0" />
              )}
              <span className="truncate flex-1">{e.name}</span>
              {!e.isDir ? (
                <>
                  {formatSize(e.size ?? 0, unit, false) && (
                    <span className="text-[10px] text-slate-600 flex-shrink-0">{formatSize(e.size ?? 0, unit, false)}</span>
                  )}
                  <Download size={11} className="text-slate-500 opacity-0 group-hover:opacity-100 flex-shrink-0" />
                </>
              ) : (
                <ChevronRight size={12} className="text-slate-600 flex-shrink-0" />
              )}
            </div>
          ))
        )}
      </div>

      {/* 批量选择设备文件下载到本机 */}
      {selectMode && (
        <div className="shrink-0 px-2 py-1.5 border-t border-slate-800/60 bg-accent-500/5 space-y-1.5">
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-slate-500 whitespace-nowrap">本机目录</span>
            <input
              value={batchLocalDir}
              onChange={e => setBatchLocalDir(e.target.value)}
              placeholder="C:\download"
              className="flex-1 min-w-0 bg-bg-900 border border-slate-700 rounded px-1.5 py-1 text-[11px] text-slate-300 outline-none focus:border-accent-500/60 font-mono"
            />
          </div>
          {batchBusy ? (
            <div className="flex items-center gap-2 text-[11px] text-accent-400"><Loader2 size={12} className="animate-spin" /> 正在下载到本机…</div>
          ) : (
            <button
              onClick={downloadSelectedToLocal}
              disabled={selected.size === 0}
              className="w-full flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium bg-accent-500/15 text-accent-400 border border-accent-500/30 hover:bg-accent-500/25 disabled:opacity-40"
              title={batchLocalDir.trim() ? `下载选中的 ${selected.size} 个设备文件到本机 ${batchLocalDir}` : '请填写本机保存目录'}
            >
              <Download size={12} /> 下载选中到本机{selected.size > 0 ? ` (${selected.size})` : ''}
            </button>
          )}
          {selected.size > 0 && (
            <button onClick={() => setSelected(new Set())} className="w-full text-center text-[10px] text-slate-500 hover:text-slate-300">清除选择</button>
          )}
        </div>
      )}

      {/* 底部提示 */}
      <div className="px-2 py-1.5 border-t border-slate-800/60 text-[10px] text-slate-600 shrink-0 flex items-center gap-1">
        <Upload size={10} /> 拖入本地文件=上传
        <span className="flex-1" />
        <Download size={10} /> 拖出文件=下载
      </div>

      {toast && (
        <div className={`absolute left-2 right-2 bottom-10 z-20 px-2 py-1 rounded-md text-[11px] border ${
          toast.kind === 'ok' ? 'text-accent-400 bg-accent-500/10 border-accent-500/20' : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
        }`}>
          {toast.text}
        </div>
      )}
    </div>
  )
}
