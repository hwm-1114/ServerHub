import { Upload, Download, Loader2, Check, AlertTriangle, Ban, Trash2, X } from 'lucide-react'
import { useTransfers, cancelTransfer, clearFinishedTransfers } from '../lib/TransferStore'
import { Transfer } from '../types'

interface Props {
  /** 传输记录里只有 serverId,展示时换成人可读的服务器名 */
  serverNameById: (id: string) => string
}

// 单条传输的状态图标:运行(转圈)/完成(✓)/失败(⚠)/取消(⊘)
function StatusIcon({ t }: { t: Transfer }) {
  if (t.status === 'running') return <Loader2 size={12} className="animate-spin text-accent-400 flex-shrink-0" />
  if (t.status === 'done') return <Check size={12} className="text-emerald-400 flex-shrink-0" />
  if (t.status === 'error') return <AlertTriangle size={12} className="text-red-400 flex-shrink-0" />
  return <Ban size={12} className="text-slate-500 flex-shrink-0" />
}

// 全局传输条:常驻主区底部,渲染模块级 TransferStore 中的任务队列。
// 队列与组件生命周期解耦(控制器在 store),切换标签/服务器时传输不中断;
// 队列为空时整体不渲染。
export function TransferBar({ serverNameById }: Props) {
  const transfers = useTransfers()
  if (transfers.length === 0) return null

  const running = transfers.filter(t => t.status === 'running').length
  const finished = transfers.length - running

  return (
    <div className="shrink-0 border-t border-slate-800 bg-bg-800/60 backdrop-blur">
      {/* 头部:标题 + 一键清除已完成/失败/取消的记录 */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <div className="flex items-center gap-2 text-[11px] text-slate-400">
          <span className="font-medium">传输任务</span>
          <span className="text-slate-600">
            {transfers.length} 项{running > 0 ? ` · ${running} 进行中` : ''}
          </span>
        </div>
        {finished > 0 && (
          <button
            onClick={() => clearFinishedTransfers()}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] text-slate-500 hover:text-slate-300 hover:bg-bg-600 transition-colors"
            title="清除所有已完成/失败/取消的传输记录"
          >
            <Trash2 size={11} /> 清除记录
          </button>
        )}
      </div>

      {/* 任务列表 */}
      <div className="max-h-32 overflow-y-auto px-3 pb-1.5 space-y-1">
        {transfers.map(t => (
          <div key={t.id} className="flex items-center gap-2 text-[11px] min-w-0">
            {t.type === 'upload'
              ? <Upload size={12} className="text-sky-400/80 flex-shrink-0" />
              : <Download size={12} className="text-violet-400/80 flex-shrink-0" />}
            <StatusIcon t={t} />
            <span className="truncate max-w-[12rem] text-slate-300" title={t.fileName}>{t.fileName}</span>
            <span className="truncate text-slate-600 hidden sm:inline" title={serverNameById(t.serverId)}>
              → {serverNameById(t.serverId)}
            </span>

            <div className="flex-1 min-w-[3rem]">
              {t.status === 'running' && (
                t.progress != null ? (
                  <div className="flex items-center gap-1.5">
                    <div className="flex-1 h-1 rounded bg-bg-600 overflow-hidden">
                      <div className="h-full bg-accent-500/70 rounded transition-all" style={{ width: `${t.progress}%` }} />
                    </div>
                    <span className="text-slate-500 w-7 text-right tabular-nums">{t.progress}%</span>
                  </div>
                ) : (
                  // 无 Content-Length 的下载无法计算百分比,显示省略号
                  <span className="text-slate-600">…</span>
                )
              )}
              {t.status === 'done' && <span className="text-emerald-400/80">完成</span>}
              {t.status === 'error' && (
                <span className="truncate text-red-400/90" title={t.error || '传输失败'}>{t.error || '传输失败'}</span>
              )}
              {t.status === 'cancelled' && <span className="text-slate-600">已取消</span>}
            </div>

            {/* 进行中的任务可取消(中止 XHR/AbortController,不删除记录) */}
            {t.status === 'running' ? (
              <button
                onClick={() => cancelTransfer(t.id)}
                className="p-0.5 rounded text-slate-500 hover:text-red-400 hover:bg-bg-600 transition-colors flex-shrink-0"
                title="取消该传输"
              >
                <X size={12} />
              </button>
            ) : (
              <span className="w-[18px] flex-shrink-0" />
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
