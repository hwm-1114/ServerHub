import { useState } from 'react'
import { Server } from '../types'
import { X } from 'lucide-react'

interface Props {
  server: Server | null
  onSave: (server: Server) => void
  onClose: () => void
}

export function ServerModal({ server, onSave, onClose }: Props) {
  const [name, setName] = useState(server?.name || '')
  const [host, setHost] = useState(server?.host || '')
  const [port, setPort] = useState<string>(String(server?.port || 22))
  const [username, setUsername] = useState(server?.username || 'root')
  // 密码明文存储、明文显示(本地/内网工具定位,刻意设计)
  const [password, setPassword] = useState(server?.password || '')
  // 私钥(PEM 全文,可选):后端 getServerConfig 在有 privateKey 时只用私钥、忽略密码。
  // 旧界面完全没有这个字段,而密码又是 required —— 想用密钥登录的服务器根本建不出来。
  const [privateKey, setPrivateKey] = useState(server?.privateKey || '')
  const [error, setError] = useState('')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const portNum = Number(port)
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      setError('端口需为 1-65535 的整数')
      return
    }
    // 主机/用户名去掉首尾空白:从文档里粘贴常带空格,直接存会导致连接失败且报错难懂
    const h = host.trim()
    const u = username.trim()
    if (!h || !u) { setError('IP 地址与用户名不能为空'); return }
    if (!password && !privateKey.trim()) {
      setError('请填写密码,或粘贴私钥(二者至少填一个)')
      return
    }
    setError('')
    const result: Server = {
      id: server?.id || `srv-${Date.now()}`,
      name: name.trim() || h,
      host: h,
      port: portNum,
      username: u,
      // 密码明文存储、明文编辑:保存用户输入的原值(含空字符串)。
      // 不能再回退到 server?.password —— 那会让"清空密码"变成静默保留旧密码。
      // 编辑时输入框已预填现有明文密码,不动它即为保留。
      password,
      // 私钥:空串表示"清掉私钥"(回到密码认证)
      privateKey: privateKey.trim(),
    }
    if (server?.createdAt) result.createdAt = server.createdAt
    onSave(result)
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center animate-fade-in"
      onClick={onClose}
    >
      <div
        className="w-[440px] bg-bg-800 border border-slate-700 rounded-2xl shadow-2xl animate-slide-up"
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700">
          <h2 className="text-base font-semibold text-slate-200">
            {server ? '编辑服务器' : '添加服务器'}
          </h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-bg-600 text-slate-400">
            <X size={18} />
          </button>
        </div>

        {/* 表单 */}
        <form onSubmit={handleSubmit} className="px-6 py-5 space-y-4">
          <div>
            <label className="label">名称（可选）</label>
            <input
              className="input"
              placeholder="如：生产服务器-01"
              value={name}
              onChange={e => setName(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2">
              <label className="label">IP 地址 *</label>
              <input
                className="input"
                placeholder="192.168.1.100"
                required
                value={host}
                onChange={e => setHost(e.target.value)}
              />
            </div>
            <div>
              <label className="label">端口</label>
              <input
                className="input"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={e => setPort(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="label">用户名 *</label>
            <input
              className="input"
              placeholder="root"
              required
              value={username}
              onChange={e => setUsername(e.target.value)}
            />
          </div>

          <div>
            <label className="label">密码</label>
            <input
              className="input font-mono"
              type="text"
              placeholder="输入密码(用私钥认证时可留空)"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>

          <div>
            <label className="label">私钥(可选,粘贴 PEM 全文)</label>
            <textarea
              className="input font-mono text-[11px] h-24 resize-y"
              placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----'}
              value={privateKey}
              onChange={e => setPrivateKey(e.target.value)}
              spellCheck={false}
            />
            <p className="text-[11px] text-slate-500 mt-1">填了私钥则只用私钥认证(忽略上面的密码);清空即回到密码认证。</p>
          </div>

          {error && (
            <div className="px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-xs text-red-300">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-ghost">取消</button>
            <button type="submit" className="btn-primary">
              {server ? '保存' : '添加'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
