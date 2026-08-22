// 模块级传输队列:上传/下载任务不绑定到任何组件生命周期,
// 切换标签/服务器时任务照常进行;XHR/fetch 句柄存于此处,组件卸载不取消。
// UI 通过 useTransfers() 订阅渲染。
import { useSyncExternalStore } from 'react'
import { Transfer } from '../types'
import { getAccessToken } from './token'

type Listener = () => void

const transfers = new Map<string, Transfer>()
const controllers = new Map<string, { abort: () => void }>()
const listeners = new Set<Listener>()

// 缓存快照数组:useSyncExternalStore 每次渲染都会比对 getSnapshot 的返回值,
// 若每次都返回新数组,引用一直不同,React 会判定"store 变了"从而无限重渲染
// (Maximum update depth exceeded → 页面崩溃黑屏)。因此在 emit() 时重建一次,
// 两次变更之间返回同一引用。
let snapshot: Transfer[] = []

function emit() {
  snapshot = Array.from(transfers.values())
  for (const l of listeners) l()
}

function subscribe(listener: Listener) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

function getSnapshot(): Transfer[] {
  return snapshot
}

export function useTransfers(): Transfer[] {
  return useSyncExternalStore(subscribe, getSnapshot)
}

// 等待一批传输全部离开 running(完成/失败/取消)后回调一次;返回取消订阅函数。
// 供上传方在"这批文件真正传完后"再刷新远端目录列表(替代固定 800ms 定时,
// 那样大文件未传完就刷新会缺文件,闭包捕获的旧目录也可能刷错地方)。
export function whenSettled(ids: string[], cb: () => void): () => void {
  const pending = new Set(ids)
  let done = false
  const listener: Listener = () => {
    if (done) return
    for (const id of Array.from(pending)) {
      const t = transfers.get(id)
      if (!t || t.status !== 'running') pending.delete(id)
    }
    if (pending.size === 0) {
      done = true
      listeners.delete(listener)
      cb()
    }
  }
  listeners.add(listener)
  listener() // 可能已全部完成,立即触发
  return () => { done = true; listeners.delete(listener) }
}

function update(id: string, patch: Partial<Transfer>) {
  const t = transfers.get(id)
  if (!t) return
  transfers.set(id, { ...t, ...patch })
  emit()
}

