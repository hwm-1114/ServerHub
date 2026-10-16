import React from 'react'
import ReactDOM from 'react-dom/client'
// 字体本地化(@fontsource,随包打包):替代 index.html 里的 Google Fonts 外链,
// 离线/内网环境首屏不再阻塞等外网字体。字重与原外链一致(Inter 400/500/600/700,
// JetBrains Mono 400/500/600);中文仍按 CSS 字体栈回退系统字体,行为与之前相同。
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import App from './App'
import './index.css'
import './skins.css'
import { ErrorBoundary } from './components/ErrorBoundary'
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
    {/* 最外层兜底:渲染异常不许白屏(见 ErrorBoundary 注释) */}
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
