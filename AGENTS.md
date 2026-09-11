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

**验证基线（2026-08-22 全部通过）**：`npx tsc --noEmit` 零错误、`npm run build` 成功、五个离线脚本（verify-sessions / verify-20-sessions / stress-transfer-stability / stress-switch-stability / stress-process-reliability）全过；真机（Linux，sshd MaxSessions=10）18/18 冒烟通过：exec/上传下载回环/local-to-remote/双会话 WS/**20 并发会话连接池分摊**/文件操作期间终端不断线/本地 PowerShell 终端。真机冒烟脚本在 `.verify/smoke.mjs`（后端 `PORT=3199 SERVERHUB_DATA_DIR=.verify/data` 下运行，测试结束自动清理远端与服务器记录）。

**2026-08-22 缺陷修复批次（同日完成，回归全绿）**：P0 五项（dragFiles 拖目录重复+丢文件、requestPath 二次定位失效、exec 通道耗尽杀全池会话、本地终端正常退出重连、loadDir 竞态）；后端五项（删服务器清理 sessions/bookmarks、数据层容错+原子写+串行、hdc 超时 30min、上传 ~ 路径明确报错、id 防撞）；前端反馈四项（apiFetch、批量串行、满员提示）；遗留批次 A/B/C/D 六+一+三+四项（命令复制跨分区重名、分区折叠 key、拖拽半透明、传输完成后刷新、拖拽深度对称、设备列表失败清空；大文件流式另存；ls 单引号转义、WS 会话上限、pendingInitialDir 清理；**访问令牌/CORS 收敛/密码掩码+显式接口/跨平台 shell 与打开器**）。

**安全层行为（批次 D，2026-08-22；密码策略按用户要求定稿）**：设置 `SERVERHUB_TOKEN` 后 REST（`X-ServerHub-Token` 头或 `?token=`）与 WS（`?token=`）强制校验，未设置完全维持现状；`SERVERHUB_CORS_ORIGIN`（逗号分隔）设置后 CORS 收敛为白名单，默认同源；**密码保持明文存储、明文显示（用户明确要求，勿再加掩码/加密）**，需要收敛暴露面时用访问令牌；前端令牌经 URL `?token=` 首次带入存 localStorage（`src/lib/token.ts` + main.tsx 全局 fetch 包装）。

**功能补齐与增强（2026-08-22 批次 E/F/G 完成，冒烟 24/24）**：文件管理四项（重命名/移动 `POST /files/rename`、递归建目录 `POST /files/mkdir`、在线编辑保存 `PUT /files/content`【不存在即新建，均限 512KB】、递归搜索 `GET /files/search?path=&q=&maxdepth=`【find 按条目名匹配，≤2000 条】）；工程化（`npm test` 一键串跑五脚本、`npm run typecheck`、`npm run lint`【eslint 最小配置，0 error/67 warning 作改进清单】、桌面壳 app:dev 与 NSIS 出包均验证通过）；体验增强（侧栏已连接服务器 30s 健康摘要 load+内存、上传并发度 2 的队列调度、完整历史导出 HTML 保留颜色 `lib/ansiToHtml.ts`、浏览器环境 hdc 上传路径提示）。

**动态特效皮肤（2026-08-27 批次 H，v1.2.0）**：20 款纯 CSS 全屏氛围层皮肤（粒子/光效/氛围三组），侧栏 Logo 行调色板入口（`Sidebar.tsx` onOpenSkins）→ `SkinPicker.tsx` 弹窗（每卡含 `.skin-preview` 迷你实时预览）。实现在 `src/skins.css`（单文件，动画仅 transform/opacity，`@media (prefers-reduced-motion)` 自动关闭）+ `src/lib/skins.ts`（注册表/存储键 `serverhub:skin`）。全屏氛围层 `.skin-layer` 为 `pointer-events:none` 纯装饰层（z-35），**不拦截任何交互、不影响功能**；选择存 localStorage，App.tsx 按 skin!==none 挂载。已浏览器实测：应用/点击穿透/关闭特效/全新加载持久化/界面文字可读。