function ensureTransfer(item: Omit<Transfer, 'status' | 'progress'>) {
  const transfer: Transfer = { ...item, status: 'running', progress: 0 }
  transfers.set(item.id, transfer)
  emit()
  return item.id
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// ========== 取消 / 清理 ==========
export function cancelTransfer(id: string) {
  const ctrl = controllers.get(id)
  if (ctrl) {
    try { ctrl.abort() } catch {}
    controllers.delete(id)
  }
  update(id, { status: 'cancelled' })
}

export function clearFinishedTransfers() {
  for (const [id, t] of transfers) {
    if (t.status !== 'running') {
      transfers.delete(id)
      controllers.delete(id)
    }
  }
  emit()
}

// ========== 上传并发度调度 ==========
// 同时进行的上传最多 MAX_CONCURRENT_UPLOADS 条,超出的排队(状态仍为 running、
// 进度 0),空出槽位后按 FIFO 发送。旧实现一次性全量并发,批量上传几十个文件
// 会同时打满后端与网络。取消排队中的任务时直接标记 cancelled 不再发送。
const MAX_CONCURRENT_UPLOADS = 2
let activeUploads = 0
const uploadQueue: Array<() => void> = []

function acquireUploadSlot(run: () => void): { cancel: () => boolean } {
  if (activeUploads < MAX_CONCURRENT_UPLOADS) {
    activeUploads++
    run()
    return { cancel: () => false }
  }
  let started = false
  const queued = () => { started = true; run() }
  uploadQueue.push(queued)
  return {
    cancel: () => {
      if (started) return false
      const i = uploadQueue.indexOf(queued)
      if (i !== -1) uploadQueue.splice(i, 1)
      return true
    },
  }
}

function releaseUploadSlot() {
  activeUploads = Math.max(0, activeUploads - 1)
  const next = uploadQueue.shift()
  if (next) {
    activeUploads++
    next()
  }
}

// ========== 上传 ==========
export function startUpload(serverId: string, dir: string, file: File): string {
  const id = makeId('up')
  ensureTransfer({ id, serverId, fileName: file.name, type: 'upload' })

  const xhr = new XMLHttpRequest()
  xhr.open('POST', `/api/servers/${serverId}/files/upload?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}`)
  // XHR 不走全局 fetch 包装,访问令牌需单独附加
  const token = getAccessToken()
  if (token) xhr.setRequestHeader('X-ServerHub-Token', token)
  // 排队槽:进队等待或立即执行;取消时若仍在队列里则不发送
  const slot = acquireUploadSlot(() => { xhr.send(file) })
  controllers.set(id, { abort: () => {
    if (slot.cancel()) {
      // 排队中被取消:从未发送,直接标记取消
      controllers.delete(id)
      update(id, { status: 'cancelled' })
      return
    }
    xhr.abort()
  } })

  xhr.upload.onprogress = (e) => {
    if (e.lengthComputable) {
      update(id, { progress: Math.round((e.loaded / e.total) * 100) })
    }
  }
  xhr.onload = () => {
    releaseUploadSlot()
    let ok = xhr.status >= 200 && xhr.status < 300
    let errMsg = ''
    try {
      const data = JSON.parse(xhr.responseText)
      if (!ok) errMsg = data.error || `HTTP ${xhr.status}`
    } catch {
      errMsg = `HTTP ${xhr.status}`
    }
    if (ok) {
      controllers.delete(id)
      update(id, { status: 'done', progress: 100 })
    } else {
      controllers.delete(id)
      update(id, { status: 'error', error: errMsg })
    }
  }
  xhr.onerror = () => {
    releaseUploadSlot()
    controllers.delete(id)
    update(id, { status: 'error', error: '网络错误' })
  }
  xhr.onabort = () => {
    releaseUploadSlot()
    controllers.delete(id)
    // abort 由 cancelTransfer 触发时,状态已改为 cancelled
    const cur = transfers.get(id)
    if (cur && cur.status === 'running') update(id, { status: 'cancelled' })
  }
  return id
}

// ========== 下载 ==========
// 超过该阈值的下载优先走 File System Access API 流式落盘(弹另存为对话框,
// 边收边写、内存恒定);小文件或不支持该 API 的浏览器回退 Blob 方案。
// 旧实现把整个文件缓存在 chunks 数组里再建 Blob,GB 级下载会把标签页内存撑爆。
const STREAM_SAVE_THRESHOLD = 64 * 1024 * 1024

async function saveViaPicker(res: Response, fileName: string, total: number | null, onProgress: (n: number) => void): Promise<void> {
  const picker = (window as any).showSaveFilePicker
  if (typeof picker !== 'function') throw new Error('UNSUPPORTED')
  const handle = await picker.call(window, { suggestedName: fileName })
  const writable = await handle.createWritable()
  const reader = res.body!.getReader()
  let received = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      await writable.write(value)
      received += value.length
      if (total) onProgress(Math.min(99, Math.round((received / total) * 100)))
    }
    await writable.close()
  } catch (err) {
    try { await writable.abort() } catch { /* 句柄可能已关闭 */ }
    throw err
  }
}

export async function startDownload(serverId: string, path: string): Promise<string> {
  const fileName = decodeURIComponent(path).split('/').filter(Boolean).pop() || 'file'
  const id = makeId('dl')
  ensureTransfer({ id, serverId, fileName, type: 'download' })

  const ctrl = new AbortController()
  controllers.set(id, { abort: () => ctrl.abort() })

  try {
    const res = await fetch(`/api/servers/${serverId}/files/download?path=${encodeURIComponent(path)}`, { signal: ctrl.signal })
    if (!res.ok) {
      let errMsg = `HTTP ${res.status}`
      try { errMsg = (await res.json()).error || errMsg } catch {}
      controllers.delete(id)
      update(id, { status: 'error', error: errMsg })
      return id
    }
    const total = Number(res.headers.get('Content-Length') || 0) || null
    const reader = res.body?.getReader()
    if (!reader) throw new Error('无法读取响应流')

    // 大文件优先流式另存(取消键由 AbortController 中断 read,-picker 流会 abort)
    if (total === null || total > STREAM_SAVE_THRESHOLD) {
      try {
        await saveViaPicker(res, fileName, total, (p) => update(id, { progress: p }))
        controllers.delete(id)
        update(id, { status: 'done', progress: 100 })
        return id
      } catch (err) {
        // 用户取消选择对话框 / API 不可用:取消传输或回退 Blob 方案
        if (err instanceof Error && err.message === 'UNSUPPORTED') {
          // 落到下方 Blob 路径(响应流未消费,reader 仍可读)
        } else {
          throw err
        }
      }
    }

    const chunks: BlobPart[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value as BlobPart)
      received += value.length
      if (total) update(id, { progress: Math.min(99, Math.round((received / total) * 100)) })
    }

    const blob = new Blob(chunks)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)

    controllers.delete(id)
    update(id, { status: 'done', progress: 100 })
  } catch (err) {
    controllers.delete(id)
    const cur = transfers.get(id)
    if (cur && cur.status === 'running') {
      update(id, { status: 'error', error: err instanceof Error ? err.message : '下载失败' })
    }
  }
  return id
}
