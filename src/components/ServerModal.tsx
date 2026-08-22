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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    const result: Server = {
      id: server?.id || `srv-${Date.now()}`,
      name: name || host,
      host,
      port: Number(port) || 22,
      username,
      password: password || server?.password || '',
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
              placeholder="输入密码"
              value={password}
              onChange={e => setPassword(e.target.value)}
              {...(!server && { required: true })}
            />
          </div>

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
