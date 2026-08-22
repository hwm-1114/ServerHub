import { useState, useEffect, useCallback, useRef } from 'react'
import { Command, CATEGORY_LABELS, CATEGORY_COLORS } from '../types'
import { sendToTerminal, focusTerminal } from '../lib/TerminalBridge'
import { apiFetch } from '../lib/api'
import { ConfirmDialog } from './ConfirmDialog'
import {
  Plus, Edit2, Trash2, Copy, X, Search, TerminalSquare, Tag,
  ChevronDown, ChevronRight, Play, Globe, Server as ServerIcon, GripVertical,
  Zap, CornerDownLeft, Pencil, Download, Upload,
} from 'lucide-react'

interface Props {
  serverId: string | null | undefined
  isConnected: boolean
  activeSessionId: string | null
  /** 内嵌到侧栏时:占满高度、无折叠头 */
  embedded?: boolean
  /** 本地终端模式:仅显示公共命令,并注入到活跃的本地终端;无服务器归属 */
  localMode?: boolean
  /** 活跃的本地终端会话 id(用于命令注入) */
  activeLocalSessionId?: string | null
}

export function CommandPanel({ serverId, isConnected, activeSessionId, embedded = false, localMode = false, activeLocalSessionId = null }: Props) {
  // 默认展开:每次切到"命令集"视图组件会重新挂载,保持面板整体打开并展示所有命令集
  const [open, setOpen] = useState(true)
  const [commands, setCommands] = useState<Command[]>([])
  const [search, setSearch] = useState('')
  const [expandedGroups, setExpandedGroups] = useState<Record<string, string | null>>({})
  const [showModal, setShowModal] = useState(false)
  const [editingCmd, setEditingCmd] = useState<Command | null>(null)
  const [deleteCmd, setDeleteCmd] = useState<Command | null>(null)
  const [batchConfirm, setBatchConfirm] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [deleteSet, setDeleteSet] = useState<{ cat: string; serverId: string | null } | null>(null)
  // 正在重命名的命令集:{ 旧分类, 归属, 新名草稿 }
  const [renamingSet, setRenamingSet] = useState<{ cat: string; serverId: string | null; draft: string } | null>(null)
  const [dropOver, setDropOver] = useState<string | null>(null)
  const dragCmdIdRef = useRef<Command | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // 删除模式:默认不显示勾选框,点击"删除"按钮才进入,进入后逐条勾选删除
  const [deleteMode, setDeleteMode] = useState(false)
  // 同命令集内拖拽排序:当前高亮的目标行 id
  const [dropRowId, setDropRowId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ text: string; kind: 'ok' | 'warn' } | null>(null)

  // 归一化 serverId:本地终端模式传 undefined/null;内部统一用 string | null
  const serverIdValue = serverId ?? null

  const fetchCommands = useCallback(async () => {
    // 本地终端模式取本地命令集;否则取远程命令集(公共 + 该服务器专属)
    const q = localMode ? '?scope=local' : (serverIdValue ? `?serverId=${serverIdValue}` : '')
    try {
      const list = await apiFetch<Command[]>(`/api/commands${q}`)
      setCommands(Array.isArray(list) ? list : [])
    } catch (err) {
      // 加载失败保持空列表并提示,绝不能把 {error} 对象当列表渲染(会白屏)
      setCommands([])
      setFeedback({ text: `命令加载失败:${err instanceof Error ? err.message : '未知错误'}`, kind: 'warn' })
    }
  }, [localMode, serverIdValue])

  useEffect(() => {
    fetchCommands()
  }, [embedded, fetchCommands])

  useEffect(() => {
    if (!feedback) return
    const t = setTimeout(() => setFeedback(null), 2200)
    return () => clearTimeout(t)
  }, [feedback])

  // 公共 = serverId 为空/'common' 且非本地命令(位于远程命令集)
  const isCommon = (c: Command) => (!c.serverId || c.serverId === 'common') && c.scope !== 'local'
  const commonCommands = commands.filter(isCommon)
  const serverCommands = commands.filter(c => c.serverId === serverIdValue)
  // 本地终端命令(独立的一套,不属于任何服务器,远程界面不显示)
  const localCommands = commands.filter(c => c.scope === 'local')
  // 当前已存在的命令集(分类),用于新建/编辑时的下拉:已删除的不再出现,新建的即时可选
  const categories = Array.from(new Set(commands.map(c => c.category)))
  // 命令归属键:公共=common,否则为其 serverId(用于判断是否同一分区)
  const curServerOf = (c: Command) => (!c.serverId || c.serverId === 'common') ? 'common' : c.serverId

  // 搜索过滤
  const filter = (list: Command[]) => {
    if (!search) return list
    const s = search.toLowerCase()
    return list.filter(c =>
      c.name.toLowerCase().includes(s) ||
      c.command.toLowerCase().includes(s) ||
      c.category.toLowerCase().includes(s))
  }

  // 分组(按分类),返回展开状态
  // 默认全部展开,一次展示所有命令;点击标题可单独折叠/展开(堆叠)。
  // 折叠状态的 key 带分区前缀:公共区与服务器区出现同名分类时不能联动折叠
  const groups = (list: Command[], partition: string) => {
    const cats = Array.from(new Set(list.map(c => c.category)))
    return cats.map(cat => ({
      cat,
      items: list.filter(c => c.category === cat),
      // 搜索时恒展开;否则默认展开(仅当显式折叠为 null 时才收起)
      expanded: !!search || expandedGroups[`${partition}:${cat}`] !== null,
    }))
  }

  const toggleGroup = (key: string) => {
    setExpandedGroups(prev => ({ ...prev, [key]: prev[key] ? null : key }))
  }

  // 在终端里执行:优先注入到当前活跃会话,否则回退 execute API
  // 执行方式:autoRun=false → 仅敲入命令,由用户按回车执行;缺省/true → 直接执行
  const runCommand = async (cmd: Command) => {
    const manual = cmd.autoRun === false
    const needsEnter = manual ? '' : '\r'
    const text = cmd.command.endsWith('\n') ? cmd.command : cmd.command + needsEnter
    // 本地终端模式:仅注入到活跃的本地终端,不回退 execute API(本地没有服务器)
    if (localMode) {
      const targetId = activeLocalSessionId ?? null
      if (targetId && sendToTerminal(targetId, text)) { focusTerminal(targetId); return }
      setFeedback({ text: manual ? '该命令为手动执行,请先打开本地终端' : '请先打开本地终端', kind: 'warn' })
      return
    }
    const delivered = activeSessionId ? sendToTerminal(activeSessionId, text) : false
    if (delivered) { focusTerminal(activeSessionId!); return } // 已在终端执行,并聚焦终端便于直接输入
    // 手动模式没有可用终端时,无法"待回车",提示用户先连接以便手动执行
    if (manual) {
      setFeedback({ text: '该命令为手动执行,请先在终端连接服务器后运行', kind: 'warn' })
      return
    }
    // 终端不可用:回退到 exec API
    if (!isConnected) {
      setFeedback({ text: '请先连接服务器', kind: 'warn' })
      return
    }
    try {
      const res = await fetch(`/api/servers/${serverIdValue}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: cmd.command }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      // 执行结果不展示日志
    } catch (err) {
      setFeedback({ text: `执行失败: ${err instanceof Error ? err.message : '未知错误'}`, kind: 'warn' })
    }
  }

  const handleSave = async (cmd: Command) => {
    try {
      await apiFetch(editingCmd ? `/api/commands/${cmd.id}` : '/api/commands', {
        method: editingCmd ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cmd),
      })
    } catch (err) {
      // 保存失败必须告知,不能静默关弹窗让用户误以为已保存
      setFeedback({ text: `保存失败:${err instanceof Error ? err.message : '未知错误'}`, kind: 'warn' })
      return
    }
    await fetchCommands()
    setShowModal(false)
    setEditingCmd(null)
  }

  // ========== 一键复制命令:名称自动递增(命令1、命令2……) ==========
  const duplicateCommand = async (cmd: Command) => {
    // 新名称 = 原名 + 递增数字(拉取第三方依赖 → 拉取第三方依赖1 → …)
    const base = cmd.name.replace(/\d+$/, '')
    // 编号扫描用全量命令表:当前面板列表是按服务器/scope 过滤后的子集,
    // 同名命令在公共区或其他服务器存在时会在全库撞名
    let pool = commands
    try {
      const all = await apiFetch<Command[]>('/api/commands')
      if (Array.isArray(all) && all.length) pool = all
    } catch { /* 拉不到全量就退回当前列表 */ }
    let maxN = 0
    for (const c of pool) {
      if (c.name.startsWith(base)) {
        const tail = c.name.slice(base.length)
        if (/^\d+$/.test(tail)) maxN = Math.max(maxN, parseInt(tail, 10))
      }
    }
    const newCmd = {
      name: `${base}${maxN + 1}`,
      command: cmd.command,
      category: cmd.category,
      description: cmd.description,
      // 保持与原命令相同的归属、命令集与执行方式
      serverId: cmd.serverId && cmd.serverId !== 'common' ? cmd.serverId : null,
      scope: cmd.scope,
      autoRun: cmd.autoRun !== false,
    }
    const res = await fetch('/api/commands', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(newCmd),
    })
    if (res.ok) {
      setFeedback({ text: `已复制为「${newCmd.name}」`, kind: 'ok' })
      fetchCommands()
    }
  }

  // ========== 导出/导入命令(.txt,JSON 格式) ==========
  // Electron 桌面版优先调原生保存/打开对话框(记住上次目录);
  // 纯浏览器(无 window.serverhub)降级为 Blob 下载 / <input type=file>。
  // 生成默认文件名:ServerHub命令_20260810.txt
  const defaultExportName = () => {
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    return `ServerHub命令_${stamp}.txt`
  }

  const exportCommands = async () => {
    try {
      const res = await fetch('/api/commands') // 不带参数=全部命令
      const all = await res.json()
      const content = JSON.stringify(all, null, 2)
      if (window.serverhub) {
        // 桌面:原生「另存为」,记住上次目录,由主进程直接写盘
        const r = await window.serverhub.saveFile({ defaultPath: defaultExportName(), content })
        if (r.canceled) return
        if (r.error) throw new Error(r.error)
        setFeedback({ text: `已导出 ${all.length} 条命令到 ${r.filePath}`, kind: 'ok' })
        return
      }
      // 浏览器降级:Blob + a.download
      const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = defaultExportName()
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setFeedback({ text: `已导出 ${all.length} 条命令`, kind: 'ok' })
    } catch (err) {
      setFeedback({ text: `导出失败: ${err instanceof Error ? err.message : '未知错误'}`, kind: 'warn' })
    }
  }

  // 解析并校验导入的 JSON 命令数组
  const parseImportText = (text: string): unknown[] => {
    let arr: unknown
    try { arr = JSON.parse(text) } catch { throw new Error('文件不是有效的 JSON 格式') }
    if (!Array.isArray(arr)) throw new Error('文件内容应为命令数组')
    for (const c of arr) {
      if (!c || (c as Command).name === undefined || (c as Command).command === undefined) {
        throw new Error('存在缺少 名称/命令 的命令')
      }
    }
    return arr
  }

  const doImportText = async (text: string) => {
    try {
      const arr = parseImportText(text)
      const res = await fetch('/api/commands/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands: arr }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '导入失败')
      setFeedback({ text: `导入成功(已覆盖,共 ${data.count} 条)`, kind: 'ok' })
      fetchCommands()
    } catch (err) {
      setFeedback({ text: `导入失败: ${err instanceof Error ? err.message : '未知错误'}`, kind: 'warn' })
    }
  }

  // 桌面:直接走原生「打开」对话框(记住上次目录);浏览器走 <input type=file>
  const importCommandsElectron = async () => {
    if (!window.serverhub) { fileInputRef.current?.click(); return }
    const r = await window.serverhub.openFile({
      filters: [{ name: '命令文件', extensions: ['txt', 'json'] }],
    })
    if (r.canceled) return
    if (r.error) { setFeedback({ text: `读取失败: ${r.error}`, kind: 'warn' }); return }
    if (r.content == null) { setFeedback({ text: '文件读取失败', kind: 'warn' }); return }
    await doImportText(r.content)
  }

  // 浏览器降级路径:<input type=file> 取到的 File 交给统一解析/导入
  const importCommands = async (file: File) => {
    try {
      const text = await file.text()
      await doImportText(text)
    } catch (err) {
      setFeedback({ text: `导入失败: ${err instanceof Error ? err.message : '未知错误'}`, kind: 'warn' })
    }
  }

  const doDelete = async () => {
    if (!deleteCmd) return
    await fetch(`/api/commands/${deleteCmd.id}`, { method: 'DELETE' })
    setDeleteCmd(null)
    setSelected(prev => { const n = new Set(prev); n.delete(deleteCmd.id); return n })
    fetchCommands()
  }

  // ========== 批量删除(勾选) ==========
  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const n = new Set(prev)
      if (n.has(id)) n.delete(id); else n.add(id)
      return n
    })
  }

  const doBatchDelete = async () => {
    for (const id of selected) {
      await fetch(`/api/commands/${id}`, { method: 'DELETE' })
    }
    setSelected(new Set())
    fetchCommands()
  }

  // ========== 删除整个命令集(某分类下的全部命令) ==========
  const startDeleteSet = (cat: string, ownerServerId: string | null) => {
    setDeleteSet({ cat, serverId: ownerServerId })
  }

  const deleteSetCount = deleteSet
    ? commands.filter(c => c.category === deleteSet.cat && (deleteSet.serverId === null ? (!c.serverId || c.serverId === 'common') : c.serverId === deleteSet.serverId)).length
    : 0

  const doDeleteSet = async () => {
    if (!deleteSet) return
    const targets = commands.filter(c =>
      c.category === deleteSet.cat &&
      (deleteSet.serverId === null ? (!c.serverId || c.serverId === 'common') : c.serverId === deleteSet.serverId))
    for (const c of targets) {
      await fetch(`/api/commands/${c.id}`, { method: 'DELETE' })
      setSelected(prev => { const n = new Set(prev); n.delete(c.id); return n })
    }
    setDeleteSet(null)
    fetchCommands()
  }

  // 重命名命令集:把该分区下该分类的所有命令改为新分类名
  const doRenameSet = async () => {
    if (!renamingSet || !renamingSet.draft.trim()) { setRenamingSet(null); return }
    const newCat = renamingSet.draft.trim()
    if (newCat === renamingSet.cat) { setRenamingSet(null); return }
    const targets = commands.filter(c =>
      c.category === renamingSet.cat &&
      (renamingSet.serverId === null ? (!c.serverId || c.serverId === 'common') : c.serverId === renamingSet.serverId))
    for (const c of targets) {
      await fetch(`/api/commands/${c.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...c, category: newCat }),
      })
    }
    const old = renamingSet.cat
    setRenamingSet(null)
    setFeedback({ text: `命令集「${CATEGORY_LABELS[old] || old}」已重命名为「${newCat}」`, kind: 'ok' })
    fetchCommands()
  }

  // ========== 拖拽:改命令集/跨分区 ==========
  const handleDrop = async (targetServerId: string | null, targetCat: string) => {
    registerDropOver(null)
    const cmd = dragCmdIdRef.current
    dragCmdIdRef.current = null
    if (!cmd) return
    const targetServerIdVal = targetServerId === null ? null : targetServerId
    const newServerId = targetServerIdVal
    const curIsCommon = !cmd.serverId || cmd.serverId === 'common'
    const curServerId = curIsCommon ? null : cmd.serverId
    // 无变化则不请求
    if (cmd.category === targetCat && curServerId === newServerId) return
    const res = await fetch(`/api/commands/${cmd.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...cmd,
        category: targetCat,
        serverId: newServerId,
      }),
    })
    if (res.ok) {
      setFeedback({ text: `已移动到「${CATEGORY_LABELS[targetCat] || targetCat}」`, kind: 'ok' })
      fetchCommands()
    }
  }

  // 同一命令集内拖拽排序:把拖动的命令移到目标行位置(整份顺序交给 /order 重排)
  const reorderCommand = async (draggedId: string, targetId: string) => {
    setDropRowId(null)
    if (draggedId === targetId) return
    const current = commands.map(c => c.id)
    const from = current.indexOf(draggedId)
    if (from < 0) return
    const next = [...current]
    next.splice(from, 1)
    let to = next.indexOf(targetId)
    if (to < 0) return
    // 拖到目标行之前
    next.splice(to, 0, draggedId)
    const res = await fetch('/api/commands/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: next }),
    })
    if (res.ok) {
      setFeedback({ text: '已调整命令顺序', kind: 'ok' })
      fetchCommands()
    }
    dragCmdIdRef.current = null
  }

  const registerDropOver = (key: string | null) => setDropOver(key)

  // ownerServerId:null=公共分区;=serverId=本服务器分区。
  // 每个分类分组是拖拽投放目标(改 category+归属)。
  const renderSection = (title: string, icon: React.ReactNode, list: Command[], ownerServerId: string | null) => {
    const partition = ownerServerId ?? 'common'
    const gs = groups(filter(list), partition)
    if (gs.length === 0) return null
    return (
      <div className="mb-2">
        <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 text-[11px] font-medium text-slate-500">
          {icon}
          {title}
          <span className="text-slate-600">({list.length})</span>
        </div>
        {gs.map(({ cat, items, expanded }) => {
          const colorClass = CATEGORY_COLORS[cat] || CATEGORY_COLORS.custom
          const dropKey = `${ownerServerId}:${cat}`
          return (
            <div
              key={cat}
              onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropOver(dropKey) }}
              onDragLeave={() => setDropOver((p) => (p === dropKey ? null : p))}
              onDrop={(e) => { e.preventDefault(); handleDrop(ownerServerId, cat) }}
              className={`group mb-1 overflow-hidden rounded-lg border bg-bg-800/50 transition-colors ${
                dropOver === dropKey ? 'border-accent-500/60 ring-1 ring-accent-500/30' : 'border-slate-800/70'
              }`}
            >
              <div className="w-full flex items-center gap-1 px-2.5 py-1.5 text-xs">
                {renamingSet && renamingSet.cat === cat && renamingSet.serverId === ownerServerId ? (
                  <input
                    autoFocus
                    value={renamingSet.draft}
                    onChange={e => setRenamingSet(r => r ? { ...r, draft: e.target.value } : r)}
                    onBlur={doRenameSet}
                    onKeyDown={e => {
                      if (e.key === 'Enter') doRenameSet()
                      if (e.key === 'Escape') setRenamingSet(null)
                    }}
                    onClick={e => e.stopPropagation()}
                    className="flex-1 min-w-0 bg-bg-900 border border-accent-500/40 rounded px-1.5 py-0.5 text-xs text-accent-300 outline-none"
                  />
                ) : (
                  <button onClick={() => toggleGroup(`${partition}:${cat}`)} className="flex-1 flex items-center gap-2 hover:bg-bg-700/40 rounded min-w-0">
                    {expanded ? <ChevronDown size={13} className="text-slate-500" /> : <ChevronRight size={13} className="text-slate-500" />}
                    <Tag size={12} className={colorClass.split(' ')[0]} />
                    <span className="font-medium text-slate-300 truncate">{CATEGORY_LABELS[cat] || cat}</span>
                    <span className="text-slate-500">({items.length})</span>
                  </button>
                )}
                <span className="flex-1" />
                <button
                  onClick={() => setRenamingSet({ cat, serverId: ownerServerId, draft: cat })}
                  className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400"
                  title="重命名命令集"
                >
                  <Pencil size={12} />
                </button>
                <button
                  onClick={() => startDeleteSet(cat, ownerServerId)}
                  className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-red-400"
                  title="删除整个命令集"
                >
                  <Trash2 size={12} />
                </button>
              </div>
              {expanded && (
                <div className="border-t border-slate-800/50 divide-y divide-slate-800/40">
                  {items.map(cmd => (
                    <div
                      key={cmd.id}
                      onDragOver={(e) => {
                        // 同一命令集内拖拽:允许放到某条命令上来调整顺序
                        const cur = dragCmdIdRef.current
                        if (cur && cur.id !== cmd.id && cur.category === cmd.category && curServerOf(cur) === curServerOf(cmd)) {
                          e.preventDefault()
                          e.dataTransfer.dropEffect = 'move'
                          setDropRowId(cmd.id)
                        }
                      }}
                      onDragLeave={() => setDropRowId(p => (p === cmd.id ? null : p))}
                      onDrop={(e) => {
                        e.stopPropagation()
                        e.preventDefault()
                        const cur = dragCmdIdRef.current
                        if (!cur || cur.id === cmd.id) { setDropOver(null); setDropRowId(null); return }
                        if (cur.category === cmd.category && curServerOf(cur) === curServerOf(cmd)) {
                          reorderCommand(cur.id, cmd.id)
                        } else {
                          // 跨命令集:当作移动到该命令所在命令集
                          handleDrop(curServerOf(cmd), cmd.category)
                        }
                      }}
                      className={`group flex items-center gap-1.5 px-2 py-1.5 text-xs ${
                        dropRowId === cmd.id
                          ? 'bg-accent-500/10 outline outline-1 outline-accent-500/50 relative'
                          : 'hover:bg-bg-700/30'
                      }`}
                    >
                      {/* 删除模式下显示勾选框,默认隐藏 */}
                      {deleteMode && (
                        <input
                          type="checkbox"
                          checked={selected.has(cmd.id)}
                          onChange={() => toggleSelect(cmd.id)}
                          className="accent-accent-500 flex-shrink-0"
                          title="勾选(可批量删除)"
                        />
                      )}
                      <span
                        draggable
                        onDragStart={(e) => {
                          dragCmdIdRef.current = cmd
                          e.dataTransfer.effectAllowed = 'move'
                          try { e.dataTransfer.setData('text/plain', cmd.id) } catch {}
                        }}
                        onDragEnd={() => { setDropOver(null) }}
                        className="opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing text-slate-500 flex-shrink-0"
                        title="拖到其他命令集"
                      >
                        <GripVertical size={12} />
                      </span>
                      <button
                        onClick={() => runCommand(cmd)}
                        className="flex-1 flex items-center gap-2 min-w-0 text-left"
                        title={cmd.command}
                      >
                        <Play size={11} className="text-accent-400 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                        {/* 名称最重要:一行显示、完整不截断,占据优先宽度 */}
                        <span className="text-slate-200 whitespace-nowrap">{cmd.name}</span>
                        {/* 详情缩略显示:随侧栏宽度自适应,空间不足时自然被挤掉/省略 */}
                        <span className="text-slate-500 truncate font-mono hidden md:inline flex-1 min-w-0">{cmd.command}</span>
                      </button>
                      {!deleteMode && (
                        <>
                          <button
                            onClick={() => duplicateCommand(cmd)}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-bg-600 text-slate-400"
                            title="一键复制命令(名称自动递增)"
                          >
                            <Copy size={12} />
                          </button>
                          <button
                            onClick={() => { setEditingCmd(cmd); setShowModal(true) }}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-bg-600 text-slate-400"
                            title="编辑"
                          >
                            <Edit2 size={12} />
                          </button>
                          <button
                            onClick={() => setDeleteCmd(cmd)}
                            className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-bg-600 text-red-400"
                            title="删除"
                          >
                            <Trash2 size={12} />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <>
      {/* 折叠面板:内嵌到侧栏时占满高度、无浮动卡片样式,仅金色分隔线 */}
      <div className={embedded ? 'flex flex-col min-h-0 flex-1 border-t border-slate-800/70' : 'border-b border-slate-800 bg-bg-800/60'}>
        <div className="flex items-center gap-2 px-3 py-1.5">
          <button
            onClick={() => setOpen(!open)}
            className="flex items-center gap-1.5 text-xs font-medium text-slate-300 hover:text-accent-400 transition-colors"
          >
            {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <TerminalSquare size={14} className="text-accent-400" />
            命令
            <span className="text-slate-500">
              {localMode
                ? `(本地命令 ${localCommands.length})`
                : `(公共 ${commands.filter(isCommon).length} · 专属 ${commands.filter(c => c.serverId === serverIdValue).length})`}
            </span>
          </button>
          <span className="flex-1" />
          {feedback && (
            <span className={`text-[11px] px-2 py-0.5 rounded-full border ${
              feedback.kind === 'ok'
                ? 'text-accent-400 bg-accent-500/10 border-accent-500/20'
                : 'text-amber-400 bg-amber-500/10 border-amber-500/20'
            }`}>
              {feedback.text}
            </span>
          )}
          {open && !deleteMode && (
            <button
              onClick={() => { setEditingCmd(null); setShowModal(true) }}
              className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400"
              title="添加命令"
            >
              <Plus size={14} />
            </button>
          )}
          {open && !deleteMode && (
            <button
              onClick={exportCommands}
              className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400"
              title="导出命令为 .txt"
            >
              <Download size={14} />
            </button>
          )}
          {open && !deleteMode && (
            <>
              <button
                onClick={importCommandsElectron}
                className="p-1 rounded hover:bg-bg-600 text-slate-400 hover:text-accent-400"
                title="从 .txt 导入命令(覆盖)"
              >
                <Upload size={14} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,application/json,text/plain"
                className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) importCommands(f); e.target.value = '' }}
              />
            </>
          )}
          {/* 删除模式开关:进入后逐条勾选,可批量删除 */}
          {open && (
            <button
              onClick={() => { setDeleteMode(m => !m); if (!deleteMode) setSelected(new Set()) }}
              className={`p-1 rounded hover:bg-bg-600 ${deleteMode ? 'text-red-400 bg-red-500/10' : 'text-slate-400 hover:text-red-400'}`}
              title={deleteMode ? '退出删除模式' : '进入删除模式(勾选批量删除)'}
            >
              <Trash2 size={14} />
            </button>
          )}
          {open && (
            <Search size={13} className="text-slate-500" />
          )}
          {open && (
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜索命令..."
              className="w-32 bg-bg-900 border border-slate-700 rounded px-2 py-0.5 text-[11px] text-slate-200 focus:outline-none focus:border-accent-500/50"
            />
          )}
        </div>

        {/* 删除模式/批量删除工具条:进入删除模式或已勾选时显示 */}
        {open && (deleteMode || selected.size > 0) && (
          <div className={`flex items-center gap-2 px-3 py-1 border-b border-slate-800 ${deleteMode ? 'bg-red-500/5' : 'bg-accent-500/5'}`}>
            <span className="text-[11px] text-slate-300">
              {deleteMode
                ? <><span className="text-red-400 font-semibold">删除模式</span> · 勾选要删除的命令</>
                : <>已选 <span className="text-accent-400 font-semibold">{selected.size}</span> 项</>}
            </span>
            <span className="flex-1" />
            {selected.size > 0 && (
              <button
                onClick={() => setBatchConfirm(true)}
                className="btn-danger !py-0.5 !px-2 !text-[11px]"
              >
                删除选中({selected.size})
              </button>
            )}
            <button
              onClick={() => { setDeleteMode(false); setSelected(new Set()) }}
              className="text-[11px] text-slate-400 hover:text-slate-200 px-1"
            >
              {deleteMode ? '完成' : '取消选择'}
            </button>
          </div>
        )}

        {open && (
          <div className={embedded ? 'flex-1 min-h-0 overflow-y-auto px-1 pb-2' : 'px-2 pb-2 max-h-64 overflow-y-auto'}>
            {commands.length === 0 && (
              <div className="text-xs text-slate-500 px-2 py-4 text-center">
                还没有命令,点右上角 + 添加
              </div>
            )}
            {localMode ? (
              renderSection('本地命令', <TerminalSquare size={11} className="text-accent-400" />, localCommands, null)
            ) : (
              <>
                {renderSection('公共命令', <Globe size={11} className="text-accent-400" />, commonCommands, null)}
                {renderSection('本服务器命令', <ServerIcon size={11} className="text-sky-400" />, serverCommands, serverIdValue)}
              </>
            )}
          </div>
        )}
      </div>

      {/* 新增/编辑弹窗 */}
      {showModal && (
        <CommandModal
          serverId={serverIdValue}
          command={editingCmd}
          categories={categories}
          localMode={localMode}
          onSave={handleSave}
          onClose={() => { setShowModal(false); setEditingCmd(null) }}
        />
      )}

      {/* 删除确认 */}
      <ConfirmDialog
        open={!!deleteCmd}
        title="删除命令"
        message={deleteCmd ? `确定删除命令「${deleteCmd.name}」吗?` : ''}
        danger={false}
        confirmText="删除"
        onConfirm={doDelete}
        onCancel={() => setDeleteCmd(null)}
      />

      {/* 批量删除确认 */}
      <ConfirmDialog
        open={batchConfirm}
        title="批量删除"
        message={`确定删除选中的 ${selected.size} 条命令吗?`}
        danger
        typeText={`${selected.size}`}
        confirmText="批量删除"
        onConfirm={() => { setBatchConfirm(false); doBatchDelete() }}
        onCancel={() => setBatchConfirm(false)}
      />

      {/* 删除命令集确认 */}
      <ConfirmDialog
        open={!!deleteSet}
        title="删除命令集"
        message={deleteSet ? `确定删除命令集「${CATEGORY_LABELS[deleteSet.cat] || deleteSet.cat}」下的 ${deleteSetCount} 条命令吗?\n此操作不可恢复!` : ''}
        danger
        typeText={CATEGORY_LABELS[deleteSet?.cat || ''] || deleteSet?.cat || ''}
        confirmText="删除该命令集"
        onConfirm={doDeleteSet}
        onCancel={() => setDeleteSet(null)}
      />
    </>
  )
}

// ========== 命令编辑弹窗(支持归属:公共 / 本服务器) ==========
function CommandModal({ serverId, command, categories, onSave, onClose, localMode = false }: {
  serverId: string | null
  command: Command | null
  /** 已存在的命令集(分类),下拉据此展示 */
  categories: string[]
  localMode?: boolean
  onSave: (cmd: Command) => void
  onClose: () => void
}) {
  const [name, setName] = useState(command?.name || '')
  const [cmdText, setCmdText] = useState(command?.command || '')
  const [category, setCategory] = useState(command?.category || 'custom')
  const [description, setDescription] = useState(command?.description || '')
  // 归属:undefined=公共,serverId=专属;本地终端模式强制公共
  const [ownership, setOwnership] = useState<string>(localMode ? 'common' : (command ? (command.serverId && command.serverId !== 'common' ? 'server' : 'common') : 'server'))
  // "新建命令集"状态:creatingCat 为 true 时显示输入框
  const [creatingCat, setCreatingCat] = useState(false)
  const [newCat, setNewCat] = useState('')
  // 执行方式:true=直接执行(自动带回车),false=仅敲入命令待用户按回车
  const [autoRun, setAutoRun] = useState(command ? command.autoRun !== false : true)

  const selectCategory = (val: string) => {
    if (val === '__new__') {
      setCreatingCat(true)
      setCategory('')
    } else {
      setCreatingCat(false)
      setCategory(val)
    }
  }

  const effectiveCategory = creatingCat ? (newCat.trim() || '__new__') : category

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const finalCat = creatingCat ? (newCat.trim() || 'custom') : category
    onSave({
      id: command?.id || `cmd-${Date.now()}`,
      name,
      command: cmdText,
      category: finalCat,
      description,
      // 本地终端模式:命令属于"本地命令集"(scope='local'),与远程命令集互不共享
      serverId: localMode || ownership === 'common' ? null : serverId,
      scope: localMode ? 'local' : undefined,
      autoRun,
    })
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center animate-fade-in" onClick={onClose}>
      <div className="w-[480px] bg-bg-800 border border-slate-700 rounded-2xl shadow-2xl animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="text-base font-semibold text-slate-200">{command ? '编辑命令' : '添加命令'}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-bg-600 text-slate-400">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div>
            <label className="label">命令名称 *</label>
            <input className="input" placeholder="如：查看内存" required value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">命令内容 *</label>
            <textarea
              className="input font-mono"
              placeholder="free -h"
              required
              rows={3}
              value={cmdText}
              onChange={e => setCmdText(e.target.value)}
            />
          </div>
          <div>
            <label className="label">归属</label>
            <div className="grid grid-cols-2 gap-2">
              {localMode ? (
                <div className="btn text-xs justify-center !bg-accent-500/15 !text-accent-400 !border-accent-500/30">
                  <TerminalSquare size={13} /> 本地终端命令
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setOwnership('common')}
                    className={`btn text-xs justify-center ${ownership === 'common' ? '!bg-accent-500/15 !text-accent-400 !border-accent-500/30' : ''}`}
                  >
                    <Globe size={13} /> 公共命令
                  </button>
                  <button
                    type="button"
                    onClick={() => setOwnership('server')}
                    className={`btn text-xs justify-center ${ownership === 'server' ? '!bg-accent-500/15 !text-accent-400 !border-accent-500/30' : ''}`}
                  >
                    <ServerIcon size={13} /> 本服务器
                  </button>
                </>
              )}
            </div>
          </div>
          <div>
            <label className="label">执行方式</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setAutoRun(true)}
                className={`btn text-xs justify-center gap-1 ${autoRun ? '!bg-accent-500/15 !text-accent-400 !border-accent-500/30' : ''}`}
              >
                <Zap size={13} /> 直接执行
              </button>
              <button
                type="button"
                onClick={() => setAutoRun(false)}
                className={`btn text-xs justify-center gap-1 ${!autoRun ? '!bg-accent-500/15 !text-accent-400 !border-accent-500/30' : ''}`}
              >
                <CornerDownLeft size={13} /> 手动按回车
              </button>
            </div>
            <p className="text-[11px] text-slate-500 mt-1">直接执行=点击即运行;手动按回车=仅把命令敲进终端,由你确认后按 Enter 运行</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">{creatingCat ? '新命令集名' : '命令集(分类)'}</label>
              {creatingCat ? (
                <input
                  autoFocus
                  className="input"
                  placeholder="输入新命令集名称"
                  value={newCat}
                  onChange={e => setNewCat(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Escape') selectCategory('custom') }}
                />
              ) : (
                <select
                  className="input"
                  value={effectiveCategory === '__new__' ? '__new__' : category}
                  onChange={e => selectCategory(e.target.value)}
                >
                  {/* 展示当前实际存在的命令集:已删除的不出现,新建的即时可选 */}
                  {Array.from(new Set([...categories, category])).map(cat => (
                    <option key={cat} value={cat}>{CATEGORY_LABELS[cat] || cat}</option>
                  ))}
                  <option value="__new__">＋ 新建命令集…</option>
                </select>
              )}
            </div>
            <div>
              <label className="label">描述</label>
              <input className="input" placeholder="可选" value={description} onChange={e => setDescription(e.target.value)} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost" >取消</button>
            <button type="submit" className="btn-primary">{command ? '保存' : '添加'}</button>
          </div>
        </form>
      </div>
    </div>
  )
}
