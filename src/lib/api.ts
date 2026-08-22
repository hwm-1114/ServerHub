// 统一 REST 帮手:非 2xx 或响应体带非空 error 字段时抛 Error(消息用后端返回的 error),
// 调用方 catch 后 toast/notice。避免两类旧问题:失败被静默吞掉;错误响应体被当作
// 正常数据渲染(如命令列表变成 {error} 对象后 .filter 白屏)。
// 注:设备类接口成功时也会带 error:''(空串),空串不视为失败。
export async function apiFetch<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  let data: any = null
  try { data = await res.json() } catch { /* 非 JSON 响应体 */ }
  const errMsg = (data && typeof data === 'object' && typeof data.error === 'string' && data.error) ? data.error : ''
  if (!res.ok || errMsg) throw new Error(errMsg || `HTTP ${res.status}`)
  return data as T
}
