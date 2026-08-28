# AGENTS.md

本文件为 ZCode/AI 编码代理在本工作区工作时的指引。

## 工作区现状（先读这一节）

源码树已从 `allfiles.md`（ServerHub v1.0.0 全量源码归档，约 10600 行）恢复到本目录（2026-08-22 完成，`.verify/restore.mjs` 为恢复脚本，可重复执行）。归档仍是查证原始实现的依据：`# 数字-分类` 大节 → `## <文件路径>` 小节；末尾附《ServerHub 功能描述》（完整功能/API/数据文件表）。

**归档本身有缺损，恢复时已修复以下 5 处**（勿从归档原样回抄这些位置）：

1. `server/index.js` 的 `POST /files/local-to-remote` 路由声明与参数解构整段丢失（照抄会导致后端无法启动）——已按 remote-to-local 对称结构补回。
2. `server/ssh-manager.js` 的 `DEFAULT_EXEC_TIMEOUT`/`MAX_EXEC_OUTPUT` 常量定义行丢失（调用 /execute 即 ReferenceError）——已按文档补回 30s / 5MB。
3. `src/components/LocalDirBrowser.tsx` 末尾多出一个 `</div>`（归档重复行，tsc 报错定位）——已删除。
4. `src/components/TransferBar.tsx` 与 `src/components/LocalTerminal.tsx` **整文件缺失**——已按文档描述 + App.tsx 接口重建（LocalTerminal 镜像 Terminal.tsx 连 `/ws/local`）。
5. `LocalDirBrowser.tsx`/`Terminal.tsx` 小节丢失闭合围栏，恢复脚本按分隔结构截取，经 tsc 验证完整。

**验证基线（2026-08-22 全部通过）**：`npx tsc --noEmit` 零错误、`npm run build` 成功、五个离线脚本（verify-sessions / verify-20-sessions / stress-transfer-stability / stress-switch-stability / stress-process-reliability）全过；真机（阿里云 Linux，sshd MaxSessions=10）18/18 冒烟通过：exec/上传下载回环/local-to-remote/双会话 WS/**20 并发会话连接池分摊**/文件操作期间终端不断线/本地 PowerShell 终端。真机冒烟脚本在 `.verify/smoke.mjs`（后端 `PORT=3199 SERVERHUB_DATA_DIR=.verify/data` 下运行，测试结束自动清理远端与服务器记录）。

**2026-08-22 缺陷修复批次（同日完成，回归全绿）**：P0 五项（dragFiles 拖目录重复+丢文件、requestPath 二次定位失效、exec 通道耗尽杀全池会话、本地终端正常退出重连、loadDir 竞态）；后端五项（删服务器清理 sessions/bookmarks、数据层容错+原子写+串行、hdc 超时 30min、上传 ~ 路径明确报错、id 防撞）；前端反馈四项（apiFetch、批量串行、满员提示）；遗留批次 A/B/C/D 六+一+三+四项（命令复制跨分区重名、分区折叠 key、拖拽半透明、传输完成后刷新、拖拽深度对称、设备列表失败清空；大文件流式另存；ls 单引号转义、WS 会话上限、pendingInitialDir 清理；**访问令牌/CORS 收敛/密码掩码+显式接口/跨平台 shell 与打开器**）。

**安全层行为（批次 D，2026-08-22；密码策略按用户要求定稿）**：设置 `SERVERHUB_TOKEN` 后 REST（`X-ServerHub-Token` 头或 `?token=`）与 WS（`?token=`）强制校验，未设置完全维持现状；`SERVERHUB_CORS_ORIGIN`（逗号分隔）设置后 CORS 收敛为白名单，默认同源；**密码保持明文存储、明文显示（用户明确要求，勿再加掩码/加密）**，需要收敛暴露面时用访问令牌；前端令牌经 URL `?token=` 首次带入存 localStorage（`src/lib/token.ts` + main.tsx 全局 fetch 包装）。

**功能补齐与增强（2026-08-22 批次 E/F/G 完成，冒烟 24/24）**：文件管理四项（重命名/移动 `POST /files/rename`、递归建目录 `POST /files/mkdir`、在线编辑保存 `PUT /files/content`【不存在即新建，均限 512KB】、递归搜索 `GET /files/search?path=&q=&maxdepth=`【find 按条目名匹配，≤2000 条】）；工程化（`npm test` 一键串跑五脚本、`npm run typecheck`、`npm run lint`【eslint 最小配置，0 error/67 warning 作改进清单】、桌面壳 app:dev 与 NSIS 出包均验证通过）；体验增强（侧栏已连接服务器 30s 健康摘要 load+内存、上传并发度 2 的队列调度、完整历史导出 HTML 保留颜色 `lib/ansiToHtml.ts`、浏览器环境 hdc 上传路径提示）。

