import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import { initAccessToken, getAccessToken } from './lib/token'

// 首次进入:URL ?token=xxx 带入访问令牌并持久化(见 lib/token.ts)
initAccessToken()

// 全局 fetch 包装:对本站 /api 请求自动附加访问令牌头。
// 项目里大量组件直接用 fetch,逐个改造容易漏;在入口处统一包装最可靠。
if (typeof window !== 'undefined') {
  const rawFetch = window.fetch.bind(window)
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const token = getAccessToken()
    if (!token) return rawFetch(input, init)
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url)
    if (!url.startsWith('/api') && !url.includes(`${location.host}/api`)) return rawFetch(input, init)
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
    headers.set('X-ServerHub-Token', token)
    return rawFetch(input, { ...init, headers })
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
