import * as THREE from 'three';
import type { NotificationMeta } from '../game/notifications';

/**
 * 顶部招牌的**实时显示屏**（R3-U4）。
 *
 * ## 为什么是一块独立的小 mesh，而不是把数字画进招牌贴图
 *
 * 招牌画布是 1024×512。往它上面每帧写一次数字 = 每帧重传 ≈2 MB 纹理，
 * 而 `perf` 闸门的预算里没有这笔带宽（帧时间会被一次纹理上传吃掉半帧）。
 * 所以静态构图烘焙一次，会变的数字单独一块 LED 小屏（高 64 纹素、宽按面板比例算），
 * 贴在檐板正前 2 mm —— 更新代价 ≈64 KB，而且只在**内容真的变了**的时候传。
 *
 * ## 刷新是事件驱动 + 节流的
 *
 * `pushLedger()` / `subtitle()` 只置脏位；`tick()` 每帧被调用，但最多
 * 每 125 ms（8 fps）重画一次。LED 招牌本来就是这个刷新率 —— 60 fps 的
 * 数字滚动在 0.24 米高的点阵上只会糊成一片。
 *
 * 滚动**不重画纹理**：改 `texture.offset.x` 让采样窗口滑过整张图，
 * 代价是一个 uniform。所以 `wrapS` 必须是 `RepeatWrapping`。
 *
 * ## 材质侧的约束（`TableBuilder` 负责，这里只把纹理交出去）
 *
 * `map` 与 `emissiveMap` 挂同一张纹理、`detailKind` 与侧板那份一致 ——
 * defines 一字不差才能复用同一个 program（`perf` 的 program 预算不让步）。
 * 自发光是必须的：三渲二的 `color × map` 里，暗底色带永远乘不出亮像素。
 */

/**
 * 面板的**纵向**纹素数固定，横向由 `setAspect()` 按实际面板宽高比算出来。
 *
 * 为什么不再是写死的 256×64：屏「做满」之后面板是 4.997:1，而纹理一直是 4:1 ⇒
 * 字被横向白拉 **24.9 %**（实测，见 `marqueeReport()` 的 textureWidth/Height）。
 * 只把 256 改成 320 也能对上，但对不上 `?model` —— 檐板尺寸一改，比例就又错开，
 * 而且这次连「4:1」这个锚都没了，没人会想起来再修。所以**从几何反推**是唯一
 * 不会过期的写法。
 *
 * 高度不动是有意的：字号、基线、扫描线周期全挂在纵向纹素数上，
 * 改它会同时动三样，而拉伸这件事只需要动宽度。
 */
const H = 64;
/** 宽度取到 4 的整数倍：扫描线周期是 4，非整倍会让最后一道线被截断。 */
const WIDTH_STEP = 4;
/** 未设比例时的兜底宽度（与改造前一致，保证旧截图可比）。 */
const DEFAULT_WIDTH = 256;
/** 重画节流：8 fps 封顶。 */
const MIN_INTERVAL = 0.125;
/**
 * 滚动**只属于超宽的字幕**（V3 UI-001）。
 *
 * ⚠️ 旧版是「整张纹理无条件循环滚动」（`texture.offset.x` 每帧累加 + RepeatWrapping），
 * 账本行跟着一起卷 —— 用户实测看到的就是残缺的 `+0` / `余额 81 本段`。这轮反转为：
 * **账本行永静止**；只有 `measureText` 量出来真的超宽的字幕才滚，滚动走**逐帧重绘
 * 内容 x 偏移**（节流 8 fps，≈64 KB/次），`texture.offset` 恒为 0，
 * `wrapS` 因此改成 ClampToEdge（不再有采样窗口越界这回事）。
 *
 * 旧版滚动的理由（DOM 压掉屏面约 48%）已经不成立：P08 把 `#earned-block` 瘦身、
 * 状态条挪走之后，遮挡问题归 HUD 层解决，屏上内容不再需要「自己走到可见区」。
 * **会动的数字比静止的难读** —— 余额是玩家随时要读的数，它不许动。
 */
const SCROLL_SPEED = 34; // 纹素/秒（20px 字号下约 1.7 字/秒，LED 点阵的可读档）
/** 滚动字幕首尾的空隙（纹素）：从头到尾看全之前有一眼「整句静止」的呼吸位。 */
const SCROLL_GAP = 28;
/** 账本行的字号阶梯：超宽时逐档缩小，**不裁字**（合同：不得静默裁掉单位/数字）。 */
const LEDGER_FONT_SIZES = [20, 17, 14, 12] as const;
/** 字幕停留时长（秒）；到期回到常态行。 */
const SUBTITLE_SECONDS = 6;

