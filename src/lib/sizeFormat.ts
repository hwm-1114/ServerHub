// 文件大小显示工具:把字节数按用户选定的单位格式化,单位选择持久化到 localStorage。
// 默认单位为字节,可选 B / KB / MB / GB。

export type SizeUnit = 'B' | 'KB' | 'MB' | 'GB'

const STORAGE_KEY = 'serverhub:sizeUnit'

export const SIZE_UNITS: SizeUnit[] = ['B', 'KB', 'MB', 'GB']

// 读取当前单位(默认字节);非法值回退默认
export function getSizeUnit(): SizeUnit {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return SIZE_UNITS.includes(v as SizeUnit) ? (v as SizeUnit) : 'B'
  } catch {
    return 'B'
  }
}

export function setSizeUnit(u: SizeUnit) {
  try { localStorage.setItem(STORAGE_KEY, u) } catch {}
  // 广播给所有面板:单位偏好是全局的,但每个面板各自持有 useState,
  // 没有通知时同屏会同时显示两种单位(设备面板 1.00 MB、侧栏 1048576 B)
  try { window.dispatchEvent(new CustomEvent(UNIT_EVT, { detail: u })) } catch { /* 非浏览器环境忽略 */ }
}

const UNIT_EVT = 'serverhub:size-unit-change'

/** 订阅单位变化(直接用作 useEffect 的清理函数);返回取消订阅函数 */
export function onSizeUnitChange(fn: (u: SizeUnit) => void) {
  try {
    const handler = (e: Event) => {
      const u = (e as CustomEvent).detail
      if (SIZE_UNITS.includes(u)) fn(u)
    }
    window.addEventListener(UNIT_EVT, handler)
    return () => window.removeEventListener(UNIT_EVT, handler)
  } catch {
    return () => {}
  }
}

// 把字节数按单位格式化;目录返回 null(不显示大小)
export function formatSize(bytes: number, unit: SizeUnit, isDir: boolean): string | null {
  if (isDir) return null
  const n = Number(bytes) || 0
  switch (unit) {
    case 'GB':
      return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB'
    case 'MB':
      return (n / 1024 / 1024).toFixed(2) + ' MB'
    case 'KB':
      return (n / 1024).toFixed(1) + ' KB'
    default:
      return n + ' B'
  }
}