**本机传输可靠性修复（2026-08-28 批次 I，v1.2.1）**：本机↔远端互传与拖拽专项修复，11 项。后端：`local-to-remote`/`remote-to-local` 重构为 `runTransfer` 统一收尾——任一端出错 destroy 两端流+删半成品+`makeRespondOnce` 防双响应（旧实现读流出错写流永不 close，路由挂死成僵尸请求）；空闲 60s 无进展/总 30min 超时中止（SFTP 半开连接兜底）；完成后核对目标端大小与源端一致，不符删半成品报错（与 /files/upload 同标准）。`saveTransferState` 按文件互斥排队；`browseDirectory` 全异步（旧同步 stat 卡事件循环）。前端拖拽：`RemoteLocalPanel` 两处 `onDragOver` 改 `types` 判断（**dragover 期间 getData 恒为空**，旧实现高亮永不出现——LocalDirBrowser 早已修过此处漏改）；本机面板/本地终端列表对 DND_MIME 一律 `stopPropagation`（封闭投放区，旧实现本地文件掉在本机面板上会冒泡到根层被误上传远程并覆盖同名文件）；根层 `onDrop` 对落点在 `[data-localpanel]` 内的系统文件只提示不上传；`DownloadURL` 拖出追加 `withWsToken`；四处批量循环聚合每文件失败原因（旧 `catch{}` 只报 N/M）；拖拽含目录提示"已跳过"；批量下载完成 `refreshSignal` 通知本机面板刷新；面板关闭清空 `localPanelPath`。验证：tsc/build/lint(0 error)/离线矩阵 51 PASS（新增 R14 l2r 回环+缺失快速失败、R15 r2l 缺失+中途断流清理半成品）/真机传输冒烟 10 PASS（`.verify/transfer-smoke.mjs`）。**已知边界**：字节级进度需桌面版走 Electron IPC（Web 模式后端侧到侧拿不到浏览器文件句柄），列远期。

**缺陷修复批次 J/K/L（2026-09-11，v1.3.0；离线 45 断言 + 真机 27 断言全绿）**：用一台真实阿里云 Linux（Alibaba Cloud Linux 4，内核 6.6，**maxsessions=10**，2 vCPU/1.6GB，实测带宽 0.4–0.9MB/s）做真机审计，发现并修掉以下问题（J1 与 K2 是离线 fake harness **测不出来**、只有真机才暴露的）。

