// 最小可用 lint 配置:不做风格约束,只抓真问题。
// 现有代码库未按 lint 标准编写,规则一律 warning 级别,报告作为改进清单,不阻塞开发。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

// Node / CommonJS 运行时全局(项目没装 `globals` 包,按需内联声明,不新增依赖)。
// 只用于 server/ scripts/ electron/ 与根目录 *.config.js 这些纯 JS 文件:
// 它们不在 tsconfig 的 include 里(tsc 只看 src/),必须靠 no-undef 把关。
const NODE_GLOBALS = {
  // 进程与模块
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  global: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  // 定时器与微任务
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  clearImmediate: 'readonly',
  queueMicrotask: 'readonly',
  // 标准全局(Node 18+ 均可用)
  URL: 'readonly',
  URLSearchParams: 'readonly',
  TextEncoder: 'readonly',
  TextDecoder: 'readonly',
  AbortController: 'readonly',
  AbortSignal: 'readonly',
  structuredClone: 'readonly',
  fetch: 'readonly',
  performance: 'readonly',
}

// TypeScript 源码才交给 typescript-eslint。
// 注意:tseslint.configs.recommended 里的 base 配置不带 files 字段,默认会把 TS 解析器
// 和 TS 专属规则套到 .js/.mjs/.cjs 上 —— electron/*.cjs 曾因此报 3 个
// no-require-imports 错误,而 CJS 里 require 本来就是正常写法。故显式限定 files。
// 另外 TS 解析器下 no-undef 不可靠(TS 自己负责这件事),纯 JS 文件走 espree 才有意义。
const TS_FILES = ['**/*.{ts,tsx,mts,cts}']

export default tseslint.config(
  { ignores: ['dist/**', 'release/**', 'node_modules/**', '.verify/**', 'build/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended.map(c => ({ ...c, files: TS_FILES })),
  // 仅"注册"TS 插件(不绑定 files,也不套用 TS 解析器):下面的全局规则块里
  // 引用了 @typescript-eslint/no-unused-vars,ESLint 要求该插件在配置里可见。
  { plugins: { '@typescript-eslint': tseslint.plugin } },
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/exhaustive-deps': 'warn',
      // v6 的 React-Compiler 级规则(refs/purity/immutability 等)对既有代码过于严格:
      // 本项目刻意使用"渲染期同步 ref 最新值"(currentPathRef.current = currentPath)
      // 等模式,降为 warn 作参考,只有 rules-of-hooks 保持 error
      'react-hooks/refs': 'warn',
      'react-hooks/purity': 'warn',
      'react-hooks/immutability': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/preserve-manual-memoization': 'warn',
      'react-hooks/globals': 'warn',
      'react-hooks/incompatible-library': 'warn',
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': 'warn',
      '@typescript-eslint/no-explicit-any': 'off', // 与 xterm/拖拽 API 交互处大量 any,属既有约定
      'no-unused-vars': 'off',
      'no-empty': 'off', // catch {} 是项目里明确的静默忽略写法
      'no-undef': 'off', // TS 源码由 TS 判定;纯 JS 文件在下面的 Node 块里单独打开
      // ANSI 处理必须匹配控制字符(\x1b 等),关掉该误伤
      'no-control-regex': 'off',
      // shell 单引号转义里 '\\'' 的写法会被判"无用转义",属刻意写法
      'no-useless-escape': 'off',
      // 以下为风格类,降为 warn 作为改进清单,不阻塞
      'prefer-const': 'warn',
      'no-useless-assignment': 'warn',
      '@typescript-eslint/no-unused-expressions': 'warn',
    },
  },
  {
    files: ['src/**/*.{ts,tsx}'],
    rules: {
      // 项目大量"轮询/挂载即拉取"的 effect 直接 setState,是既有模式;新派规则降为 warn
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
  // ---- 纯 JS(Node)文件:打开 no-undef,补上 tsc 看不到的目录 ----
  // 动因(真实事故):server/ssh-manager.js 丢过一行常量定义,路由跑到才抛 ReferenceError,
  // 而 typecheck(只看 src)与 lint(no-undef 被关)双双全绿。现在这类未定义标识符
  // 由 eslint 直接报 error,不再依赖运行时才发现。
  // server/ 与根 *.config.js 走 ESM(package.json 是 "type": "module"),
  // scripts/ 是 .mjs 显式 ESM,故 sourceType 均为 module。
  {
    files: ['server/**/*.js', 'scripts/**/*.mjs', '*.config.js', '*.config.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: {
      'no-undef': 'error',
    },
  },
  // electron/ 是 Electron 主进程/预加载脚本,CommonJS(.cjs,require/module.exports)
  {
    files: ['electron/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: {
      'no-undef': 'error',
    },
  },
)
