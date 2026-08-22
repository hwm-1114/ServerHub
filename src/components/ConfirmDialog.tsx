import { useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'

interface Props {
  open: boolean
  title: string
  message: string
  /** 危险操作(如递归删除目录):需输入 typeText 才能确认,实现二次确认 */
  danger?: boolean
  typeText?: string
  confirmText?: string
  onConfirm: () => void
  onCancel: () => void
}

export function ConfirmDialog({ open, title, message, danger = false, typeText = '', confirmText = '确认删除', onConfirm, onCancel }: Props) {
  const [typed, setTyped] = useState('')
  const canConfirm = !danger || (typed.trim() === typeText)

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center animate-fade-in" onClick={onCancel}>
      <div className="w-[400px] bg-bg-800 border border-slate-700 rounded-2xl shadow-2xl animate-slide-up" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
            {danger && <AlertTriangle size={16} className="text-red-400" />}
            {title}
          </h2>
          <button onClick={onCancel} className="p-1 rounded-lg hover:bg-bg-600 text-slate-400">
            <X size={16} />
          </button>
        </div>
        <div className="px-5 py-4">
          <p className={`text-sm leading-relaxed whitespace-pre-wrap ${danger ? 'text-red-300/90' : 'text-slate-400'}`}>{message}</p>
          {danger && (
            <div className="mt-4">
              <label className="text-xs text-slate-500 block mb-1.5">
                此操作不可恢复。输入 <span className="text-red-400 font-mono">{typeText}</span> 以确认:
              </label>
              <input
                autoFocus
                className="input font-mono"
                value={typed}
                onChange={e => setTyped(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && canConfirm) onConfirm() }}
                placeholder={typeText}
              />
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-slate-700">
          <button onClick={onCancel} className="btn-ghost">取消</button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className={danger
              ? 'btn-danger disabled:opacity-40 disabled:cursor-not-allowed'
              : 'btn-primary'}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