- **J1（P0，真机发现）符号链接删除穿透目标**：`removeRecursive` 用 `sftp.stat`（跟随链接）判类型，删"指向目录的链接"时会把**目标目录里的真实文件全部删掉**，最后 `rmdir(链接)` 又必然失败 → 用户看到 500 `No such file`、链接还在，而目标目录已被清空；悬空链接则因 stat ENOENT 永远删不掉（前端又把 symlink→dir 列成 `isDirectory:false`，删除走的是简单确认，极易触发）。改为 `lstat` + 链接一律 `unlink`（不递归、不碰目标）。
- **J2（P0，真机复现）文件名含 `%` 时下载/删除打到别的文件**：前端 `encodeURIComponent` → express 已解码一次 → 后端 download/delete 又 `decodeURIComponent` 一次。真机实测：`100%25.txt` 下载返回的是 `100%.txt` 的内容、DELETE 删掉的也是 `100%.txt`（删除默认递归 → 目录名会整棵删错）；`50%off.txt` 直接 500 `URI malformed`，而列表接口正常（只有这两处二次解码）。已去掉后端 4 处二次解码 + `TransferStore.ts` 客户端那次（后者会让含 `%` 的文件"点下载毫无反应、无提示"）。
- **J3（P0）导出→导入一次就把本地命令集删光**：导出调的是不带参数的 `/api/commands`（注释误以为"不带参数=全部"），后端**只返回远程命令**；而 `/api/commands/import` 是整表覆盖 → 本地终端命令集永久丢失。新增 `GET /api/commands?scope=all`，导出与"复制命令编号池"改用它；导入前若会丢本地命令则弹危险二次确认。顺带修掉 `POST /api/commands/order`：旧实现把未提交的命令整段追加到数组末尾，而面板按"分类首次出现顺序"分组，于是拖一条命令会打乱同分区其它命令集的显示顺序、被拖那条自己却没动（现已按提交顺序就位、其余命令原位不动；前端也改为按面板显示顺序提交）。
- **J4（P0）>64MB 下载必然失败**：先 `res.body.getReader()` 锁流，再在 `saveViaPicker` 里第二次 `getReader()` → `TypeError: ReadableStream is locked`，且不匹配 `UNSUPPORTED` 分支所以不回退 Blob。改为先按大小分流再取 reader；picker 取消(AbortError)归为"已取消"而非失败。
- **K1（P1）后端返回非数组导致白屏**：设置 `SERVERHUB_TOKEN` 后不带 `?token=` 打开 → `/api/servers` 返回 401 `{error}` → `setServers(对象)` → Sidebar 渲染里 `servers.filter` 抛 TypeError → React 卸载整棵树（SSR 实测复现）。已加响应校验 + 顶部横幅（含"请在地址后加 ?token=令牌"）+ 最外层 `ErrorBoundary`；`loadSessions` 的 `[...prev, ...list]` 崩溃路径一并加固。
- **K2（P1，真机发现）cwd 采集失效且吃掉用户输入**：注入文本里直接写了首尾标记，**终端回显先出现"结束标记"**，`pickPath` 在回显处截断 → 真机上 cwd 恒为空（"复制路径/复制会话保持目录/在当前目录打开会话"一起失效）；引号内的裸 `\r` 还会把命令行提前提交（多出 `> ` 续行符），用户打了一半的命令被拼进注入命令里**执行**成畸形命令。改为**远端 printf 拼标记**（`printf 'SCWD%s\n' '_B_<nonce>'`：回显里只有 `%s`，解析串只出现在输出里）、去掉裸 `\r`、注入前发 Ctrl-U 清行、同一会话测量串行化。
- **K3（P1）拖入文件夹丢顶层目录名 + 子目录文件必失败**：`collectDroppedFiles` 对顶层目录传 `''` → 文件夹被拍平到当前目录，两个文件夹里的同名文件落到同一远端路径互相覆盖；带子目录时拼出 `<当前目录>/子目录/文件` 而上传链路**没有任何 mkdir**（真机 500 `No such file`）。现在 relPath 带上顶层目录名、路径映射抽成 `targetDirForRelPath()`（单测覆盖），上传前用 `POST /files/mkdir {existOk:true}` 补建父目录。
- **K5（P1）勾选集合与请求竞态**：FileBrowser/RemoteLocalPanel/DeviceFilePanel 的勾选集合在换目录/换服务器后不清空（按钮仍显示"(N)"，实际操作的是上一个目录甚至别的服务器的文件）；三个本地面板与 `viewFile` 缺请求序号（慢响应覆盖新目录 → 路径栏与列表不一致）。已统一补清空 effect + 请求序号（FileBrowser 早有 `loadSeqRef` 可对照）。设备面板批量下载另修三处：失败原因被吞且弹**绿色**"已下载 0/3"、不带 `serial`（多设备打到默认设备）、完成后不刷新本机列表（新增 `lib/uiBus.ts` 极小事件总线）。
- **K6（P1）拖到非投放区会整窗导航走**：Chromium 对未被 `preventDefault` 的文件拖放默认动作是"打开该文件"，会替换整个 SPA（连同全部终端 WS 会话），桌面版没有后退键。App 根节点加 dragover/drop 兜底 + 中文提示；`electron/main.cjs` 增加 `will-navigate`/`will-redirect` 守卫（同源放行、外链交系统浏览器）。
- **L1/L4（P2）**：`Terminal`/`LocalTerminal` 累积历史文本改用**单实例流式 `TextDecoder`**（`decode(bytes,{stream:true})`）。真机实测 3MB 中文输出有 83–118 个 WS 分片切在多字节字符中间，逐帧解码产生 **407–610 个 U+FFFD**（导出 txt / 完整历史原始文本 / 导出 HTML 全部乱码），流式解码为 0；WS 被服务端 `close(1008, reason)` 拒绝时把原因显示到终端并跳过无意义重试。
- **L2/L3（P2）**：`POST /files/upload` 补上 idle 60s / total 30min 看护（与 local↔remote 同一套阈值，可用 `SERVERHUB_TRANSFER_IDLE_MS`/`_TOTAL_MS` 覆盖以便测试）——半开连接时旧实现让请求与一条 SFTP 通道永久挂住，真机带宽仅 0.4–0.9MB/s，慢链路是常态；SFTP 英文错误统一中文化（`Failure` → "目标是目录,不能直接下载"）。
- **L5/L6（P2）**：命令集标题首次点击不折叠；删除模式下点行会执行命令（对 rm/reboot 有实害）；`ConfirmDialog` 的 `typed` 不复位（删同名条目时二次确认被绕过）；编辑服务器无法清空密码；会话标签拖拽落点偏移一格；`ansiToHtml` 真彩色被 0 分量重置 + 跨行 span 被 `<div>` 截断；盘符列表态拖拽下载落点算成 `\C:\`；搜索命中在当前目录时点击无反应；二进制文件在线编辑无警告（不可逆损坏）；`LocalDirBrowser` 把下载到的**文件**路径当"上次设备目录"（下次批量上传全发往同一个文件）；大小单位各面板不同步；Electron 单实例、`eslint no-undef` 对 `server/|scripts/|electron/` 的盲区、`vite strictPort`、`start.bat` 端口占用与 `cd /d` 引号、`make-icon` 恒 0 混合系数。

**验证手段（新增）**：`npm test` 追加三个离线回归——`scripts/verify-fixes.mjs`（% 文件名 / 符号链接删除语义 / mkdir existOk / 下载错误中文化 / 命令集导出导入与排序 / 上传看护超时，26 断言）、`scripts/verify-drag-paths.mjs`（拖入文件夹的路径映射，9 断言）、`scripts/verify-ansi-html.mjs`（HTML 导出色，10 断言）。**真机回归** `npm run audit:real`（`scripts/real-audit.mjs`；凭据只走 `SH_HOST/SH_USER/SH_PASS` 环境变量，未设置则跳过；只在自己创建的 `/root/serverhub-audit-*` 内增删并清理，不改服务器配置）27 断言：% 文件名、符号链接删除穿透、cwd 采集（含"不误执行半截输入"与前台被 `sleep` 占用时的兜底）、mkdir existOk + 嵌套上传、错误信息、命令集往返、真实分片下的流式解码。
**真机踩坑经验（写测试时注意）**：① 造中文大输出夹具时长度必须是"每行字节数"的整数倍，否则文件自身以半个汉字结尾，会得到 1 个假阳性 U+FFFD；② 等待哨兵不能用终端会回显的字面量（与应用捕获 cwd 是同一个坑），要用 `printf 'REAL%s\n' '-AUDIT-DONE'` 这类远端拼出的哨兵；③ 真机 `/tmp` 是 tmpfs（838MB），大文件要放磁盘目录；④ 20 会话首次连接在 2 核真机上是**中位 5s / 最慢 8.5s**（shell 串行创建），断言要留足等待时间（旧审计脚本只等 6s 会误判成"连不上"）。

**缺陷修复批次 M（2026-09-11，v1.3.1；用户报的"会话消失/没有断开按钮/传文件/新建服务器"，新增 UI 级回归）**：这一批全部是**状态与交互层**问题，离线 API 脚本测不出来，因此新增了 UI 级验证手段（见下）。

- **M1（P1）刷新/重启后界面看不到已持久化的会话**：`App.tsx` 只在"选中服务器"或"连接成功"时才 `loadSessions`，于是**刷新页面后 `sessions` 恒为空 → `hasSessions=false` → 整个远程工作区（会话标签 + 所有终端）都不渲染**，界面退回"开始管理你的服务器"；而点"连接"时 `handleConnect` 会加载会话，于是用户看到"断开/刷新后会话消失，重连又能看到之前的会话"。修复：拿到服务器列表后一次性把所有服务器的会话读进来（`Promise.all`，用 `sessionsLoadedRef` 防重复），既有的"自动激活第一个会话"逻辑随后挂载终端。**UI 实测**：后端已连接 + 3 个会话时刷新页面 → 3 个标签 + "终端就绪"（修复前 0 个标签 + 空状态）。
- **M2（P1）没有"断开连接"按钮**：连接/断开只藏在**需要 hover 才出现**的齿轮菜单里（`+` 与齿轮本身也是 `opacity-0 group-hover:opacity-100`）。修复：每个服务器行加**常显**的连接/断开开关按钮（图标随状态变化，连接中显示转圈），`+`/齿轮改为常显（60% 透明、悬停变亮），顶部栏的"● 已连接/断开"变成可点击的连接/断开开关。
- **M3（P1）新建服务器**：① 界面**完全没有私钥字段**（后端 `getServerConfig` 支持 `privateKey` 并用它替代密码）→ 密钥认证的服务器根本建不出来；② 密码输入框是 `required` → 无法建"无密码/密钥认证"的服务器；③ 无校验：端口填 99999 会原样落盘、IP/用户名粘贴带前后空格也原样存 → 连接失败时报错难懂。修复：新增私钥文本域（含"填了私钥则忽略密码、清空即回到密码认证"说明）、密码改为可选但要求"密码或私钥至少填一个"、端口校验 1–65535 并给中文内联报错、IP/用户名/名称 trim；`Server` 类型补 `privateKey?`。
- **M4（P1）本机→远端批量上传后远程列表不刷新**（用户怀疑的"传文件有 bug"）：`RemoteLocalPanel.uploadSelected` 只弹了"已上传 N/M"的提示，**从不通知 `FileBrowser` 刷新**，右侧远程列表仍显示旧内容 → 用户以为没传上去、重复上传覆盖同名文件。修复：`lib/uiBus.ts` 增加 `requestRemoteRefresh/onRemoteRefresh`，`FileBrowser` 订阅后 `loadDir(currentPathRef.current)`；对称补上设备方向（`LocalDirBrowser` 批量上传设备 → `requestDeviceRefresh` → `DeviceFilePanel` 刷新）。**UI 实测**：走界面按钮批量上传 2 个本机文件 → 远程列表出现这 2 个文件；再勾选远程行 → "下载选中到本机(1)" → 本地文件内容一致。
- **M5（工程化，新增手段）UI 级回归 `scripts/ui-audit.cjs` + `npm run audit:ui`**：用已安装的 Electron 起**隐藏窗口真实驱动界面**（后端用假 ssh2，独立数据目录，跑完清理），16 条断言覆盖：新建服务器（私钥入口/密码可选/必填拦截/落盘字段）、连接断开入口可见性、会话在"启动/刷新/断开/重连"四个时机的存续、以及本机↔远端批量上传/下载（点击真实按钮 + 校验本地/远端结果）。这是本项目第一个 UI 级测试（此前只有离线 API/单元脚本 + 人工点击）。
  **踩坑记录（写 UI 测试必看）**：① `.verify/` 下自带一份 `node_modules/ssh2`，直接 `require('ssh2')` 打补丁打不到 `server/ssh-manager.js` 加载的根那份（同一坑在 `.verify/repro-bugs.mjs` 也踩过）——必须 `require(path.join(__dirname,'..','node_modules','ssh2'))`；② 状态轮询间隔 5s，刷新页面后要等一轮才能拿到 `connected`，否则文件页显示"未连接"；③ 列表刷新期间 `<table>` 会被 loading 占位替换，查行必须轮询而不是固定等待；④ 远程文件行的"勾选框"不是 `input[type=checkbox]`（点整行切换勾选），"下载选中到本机"按钮**只在有勾选时才渲染**；⑤ `document.querySelector('h2')` 会先命中空状态标题，要取全部 h2 再匹配。

**桌面版 GUI 验证（2026-09-11 批次 N，v1.3.2；打包版 15 断言全绿）**：出包 `npm run app` → `release/win-unpacked/ServerHub.exe`，用 **Chrome DevTools Protocol** 驱动**打包后的真实应用**（`--remote-debugging-port` + `--user-data-dir=<临时目录>`，后者同时验证了"数据写在 userData"且**不污染 `%APPDATA%/ServerHub`**），并用 `Input.dispatchDragEvent` 合成**真实 OS 拖放**。新增 `npm run audit:desktop`（`scripts/desktop-audit.mjs`，15 断言）：
- 打包版内置后端在 33120 服务 API、界面正常渲染、数据目录落在 userData；
- 走界面弹窗新建服务器（含批次 M 的私钥字段/密码可选）→ 点**常显的连接按钮**连上真机 → 会话标签出现且"终端就绪"；
- 文件页列出真实目录（72 行）；
- **把本机文件拖到远程文件列表 = 上传成功**（合成 OS 拖放 → 真实 SFTP 写入远端，已核对远端条目）；
- **把文件拖到侧栏 / 终端区（非投放区）后窗口仍停在 `http://localhost:33120/`，没有被 `file://` 导航替换**（`will-navigate` 守卫 + 根层 dragover/drop 兜底在打包版生效）；
- 断开连接后会话标签仍在、不退回空状态（批次 M 的打包版回归）；单实例锁：第二个实例 exit 0 自行退出，第一个实例后端仍正常服务。
**已知未自动化**：**文件夹**拖拽的递归展开（`webkitGetAsEntry`）无法用 CDP 合成（合成拖放只带文件列表，走的是 `dt.files` 兜底分支）——该路径由 `scripts/verify-drag-paths.mjs`（9 断言，忠实模拟 FileSystemEntry）+ 真机 `audit:real` 的"mkdir existOk + 嵌套上传"共同覆盖，残余风险是"真实资源管理器拖目录时 relPath 的实际形态"。**踩坑**：GUI 版审计里 `innerText` 读不到 `display:none` 里的内容——会话标签位于终端层，切到"文件"页签后整层被隐藏，必须先切回"终端"页签再断言标签数量。

