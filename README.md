# ServerHub - Linux 服务器管理 Web 工具

一个精美的 Web 界面工具，用于管理多台远程 Linux 服务器。支持 SSH 终端、文件浏览、命令预设三大核心功能。

## ✨ 功能特性

### 1. 服务器管理
- 填入 IP、端口、用户名、密码即可添加服务器
- 支持多台服务器同时管理
- 一键连接/断开
- 实时连接状态指示

### 2. SSH 终端
- 基于 xterm.js 的完整终端模拟
- 支持所有 shell 命令（ls -l、vim、top 等）
- 多标签页切换不同服务器
- 自动适配终端大小

### 3. 文件浏览器
- SFTP 远程目录浏览
- 显示文件权限、大小、修改时间
- 支持点击进入子目录、返回上级目录
- 在线查看文本文件内容
- 支持文件下载

### 4. 命令预设
- 预置 18 条常用命令（系统/进程/网络/文件/日志/Docker/开发环境）
- 支持自定义命令（shell、python 等）
- 按分类分组管理
- 一键执行，实时查看输出
- 支持搜索、编辑、删除

## 🚀 快速开始

### 安装

```bash
cd server-manager
npm install
```

### 开发模式

```bash
npm run dev
```

- 前端: http://localhost:5173
- 后端 API: http://localhost:3120

### 生产模式

```bash
npm run build    # 构建前端
npm start        # 启动服务
```

访问 http://localhost:3120 即可使用。

## 📁 项目结构

```
server-manager/
├── server/              # 后端 (Node.js + Express)
│   ├── index.js        # Express + WebSocket 服务
│   └── ssh-manager.js  # SSH 连接管理
├── src/                 # 前端 (React + TypeScript)
│   ├── App.tsx         # 主应用
│   ├── components/
│   │   ├── Sidebar.tsx       # 侧边栏（服务器列表）
│   │   ├── ServerModal.tsx    # 添加/编辑服务器弹窗
│   │   ├── Terminal.tsx       # SSH 终端
│   │   ├── FileBrowser.tsx    # 文件浏览器
│   │   └── CommandPresets.tsx # 命令预设面板
│   ├── types.ts        # TypeScript 类型
│   └── index.css       # 全局样式
├── data/               # 运行时数据
│   ├── servers.json    # 服务器配置
│   └── commands.json   # 命令预设
├── dist/               # 构建产物
└── package.json
```

## 🛠 技术栈

**后端:**
- Node.js + Express — HTTP API 服务
- SSH2 — SSH 连接与 SFTP 文件操作
- ws — WebSocket 实时终端通信

**前端:**
- React 18 + TypeScript — UI 框架
- Vite — 构建工具
- Tailwind CSS — 样式
- xterm.js — 终端模拟
- lucide-react — 图标库

## 📝 使用说明

1. **添加服务器**: 点击左侧"添加服务器"按钮，填入 IP、用户名、密码
2. **连接**: 点击服务器卡片上的连接按钮，或选中后在主区域点击"连接服务器"
3. **终端**: 选中服务器 → 终端标签 → 自动建立 SSH Shell 连接
4. **文件浏览**: 选中服务器 → 文件标签 → 浏览远程目录
5. **命令预设**: 选中服务器 → 命令标签 → 点击"执行"一键运行

## ⚠️ 注意事项

- 密码以明文存储在 `data/servers.json`（**有意设计**，不加密、界面明文显示）——本项目定位为本地/内网单用户工具，不做多租户隔离；请确保运行本工具的机器安全
- 若需要在不可信网络暴露端口，务必设置访问令牌：启动前配置环境变量 `SERVERHUB_TOKEN=你的令牌`，之后访问 `http://host:3120/?token=你的令牌`（浏览器会记住并自动附带；REST/WS 均强制校验）
- 可选配置 `SERVERHUB_CORS_ORIGIN`（逗号分隔的来源白名单）收敛跨域；默认仅同源
- SSH 连接超时默认 15 秒
- 终端断开后 SSH 连接保持，可重新打开终端
