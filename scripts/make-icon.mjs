// 生成 256x256 应用图标(build/icon.png),electron-builder 会转成 Windows .ico
// 设计:圆角深色卡片 + 右上角径向辉光 + 居中"终端窗口"(顶栏三个圆点 + 青色 ">_" 提示符 + 光标闪烁感)。
// 用 4x 超采样抗锯齿,边缘平滑。纯 Node 实现,无第三方图像依赖。
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SIZE = 256
const SS = 4            // 超采样倍数
const W = SIZE * SS     // 渲染缓冲区尺寸

// 调色板
const GRAD_TOP = [22, 30, 54]      // 卡片顶部(深蓝黑)
const GRAD_BOT = [8, 20, 30]       // 卡片底部(深墨绿蓝)
const GLOW = [34, 211, 238]        // 辉光:青色
const DOT = [244, 63, 94]          // 红点(关闭)
const DOT_Y = [245, 158, 11]       // 黄点(最小化)
const DOT_G = [16, 185, 129]       // 绿点(最大化)
const BAR = [32, 42, 66]           // 终端顶栏
const PROMPT = [52, 211, 153]      // 提示符符号(翠绿)
const CURSOR = [153, 246, 228]     // 光标(浅翠)
const TXT = [148, 163, 184]        // 提示文本(灰蓝)
const FONT = [58, 72, 100]         // 终端窗口描边

function lerp(a, b, t) { return a + (b - a) * t }
function mix(c1, c2, t) { return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)] }