**安装包(NSIS)自动化验证（2026-09-11，随批次 N）**：`npx electron-builder --win nsis` → `release/ServerHub Setup <version>.exe`（约 104MB），`npm run audit:installer`（`scripts/installer-audit.mjs`，18 断言）已把此前的人工步骤自动化：`/S /D=<临时目录>` 静默安装 → 校验 `ServerHub.exe`/`app.asar`/`app.asar.unpacked/node_modules/node-pty` 就位 → 启动已安装的应用（内置后端 33120 就绪）→ 通过 API 种入服务器(含明文密码)与会话记录 → **再次覆盖安装** → 记录仍在 → `Uninstall ServerHub.exe /S` 静默卸载 → 程序删除而 **userData 数据保留**。安装包文件名/版本取自 `package.json` 的 `version`，**发版前记得同步版本号**（本次由 1.2.2 → 1.3.2）。
**发布到 GitHub（2026-09-11）**：源码推送到 `https://github.com/hwm-1114/ServerHub`（`main`），安装包以 **Release 资产**发布（tag `v1.3.2`）。**踩坑**：① 本机 git 全局配置了 `http.proxy=http://127.0.0.1:7890`，代理客户端没开时 `git fetch/push` 会直接失败——一次性覆盖即可：`git -c http.proxy= push <url> main`；② 仓库 remote URL 里曾内嵌明文 token（已改为不含 token 的纯 URL，**别再写回去**，改用凭据管理器）；③ `.gitignore` 已排除 `data/`（真实服务器明文密码）、`.verify/`（含凭据的临时脚本）、`release/`、`dist/`——**推送前务必复查 `git status` 确认这三类没被跟踪**。