const FONT = 'bold 20px "Courier New", monospace';
/**
 * 文字二值化的 alpha 阈值（0~255）。取 **128 = 覆盖率过半**：
 * 20px 粗体的笔画只有 2~3 纹素宽，再高会断笔（尤其「钱包」的细钩），再低等于没做。
 * 调它只需要看一个数：`marqueeReport().distinctColors` 是否仍是调色板那么大。
 */
const CRISP_ALPHA = 128;
const LED_OFF = '#05090a';
/** 扫描线：只压暗横行，**不画纵缝**（纵横都压就是网格）。 */
const SCANLINE = 'rgba(0, 0, 0, 0.35)';
const BRASS = '#ffd88a';
const DIM = '#7f8a76';

export type MarqueeLedger = { balance: number; earned: number };
type SubtitleEntry = { text: string; priority: number; minimum: number };

export class MarqueeScreen {
  readonly texture: THREE.CanvasTexture;

  private readonly ctx: CanvasRenderingContext2D;
  private readonly canvas: HTMLCanvasElement;
  /**
   * 文字专用的离屏层（B：硬边化）。
   *
   * 直接 `fillText` 到主画布上，浏览器会按灰度抗锯齿画边；这块屏最终被**放大 1.36 倍**
   * 显示，灰边就被 Nearest 采样拉成 1~2 像素的软块 —— 用户看到的「糊」有一半是这个。
   * 所以文字先画进这张透明层，按 alpha 阈值二值化（非 0 即 255）再合成：
   * 每个纹素只有「亮 / 灭」两态，正是 LED 点阵该有的样子。
   */
  private readonly scratch: HTMLCanvasElement;
  private readonly scratchCtx: CanvasRenderingContext2D;
  /** 1×1 探针画布：只用来问「这个 CSS 颜色会被写成哪三个整数」。 */
  private readonly probeCtx: CanvasRenderingContext2D;
  /** 当前纹素宽度（高度固定为 `H`，宽度由面板实际宽高比反推）。 */
  private width = DEFAULT_WIDTH;
  private ledger: MarqueeLedger = { balance: 0, earned: 0 };
  private subtitleText = '';
  private subtitleLeft = 0;
  private subtitleMinimumLeft = 0;
  private subtitlePriority = 0;
  private readonly subtitleQueue: SubtitleEntry[] = [];
  private repaintLeft = 0;
  private dirty = true;
  /** 上一次真正画出去的内容（账本行 + 第二行），用来判断「有没有变」——变了才传纹理。 */
  private painted = ['', ''];
  /** 第二行（字幕）的滚动相位（纹素）。0 = 静止。 */
  private scrollPhase = 0;
  /** 当前第二行是否处于滚动态（由 measureText 宽度决定，判据读它）。 */
  private scrolling = false;
  /** 当前账本行的实际内容与是否放得下（判据读它们核对「没被裁字」）。 */
  private ledgerLine = '';
  private ledgerFits = true;
  private ledgerFontSize = 20;

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = this.width;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 2D 画布：招牌显示屏需要 CanvasRenderingContext2D');
    this.canvas = canvas;
    this.ctx = ctx;
    const scratch = document.createElement('canvas');
    scratch.width = this.width;
    scratch.height = H;
    const scratchCtx = scratch.getContext('2d');
    if (!scratchCtx) throw new Error('无法创建 2D 画布：招牌文字二值化需要一张离屏层');
    this.scratch = scratch;
    this.scratchCtx = scratchCtx;
    const probe = document.createElement('canvas');
    probe.width = 1;
    probe.height = 1;
    const probeCtx = probe.getContext('2d', { willReadFrequently: true });
    if (!probeCtx) throw new Error('无法创建 2D 画布：颜色探针需要一张 1×1 离屏层');
    this.probeCtx = probeCtx;
    // 字体在构造时定一次，之后**不**在 paint 里设：绘制层（`drawCrispLine`）只设
    // 颜色与基线，字号由这里给。留在绘制里设的话，第一帧量到的是 10px 默认字体，
    // 而 `distinctColors` 那条判据会照实报出一个「看起来正常」的值 —— 查不到。
    ctx.font = FONT;
    scratchCtx.font = FONT;
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.magFilter = THREE.NearestFilter;
    this.texture.minFilter = THREE.NearestMipmapNearestFilter;
    // V3 UI-001：不再做纹理采样窗口滚动 —— `wrapS` 回到 ClampToEdge，
    // `texture.offset` 恒为 0（判据守「账本行静止」就是守它不动）。
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
  }

  /** 当前纹素尺寸，给判据比对「纹理宽高比 == 面板宽高比」。 */
  get texels(): { width: number; height: number } {
    return { width: this.width, height: H };
  }

  // ── V3 UI-001 的判据读数（账本行静止 / 只滚超宽字幕 / 不裁字） ──

  /** 第二行（字幕）当前是否处于滚动态。 */
  get isScrollingSubtitle(): boolean {
    return this.scrolling;
  }
  /** 账本行的实际内容（tick 算出的渲染串）。 */
  get currentLedgerLine(): string {
    return this.ledgerLine;
  }
  /** 账本行按当前字号是否放得下（false = 已到最小档仍超宽，判据该红）。 */
  get doesLedgerFit(): boolean {
    return this.ledgerFits;
  }
  /** 账本行当前生效的字号（阶梯降档读数）。 */
  get activeLedgerFontSize(): number {
    return this.ledgerFontSize;
  }

  /**
   * 按面板的实际宽高比重算纹素宽度。返回**是否真的变了**。
   *
   * 由 `buildMarqueeScreenMesh()` 在每次建网格时调 —— `?model` 拖檐板尺寸会重建外壳，
   * 而这块画布是单例（见文件末尾），所以比例必须跟着走，不然拉伸会以新的比例回来。
   *
   * 宽度取到 `WIDTH_STEP` 的整数倍：扫描线周期是 4，非整倍会让最右一道线被截断；
   * 由此引入的比例残差 ≤ 2/宽度 ≈ 0.6 %，肉眼与判据都当作 0 处理。
   */
  setAspect(aspect: number): boolean {
    if (!(aspect > 0)) return false;
    const next = Math.max(
      WIDTH_STEP,
      Math.round((H * aspect) / WIDTH_STEP) * WIDTH_STEP,
    );
    if (next === this.width) return false;
    this.width = next;
    this.canvas.width = next;
    // ⚠️ 改 canvas 尺寸会**重置该 2D 上下文的全部状态**（含 font），所以两张画布都要
    // 重新设字体。漏掉的话 `?model` 一拖檐板，屏上的字就会退回 10px 默认字体 ——
    // 零报错，只是字变小，而 `distinctColors` 那条判据照样是干净的个位数。
    this.scratch.width = next;
    this.scratch.height = H;
    this.ctx.font = FONT;
    this.scratchCtx.font = FONT;
    // 改尺寸会清空画布，而 CanvasTexture 只有 `needsUpdate` 才会重传；
    // 两者都要，且 `painted` 必须作废 —— 否则「内容没变」这条快路径会让我们
    // 把一张刚被清空的黑纹理留在显存上（表现：屏闪一帧全黑）。
    this.painted = ['', ''];
    this.dirty = true;
    this.texture.needsUpdate = true;
    return true;
  }

  /**
   * 账本快照。由 `Game.publishHud()` 与 DOM HUD 同时喂 —— 同一个数据源，不可能对不上。
   *
   * 只有「现在能花多少」和「本局赚进」两项。**不带历史最高**：那个数在 HUD 里已经是
   * `Math.max(best, earned)`，屏上再算一遍就是第二份真源（改一处忘一处，且没有任何判据会红）。
   */
  pushLedger(ledger: MarqueeLedger): void {
    if (ledger.balance === this.ledger.balance && ledger.earned === this.ledger.earned) return;
    this.ledger = { ...ledger };
    this.dirty = true;
  }

  /** Important results get a reading window; decoration and ordinary messages wait their turn. */
  subtitle(text: string, meta?: Pick<NotificationMeta, 'priority' | 'minVisibleSeconds'>): void {
    if (!text) return;
    const entry: SubtitleEntry = { text, priority: meta?.priority ?? 0, minimum: Math.max(0, meta?.minVisibleSeconds ?? 0) };
    if (text === this.subtitleText && this.subtitleLeft > 0) {
      this.subtitlePriority = Math.max(this.subtitlePriority, entry.priority);
      this.subtitleMinimumLeft = Math.max(this.subtitleMinimumLeft, entry.minimum);
      this.subtitleLeft = Math.max(SUBTITLE_SECONDS, this.subtitleLeft, entry.minimum);
      return;
    }
    const duplicate = this.subtitleQueue.find(item => item.text === text);
    if (duplicate) {
      duplicate.priority = Math.max(duplicate.priority, entry.priority);
      duplicate.minimum = Math.max(duplicate.minimum, entry.minimum);
      this.subtitleQueue.sort((a, b) => b.priority - a.priority);
      return;
    }
    if (this.subtitleLeft <= 0 || (this.subtitleMinimumLeft <= 0 &&
      (entry.priority > this.subtitlePriority || (entry.priority === 0 && this.subtitlePriority === 0)))) {
      this.presentSubtitle(entry);
      return;
    }
    this.subtitleQueue.push(entry);
    this.subtitleQueue.sort((a, b) => b.priority - a.priority);
    this.subtitleQueue.length = Math.min(4, this.subtitleQueue.length);
  }

  private presentSubtitle(entry: SubtitleEntry): void {
    this.subtitleText = entry.text;
    this.subtitlePriority = entry.priority;
    this.subtitleMinimumLeft = entry.minimum;
    this.subtitleLeft = Math.max(SUBTITLE_SECONDS, entry.minimum);
    this.scrollPhase = 0;
    this.dirty = true;
  }

  resetSubtitles(): void {
    this.subtitleText = '';
    this.subtitleLeft = 0;
    this.subtitleMinimumLeft = 0;
    this.subtitlePriority = 0;
    this.subtitleQueue.length = 0;
    this.scrollPhase = 0;
    this.dirty = true;
  }

  subtitleReport(): { text: string; priority: number; remaining: number; minimumRemaining: number; queued: number } {
    return { text: this.subtitleLeft > 0 ? this.subtitleText : '', priority: this.subtitleLeft > 0 ? this.subtitlePriority : 0,
      remaining: this.subtitleLeft, minimumRemaining: this.subtitleMinimumLeft, queued: this.subtitleQueue.length };
  }

  /**
   * 每帧推进。
   *
   * @param delta 秒
   * @param attract 常态行（没有字幕时显示什么）—— 由调用方给，
   *   因为「这台机器现在该说什么」是玩法层的事，不是这块屏的事。
   */
  tick(delta: number, attract: string): void {
    const previousSubtitle = this.subtitleLeft > 0 ? this.subtitleText : '';
    this.subtitleMinimumLeft = Math.max(0, this.subtitleMinimumLeft - delta);
    if (this.subtitleLeft > 0) {
      this.subtitleLeft = Math.max(0, this.subtitleLeft - delta);
    }
    const next = this.subtitleQueue[0];
    if (next && (this.subtitleLeft <= 0 || (this.subtitleMinimumLeft <= 0 && next.priority > this.subtitlePriority))) {
      this.subtitleQueue.shift();
      this.presentSubtitle(next);
    }
    const line2 = this.subtitleLeft > 0 ? this.subtitleText : attract;
    if (previousSubtitle !== (this.subtitleLeft > 0 ? this.subtitleText : '')) this.dirty = true;

    // 账本行：先定内容再量宽。字号阶梯只在「放不下」时降档 —— 平时不动，
    // 免得数字跳动时字号跟着跳。放不下且已到最小档：如实把 ledgerFits 记成 false
    //（判据会红），**不静默裁字**。
    const top = this.line1();
    this.ledgerLine = top;
    this.ledgerFontSize = LEDGER_FONT_SIZES[0];
    let fits = false;
    for (const size of LEDGER_FONT_SIZES) {
      this.ledgerFontSize = size;
      if (this.measureWidth(top, size) <= this.width - 16) {
        fits = true;
        break;
      }
    }
    this.ledgerFits = fits;

    // 第二行：只有**量出来真的超宽**才滚（合同：短字幕静止）。
    // 滚动相位按纹素推进；重绘节流沿用 MIN_INTERVAL —— LED 点阵 8 fps 本来就是
    // 它的刷新率，滚动重绘的代价 ≈64 KB/次，远低于旧版每帧 2 MB 的反面教材。
    const overwide = this.measureWidth(line2, 20) > this.width - 16;
    this.scrolling = overwide;
    if (overwide) {
      const loop = this.measureWidth(line2, 20) + SCROLL_GAP;
      this.scrollPhase = (this.scrollPhase + delta * SCROLL_SPEED) % loop;
      this.dirty = true; // 滚动期间内容每帧都在变
    } else {
      this.scrollPhase = 0;
    }

    this.repaintLeft -= delta;
    if (!this.dirty || this.repaintLeft > 0) return;
    // 脏位可能只是「同一个数被重复推了一遍」——真传纹理前再比一次内容。
    //（滚动态相位每帧在变，比较值带相位，保证滚动不会被这条快路径吃掉。）
    if (!overwide && top === this.painted[0] && line2 === this.painted[1]) {
      this.dirty = false;
      return;
    }
    this.paint(top, line2, overwide);
    this.repaintLeft = MIN_INTERVAL;
  }

  /** 第一行：钱包 / 本段赚进。数字用千分位以外的一致性格式——点阵上逗号会糊。 */
  private line1(): string {
    return `余额 ${this.ledger.balance}  本段 +${this.ledger.earned}`;
  }

  /** 量某段文字在某字号下的纹素宽（画在二值化离屏层的同一套字体栈上）。 */
  private measureWidth(text: string, size: number): number {
    // 离屏层的 font 每次 measure 都要显式设：measureText 读的是**当前** font。
    this.scratchCtx.font = `bold ${size}px "Courier New", monospace`;
    const w = this.scratchCtx.measureText(text).width;
    this.scratchCtx.font = FONT;
    return w;
  }

  /**
   * 上一次重画之后，画布里**出现过的不同颜色数**。
   *
   * 这是「字为什么糊」的直接度量：一块只有开关两态的 LED 面板，颜色数应该等于
   * 调色板大小（底色、扫描线暗底、字色…个位数）。字体抗锯齿每多一档灰边，
   * 这个数就往上翻 —— 所以它能在肉眼看图之前先告诉我们「有没有中间灰」。
   */
  get distinctColors(): number {
    return this.paletteSize;
  }

  private paletteSize = 0;

  /** 数一遍画布上的不同颜色（含 alpha 通道，所以半透的 AA 边一定会被算进去）。 */
  private measurePalette(): void {
    const data = this.ctx.getImageData(0, 0, this.width, H).data;
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      seen.add(
        (data[i] << 24) | (data[i + 1] << 16) | (data[i + 2] << 8) | data[i + 3],
      );
      if (seen.size > 4096) break; // 只需要知道「已经爆了」，不必数完
    }
    this.paletteSize = seen.size;
  }

  /**
   * 把 CSS 颜色解析成**浏览器真正会写进画布**的整数 RGB（缓存）。
   *
   * 为什么不自己解析 `#rrggbb`：我们要的是「画出来的那个值」，而不是「我以为的值」——
   * 颜色字符串以后若改成 `rgb()`、命名色或带 alpha，手写解析就悄悄错了。
   * 1×1 画布问一次是最省事且永远正确的做法。
   *
   * ★ 探针必须是**独立的一张**，不能借 scratch：`save()/restore()` 只回滚上下文状态，
   *   **不回滚像素**，借用的话会在左上角留下一个 1×1 杂点（表现：屏角多一颗常亮 LED）。
   */
  private readonly rgbCache = new Map<string, [number, number, number]>();

  private exactRGB(color: string): [number, number, number] {
    const cached = this.rgbCache.get(color);
    if (cached) return cached;
    const ctx = this.probeCtx;
    ctx.globalCompositeOperation = 'copy';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    ctx.clearRect(0, 0, 1, 1);
    const rgb: [number, number, number] = [data[0], data[1], data[2]];
    this.rgbCache.set(color, rgb);
    return rgb;
  }

  /**
   * 画一行**硬边**文字（B）。
   *
   * 先画进离屏层 → 按 alpha 阈值二值化 → 合成回主画布。中间灰度全被抹掉，
   * 于是放大 1.36 倍之后每个纹素非亮即灭，不再有一圈被拉成块的软边。
   *
   * 为什么不在主画布上直接阈值整张图：那会连底噪、扫描线的半透明叠加一起量化，
   * 等于顺手改了别的层的效果；只处理文字层，改动面正好是被审的那一件事。
   *
   * ★ 保留下来的像素**连 RGB 一起钉成填充色**（不只是 alpha 二值化）：
   * 光栅化器在高覆盖率（≥ 阈值）的边上仍会给出与填充色差 ±1~2 的 RGB，
   * 只处理 alpha 的话这些像素会带着各自的色值留在画布里 ——
   * 实测那样画布上是 **9** 种颜色而不是 3 种。一层只有一个填充色，
   * 那就让它只有那一个颜色，`distinctColors` 也因此变成真正可断言的数。
   */
  private drawCrispLine(text: string, color: string, y: number, x = 8, fontPx = 20): void {
    const scratch = this.scratchCtx;
    scratch.clearRect(0, 0, this.width, H);
    scratch.font = `bold ${fontPx}px "Courier New", monospace`;
    scratch.fillStyle = color;
    scratch.textBaseline = 'middle';
    scratch.fillText(text, x, y);
    const [r, g, b] = this.exactRGB(color);
    const image = scratch.getImageData(0, 0, this.width, H);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] >= CRISP_ALPHA) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      } else {
        data[i + 3] = 0;
      }
    }
    scratch.putImageData(image, 0, 0);
    this.ctx.drawImage(this.scratch, 0, 0);
    // 画完把 font 恢复成基准档：measure 与后续绘制的字号假设都建立在它上。
    scratch.font = FONT;
  }

  private paint(top: string, bottom: string, scrollBottom: boolean): void {
    const ctx = this.ctx;
    ctx.fillStyle = LED_OFF;
    ctx.fillRect(0, 0, this.width, H);
    ctx.textBaseline = 'middle';
    // ★ C：扫描线**先画**，文字后画盖在它上面。
    //
    // 原来的顺序是文字 → 扫描线，于是每 4 行有一道 35% 的暗带**横切笔画**：
    // 在 1.36 倍放大下暗带约 1.36 像素高、周期 5.4 像素，正好把每一根竖向笔画
    // 锯成短截 —— B 辛苦去掉的灰边，被这一刀换成了「断续」。用户说的
    // 「扫描线我也觉得很模糊」指的就是它。
    //
    // 换顺序不是削弱效果：扫描线表达的是**发光面板**的横纹，它本该只作用在底色上 ——
    // LED 点亮的时候不会被自己面板的扫描线切掉。所以这一改同时修掉观感与物理含义。
    this.paintScanlines();
    // 屏现在铺满檐板 ⇒ 没有第二行时把唯一一行**垂直居中**，
    // 否则上半屏有字、下半屏一片空黑，看着像坏了一半。
    // 账本行字号由 tick() 的阶梯选出（超宽降档，不裁字）。
    this.drawCrispLine(top, BRASS, bottom ? 18 : H / 2, 8, this.ledgerFontSize);
    if (bottom) {
      // 滚动的字幕从**右缘外**进场（首尾各留 SCROLL_GAP 的空隙），静置的字幕照常贴左。
      const x = scrollBottom ? this.width - this.scrollPhase : 8;
      this.drawCrispLine(bottom, DIM, 44, x, 20);
    }
    // 不再画压圈边框：屏已经铺满檐板的平坦区，檐板自己的倒角就是它的框。
    // （原先那条 2px 实线还被点阵缝隙横穿、切成了一段段的「虚线框」——
    //  缝隙去掉后它顶多变成实线，而实线也不是想要的。）
    this.measurePalette();
    this.painted = [top, bottom];
    this.dirty = false;
    this.texture.needsUpdate = true;
  }

  /** 扫描线：每隔一行压暗一道横纹，做出「发光面板」的条纹；**不画纵缝**（那就是网格）。 */
  private paintScanlines(): void {
    const ctx = this.ctx;
    ctx.fillStyle = SCANLINE;
    for (let y = 2; y < H; y += 4) ctx.fillRect(0, y, this.width, 1);
  }
}

let singleton: MarqueeScreen | null = null;

/**
 * 模块单例。
 *
 * `?model` 模型模式每改一次参数就重建外壳（见 `disposeCabinetShell`），
 * 屏的**几何**跟着重建，但这块画布与纹理只有一份 ——
 * 否则每拖一次滑块就多一张常驻纹理，而且旧数字还会在
 * 新网格上闪一帧。
 */
export function marqueeScreen(): MarqueeScreen {
  if (!singleton) singleton = new MarqueeScreen();
  return singleton;
}
