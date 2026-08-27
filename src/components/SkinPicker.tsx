import { Palette, X, Check } from 'lucide-react'
import { SKINS } from '../lib/skins'

interface Props {
  current: string
  onApply: (id: string) => void
  onClose: () => void
}

// 皮肤选择器:网格卡片,每张卡内嵌同款 CSS 动画的迷你实时预览(复用 .skin-layer)。
// 点击即应用(所见即所得),当前皮肤高亮;效果是全屏氛围层,不影响操作。
export function SkinPicker({ current, onApply, onClose }: Props) {
  const groups: Array<[string, typeof SKINS]> = [
    ['粒子', SKINS.filter(s => s.tag === '粒子')],
    ['光效', SKINS.filter(s => s.tag === '光效')],
    ['氛围', SKINS.filter(s => s.tag === '氛围')],
  ]
  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center animate-fade-in" onClick={onClose}>
      <div className="w-[720px] max-w-[94vw] max-h-[86vh] flex flex-col bg-bg-800 border border-slate-700 rounded-2xl shadow-2xl animate-slide-up" onClick={e => e.stopPropagation()}>
        {/* 标题栏 */}
        <div className="flex items-center gap-2 px-5 h-12 border-b border-slate-700 shrink-0">
          <Palette size={15} className="text-accent-400" />
          <span className="text-sm font-semibold text-slate-200">动态特效皮肤</span>
          <span className="text-[11px] text-slate-500">共 {SKINS.length} 款 · 点击卡片立即应用 · 纯装饰层,不影响任何功能</span>
          <span className="flex-1" />
          <button
            onClick={() => onApply('none')}
            className={`px-2 py-1 rounded-md text-[11px] border transition-colors ${
              current === 'none'
                ? 'text-accent-400 bg-accent-500/10 border-accent-500/30'
                : 'text-slate-400 border-slate-600 hover:text-slate-200 hover:border-slate-500'
            }`}
          >
            关闭特效
          </button>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-bg-600 text-slate-400"><X size={16} /></button>
        </div>

        {/* 皮肤网格 */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {groups.map(([label, list]) => (
            <div key={label}>
              <div className="text-[11px] text-slate-500 font-medium mb-2">{label}</div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2.5">
                {list.map(s => {
                  const active = current === s.id
                  return (
                    <button
                      key={s.id}
                      onClick={() => onApply(s.id)}
                      className={`group relative text-left rounded-xl overflow-hidden border transition-all ${
                        active
                          ? 'border-accent-500/60 ring-1 ring-accent-500/30'
                          : 'border-slate-700/70 hover:border-slate-500'
                      }`}
                      title={`${s.name} — ${s.desc}`}
                    >
                      {/* 迷你实时预览(与全屏同一套 CSS 动画) */}
                      <div className="skin-preview relative h-20 bg-bg-900">
                        <div className={`skin-layer skin-${s.id}`} aria-hidden>
                          <i /><i /><i /><i />
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 px-2.5 py-1.5 bg-bg-800/80">
                        <span className={`text-xs font-medium truncate ${active ? 'text-accent-400' : 'text-slate-300'}`}>{s.name}</span>
                        <span className="text-[10px] text-slate-600 truncate flex-1">{s.desc}</span>
                        {active && <Check size={12} className="text-accent-400 flex-shrink-0" />}
                      </div>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>

        {/* 底部说明 */}
        <div className="px-5 h-9 border-t border-slate-700 flex items-center text-[10px] text-slate-600 shrink-0">
          特效层不拦截点击与键盘(弹窗之上仍可见界面),选择自动记住 · 遵循系统"减少动态"设置
        </div>
      </div>
    </div>
  )
}