**持续集成（2026-09-11，`.github/workflows/ci.yml`）**：四个任务——`static`（ubuntu：`npm ci --ignore-scripts` + typecheck/lint/build，**必须 `--ignore-scripts`**：node-pty 只发布 darwin/win32 预编译，Linux 上会退化成 node-gyp 全量编译，而这三步都不加载 node-pty；esbuild 平台包在 `optionalDependencies`，不受影响）、`test`（windows：`npm test` + `audit:ui`，配了 `SH_*` secrets 才跑 `audit:real` 且 `continue-on-error`）、`package`（windows：`npm run app` → `audit:desktop` → NSIS → `audit:installer`，上传安装包产物）、`release`（`v*` 标签才跑：**先校验 `v<tag>` 与 `package.json` 的 `version` 一致**再用 `gh release` 建 Release 并 `--clobber` 上传，避免"标签是 v1.3.2、包里装的是 1.2.2"）。写工作流时注意 `concurrency.cancel-in-progress` 按 ref 分组：**同一分支连续推送会取消上一次运行**（`audit:desktop`/`audit:installer` 在内网真机上会跳过真机断言而不是失败，所以 CI 无 secrets 也能全绿）。工作流本身用 `npm run validate:workflow`（`scripts/validate-workflow.mjs`，40 断言，纯文本解析 YAML，不引入依赖）离线校验。

