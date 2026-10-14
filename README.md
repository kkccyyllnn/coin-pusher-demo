# 币塔街机 · 网页推币机（demo / 预览版）

推币机 + 老虎机 + 构筑的网页 demo。Three.js 渲染真 3D 机柜，Rapier 跑真实硬币物理，
XIXI 老虎机给奖励演出，攒票券触发波间三选一。开局 200 筹码，撑多久算多久。

**在线玩（GitHub Pages，需在 Settings → Pages 启用后生效）**：
https://kkccyyllnn.github.io/coin-pusher-demo/

## 本地跑

```bash
npm ci
npm run dev        # http://127.0.0.1:5188
npm run build      # 产物在 dist/（发在子路径下，构建走相对 base）
npm run preview
```

## 怎么玩

- **投币**（右下角大按钮，1 筹码/投，可切 1/2/5 注额 = ×1/×2/×4 返值）把币推上斜面，越过发光得分线才入账。
- **八种币**：铜币（越线只有 9 % 真返值）、花纹、返币、大赏、钻石、宝箱、催债币（越线反而按比例扣钱）、票币（不返筹码、给 1 张票券）。
- **三个机关**（局内花筹码）：扫板、抓斗、后装填。
- **XIXI 老虎机**：四格集齐开奖。三同是常规奖（画面画成"差一格"），四同按符号分派大奖，胡萝卜四连是罚金。
- **票券与波次**：攒够本波目标弹"三选一"，选一张构筑（机关充能 / 加力包 / 缩短发券间隔…）。
- **破产是内容不是惩罚**：输光后是"续玩报价"，可以就地借钱接着玩，欠款进存档、之后按比例先还债。

进度存在浏览器 `localStorage`，不上传任何数据。

## 这个仓库不含什么

预览包只留"跑得起来 + 构建得出来"的必要件（`src/`、`public/`、`index.html`、`vite.config.ts`、`tsconfig.json`、
`package*.json`）。仓库里的 `gh-pages` 分支是构建产物（Pages 用它）。
以下刻意没放进来：验证脚本与 Playwright 用例、内部决策记录、截图与评审产物。

## 技术栈

Three.js 0.184 · Rapier3D 0.12 · TypeScript strict · Vite 8（rolldown）· 无后端、无账号、无内购。