// 圆角矩形 SDF
function sdRounded(x, y, cx, cy, hw, hh, r) {
  const dx = Math.abs(x - cx) - (hw - r)
  const dy = Math.abs(y - cy) - (hh - r)
  const ox = Math.max(dx, 0), oy = Math.max(dy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r
}

// 圆角方框 SDF(描边用)
function sdRoundedFrame(x, y, cx, cy, hw, hh, r, t) {
  return Math.abs(sdRounded(x, y, cx, cy, hw, hh, r)) - t
}

// 在采样点 (sx, sy) ∈ [0,W) 计算颜色
function sample(sx, sy) {
  const x = sx / W, y = sy / W
  // 1) 外部透明
  if (x < 0 || x > 1 || y < 0 || y > 1) return [0, 0, 0, 0]

  // 卡片:圆角方形,占满画面带 4% 边距
  const card = sdRounded(x, y, 0.5, 0.5, 0.46, 0.46, 0.12)
  if (card > 0.004) return [0, 0, 0, 0]

  // 背景:垂直渐变 + 右上角青色辉光
  let bg = mix(GRAD_TOP, GRAD_BOT, y)
  const glowDx = x - 1.18, glowDy = y + 0.05
  const glow = Math.exp(-(glowDx * glowDx + glowDy * glowDy) * 2.2)
  bg = [
    lerp(bg[0], GLOW[0], glow * 0.35),
    lerp(bg[1], GLOW[1], glow * 0.45),
    lerp(bg[2], GLOW[2], glow * 0.55),
  ]

  const fill = (fx, fy, w, h, r, col, aa = 0.004) => {
    const d = sdRounded(x, y, fx, fy, w / 2, h / 2, r)
    return Math.max(0, Math.min(1, -d / aa))
  }
  const frame = (fx, fy, w, h, r, t, col, aa = 0.004) => {
    const d = sdRoundedFrame(x, y, fx, fy, w / 2, h / 2, r, t)
    return Math.max(0, Math.min(1, -d / aa))
  }

  // 2) 终端窗口:居中,约占 78%
  const tw = 0.62, th = 0.5, tx = 0.5, ty = 0.52
  const winFill = fill(tx, ty, tw, th, 0.055, [1, 1, 1])
  let col = mix(bg, [20, 28, 44], winFill)

  // 窗口描边
  const winFrame = frame(tx, ty, tw, th, 0.055, 0.012, [1, 1, 1])
  col = mix(col, FONT, winFrame * 0.7)

  // 3) 顶栏
  const barH = 0.15
  const bar = fill(tx, ty - th / 2 + barH / 2, tw, barH, 0.045, [1, 1, 1])
  col = mix(col, BAR, bar)

  // 顶栏三个圆点
  const dotY = ty - th / 2 + barH / 2
  const r = 0.014
  const dR = Math.hypot(x - (tx - tw / 2 + 0.055), y - dotY), dY = Math.hypot(x - (tx - tw / 2 + 0.082), y - dotY), dG = Math.hypot(x - (tx - tw / 2 + 0.109), y - dotY)
  const doDot = (d, c) => Math.max(0, Math.min(1, 1 - (d - r) / 0.004))
  col = mix(col, DOT, doDot(dR, r))
  col = mix(col, DOT_Y, doDot(dY, r))
  col = mix(col, DOT_G, doDot(dG, r))

  // 4) 提示符 ">_" :起于窗口内左上
  const baseX = tx - tw / 2 + 0.10
  const baseY = ty + th / 2 - 0.11
  const chev = (y >= baseY - 0.020 && y <= baseY + 0.020)
    ? Math.max(0, Math.min(1, 1 - Math.abs(x - baseX) / 0.028))
    : 0
  const chev2 = (x >= baseX - 0.060 && x <= baseX - 0.018 && Math.abs(y - (baseY + 0.020)) < 0.012)
    ? Math.max(0, Math.min(1, 1 - Math.abs((y - (baseY + 0.020))) / 0.012)) : 0
  // 简化:画一个大" ">"" 用两条斜杠
  const slashDown = sdLine(x, y, baseX - 0.030, baseY - 0.020, baseX + 0.015, baseY + 0.020, 0.014)
  const slashUp = sdLine(x, y, baseX - 0.030, baseY + 0.020, baseX + 0.015, baseY - 0.020, 0.014)
  const chevCol = Math.max(0, Math.min(1, Math.max(-slashDown, -slashUp) / 0.004))
  col = mix(col, PROMPT, chevCol * winFill)

  // 提示文本下划线(模拟输入内容)
  const under = (y >= baseY - 0.012 && y <= baseY + 0.012 && x > baseX + 0.045 && x < tx + tw / 2 - 0.10)
    ? Math.max(0, Math.min(1, 1 - 0.012 / 0.012)) : 0
  const accentLine = mix(BAR, TXT, 0.8)
  col = mix(col, accentLine, under * winFill * 0.5)

  // 光标块(闪烁感,固定为亮块)
  const curX = baseX + 0.030
  const cur = (y >= baseY - 0.016 && y <= baseY + 0.016 && x >= curX - 0.015 && x <= curX + 0.015)
    ? Math.max(0, Math.min(1, 1 - 0.016 / 0.016)) : 0
  col = mix(col, CURSOR, cur * winFill * 0.92)

  return [col[0], col[1], col[2], 255]
}

// 线段 SDF
function sdLine(x, y, ax, ay, bx, by, r) {
  const pax = x - ax, pay = y - ay
  const bax = bx - ax, bay = by - ay
  const h = Math.max(0, Math.min(1, ((pax * bax + pay * bay) / (bax * bax + bay * bay))))
  const dx = pax - bax * h, dy = pay - bay * h
  return Math.hypot(dx, dy) - r
}

// ---- PNG 编码 ----
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  return t
})()
function crc32(buf) { let c = -1; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

// 超采样渲染:对每个输出像素对 SS*SS 个样本求平均
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
let off = 0
const SS2 = SS * SS
for (let y = 0; y < SIZE; y++) {
  raw[off++] = 0
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const c = sample(x * SS + sx + 0.5, y * SS + sy + 0.5)
        r += c[0]; g += c[1]; b += c[2]; a += c[3]
      }
    }
    raw[off++] = Math.round(r / SS2)
    raw[off++] = Math.round(g / SS2)
    raw[off++] = Math.round(b / SS2)
    raw[off++] = Math.round(a / SS2)
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])

const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'icon.png')
fs.writeFileSync(outFile, png)
console.log(`已生成图标: ${outFile} (${png.length} bytes)`)