**CI 首次运行暴露的三个真问题（2026-09-11，已修）**：① `audit:ui` 加载的是**真实前端产物**（server 只在 `dist/` 存在时服务静态文件），而 `test` 任务没构建 → 首页 404、断言集体失败；同时 `ui-audit.cjs` 结尾写死 `app.exit(0)`，**断言失败也会以 0 退出**（本地串跑同样掩盖失败）——已补 `npm run build` 步骤、缺产物明确报错退出 2、退出码改为 `fail ? 1 : 0`。② `stress-process-reliability.mjs` / `stress-switch-stability.mjs` 里 `cls(HELPERS.down(i))` **把 Promise 当函数传**（`await fn()` 抛 `fn is not a function`）：请求变成"发射后不管"，既测不到结果，失败时又成为未处理的 rejection——本地请求都会正常返回所以看不出来，CI 上收尾杀子进程时的 ECONNRESET 才让它以 exit 1 崩掉（而 6 条断言全过）。已改为传 thunk、在 `cls()` 里显式拦截非函数入参、并给该脚本加 `unhandledRejection` 护栏。③ **CI 出包必须显式 `--publish never`**：electron-builder 检测到 CI 环境（`CI=true`）且能从 git remote 推断出 GitHub provider 时，会**隐式尝试把产物发布到 GitHub Release**，没有 `GH_TOKEN` 就直接以 exit 1 结束——而**安装包其实已经生成好了**（日志末尾只有一句 `⨯ GitHub Personal Access Token is not set`）。已抽成 `npm run dist:nsis`（= `electron-builder --win nsis --publish never`）、给 `npm run app` 也加上该参数，并在 `validate:workflow` 里加断言防回归（40 断言）。
**看 CI 日志的坑**：PowerShell 直接读 `Invoke-WebRequest` 拿到的日志会把 UTF-8 显示成乱码（`é¶æ®µ2`），排查时用 node 的 `fetch` 拉 `/actions/jobs/<id>/logs` 再按 UTF-8 落盘；node-pty 的 `conpty_console_list_agent` 会打印 `Error: AttachConsole failed` 堆栈（本地与 CI 都有，属噪声，不影响断言）。

