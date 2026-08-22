export interface Server {
  id: string
  name: string
  host: string
  port: number
  username: string
  password: string
  createdAt?: string
}

export interface Command {
  id: string
  name: string
  command: string
  category: string
  description: string
  /** 为空/undefined/'common' 表示公共命令;否则为该服务器专属 */
  serverId?: string | null
  /** 命令集归属:缺省/'server'=远程命令集;'local'=本地终端命令集(两套互不共享) */
  scope?: 'local' | 'server'
  /** 执行方式:缺省/true=直接执行(自动带回车);false=仅敲入命令,由用户按回车执行 */
  autoRun?: boolean
}

/** 路径收藏夹:属于某台服务器,点击直达 */
export interface Bookmark {
  id: string
  serverId: string
  path: string
  name: string
  createdAt?: string
}

/** 传输任务(上传/下载,存于模块级 store 以跨标签保持) */
export interface Transfer {
  id: string
  serverId: string
  fileName: string
  type: 'upload' | 'download'
  status: 'running' | 'done' | 'error' | 'cancelled'
  /** 0-100;未知大小时为 null(下载无 Content-Length) */
  progress: number | null
  error?: string
}

// 终端会话:属于某个服务器,一条会话 = 一条 WS = 一个远端 shell
// local=true 表示"本地终端"(本机 PowerShell),不属服务器,用 cwd 指定工作目录
export interface Session {
  id: string
  serverId: string
  name: string
  createdAt?: string
  /** 本地终端工作目录(远程会话无此字段) */
  cwd?: string
  /** true = 本机 PowerShell 终端(非 SSH 会话) */
  local?: boolean
}

// 本地目录收藏:侧栏"本地终端"可一键在指定目录开终端
export interface LocalFavorite {
  id: string
  path: string
  name?: string
}

// 每台服务器会话上限。ssh 默认 MaxSessions=10 限制的是"单条连接"的并发通道数;
// 后端已改为"多连接分摊"(每条连接≤8 个 shell),所以每服务器可开更多会话。
export const MAX_SESSIONS_PER_SERVER = 20

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected'

export interface FileEntry {
  filename: string
  longname: string
  type: string
  size: number
  mode: number
  mtime: number
  isDirectory: boolean
  isFile: boolean
  isSymlink: boolean
}

export const CATEGORY_LABELS: Record<string, string> = {
  system: '系统',
  process: '进程',
  network: '网络',
  file: '文件',
  log: '日志',
  docker: 'Docker',
  dev: '开发环境',
  custom: '自定义',
}

export const CATEGORY_COLORS: Record<string, string> = {
  system: 'text-cyan-400 bg-cyan-500/10 border-cyan-500/20',
  process: 'text-amber-400 bg-amber-500/10 border-amber-500/20',
  network: 'text-violet-400 bg-violet-500/10 border-violet-500/20',
  file: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  log: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
  docker: 'text-sky-400 bg-sky-500/10 border-sky-500/20',
  dev: 'text-pink-400 bg-pink-500/10 border-pink-500/20',
  custom: 'text-slate-400 bg-slate-500/10 border-slate-500/20',
}
