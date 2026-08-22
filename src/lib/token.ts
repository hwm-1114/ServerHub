// 访问令牌(可选):后端设置 SERVERHUB_TOKEN 时生效。
// 首次通过 URL ?token=xxx 带入并存 localStorage,之后 REST 自动附加
// X-ServerHub-Token 头(main.tsx 的全局 fetch 包装),WS 在连接 URL 上附加。
const TOKEN_KEY = 'serverhub:token'

export function initAccessToken() {
  try {
    const q = new URLSearchParams(window.location.search).get('token')
    if (q) localStorage.setItem(TOKEN_KEY, q)
  } catch { /* localStorage 不可用则忽略(每次需带 ?token=) */ }
}

export function getAccessToken(): string {
  try { return localStorage.getItem(TOKEN_KEY) || '' } catch { return '' }
}

/** WS 连接 URL 追加令牌参数(已含 query 时用 & 拼接);无令牌原样返回 */
export function withWsToken(url: string): string {
  const t = getAccessToken()
  if (!t) return url
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t)
}