**本地终端同目录多会话（2026-08-29，v1.2.2）**：`openLocalTerminal` 移除同目录去重（旧实现同目录已存在会话时仅激活不新建），每次点击「在此目录打开终端」都新建独立 PowerShell 会话；同目录第 2+ 个标签自动命名 `目录名 (2)`。后端本就按会话 id 各建 node-pty,无需改动。已浏览器实测:同目录双会话独立运行、输入互不串扰。

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
| `npm run app` | `vite build` + `electron-builder --dir --publish never` → `release/win-unpacked/`（`--publish never` 防止 CI 环境下 electron-builder 隐式发布） |
| `npm run dist:nsis` | `electron-builder --win nsis --publish never` → `release/ServerHub Setup <version>.exe`（CI 出包与本地出安装包都用它） |
| `node scripts/verify-sessions.mjs` / `verify-20-sessions.mjs` | 离线断言：会话隔离 / 20 会话并发全开 |
| `node scripts/stress-transfer-stability.mjs` / `stress-switch-stability.mjs` / `stress-process-reliability.mjs` | 离线压力：传输自愈 / 切换稳定 / 进程不崩 |
| `npm run typecheck` | `tsc --noEmit`（只覆盖 `src/`，`server/`+`scripts/`+`electron/` 的未定义标识符由 lint 的 `no-undef` 兜底） |
| `npm run lint` | `eslint src server scripts electron`（当前 0 error / 88 warning，warning 作改进清单） |
| `npm test` | 一键串跑：五个旧脚本 + `verify-fullhistory` + 可靠性矩阵 51 条 + 批次 J/K/L 新增的三个离线回归（verify-fixes 26 / verify-drag-paths 9 / verify-ansi-html 10） |
| `npm run audit:real` | **真机回归**：`scripts/real-audit.mjs`，27 断言；凭据走 `SH_HOST/SH_USER/SH_PASS` 环境变量，未设置自动跳过 |
| `npm run audit:ui` | **UI 级回归**：`scripts/ui-audit.cjs`（Electron 隐藏窗口真实驱动界面，假 ssh2），16 断言：新建服务器/连接断开入口/会话在启动·刷新·断开·重连四个时机的存续/本机↔远端批量上传下载；**需先 `npm run build`**（加载的是真实前端产物，缺 `dist/` 会明确报错退出 2），断言失败退出码 1 |
| `npm run audit:desktop` | **打包版 GUI 回归**：`scripts/desktop-audit.mjs`（对 `release/win-unpacked/ServerHub.exe` 用 CDP 驱动 + `Input.dispatchDragEvent` 合成真实拖放），15 断言：内置后端/数据目录、界面建服务器并连真机、**拖文件到远程列表=上传**、**拖到侧栏/终端区不导航走**、断开后会话仍在、单实例锁 |
| `npm run audit:installer` | **安装包回归**：`scripts/installer-audit.mjs`（NSIS 静默安装 → 启动 → 种数据 → **覆盖安装** → 数据仍在 → 静默卸载 → 数据保留），18 断言；需先 `npm run dist:nsis` |
| `npm run validate:workflow` | 离线校验 `.github/workflows/ci.yml`（40 断言：任务/触发/secrets 用法/步骤顺序/出包参数/版本一致性检查等），改工作流后跑一次 |

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
