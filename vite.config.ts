import { defineConfig } from 'vite';

export default defineConfig(({ command }) => ({
  // 项目页发在 `/<repo>/` 子路径下，绝对 `/` 的资源引用会 404。
  // 只在 `build` 时改成相对路径 —— **dev 保持 `/`**：验证批靠 `page.goto('/')` 与
  // `/src/...` 的动态 import 取引擎活表，动 dev 的 base 等于动判据装置。
  base: command === 'build' ? './' : '/',
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4188,
    strictPort: true,
  },
  build: {
    sourcemap: true,
    chunkSizeWarningLimit: 900,
    // 本环境对批量删除有保护，Vite 清空 dist 会被拦下来导致构建失败。
    // 关掉自动清空，改为每次构建覆盖同名产物。（CI 用 `--emptyOutDir` 显式清，见 .github/workflows/pages.yml）
    emptyOutDir: false,
  },
}));
