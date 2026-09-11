// 极简跨组件事件总线(仅浏览器内、模块级):解决"本机目录列表在别处的操作后不刷新"。
// 例:设备面板批量下载到本机后,侧栏的《本机目录》列表并不知道磁盘上多了文件,
// 用户看不到新文件会以为失败并重复下载。用 CustomEvent 比层层传回调改动更小,
// 也不引入新的全局状态库。
const LOCAL_REFRESH = 'serverhub:local-refresh'
const REMOTE_REFRESH = 'serverhub:remote-refresh'
const DEVICE_REFRESH = 'serverhub:device-refresh'

/** 请求所有"本机目录列表"重新读取磁盘 */
export function requestLocalRefresh() {
  try { window.dispatchEvent(new Event(LOCAL_REFRESH)) } catch { /* 非浏览器环境忽略 */ }
}

/** 订阅上述请求;返回取消订阅函数(直接用作 useEffect 的清理函数) */
export function onLocalRefresh(fn: () => void) {
  try {
    window.addEventListener(LOCAL_REFRESH, fn)
    return () => window.removeEventListener(LOCAL_REFRESH, fn)
  } catch {
    return () => {}
  }
}

/** 请求远程文件列表重新列目录(本机面板批量上传到远程后必须调用,否则列表还是旧的) */
export function requestRemoteRefresh() {
  try { window.dispatchEvent(new Event(REMOTE_REFRESH)) } catch { /* 忽略 */ }
}

export function onRemoteRefresh(fn: () => void) {
  try {
    window.addEventListener(REMOTE_REFRESH, fn)
    return () => window.removeEventListener(REMOTE_REFRESH, fn)
  } catch {
    return () => {}
  }
}

/** 请求设备目录列表重新列目录(从侧栏上传到设备后调用) */
export function requestDeviceRefresh() {
  try { window.dispatchEvent(new Event(DEVICE_REFRESH)) } catch { /* 忽略 */ }
}

export function onDeviceRefresh(fn: () => void) {
  try {
    window.addEventListener(DEVICE_REFRESH, fn)
    return () => window.removeEventListener(DEVICE_REFRESH, fn)
  } catch {
    return () => {}
  }
}