**动态特效皮肤（2026-08-27 批次 H，v1.2.0）**：20 款纯 CSS 全屏氛围层皮肤（粒子/光效/氛围三组），侧栏 Logo 行调色板入口（`Sidebar.tsx` onOpenSkins）→ `SkinPicker.tsx` 弹窗（每卡含 `.skin-preview` 迷你实时预览）。实现在 `src/skins.css`（单文件，动画仅 transform/opacity，`@media (prefers-reduced-motion)` 自动关闭）+ `src/lib/skins.ts`（注册表/存储键 `serverhub:skin`）。全屏氛围层 `.skin-layer` 为 `pointer-events:none` 纯装饰层（z-35），**不拦截任何交互、不影响功能**；选择存 localStorage，App.tsx 按 skin!==none 挂载。已浏览器实测：应用/点击穿透/关闭特效/全新加载持久化/界面文字可读。

**本机传输可靠性修复（2026-08-28 批次 I，v1.2.1）**：本机↔远端互传与拖拽专项修复，11 项。后端：`local-to-remote`/`remote-to-local` 重构为 `runTransfer` 统一收尾——任一端出错 destroy 两端流+删半成品+`makeRespondOnce` 防双响应（旧实现读流出错写流永不 close，路由挂死成僵尸请求）；空闲 60s 无进展/总 30min 超时中止（SFTP 半开连接兜底）；完成后核对目标端大小与源端一致，不符删半成品报错（与 /files/upload 同标准）。`saveTransferState` 按文件互斥排队；`browseDirectory` 全异步（旧同步 stat 卡事件循环）。前端拖拽：`RemoteLocalPanel` 两处 `onDragOver` 改 `types` 判断（**dragover 期间 getData 恒为空**，旧实现高亮永不出现——LocalDirBrowser 早已修过此处漏改）；本机面板/本地终端列表对 DND_MIME 一律 `stopPropagation`（封闭投放区，旧实现本地文件掉在本机面板上会冒泡到根层被误上传远程并覆盖同名文件）；根层 `onDrop` 对落点在 `[data-localpanel]` 内的系统文件只提示不上传；`DownloadURL` 拖出追加 `withWsToken`；四处批量循环聚合每文件失败原因（旧 `catch{}` 只报 N/M）；拖拽含目录提示"已跳过"；批量下载完成 `refreshSignal` 通知本机面板刷新；面板关闭清空 `localPanelPath`。验证：tsc/build/lint(0 error)/离线矩阵 51 PASS（新增 R14 l2r 回环+缺失快速失败、R15 r2l 缺失+中途断流清理半成品）/真机传输冒烟 10 PASS（`.verify/transfer-smoke.mjs`）。**已知边界**：字节级进度需桌面版走 Electron IPC（Web 模式后端侧到侧拿不到浏览器文件句柄），列远期。

**桌面版升级数据保留（用户强要求，已实测）**：所有运行数据写在 `%APPDATA%/ServerHub`（Electron userData，`main.cjs` 设 `SERVERHUB_DATA_DIR`），与安装目录完全隔离；NSIS 覆盖安装只替换安装目录文件。已实测"安装→种入服务器/命令数据→覆盖重装→数据完整保留"，且 `deleteAppDataOnUninstall: false` 保证卸载也不删数据。

## 项目概述

ServerHub——远程 Linux 服务器连接管理工具（Web UI + Electron 桌面壳）：SSH 终端（xterm.js + WebSocket）、SFTP 文件浏览/双向传输、命令预设、本机 PowerShell 终端、hdc 设备文件传输。单体架构：Express + ws 后端（端口 3120）+ Vite/React 前端（端口 5173）。全部 UI 文案与代码注释为**中文**，保持中文。

恢复后的目录结构：

