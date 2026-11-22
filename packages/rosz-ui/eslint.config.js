import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist', '.claude']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
    rules: {
      // 库导出组件与工具函数并存, 不按fast refresh拆文件
      'react-refresh/only-export-components': 'off',
      // effect的返回值会被React当清理函数调用, effect写块体, 要清理时显式return
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'CallExpression[callee.name=/^use(Layout|Insertion)?Effect$/] > ArrowFunctionExpression.arguments:first-child[expression=true]:not([body.type="ArrowFunctionExpression"])',
          message: 'effect回调写块体 `() => { ... }`, 要清理时显式return清理函数',
        },
      ],
    },
  },
])
