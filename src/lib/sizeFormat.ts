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