- `server/index.js` — Express + 唯一 WebSocketServer（按 pathname 分流 `/ws/terminal` 与 `/ws/local`），全部 REST `/api/*` 路由
- `server/ssh-manager.js` — SSH 终端连接池 + 独立文件连接 + SFTP 操作 + JSON 数据读写
- `server/local-exec.js` — node-pty 本地终端、本机目录浏览、hdc 命令
- `electron/main.cjs` + `preload.cjs` — 桌面壳（生产内置后端端口 33120；`contextIsolation: true`）
- `src/` — React 前端；核心：`App.tsx`、`components/`（Terminal、FileBrowser、CommandPanel、SessionTabs、Sidebar、TransferBar 等）、`lib/`（TerminalBridge、TransferStore）、`types.ts`
- `scripts/` — 离线验证/压力脚本（伪造 ssh2 Client，无需真服务器）
- `data/*.json` — 运行时可变状态（servers/commands/sessions/bookmarks/local-dirs/local-transfer），不是源码

## 命令（源码恢复后）

| 命令 | 用途 |
|---|---|
| `npm run dev` | 后端(nodemon:3120) + 前端(Vite:5173) 并发 |
| `npm run dev:server` / `dev:web` | 单独跑一侧 |
| `npm run build` | `vite build` → `dist/`（不构建后端） |
| `npm start` | 生产后端：有 `dist/` 才服务静态文件 + SPA fallback，不会重新构建 |
| `npm run app:dev` | Electron 开发：后端 + Vite(HMR) + electron 三并发 |
| `npm run app` | `vite build` + `electron-builder --dir` → `release/win-unpacked/` |
| `node scripts/verify-sessions.mjs` / `verify-20-sessions.mjs` | 离线断言：会话隔离 / 20 会话并发全开 |
| `node scripts/stress-transfer-stability.mjs` / `stress-switch-stability.mjs` / `stress-process-reliability.mjs` | 离线压力：传输自愈 / 切换稳定 / 进程不崩 |

无 lint/test/typecheck 脚本、无测试框架。验证手段：`npx tsc --noEmit` + `npm run build` + 上述离线脚本。

## 架构红线（改动前必读，均在 allfiles.md 有详细注释）

1. **终端连接池与独立文件连接必须隔离**：每台服务器多条终端连接（每条 ≤8 shell，自动分摊、创建串行化）；SFTP 全部走独立文件连接且每连接只复用一个 sftp 会话。通道耗尽（"channel open failure"）自愈时：终端侧重连终端连接、文件侧重连文件连接，**绝不互相牵连**——这是"传输后终端不断线"的核心设计。
2. **WS 终端协议**：消息为 JSON，`data`/`input` 双向 **base64**；type：`connected/error/data/input/resize`。只用一个 WebSocketServer 按 pathname 分流（同 HTTP server 上再建第二个 WSS 会返回 400）。
3. **终端实例永远挂载**：所有会话的 Terminal/LocalTerminal 通过 CSS `hidden` 切换显隐，**不得卸载**（卸载 = 断 WS = 杀远端 shell）。本地工作区是覆盖在远程工作区上的 `absolute inset-0` 层。Terminal 的 WS effect 依赖里**禁止**加入 `connected/connecting/active`（曾引发无限重连死循环）。
4. **上传路由必须绕过 `express.json()`**（路径含 `/files/upload` 的请求跳过解析，否则请求体被读空导致 0 字节文件）；完成信号用写流 `'close'`（Node 18+ 上 ssh2 的 `'finish'` 不可靠），完成后 `sftp.stat` 核对远端大小与 Content-Length，不一致删半成品报错。
5. **崩溃护栏**：`uncaughtException/unhandledRejection` 只记录不退出；ssh2 流必须挂 `error` 监听。
6. **node-pty**：N-API 预编译，**禁止 electron-rebuild**；electron-builder 需 `asarUnpack: ["node_modules/node-pty/**"]`（package.json 已配）。
7. **数据目录**：尊重 `SERVERHUB_DATA_DIR` 环境变量（Electron 生产指向 userData，asar 只读）；端口 Electron 生产为 33120。不要硬编码 `data/` 路径。
8. **模块级单例**：`TerminalBridge`（sessionId→注入/focus/导出注册表）与 `TransferStore`（useSyncExternalStore 传输队列，控制器在 store 不在组件）依赖"组件卸载不销毁"才能跨标签工作，勿改成组件状态。

## 约定

- UI 文案、注释**中文**；相对导入，**不用** `@/`（tsconfig 里配了但 Vite 未配且未用）。
- Tailwind 自定义色（`bg-*`/`accent-*`）在 `tailwind.config.js`；全局类（`btn-primary`、`status-*`）在 `src/index.css`。
- 拖拽跨面板传输统一 MIME `application/x-serverhub-file`（定义在 DeviceFilePanel.tsx）。
- 前端 REST 请求优先用 `src/lib/api.ts` 的 `apiFetch`（非 2xx/带 error 即抛错，勿把错误体当数据渲染）；批量传输循环必须 `await` 串行。
- Id 由后端生成：`srv-/cmd-/ses-/bm-<timestamp>`。

