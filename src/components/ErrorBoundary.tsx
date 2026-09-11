import { Component, ErrorInfo, ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { error: Error | null }

// 最外层错误边界:任何渲染期异常都不该让整个界面变成一片空白。
// 真实事故:后端返回非数组(如设置了 SERVERHUB_TOKEN 但浏览器没带令牌 → 401 的
// {error:'未授权'})时,Sidebar 渲染途中 servers.filter 抛 TypeError,React 18 在没有
// 错误边界的情况下会卸载整棵树 —— 用户只看到白屏,连"需要访问令牌"都看不到。
// 这里兜住并给出可操作的提示 + 重新加载按钮。
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] 界面渲染异常:', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="h-screen w-screen flex items-center justify-center bg-bg-900 p-6">
        <div className="max-w-lg w-full bg-bg-800 border border-red-500/30 rounded-2xl p-6">
          <h1 className="text-base font-semibold text-red-300 mb-2">界面出现异常</h1>
          <p className="text-xs text-slate-400 mb-3 leading-relaxed">
            页面渲染时发生错误,已阻止整个界面白屏。常见原因:后端返回了非预期的数据
            (例如设置了访问令牌 <span className="font-mono text-slate-300">SERVERHUB_TOKEN</span> 但当前地址没带
            <span className="font-mono text-slate-300"> ?token=</span>),或后端未启动。
          </p>
          <pre className="text-[11px] text-red-300/90 bg-bg-900 border border-slate-800 rounded-lg p-3 overflow-auto max-h-40 mb-4 whitespace-pre-wrap">
            {error.message}
          </pre>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={() => window.location.reload()}>重新加载</button>
            <button
              className="btn-ghost"
              onClick={() => this.setState({ error: null })}
            >
              忽略并继续
            </button>
          </div>
        </div>
      </div>
    )
  }
}
