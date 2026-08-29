# ServerHub

远程 Linux 服务器连接管理工具 —— SSH 终端、SFTP 文件管理、命令预设、本机终端、hdc 设备传输，提供 Web UI 与 Windows 桌面版。

> 为"同时照看多台 Linux 服务器"的运维/开发场景设计：多标签多会话终端、拖拽式文件互传、常用命令一键执行，全部在同一个界面里完成。

## 功能特性

### 服务器与连接管理
- 多台服务器统一管理，填入 IP / 端口 / 用户名 / 密码或私钥即可连接
- 每台服务器最多 **20 个并发会话**，多条终端连接自动分摊（连接池），通道耗尽自动自愈
- 服务器状态轮询、已连接服务器健康摘要（负载 / 内存）

### SSH 终端
- 基于 xterm.js 的完整终端体验：彩色输出、vim / htop 等 TUI 程序、鼠标选中复制、右键粘贴
- 多标签多会话：复制会话保持所在目录、从文件管理器"在当前目录打开会话"
- **完整历史查看器**：不限大小保留自连接以来的全部输出；对 AI agent（claude 等）/ vim / htop 的全屏与原地重绘输出做终端状态机重建，还原"终端实际显示过的内容"；支持导出保留颜色的 HTML
- 会话断线有限次自动重连；后台会话持续输出并做标签提醒

### 文件管理
- SFTP 目录浏览、在线预览与**在线编辑保存**（≤512KB）、递归搜索
- 上传 / 下载流式传输（内存恒定），完成后核对文件大小，**完整性校验**不合格自动清理半成品
- 内置"本机目录面板"：本机 ↔ 远程拖拽互传、批量勾选传输、失败逐文件给出原因
- 重命名 / 移动、递归新建目录、递归删除、目录收藏

### 命令预设
- 预置 18 条常用命令（系统 / 进程 / 网络 / 文件 / 日志 / Docker / 开发环境）
- 自定义命令、分类分组、拖拽排序、`autoRun` 自动执行、导入导出
- 远程与本地两套作用域

### 本机终端
- 本机 PowerShell / bash 真伪终端（ConPTY / node-pty），彩色、交互命令全支持
- **同一目录可开多个会话**，目录收藏、一键复制路径、用资源管理器打开

### hdc 设备传输（鸿蒙设备）
- 自动发现 hdc 连接的设备，多设备 `-t serial` 定向
- 设备 ↔ 本机文件收发、设备目录浏览

### 桌面版（Windows）
- Electron 桌面应用，安装即用
- 运行数据写在 `%APPDATA%\ServerHub`，与安装目录完全隔离：**覆盖升级 / 卸载均不丢失服务器与命令数据**

### 个性化
- 20 款纯 CSS 动态特效皮肤（粒子 / 光效 / 氛围），纯装饰层不拦截任何交互；跟随系统"减少动态效果"设置自动关闭

## 快速开始

### 方式一：下载安装包（推荐）

到 [Releases](https://github.com/hwm-1114/ServerHub/releases) 下载最新的 `ServerHub Setup x.x.x.exe`，双击安装即可。

### 方式二：从源码运行

环境要求：Node.js 18+；Windows 10+ / macOS / Linux（本地终端与桌面版打包在 Windows 上体验最佳）。

```bash
git clone https://github.com/hwm-1114/ServerHub.git
cd ServerHub
npm install

# 开发模式:后端(3120) + 前端(5173) 热更新
npm run dev
# 打开 http://localhost:5173
```

生产模式（构建前端后单端口 3120 提供服务）：

```bash
npm run build
npm start
# http://localhost:3120
```

Windows 桌面版开发与打包：

```bash
npm run app:dev      # 后端 + Vite + Electron 三进程热更新
# 或双击 publish.bat 一键构建桌面应用
```

## 安全须知（请务必阅读）

ServerHub 定位为**运行在本机 / 内网的个人工具**，以下几点是刻意设计，请根据自己场景判断是否适用：

- **服务器凭据（含密码）明文保存在本地数据文件中**（默认 `data/servers.json`），不加密——便于本机使用与备份。请勿在不可信的主机上运行本工具；数据目录可通过 `SERVERHUB_DATA_DIR` 重定向。
- 默认**无鉴权**（本机使用零配置）。若端口暴露给非本机访问，务必设置访问令牌：

| 环境变量 | 说明 |
|---|---|
| `PORT` | 后端监听端口（默认 3120；Electron 生产 33120） |
| `SERVERHUB_DATA_DIR` | 数据目录（默认 `./data`；Electron 生产为 `%APPDATA%/ServerHub`） |
| `SERVERHUB_TOKEN` | 设置后 REST 与 WebSocket 强制校验令牌（请求头 `X-ServerHub-Token` 或 `?token=`） |
| `SERVERHUB_CORS_ORIGIN` | 逗号分隔的来源白名单；不设置则仅允许同源 |

公网部署建议：`SERVERHUB_TOKEN` + 反向代理 + HTTPS + 服务器防火墙收紧来源 IP。

## 开发

```bash
npm test            # 一键回归:7 个离线脚本(会话隔离/20 并发/传输自愈/切换稳定/进程不崩/完整历史重建/可靠性矩阵 51 断言)
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
```

离线脚本通过伪造 ssh2 Client 与内存文件系统运行，不需要真实服务器。

### 架构一览

```
server/            Express + ws 单体后端(3120)
  ssh-manager.js     SSH 连接池(终端连接与独立文件连接隔离)+ SFTP + 数据读写
  local-exec.js      node-pty 本地终端 / 本机目录 / hdc
electron/          桌面壳(contextIsolation,生产内置后端 33120)
src/               React + Vite 前端
  components/        Terminal / FileBrowser / CommandPanel / SkinPicker ...
  lib/               TerminalBridge(跨标签终端注册表)/ TransferStore(全局传输队列)
scripts/           离线验证与压力测试脚本
```

关键设计：终端连接池与独立文件连接**严格隔离**——文件传输的通道问题绝不牵连终端会话；所有会话的终端实例常驻挂载（切换标签不断线）；传输队列跨标签存活。

## 已知边界

- Web 模式下"本机"指**运行后端的机器**；浏览器拿不到本地文件句柄，文件传输的字节级进度条需桌面版（规划中）
- 文件在线预览 / 编辑上限 512KB；每台服务器会话上限 20 个

## 许可证

本项目尚未附带开源许可证（默认保留所有权利）。如需二次分发或商用，请先与作者取得联系。
