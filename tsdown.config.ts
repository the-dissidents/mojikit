import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['./src/index.ts', './src/ToolbarApp.tsx', './src/Inspector.ts'],
    platform: 'neutral',
    dts: true
  }
])
