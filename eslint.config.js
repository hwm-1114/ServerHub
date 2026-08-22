// 最小可用 lint 配置:不做风格约束,只抓真问题。
// 现有代码库未按 lint 标准编写,规则一律 warning 级别,报告作为改进清单,不阻塞开发。
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['dist/**', 'release/**', 'node_modules/**', '.verify/**', 'build/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
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
      'no-undef': 'off', // ESM 由 TS 判定
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
)