## 关键上限/常量

`MAX_SESSIONS_PER_SERVER=20`（前后端一致，后端强制校验）；每条终端连接 ≤8 shell；文件预览 ≤512KB；exec 30s 超时 / 5MB 输出（UTF-8 安全截断）；SSH `readyTimeout 15000` / `keepalive 30000`；密码**明文**存 `data/servers.json`（本地/内网定位，刻意不加密）。

---

## ServerHub 开发计划（依据 allfiles.md 全量内容制定）

### 已实现基线（v1.0.0，勿重复造轮子）

服务器管理（CRUD/状态轮询/私钥认证）；SSH 终端（20 会话、复制会话保持 cwd、指定目录开会话、拖拽排序、后台输出标记、导出/完整历史查看器、有限次自动重连）；SSH 连接池 + 通道耗尽自愈；文件浏览器（SFTP 列目录/预览/流式上传下载含完整性校验/递归删除/收藏夹/本地-远程双面板拖拽互传/批量勾选）；全局传输队列（进度/取消/跨标签存活）；命令预设（18 条默认、公共/专属、远程/本地两套 scope、autoRun、导入导出、拖拽排序）；本机 PowerShell 终端（ConPTY、目录收藏）；hdc 设备文件传输（多设备 `-t serial`）；Electron 桌面应用；进程级崩溃防护。

### 阶段 0：源码恢复与环境搭建 ✅（2026-08-22 完成，含 5 处归档缺损修复，见上）

### 阶段 1：基线验证 ✅（2026-08-22 完成：离线脚本全过 + 真机 18/18；桌面壳 `npm run app:dev` / `publish.bat` 出包尚未跑）

### 阶段 2：文件管理能力补齐 ✅（2026-08-22 批次 E 完成：rename/mkdir/编辑保存/递归搜索，冒烟 24/24）

现有文件 API 仅有 列表/预览/下载/上传/删除/双向互传，缺：**重命名与移动**（sftp.rename/renamePath）、**新建目录**（sftp.mkdir）、**在线编辑保存**（复用 512KB 上限，PUT content 走文件连接写流）、**递归搜索**（文件连接 exec `find`，注意 5MB 输出上限）。全部走**独立文件连接 + retryFileAfterReconnect**，UI 在 FileBrowser 工具栏/右键菜单。验收：新操作不占用终端通道（用 stress-transfer-stability 思路补一条断言）。

### 阶段 3：安全加固 ✅（2026-08-22 批次 D 完成；密码明文为定稿决策,不加密不掩码）

Web 端口无任何鉴权且 CORS 全开：增加**可选访问令牌**（env `SERVERHUB_TOKEN`，REST header + WS query 校验，未设置则维持现状）；密码存储保持明文默认、提供说明文档；CORS 收敛为同源/可配置白名单。验收：设令牌后未带令牌的请求 401，不设令牌行为不变。

### 阶段 4：工程化与跨平台 ✅（2026-08-22 完成：npm test/lint/typecheck、桌面壳验证与 NSIS 出包、跨平台 shell/打开器/path.join;linux/mac 打包目标仍按需）

离线脚本接入 `npm test`（串跑五个脚本）；补 eslint/prettier 与 npm scripts（`lint`/`typecheck`）；本地能力去 Windows 硬绑定：`powershell.exe`→按平台选 `$SHELL`、`explorer.exe`→`xdg-open`/`open`、`remote-to-local` 的 `\\` 路径拼接改 `path.join`；按需增加 electron-builder 的 linux/mac 目标。验收：`npm test` 一键回归，非 Windows 平台本地终端可用。

### 阶段 5：体验增强 ✅（2026-08-22 批次 G 完成：健康摘要/上传并发/HTML 导出/小遗留;会话持久化维持"刻意不持久化"现状,断点续传列远期）

连接健康仪表盘（复用 exec 跑 top/free 的preset）；传输队列并发度与断点续传；会话输出持久化与重启恢复（当前仅存名称，属刻意设计，改动需评估体积）；端口/主题设置界面；完整历史导出为 HTML（保留颜色）。

### 通用验收线（每个阶段）

`npx tsc --noEmit` + `npm run build` + 相关离线脚本全绿；涉及终端/传输稳定性的改动必须跑 stress 三件套；UI 文案中文；新文件操作一律走独立文件连接。
