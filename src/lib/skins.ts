// 动态特效皮肤注册表:20 种全屏氛围层(纯 CSS 动画,见 src/skins.css)。
// 皮肤层 pointer-events:none 且低于弹窗层级,不影响任何功能与终端交互。
export interface SkinInfo {
  id: string
  name: string
  desc: string
  /** 分类标签:粒子/光效/氛围 */
  tag: '粒子' | '光效' | '氛围'
}

export const SKINS: SkinInfo[] = [
  { id: 'starfield', name: '星空闪烁', desc: '多层星点闪烁漂移', tag: '粒子' },
  { id: 'aurora', name: '极光', desc: '青紫绿光幕缓缓扫过', tag: '光效' },
  { id: 'neon', name: '霓虹流光', desc: '彩色光束横掠', tag: '光效' },
  { id: 'matrix', name: '数字雨', desc: '绿色数据流坠落', tag: '粒子' },
  { id: 'grid', name: '赛博网格', desc: '透视网格滚动+地平线辉光', tag: '氛围' },
  { id: 'sakura', name: '樱花飘落', desc: '花瓣旋转坠落', tag: '粒子' },
  { id: 'stream', name: '数据流光', desc: '横向流星划过', tag: '光效' },
  { id: 'ripple', name: '涟漪', desc: '同心圆波纹扩散', tag: '氛围' },
  { id: 'lava', name: '熔岩浮影', desc: '暗红光团缓慢翻涌', tag: '氛围' },
  { id: 'bubbles', name: '深海气泡', desc: '气泡上升轻摆', tag: '粒子' },
  { id: 'scanline', name: '扫描线', desc: 'CRT 扫描线+巡扫光带', tag: '氛围' },
  { id: 'core', name: '能量核心', desc: '中心脉冲+旋转能量环', tag: '光效' },
  { id: 'clouds', name: '流云', desc: '大片薄云缓慢漂移', tag: '氛围' },
  { id: 'circuit', name: '电路脉冲', desc: '虚线电流沿路流动', tag: '光效' },
  { id: 'snow', name: '雪花纷飞', desc: '多层雪花斜落', tag: '粒子' },
  { id: 'firefly', name: '萤火虫', desc: '光点随机明灭游走', tag: '粒子' },
  { id: 'breathe', name: '渐变呼吸', desc: '全屏渐变明暗律动', tag: '氛围' },
  { id: 'nebula', name: '星云漩涡', desc: '锥形渐变星云旋转', tag: '氛围' },
  { id: 'lightning', name: '雷电微光', desc: '偶发的远空闪光', tag: '光效' },
  { id: 'pulsewave', name: '脉冲波纹', desc: '底部向上的呼吸辉光', tag: '光效' },
]

export const SKIN_STORAGE_KEY = 'serverhub:skin'
export const DEFAULT_SKIN = 'none'
