import type { EndlessConfig } from '../game/endless';
import type { BetTier } from '../game/economy';
import type { ClimaxTone } from '../game/kinds';
import type { FlyTier } from '../game/feedback';
import { MECHANISM_COST, type Mechanisms } from './Mechanisms';
import { cabinetSkinById, type CabinetSkin } from '../game/cosmetics';
import { mountUiIcons, uiIconMarkup, type UiIconId } from '../game/uiIcons';
import { waveTarget } from '../game/waves';
import type { RunSnapshot } from './RunState';
import type { ShowProgress } from './ShowDirector';
import { closingLine, tauntFor } from './Taunts';

export type MechanismSnapshot = {
  sweeper: number;
  grapple: number;
  reload: number;
};

/** Display-only history events; amount is an actual ledger result, never an estimate. */
export type HudEvent = {
  text: string;
  kind?: string;
  amount?: number;
  mergeKey?: string;
  at?: number;
};
export type MechanismUiState = {
  blockedReason: string | null;
  boostPhase: 'empty' | 'ready' | 'pending' | 'stroke' | 'complete';
  /** Live unreserved coin-pool capacity, supplied by Game; not a second budget. */
  coinsRemaining?: number;
};
export type MechanismPreviewProjection = {
  id: 'sweeper' | 'grapple';
  /** Four screen points in game-stage CSS pixels; Game owns all world projection. */
  corners: Array<{ x: number; y: number }>;
  area: Pick<ReturnType<Mechanisms['preview']>, 'x' | 'z' | 'width' | 'depth' | 'bottomY'>;
  projectionY: number;
  targetCount: number;
  phase?: 'aim' | 'prepare' | 'descend';
};

type HistoryEvent = HudEvent & { kind: string; at: number; count: number };
type Toast = { text: string; kind: string; priority: number; minVisibleSeconds: number };

/** 破产弹窗 / 本局结算卡片的内容。 */
export type RuinPayload = {
  /** 本局越线赚进的筹码（不含跪求赏赐）。 */
  earned: number;
  /**
   * 结算瞬间的余额。★ S4：它与 `balance` 是**同一个数**（合并账户之后没有「桌上的」与
   * 「钱包里的」之分了），保留两个字段只因为卡片要分别印「本局赚进/当前余额」与「峰值」，
   * 而 `chipsPeak` 是历史峰值、与余额不同源。
   */
  chips: number;
  /**
   * 当前余额。
   * ★ S4：`cashOut`（可回存额）这个字段**随「回存」这个动作一起删除** ——
   *   钱从头到尾都在同一个账户里，没有"能带走多少"这回事了。
   */
  balance: number;
  drops: number;
  chipsPeak: number;
  begs: number;
  totalBegs: number;
  best: number;
  runs: Array<{ earned: number; drops: number; begs: number }>;
  grant: number;
  /** true 表示这是「保留尊严，收工」后的总结，不再显示跪求按钮。 */
  summary?: boolean;
  /**
   * 贷款续玩的一笔报价（S3）。**缺省 = 不给贷款**（结算卡片就走这条：本局已经结束，
   * 借钱没有对象）。刻意传数据而不是加一个 `payload.mode` ——
   * 行级 gating 沿用上面 `summary` 的既有形状，不发明第二套分支轴。
   */
  loan?: { amount: number; available: boolean; debt: number; ceiling: number };
};

/** XIXI 四槽的字形（点亮面板与无障碍标签共用）。 */
const XIXI_GLYPHS = ['X', 'I', 'X', 'I'];

/**
 * HUD 只读快照并写 DOM，不持有任何游戏状态。
 *
 * v3 起只有无尽这一种玩法：没有目标进度条、星级与循环警告，
 * 破产弹窗（嘲讽 + 跪求 / 收工）是唯一的结算界面。
 */
export class Hud {
  private readonly levelLabel = this.el('#level-label');
  private readonly earnedValue = this.el('#earned-value');
  private readonly bestValue = this.el('#best-value');
  private readonly creditsValue = this.el('#credits-value');
  private readonly statusSlot = this.el('#status-slot');
  private readonly statusLine = this.el('#status-line');
  private readonly comboToast = this.el('#combo-toast');
  private readonly markNote = this.el('#mark-note');
  private readonly debtLine = this.el('#debt-line');
  private readonly debtNote = this.el('#debt-note');
  /**
   * XIXI 集章的容器。
   *
   * ⚠️ **四槽的亮灭不在这里画。** 它们已经内嵌进 3D 模型（推板前缘的四段标牌，
   * 见 `Pusher.buildXixiLanes`），HUD 只负责一行进度文字。
   * 早先这里还有四个 DOM 圆点，与 3D 标牌叠在同一处屏幕上，两套同样的东西互相打架。
   */
  private readonly channelMarks = this.el('#xixi-marks');
  private readonly dropButton = this.el<HTMLButtonElement>('#drop-button');
  private readonly dropState = this.el('#drop-state');
  private readonly boostButton = this.el<HTMLButtonElement>('#boost-button');
  private readonly boostState = this.el('#boost-state');
  private readonly pauseButton = this.el<HTMLButtonElement>('#pause-button');
  private readonly pausePanel = this.el('#pause-panel');
  private readonly drainPrompt = this.el('#drain-prompt');
  private readonly climaxFlash = this.el('#climax-flash');
  private readonly hud = this.el('#hud');
  private readonly app = this.el('#app');
  private readonly stageOverlays = this.el('#stage-overlays');
  private readonly mechanismPreview = this.el('#mechanism-preview');
  private readonly previewSvg = this.mechanismPreview.querySelector<SVGSVGElement>('svg')!;
  private readonly previewPolygon = this.previewSvg.querySelector<SVGPolygonElement>('polygon')!;
  private readonly previewLabel = this.el('#mechanism-preview-label');
  private readonly previewName = this.el('#mechanism-preview-name');
  private readonly previewCount = this.el('#mechanism-preview-count');
  private previewHover: 'sweeper' | 'grapple' | null = null;
  private previewFocus: 'sweeper' | 'grapple' | null = null;
  private previewChanged: () => void = () => {};
  private readonly previewInputCleanup: Array<() => void> = [];
  private readonly actionInputCleanup: Array<() => void> = [];
  private readonly rewardStageLabel = document.createElement('div');
  private readonly xixiCollectionTokens = Array.from({ length: 4 }, () => document.createElement('i'));
  private readonly eventList = this.el('#event-list');
  private readonly eventPanel = this.el('#event-panel');
  private readonly eventToggle = this.el<HTMLButtonElement>('#event-toggle-button');
  private readonly eventClose = this.el<HTMLButtonElement>('#event-close-button');
  private readonly eventBackdrop = this.el('#event-backdrop');
  private eventsOpen = false;
  private readonly onEventsKey = (event: KeyboardEvent): void => {
    if (!this.eventsOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      this.closeEvents();
    } else if (event.key === 'Tab') {
      event.preventDefault();
      this.eventClose.focus();
    } else {
      // Game shortcuts must not consume keyboard actions aimed at the open dialog.
      event.stopPropagation();
    }
  };
  private readonly onEventsResize = (): void => {
    if (window.innerWidth >= 1100 && this.eventsOpen) this.closeEvents();
    this.placeStatusSlot();
  };
  private readonly onEventsOpen = (): void => this.openEvents();
  private readonly onEventsClose = (): void => this.closeEvents();
  private readonly onStatusKey = (event: KeyboardEvent): void => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Space'].includes(event.code)) {
      // Let the focused notice scroll without turning its reading keys into gameplay inputs.
      event.stopPropagation();
    }
  };
  private readonly rewardButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-reward-open]')];
  private readonly history: HistoryEvent[] = [];
  private toast: Toast | null = null;
  private readonly toastQueue: Toast[] = [];
  private toastTimer: number | null = null;
  private minimumReadUntil = 0;
  private toastExpiresAt = 0;
  private rewardPending = false;
  private rewardBusy = false;
  private lastRewardSignature = '';
  private readonly rewardDescriptions = [...document.querySelectorAll<HTMLElement>('[data-reward-description]')];
  private readonly rewardFills = [...document.querySelectorAll<HTMLElement>('[data-reward-fill]')];
  private readonly rewardProgressBars = [...document.querySelectorAll<HTMLElement>('.reward-progress')];
  private readonly rewardWaveLabels = [...document.querySelectorAll<HTMLElement>('[data-reward-wave]')];
  private readonly rewardTicketLabels = [...document.querySelectorAll<HTMLElement>('[data-reward-tickets]')];
  private readonly sweeperButton = this.el<HTMLButtonElement>('#sweeper-button');
  private readonly sweeperState = this.el('#sweeper-state');
  private readonly grappleButton = this.el<HTMLButtonElement>('#grapple-button');
  private readonly grappleState = this.el('#grapple-state');
  private readonly reloadButton = this.el<HTMLButtonElement>('#reload-button');
  private readonly reloadState = this.el('#reload-state');
  private readonly betButton = this.el<HTMLButtonElement>('#bet-button');
  private readonly betState = this.el('#bet-state');
  private readonly ruinPanel = this.el('#ruin-panel');
  private readonly ruinTitle = this.el('#ruin-title');
  private readonly ruinTaunt = this.el('#ruin-taunt');
  private readonly ruinStats = this.el('#ruin-stats');
  private readonly ruinBoard = this.el('#ruin-board');
  private readonly begButton = this.el<HTMLButtonElement>('#beg-button');
  private readonly loanButton = this.el<HTMLButtonElement>('#loan-button');

  private lastComboShown = 0;
  private lastBoostCharges = 0;
  private rewardBlockedReason: string | null = null;
  /**
   * XIXI `aria-label` 的签名。四槽亮灭没变就不必重建那串 `X已亮 I未亮 …` ——
   * 它在每帧路径上做一次 `map` + `join`，而四槽平均几秒才变一次。
   */
  private lastXixiSignature = -1;
  /** 后装填的提示只跟配置走、不跟帧走 ⇒ 算一次，别每帧拼同一个模板。 */
  private readonly reloadHint = `${MECHANISM_COST.reload} 筹码 · +3 枚`;

  constructor() {
    mountUiIcons();
    this.applyTheme(cabinetSkinById('classic'));
    this.rewardStageLabel.id = 'reward-stage-label';
    this.rewardStageLabel.hidden = true;
    this.rewardStageLabel.setAttribute('role', 'status');
    this.rewardStageLabel.style.cssText = 'position:absolute;transform:translate(-50%,-100%);pointer-events:none;padding:4px 8px;border:1px solid var(--ui-reward,#ffd88a);background:#101726;color:var(--ui-reward,#ffd88a);font:bold 13px monospace;white-space:nowrap;border-radius:4px;z-index:6';
    this.stageOverlays.append(this.rewardStageLabel);
    for (const [index, token] of this.xixiCollectionTokens.entries()) {
      token.className = 'xixi-collection-token';
      token.textContent = XIXI_GLYPHS[index];
      token.setAttribute('aria-hidden', 'true');
      token.hidden = true;
      token.style.cssText = 'position:absolute;pointer-events:none;color:#fff4b7;background:var(--ui-reward,#d8b25c);border:1px solid #fff4b7;border-radius:3px;padding:2px 5px;font:bold 13px monospace;font-style:normal;box-shadow:0 0 12px var(--ui-reward,#d8b25c);z-index:6';
      this.stageOverlays.append(token);
    }
    this.bindEventDrawer();
    this.bindPreviewInputs();
    this.placeStatusSlot();
    this.statusLine.addEventListener('keydown', this.onStatusKey);
  }

  /** Keep notice space inside a UI surface so it never covers the physical collection mouth. */
  private placeStatusSlot(): void {
    const target = this.el(window.innerWidth >= 1100 ? '#hud-top' : '#hud-bottom');
    if (this.statusSlot.parentElement === target) return;
    if (window.innerWidth >= 1100) target.append(this.statusSlot);
    else target.prepend(this.statusSlot);
  }

  bindMechanismPreview(handler: () => void): void { this.previewChanged = handler; }

  /** Phone selection and active-show ownership come from Game, rather than sticky touch focus. */
  mechanismPreviewRequest(): 'sweeper' | 'grapple' | null {
    return window.innerWidth >= 768 ? this.previewHover ?? this.previewFocus : null;
  }

  private bindPreviewInputs(): void {
    for (const [id, button] of [['sweeper', this.sweeperButton], ['grapple', this.grappleButton]] as const) {
      const enter = (event: PointerEvent): void => {
        if (event.pointerType === 'touch') return;
        this.previewHover = id;
        this.previewChanged();
      };
      const leave = (): void => {
        if (this.previewHover === id) this.previewHover = null;
        this.previewChanged();
      };
      const focus = (): void => { this.previewFocus = id; this.previewChanged(); };
      const blur = (): void => {
        if (this.previewFocus === id) this.previewFocus = null;
        this.previewChanged();
      };
      button.addEventListener('pointerenter', enter);
      button.addEventListener('pointerleave', leave);
      button.addEventListener('focus', focus);
      button.addEventListener('blur', blur);
      this.previewInputCleanup.push(() => {
        button.removeEventListener('pointerenter', enter);
        button.removeEventListener('pointerleave', leave);
        button.removeEventListener('focus', focus);
        button.removeEventListener('blur', blur);
      });
    }
  }

  showMechanismPreview(preview: MechanismPreviewProjection | null): void {
    const finite = preview && preview.corners.length === 4 && preview.corners.every(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    this.mechanismPreview.hidden = !finite;
    if (!preview || !finite) {
      this.sweeperButton.removeAttribute('aria-describedby');
      this.grappleButton.removeAttribute('aria-describedby');
      return;
    }
    const stage = this.stageOverlays;
    this.setAttribute(this.previewSvg, 'viewBox', `0 0 ${stage.clientWidth} ${stage.clientHeight}`);
    this.setAttribute(this.previewPolygon, 'points', preview.corners.map(point => `${point.x},${point.y}`).join(' '));
    for (const [key, value] of Object.entries({
      mechanism: preview.id, phase: preview.phase ?? 'aim', targetCount: preview.targetCount,
      projectionY: preview.projectionY, ...preview.area,
    })) this.setAttribute(this.mechanismPreview, `data-${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, String(value));
    const name = preview.id === 'sweeper' ? '扫板范围' : '抓取范围 · 不按高度筛选';
    const count = preview.phase && preview.phase !== 'aim'
      ? `本次选中 ${preview.targetCount} 枚 · ${preview.phase === 'descend' ? '下降确认中' : '准备执行'}`
      : `范围内 ${preview.targetCount} 枚${preview.targetCount === 0 ? ' · 当前无目标' : ''}`;
    this.setText(this.previewName, name);
    this.setText(this.previewCount, count);
    this.setAttribute(this.mechanismPreview, 'aria-label', `${name}，${count}`);
    this.setAttribute(preview.id === 'sweeper' ? this.sweeperButton : this.grappleButton, 'aria-describedby', 'mechanism-preview-label');
    (preview.id === 'sweeper' ? this.grappleButton : this.sweeperButton).removeAttribute('aria-describedby');
    const xs = preview.corners.map(point => point.x);
    const ys = preview.corners.map(point => point.y);
    const halfLabel = this.previewLabel.offsetWidth / 2;
    const x = Math.max(halfLabel + 6, Math.min(stage.clientWidth - halfLabel - 6, (Math.min(...xs) + Math.max(...xs)) / 2));
    const y = Math.max(6, Math.min(stage.clientHeight - this.previewLabel.offsetHeight - 6, Math.min(...ys) - this.previewLabel.offsetHeight - 7));
    this.previewLabel.style.left = `${x}px`;
    this.previewLabel.style.top = `${y}px`;
  }

  showRewardProgress(progress: ShowProgress | null, anchor?: { x: number; y: number }): void {
    this.rewardStageLabel.hidden = !progress || !anchor;
    if (!progress || !anchor) return;
    const done = progress.finished || progress.spawned === progress.promised;
    this.setText(this.rewardStageLabel, `${progress.label} · ${done ? '实发' : '交付'} ${progress.spawned}/${progress.promised}`);
    this.rewardStageLabel.dataset.spawned = String(progress.spawned);
    this.rewardStageLabel.dataset.promised = String(progress.promised);
    this.rewardStageLabel.dataset.finished = String(done);
    this.rewardStageLabel.style.left = `${anchor.x}px`;
    this.rewardStageLabel.style.top = `${anchor.y}px`;
  }

  showXixiCollection(sources: Array<{ x: number; y: number }>, target: { x: number; y: number }, progress: number, reduced: boolean): void {
    for (const [index, token] of this.xixiCollectionTokens.entries()) {
      token.hidden = reduced || progress < 0 || progress >= 1;
      if (token.hidden) continue;
      const t = Math.max(0, Math.min(1, (progress - index * 0.035) / 0.8));
      const ease = 1 - (1 - t) ** 3;
      const source = sources[index];
      token.style.left = `${source.x + (target.x - source.x) * ease}px`;
      token.style.top = `${source.y + (target.y - source.y) * ease - Math.sin(t * Math.PI) * 8}px`;
      token.style.opacity = String(Math.min(1, (1 - progress) / 0.12));
      token.style.transform = `translate(-50%,-50%) scale(${1 - t * 0.28})`;
    }
  }

  private bindEventDrawer(): void {
    this.eventToggle.addEventListener('click', this.onEventsOpen);
    this.eventClose.addEventListener('click', this.onEventsClose);
    this.eventBackdrop.addEventListener('click', this.onEventsClose);
    this.eventPanel.addEventListener('keydown', this.onEventsKey);
    window.addEventListener('resize', this.onEventsResize);
  }

  openEvents(): void {
    if (window.innerWidth >= 1100) return;
    this.eventsOpen = true;
    this.app.dataset.eventsOpen = 'true';
    this.eventPanel.setAttribute('role', 'dialog');
    this.eventPanel.setAttribute('aria-modal', 'true');
    this.eventToggle.setAttribute('aria-expanded', 'true');
    this.eventBackdrop.hidden = false;
    this.eventClose.focus();
  }

  closeEvents(): void {
    this.eventsOpen = false;
    delete this.app.dataset.eventsOpen;
    this.eventPanel.setAttribute('role', 'region');
    this.eventPanel.removeAttribute('aria-modal');
    this.eventToggle.setAttribute('aria-expanded', 'false');
    this.eventBackdrop.hidden = true;
    if (this.eventToggle.getClientRects().length > 0) this.eventToggle.focus();
  }

  /** Theme all interface surfaces in the same transaction as the 3D cabinet. */
  applyTheme(skin: CabinetSkin): void {
    this.app.dataset.cabinetSkin = skin.id;
    const draftIcons: Array<[string, UiIconId, string]> = [
      ['boostPack', 'boost', skin.ui.boost],
      ['mechanicCharge', 'grapple', skin.ui.grapple],
      ['ticketLens', 'ticket', skin.ui.reward],
    ];
    for (const [effect, icon, color] of draftIcons) {
      const svg = uiIconMarkup(icon).replaceAll('currentColor', color);
      this.app.style.setProperty(`--ui-draft-${effect}`, `url("data:image/svg+xml,${encodeURIComponent(svg)}")`);
    }
    for (const [name, color] of Object.entries(skin.ui)) {
      const token = name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      this.app.style.setProperty(`--ui-${token}`, color);
    }
  }

  /** Keep all Game action closures removable when the same DOM is reused. */
  private bindActionClick(button: HTMLElement, handler: () => void): void {
    const listener = (event: Event): void => {
      event.preventDefault();
      handler();
    };
    button.addEventListener('click', listener);
    this.actionInputCleanup.push(() => button.removeEventListener('click', listener));
  }

  bindDraftOpen(handler: () => void): void {
    for (const button of this.rewardButtons) {
      this.bindActionClick(button, () => {
        if (this.rewardPending && !this.rewardBusy) handler();
      });
    }
  }

  bindDraftClose(handler: () => void): void {
    this.bindActionClick(this.el('#draft-close-button'), handler);
  }

  /** A ready reward remains visible while a show finishes; no automatic modal interruption. */
  setRewardAvailability(pending: boolean, busy: boolean, blockedReason: string | null = null): void {
    if (this.rewardPending === pending && this.rewardBusy === busy && this.rewardBlockedReason === blockedReason) return;
    this.rewardPending = pending;
    this.rewardBusy = busy;
    this.rewardBlockedReason = blockedReason;
    for (const button of this.rewardButtons) {
      button.disabled = !pending || busy;
      button.dataset.ready = String(pending);
      const label = blockedReason === '本局已经结束' ? '本局已结束' : blockedReason?.startsWith('盘面沉降') ? '沉降中，稍后领取' :
        pending ? (busy ? '演出结束后领取' : '领取三选一') : '下一档奖励';
      this.setText(button, label);
      this.setAttribute(button, 'title', blockedReason ?? '主动打开三选一；选择时暂停，收起后继续推币');
      this.setAttribute(button, 'aria-label', blockedReason ?? '领取本波三选一奖励');
    }
  }

  recordEvent(event: HudEvent): void {
    // Zero coin payouts keep their scene feedback. A fine/jackpot result of
    // zero remains an independent event, so even a zero-balance carrot is clear.
    if (event.amount === 0 && event.kind === 'score') {
      // announce supplies its exact result after setStatus; discard its provisional zero entry too.
      const provisional = this.history[0];
      if (provisional?.text === event.text && provisional.amount === undefined && Date.now() - provisional.at < 1200) {
        this.history.shift();
        this.renderEvents();
      }
      return;
    }
    const at = event.at ?? Date.now();
    const kind = event.kind === 'danger' ? 'fine' : event.kind ?? 'info';
    const last = this.history[0];
    const smallScore = kind === 'score' && (event.amount ?? 0) > 0 && (event.amount ?? 0) < 5;
    const key = event.mergeKey ?? (smallScore ? 'small-score' : undefined);
    if (last && key && last.mergeKey === key && at - last.at <= 1500) {
      last.amount = (last.amount ?? 0) + (event.amount ?? 0);
      last.at = at;
      last.count += 1;
      last.text = kind === 'score' ? `连续入账 · ${last.count} 次落币` : event.text;
    } else if (last && last.text === event.text && last.kind === kind && at - last.at < 1200) {
      if (event.amount !== undefined) last.amount = event.amount;
      this.renderEvents();
      return;
    } else {
      this.history.unshift({ ...event, kind, at, mergeKey: key, count: 1 });
      this.history.length = Math.min(this.history.length, 5);
    }
    this.renderEvents();
  }

  private renderEvents(): void {
    const icons: Record<string, UiIconId> = {
      score: 'coin', fine: 'event', danger: 'event', jackpot: 'ticket', reward: 'ticket', refill: 'reload', mechanism: 'grapple', boost: 'boost',
    };
    const rows = this.history.map((event) => {
      const row = document.createElement('li');
      row.className = 'event-row';
      row.dataset.kind = event.kind;
      const icon = document.createElement('i');
      icon.className = 'event-icon';
      icon.innerHTML = uiIconMarkup(icons[event.kind] ?? 'event');
      icon.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('div');
      const title = document.createElement('p');
      if (event.amount !== undefined) {
        const amount = document.createElement('strong');
        amount.textContent = `${event.amount >= 0 ? '+' : ''}${event.amount} `;
        title.append(amount);
      }
      title.append(document.createTextNode(event.text));
      title.title = event.text;
      const time = document.createElement('time');
      const seconds = Math.max(0, Math.floor((Date.now() - event.at) / 1000));
      time.textContent = seconds < 60 ? '刚刚' : `${Math.floor(seconds / 60)} 分钟前`;
      time.dateTime = new Date(event.at).toISOString();
      copy.append(title, time);
      row.append(icon, copy);
      return row;
    });
    if (rows.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'event-empty';
      empty.textContent = '投币点亮 XIXI，好戏即将开始';
      rows.push(empty);
    }
    this.eventList.replaceChildren(...rows);
  }

  /**
   * 文本真的变了才写 DOM（沿用本文件既有的 `lastComboShown` / `lastBoostCharges` 脏检查范式）。
   *
   * `update()` 每帧被调用，而这些字符串在绝大多数帧里逐字不变；值仍然**全部**从传进来的
   * snapshot 现算 ⇒ 这不是"界面自己存了一份状态"的第二真源，只是省掉重复的 set。
   * ⚠️ 故意**不节流**：读 DOM 文本的判据（`save-migration.spec.ts:281-282`、
   *    `verify-game.mjs` 的 accept ① —— 它现读 `#credits-value` 的文本，行号会漂所以按门名指）
   *    要求"这一帧的值这一帧就能读到"。
   */
  private setText(node: { textContent: string | null }, text: string): void {
    if (node.textContent === text) return;
    node.textContent = text;
  }

  private setAttribute(
    node: {
      getAttribute(qualifiedName: string): string | null;
      setAttribute(qualifiedName: string, value: string): void;
    },
    name: string,
    value: string,
  ): void {
    if (node.getAttribute(name) === value) return;
    node.setAttribute(name, value);
  }

  bindPauseToggle(handler: () => void): void {
    this.bindActionClick(this.pauseButton, handler);
    this.bindActionClick(this.el('#resume-button'), handler);
  }

  /**
   * 画质锁按钮（暂停面板里）。放在暂停面板而不是常驻 HUD：
   * 它是一次性决定，不是要占住游玩时的视线；而且用户发现画面变了的时候，
   * 手边正好就是那个面板。
   */
  bindQualityToggle(handler: () => void): void {
    this.bindActionClick(this.el('#quality-lock-button'), handler);
  }

  /** 按钮文案 = 玩家唯一能读到的状态，所以 `aria-pressed` 要一起写（读屏与判据都读它）。 */
  setQualityLock(locked: boolean, tier: string): void {
    const button = this.el<HTMLElement>('#quality-lock-button');
    button.textContent = locked
      ? `画质：已锁定（${tier}）`
      : `画质：自动（当前 ${tier}）`;
    button.setAttribute('aria-pressed', String(locked));
  }

  /** 动效降级开关：读的是 <html data-motion>，与 CSS 同源。 */
  private get reducedMotion(): boolean {
    return document.documentElement.dataset.motion === 'reduced';
  }

  bindRuinActions(onBeg: () => void, onQuit: () => void, onLoan: () => void): void {
    this.bindActionClick(this.begButton, onBeg);
    this.bindActionClick(this.loanButton, onLoan);
    this.bindActionClick(this.el('#quit-button'), onQuit);
  }

  /**
   * 触底报价面板 / 本局结算卡片。
   *
   * ★ S3 去局感：非总结态的标题从「破产」改成**「续玩报价」**——
   * 触底不再是终点，而是「用哪种方式继续」的岔口。面板里现在有三个真选择，
   * 按代价从轻到重排（DOM 顺序就是玩家看到的按钮顺序）：
   *   贷款（`#loan-button`：借钱进余额接着打，**盘面一动不动**）、
   *   跪求（`#beg-button`：脏钱——能继续玩但不能换永久进度，也保留盘面）、
   *   收工（`#quit-button`：清空盘面；★ S4 之后**不动余额**，钱本来就在同一个账户里）。
   *
   * ⚠️ 标题是**文案**，而本项目的纪律是「按文案断言 ⇒ 改一次措辞判据就假红」
   * （见 `setStatus` 上那段 `data-kind` 的说明）。所以本次**同步改了**
   * `visual.spec` 里那条按文案断言的闭环用例，而不是留着它红。
   * 反过来，DOM id（`#ruin-panel` / `#ruin-title` / `#ruin-taunt`）**刻意不改名**：
   * `endless.ruinVisible` 与一大片判据都挂在这些名字上，改一次名等于第二次爆炸。
   */
  showRuin(payload: RuinPayload): void {
    const summary = payload.summary === true;
    this.ruinTitle.textContent = summary ? '本局结束' : '续玩报价';
    // 破产嘲讽的是手气与决策；收工是玩家主动离场，只做收束，不该被嘲。
    this.ruinTaunt.textContent = summary ? closingLine() : tauntFor(payload.totalBegs, payload.drops);

    this.ruinStats.innerHTML = '';
    const rows: Array<[string, string]> = [
      ['本局赚进', `${payload.earned} 筹码`],
      ['存活投数', String(payload.drops)],
      ['筹码峰值', String(payload.chipsPeak)],
      ['本局跪求', `${payload.begs} 次`],
      ['历史最高赚进', `${Math.max(payload.best, payload.earned)} 筹码`],
      ['累计跪求', `${payload.totalBegs} 次`],
    ];
    // ★ S4：原来这里有一行「回存钱包 +N」（且只在总结态出现）。
    //   「回存」这个动作已随合并账户消失 ⇒ 整行删掉，不是改成显示 0。
    rows.push(['余额', `${payload.balance} 筹码`]);
    for (const [label, value] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = label;
      const dd = document.createElement('dd');
      dd.textContent = value;
      this.ruinStats.append(dt, dd);
    }

    // 本地排行榜三列：赚进筹码 / 存活投数 / 跪求次数。
    const top = payload.runs.slice(0, 3);
    this.ruinBoard.textContent =
      top.length === 0
        ? ''
        : `本机排行榜：${top
            .map((run, index) => `${index + 1}. ${run.earned} 筹 · ${run.drops} 投 · ${run.begs} 跪`)
            .join('　')}`;

    this.begButton.hidden = summary;
    this.begButton.textContent = summary
      ? ''
      : `跪求 xixi 大王大赏（+${payload.grant} 筹码）`;
    // 贷款按钮的显隐走**行级 gating**（与 `summary`、`回存钱包` 那几行同一形状）：
    // 到欠款上限时 `available=false` ⇒ **藏掉而不是留着可点**，
    // 留着会让人点了什么都没发生，那正是本项目最讨厌的静默失败。
    this.loanButton.hidden = summary || payload.loan?.available !== true;
    // ★ 只在**真的能贷**的时候写文案：到上限时 `amount` 是 0，
    // 于是隐藏状态下会留着一句「贷款续玩 +0 筹码」——按钮虽然看不见，
    // 但无障碍树与任何读 textContent 的判据都会读到这句假话。
    if (payload.loan?.available && !summary) {
      this.loanButton.textContent =
        `贷款续玩 +${payload.loan.amount} 筹码（欠款 ${payload.loan.debt} → ` +
        `${payload.loan.debt + payload.loan.amount}/${payload.loan.ceiling}）`;
    } else {
      this.loanButton.textContent = '';
    }
    this.el<HTMLButtonElement>('#quit-button').textContent = summary ? '再来一局' : '保留尊严，收工';
    this.ruinPanel.hidden = false;
  }

  hideRuin(): void {
    this.ruinPanel.hidden = true;
  }

  get ruinVisible(): boolean {
    return !this.ruinPanel.hidden;
  }

  /**
   * 集齐四槽：整条提示闪一下，并把一枚「充能」滑向加力按钮。
   *
   * 闪的是容器而不是四个圆点 —— 圆点已经搬进 3D 模型了（见 `channelMarks` 的说明），
   * 这里只保留「集齐了」这个瞬时反馈。
   */
  private playChannelComplete(): void {
    if (this.reducedMotion) return;
    this.channelMarks.animate(
      [
        { boxShadow: '0 0 0 rgba(224,176,97,0)' },
        { boxShadow: '0 0 22px rgba(224,176,97,0.95)' },
        { boxShadow: '0 0 0 rgba(224,176,97,0)' },
      ],
      { duration: 520, easing: 'ease-out' },
    );
    this.flyChip(this.channelMarks, this.boostButton, '加力就绪');
  }

  /**
   * 一枚小徽标从 A 飞向 B。
   *
   * 集齐三路与赏赐到账都用它——两处都是「刚刚发生了什么 → 下一步看哪里」，
   * 让玩家不用自己找。
   */
  private flyChip(from: HTMLElement, to: HTMLElement, label: string): void {
    if (this.reducedMotion) return;
    const start = from.getBoundingClientRect();
    const end = to.getBoundingClientRect();
    if (start.width === 0 && start.height === 0) return;
    if (end.width === 0 && end.height === 0) return;
    const chip = document.createElement('span');
    chip.className = 'fly-chip';
    chip.textContent = label;
    const appBounds = this.app.getBoundingClientRect();
    chip.style.left = `${start.left - appBounds.left + start.width / 2}px`;
    chip.style.top = `${start.top - appBounds.top + start.height / 2}px`;
    this.app.append(chip);
    const dx = end.left + end.width / 2 - (start.left + start.width / 2);
    const dy = end.top + end.height / 2 - (start.top + start.height / 2);
    chip
      .animate(
        [
          { transform: 'translate(-50%, -50%) scale(0.6)', opacity: 0 },
          { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.2 },
          {
            transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.55)`,
            opacity: 0,
          },
        ],
        { duration: 620, easing: 'cubic-bezier(0.3, 0.1, 0.5, 1)' },
      )
      .finished.then(
        () => chip.remove(),
        () => chip.remove(),
      );
  }

  /**
   * 越线返值：从币的屏幕位置飘一个「+N」。
   * 坐标由 Game 投影世界坐标得到——飞字必须从**真的越线位置**起飞。
   *
   * `tier` 由 `Game` 用 `flyTier()`（`feedback.ts` 的单一真源）算好传进来，
   * 所以「哪个数是大号」只有一份定义；这里只负责画。
   * 同时把档位写进 `#hud[data-last-fly-tier]`：飞字 420 毫秒后就自毁了，
   * 判据去 DOM 里抓它是**时序赌博**，读这个持久属性才是稳的。
   */
  flyScore(x: number, y: number, value: number, tier: FlyTier = 'normal'): void {
    this.hud.dataset.lastFlyTier = tier;
    this.hud.dataset.lastFlyValue = String(value);
    if (this.reducedMotion) return;
    const chip = document.createElement('span');
    chip.className = tier === 'big' ? 'fly-score big' : 'fly-score';
    chip.dataset.tier = tier;
    chip.textContent = `+${value}`;
    chip.style.left = `${x}px`;
    chip.style.top = `${y}px`;
    this.stageOverlays.append(chip);
    chip.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.85)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1.05)', opacity: 1, offset: 0.25 },
        { transform: 'translate(-50%, -50%) scale(0.7) translateY(-48px)', opacity: 0 },
      ],
      { duration: tier === 'big' ? 560 : 420, easing: 'cubic-bezier(0.4, 0.1, 0.6, 1)' },
    ).finished.then(
      () => chip.remove(),
      () => chip.remove(),
    );
  }

  update(
    snapshot: RunSnapshot,
    config: EndlessConfig,
    best: number,
    mechanisms: MechanismSnapshot = { sweeper: 0, grapple: 0, reload: 0 },
    bet: BetTier = { chips: 1, mul: 1, label: '1 投 · ×1' },
    /** XIXI 四槽亮灭（Game 持有，跨局持续；P5 起不再挂在 RunState 快照上）。 */
    xixi: boolean[] = [false, false, false, false],
    interaction?: MechanismUiState,
  ): void {
    this.setText(this.levelLabel, config.name);
    this.setAttribute(this.levelLabel, 'title', config.name);
    if (this.app.dataset.runPhase !== snapshot.phase) this.app.dataset.runPhase = snapshot.phase;
    const rewardSignature = `${snapshot.wave}/${snapshot.waveTickets}/${snapshot.tickets}/${snapshot.pendingDraft}`;
    if (rewardSignature !== this.lastRewardSignature) {
      this.lastRewardSignature = rewardSignature;
      const target = waveTarget(snapshot.wave);
      const remaining = Math.max(0, target - snapshot.waveTickets);
      for (const node of this.rewardDescriptions) {
        this.setText(node, snapshot.pendingDraft ? '三选一已就绪，领取本波奖励' : `再得 ${remaining} 票，解锁三选一`);
      }
      for (const node of this.rewardFills) {
        const width = `${Math.min(100, (snapshot.waveTickets / target) * 100)}%`;
        if (node.style.width !== width) node.style.width = width;
      }
      for (const node of this.rewardProgressBars) {
        this.setAttribute(node, 'aria-valuemax', String(target));
        this.setAttribute(node, 'aria-valuenow', String(Math.min(target, snapshot.waveTickets)));
        this.setAttribute(node, 'aria-valuetext', `${snapshot.waveTickets} / ${target} 票`);
      }
      for (const node of this.rewardWaveLabels) this.setText(node, `第 ${snapshot.wave} 波`);
      for (const node of this.rewardTicketLabels) this.setText(node, `持有 ${snapshot.tickets} 票`);
    }
    // ★ S4 合并账户：这里原来有两个数 —— `walletValue`（钱包）与 `creditsValue`（局内筹码），
    //   分别读 `save.wallet` 与 `snapshot.chips`，中间靠「买入/回存」两笔转账来回搬。
    //   合并之后两者是同一个数 ⇒ **只剩一个读数**（参数 `wallet` 也一并删掉：
    //   留着一个永远等于另一个的入参，就是留给下一个人的歧义源）。
    //   现在显示的三个数分工仍然互不重叠：赚进 = 本段成绩，最高 = 历史成绩，余额 = 现在有多少钱。
    this.setText(this.earnedValue, String(snapshot.earned));
    this.setText(this.bestValue, String(Math.max(best, snapshot.earned)));
    this.setText(this.creditsValue, String(snapshot.chips));

    // XIXI 进度只出一行文字：四槽的亮灭**画在 3D 模型里**（推板前缘的四段标牌），
    // 这里不再重复画一遍圆点。进度仍按 `xixi` 数，与 3D 标牌同源。
    // 一次位运算同时拿到"亮了几槽"和"哪几槽亮"，顺便当签名用：
    // 原写法每帧要做 `filter` + `map().join()` 两次数组分配，而四槽平均几秒才变一次。
    let bits = 0;
    let litCount = 0;
    for (let index = 0; index < xixi.length; index += 1) {
      if (xixi[index]) {
        bits |= 1 << index;
        litCount += 1;
      }
    }
    this.setText(this.markNote, `XIXI 集章 ${litCount}/${xixi.length} · 集齐开奖`);
    // 签名没变 ⇒ 那串 `X已亮 I未亮 …` 不必重建（`setAttribute` 自己也会再比一次）。
    if (bits !== this.lastXixiSignature) {
      this.lastXixiSignature = bits;
      this.setAttribute(
        this.channelMarks,
        'aria-label',
        `XIXI 集章 ${litCount}/${xixi.length}（${xixi
          .map((lit, index) => `${XIXI_GLYPHS[index]}${lit ? '已亮' : '未亮'}`)
          .join(' ')}）`,
      );
    }
    // 加力进账（老虎机「力力力」）：整条提示闪一下并把一枚「充能」滑向加力按钮，
    // 把「摇中了」直接导向下一步该按哪个键。
    if (snapshot.boostCharges > this.lastBoostCharges) this.playChannelComplete();
    this.lastBoostCharges = snapshot.boostCharges;
    // 加力就绪时**顶掉**进度文字：此刻玩家该做的事从「继续集章」变成了「用加力」，
    // 两句话挤在同一行只会都读不清。上面的进度已写进 `aria-label`，信息没丢。
    if (snapshot.boostCharges > 0) this.setText(this.markNote, '加力已就绪，随时可用');

    // V4 keeps all four mechanism positions stable, with an explicit charge state.
    const blocked = interaction?.blockedReason ?? null;
    const boostPhase = interaction?.boostPhase ?? (snapshot.boostCharges > 0 ? 'ready' : 'empty');
    const boostReady =
      snapshot.boostEnabled && snapshot.boostCharges > 0 && snapshot.phase !== 'settled' &&
      !blocked && boostPhase !== 'pending' && boostPhase !== 'stroke';
    this.boostButton.disabled = !boostReady;
    this.boostButton.hidden = false;
    this.boostButton.dataset.ready = String(boostReady);
    this.boostButton.dataset.boostPhase = boostPhase;
    this.setAttribute(this.boostButton, 'title', blocked ?? (boostPhase === 'pending' ? '已排队，下一次前推会实际加力' :
      boostPhase === 'stroke' ? '加长冲程正在执行，回撤结束后恢复' : boostPhase === 'complete' ? '本次加力冲程已完成' :
      boostReady ? '使用储存的加力，为下一次前推追加行程' : '集齐 XIXI 或领取加力包获得一次加力'));
    this.setText(
      this.boostState,
      blocked ?? (boostPhase === 'pending' ? '待发 · 下一程' : boostPhase === 'stroke' ? '加强冲程中' :
        boostPhase === 'complete' ? '加力完成' : snapshot.boostCharges > 0 ? `就绪 ×${snapshot.boostCharges}` : '集章充能'),
    );

    const dropPhase = snapshot.phase === 'ready' || snapshot.phase === 'playing';
    const enoughForBet = snapshot.chips >= bet.chips;
    const coinsRemaining = interaction?.coinsRemaining ?? Infinity;
    const canDrop = dropPhase && enoughForBet && coinsRemaining >= 1;
    this.dropButton.disabled = !canDrop;
    const dropNote = !dropPhase ? snapshot.phase === 'settled' ? '本局已结束' : '盘面沉降中' : snapshot.chips <= 0 ? '筹码见底，等沉降' : !enoughForBet ? `筹码不足 · 需 ${bet.chips}` :
      coinsRemaining < 1 ? '盘面已满，等待空位' : '普通铜币';
    this.setText(this.dropState, dropNote);
    this.setAttribute(this.dropButton, 'title', canDrop ? `投 ${bet.chips} 筹码 · ${bet.label}` : dropNote);

    // 机关：每个都有明确的可用条件。不可用时**置灰**而不是隐藏——玩家得知道它存在。
    const settled = snapshot.phase === 'drainOut' && snapshot.plateStopped;
    const holdingBoost = snapshot.boostCharges > 0 && snapshot.boostUsesLeft > 0;
    // 扫板与加力互斥：同一次收尾只能选一个，否则扫板会变成无脑必点。
    const canSweep = settled && !holdingBoost;
    this.sweeperButton.disabled = !!blocked || !canSweep || mechanisms.sweeper <= 0;
    this.setAttribute(this.sweeperButton, 'title', blocked ?? (mechanisms.sweeper <= 0 ? '本局扫板已用完' : holdingBoost ? '使用或放弃加力后，才能扫板' : canSweep ? '免费将得分线前的币扫落' : '筹码见底、推板停稳后可免费扫板'));
    this.setText(
      this.sweeperState,
      blocked ?? (mechanisms.sweeper <= 0
        ? '已用完'
        : canSweep
          ? '免费 · 可用'
          : holdingBoost
            ? '先决定加力'
            : '收尾停板可用'),
    );

    const canGrapple = snapshot.phase === 'playing' && snapshot.chips >= MECHANISM_COST.grapple;
    this.grappleButton.disabled = !!blocked || !canGrapple || mechanisms.grapple <= 0;
    // Plain text makes price and remaining uses legible without learning a lamp convention.
    this.setText(this.grappleState, `${MECHANISM_COST.grapple}筹码 · 剩${mechanisms.grapple}次`);
    this.grappleState.dataset.remaining = String(mechanisms.grapple);
    this.grappleState.dataset.cost = String(MECHANISM_COST.grapple);
    this.setAttribute(this.grappleButton, 'aria-label', `抓斗，花 ${MECHANISM_COST.grapple} 筹码，剩 ${mechanisms.grapple} 次`);
    this.setAttribute(this.grappleButton, 'title', blocked ?? `花 ${MECHANISM_COST.grapple} 筹码，将推板前缘的币搬向前沿；剩 ${mechanisms.grapple} 次`);

    const canReload =
      (snapshot.phase === 'ready' || snapshot.phase === 'playing') && snapshot.chips >= MECHANISM_COST.reload && coinsRemaining >= 3;
    this.reloadButton.disabled = !!blocked || !canReload;
    const reloadNote = coinsRemaining < 3 ? `${MECHANISM_COST.reload}筹码 · 空位不足` : this.reloadHint;
    this.setText(this.reloadState, reloadNote);
    this.setAttribute(this.reloadButton, 'title', blocked ?? (coinsRemaining < 3 ? '盘面空位不足，后装填需要 3 枚空位' : `花 ${MECHANISM_COST.reload} 筹码，从后方补入 3 枚币`));

    this.betButton.disabled = snapshot.phase === 'settled';
    this.setText(this.betState, bet.label);
    this.setAttribute(this.betButton, 'aria-label', `加注档位，${bet.label}，轻点切换`);
  }

  /**
   * 把集章圆点贴到币床上缘。
   *
   * 位置由 Game 把世界坐标投影到屏幕像素后传进来——百分比定位在竖屏与横屏下
   * 会漂到别的地方去，贴在台面上必须是「真的贴着台面」。
   */
  setMarksAnchor(topPx: number): void {
    this.channelMarks.style.top = `${Math.round(topPx)}px`;
  }

  /**
   * 状态行。
   *
   * `kind` 会写到 `#status-line` 的 `data-kind` 上，**这是给判据用的**：
   * 「自动补币有没有给玩家反馈」如果靠匹配文案来判，改一次措辞判据就假红
   * ——那等于在测试里维护第二份文案。读 `data-kind` 问的是「这句话是谁说的」，
   * 与措辞无关。默认 `'info'`：任何后来的状态都会把它覆盖回去，这正是期望行为。
   */
  setStatus(text: string, kindOrMinSeconds: string | number = 'info', priority?: number, minimumSeconds?: number): void {
    const kind = typeof kindOrMinSeconds === 'string' ? kindOrMinSeconds : 'info';
    const minVisibleSeconds = Math.max(2.6, minimumSeconds ?? (typeof kindOrMinSeconds === 'number' ? kindOrMinSeconds : 2.6));
    const inferredKind = kind === 'danger' ? 'fine' : kind !== 'info' ? kind
      : /罚|扣款|催债|胡萝卜/.test(text) ? 'fine'
      : /加力/.test(text) ? 'boost'
      : /扫板|抓斗|后装填/.test(text) ? 'mechanism'
      : /大奖|票币越线|波间奖励|赏你|奖励到账/.test(text) ? 'reward' : 'info';
    const actualEvent = ['refill', 'danger', 'jackpot', 'reward'].includes(kind)
      || /^(扫板：|抓斗：|后装填：|加力生效：|加力已排队|XIXI 集齐|老虎机：|票币越线：|催债币|波间奖励：|金色大赏币注入：|产出 [1-9]|盘面回吐筹码|xixi 大王赏你|贷款续玩|已换装：)/.test(text);
    if (actualEvent) this.recordEvent({ text, kind: inferredKind });
    const next: Toast = {
      text, kind, minVisibleSeconds,
      priority: priority ?? (inferredKind === 'fine' || inferredKind === 'jackpot' ? 3 : inferredKind === 'reward' || kind === 'refill' ? 2 : inferredKind === 'info' ? 0 : 1),
    };
    if (this.toast?.text === text || this.toastQueue.some((entry) => entry.text === text)) return;
    if (!this.toast || (next.priority > this.toast.priority && performance.now() >= this.minimumReadUntil)) {
      this.presentToast(next);
      return;
    }
    this.toastQueue.push(next);
    this.toastQueue.sort((a, b) => b.priority - a.priority);
    this.toastQueue.length = Math.min(this.toastQueue.length, 4);
    this.scheduleToast();
  }

  private presentToast(toast: Toast): void {
    this.toast = toast;
    this.statusLine.hidden = false;
    this.statusLine.textContent = toast.text;
    this.statusLine.dataset.kind = toast.kind;
    this.statusLine.dataset.priority = String(toast.priority);
    this.minimumReadUntil = performance.now() + toast.minVisibleSeconds * 1000;
    this.toastExpiresAt = performance.now() + Math.max(toast.minVisibleSeconds * 1000, 3200, Math.min(6500, toast.text.length * 70 + 1200));
    this.scheduleToast();
  }

  private scheduleToast(): void {
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    const importantWaiting = (this.toastQueue[0]?.priority ?? -1) > (this.toast?.priority ?? -1);
    const deadline = importantWaiting ? this.minimumReadUntil : this.toastExpiresAt;
    this.toastTimer = window.setTimeout(() => {
      this.toastTimer = null;
      const next = this.toastQueue.shift();
      if (next) this.presentToast(next);
      else {
        this.toast = null;
        this.statusLine.hidden = true;
      }
    }, Math.max(0, deadline - performance.now()));
  }

  /**
   * 欠款一行小字（S2）。无债就整条隐藏 —— 「零」也要占一行会把玩家的注意力
   * 花在一条没有信息的话上。
   *
   * ★ 这里只**显示**，不持有数值：`debt` 的真源是 `SaveStore`，
   * 在 HUD 里存一份就是本项目反复清的那种第二份真源。
   */
  setDebt(debt: number, ceiling: number): void {
    if (!this.debtLine || !this.debtNote) return;
    if (debt <= 0) {
      this.debtLine.hidden = true;
      this.debtNote.textContent = '';
      return;
    }
    this.debtLine.hidden = false;
    this.debtNote.textContent = `欠款 ${debt} / ${ceiling} 筹码 · 产出会按比例自动抵债`;
  }

  /**
   * 自动补币的 HUD 反馈（P10 ⑦）。
   *
   * 独立成方法而不是就地拼一句 `setStatus(...)`，是为了让「补币有反馈」成为
   * **可判据的事实**：验证脚本读 `#status-line[data-kind="refill"]`，
   * 而不是去匹配「庄家补货」这四个字。
   */
  showRefill(bedCoins: number, promised: number, downgraded: boolean): void {
    this.setStatus(
      `台面见底（${bedCoins} 枚）：庄家补货 ${promised} 枚` +
        (downgraded ? '（余量不足，按实有交付）' : ''),
      'refill',
    );
  }

  /** 越线入账：本局赚进那一位数字弹一下，并把这次入账记在 data 上供测试读取。 */
  flashScore(value: number): void {
    this.earnedValue.classList.remove('bump');
    void this.earnedValue.offsetWidth;
    this.earnedValue.classList.add('bump');
    this.earnedValue.dataset.lastGain = `+${value}`;
    this.recordEvent({ text: '越线入账', kind: 'score', amount: value });
  }

  showCombo(count: number, label: string): void {
    if (count < 3 || count === this.lastComboShown) return;
    this.lastComboShown = count;
    const text = count === 3 ? '三连落' : count === 5 ? '五连落' : `${count} 连落`;
    this.comboToast.textContent = `${text} · ${label}`;
    this.comboToast.animate(
      [
        { opacity: 0, transform: 'translate(-50%, 10px)' },
        { opacity: 1, transform: 'translate(-50%, 0)' },
        { opacity: 1, transform: 'translate(-50%, 0)' },
        { opacity: 0, transform: 'translate(-50%, -10px)' },
      ],
      { duration: 1100, easing: 'ease-out' },
    );
  }

  resetCombo(): void {
    this.lastComboShown = 0;
  }

  showPause(paused: boolean): void {
    this.pausePanel.hidden = !paused;
    const label = this.pauseButton.querySelector('span');
    if (label) label.textContent = paused ? '继续' : '暂停';
    const icon = this.pauseButton.querySelector('i');
    if (icon) icon.innerHTML = uiIconMarkup(paused ? 'play' : 'pause');
    this.pauseButton.setAttribute('aria-label', paused ? '继续' : '暂停');
  }

  /** 收尾时仍持有加力：提示玩家使用或放弃，不静默清空。 */
  showDrainPrompt(visible: boolean): void {
    this.drainPrompt.hidden = !visible;
  }

  /**
   * 高潮反馈：屏幕边缘一次性闪一下，金色给高分币/连落，绿色给返币，
   * 白色给「连落 5 次」（与币种无关的那一档）。
   *
   * ★ `classList.remove(...)` 的名单必须与 `ClimaxTone`（`kinds.ts`）逐项一致：
   * 漏掉一个，上一个色调的 class 会赖在元素上——零报错的静默错
   * （下一次闪的其实是上一个颜色，因为 CSS 里两个动画规则同时命中，
   * 后定义的那条赢）。
   */
  flashClimax(tone: ClimaxTone): void {
    const element = this.climaxFlash;
    element.classList.remove('gold', 'green', 'blue', 'white');
    void element.offsetWidth;
    element.classList.add(tone);
  }

  /** Clear queued notices when beginning another run or disposing the game. */
  resetNotifications(): void {
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.toastQueue.length = 0;
    this.toast = null;
    this.statusLine.hidden = true;
    this.previewHover = null;
    this.previewFocus = null;
    this.showMechanismPreview(null);
    this.rewardStageLabel.hidden = true;
    for (const token of this.xixiCollectionTokens) token.hidden = true;
  }

  dispose(): void {
    if (this.eventsOpen) this.closeEvents();
    this.eventToggle.removeEventListener('click', this.onEventsOpen);
    this.eventClose.removeEventListener('click', this.onEventsClose);
    this.eventBackdrop.removeEventListener('click', this.onEventsClose);
    this.eventPanel.removeEventListener('keydown', this.onEventsKey);
    window.removeEventListener('resize', this.onEventsResize);
    this.statusLine.removeEventListener('keydown', this.onStatusKey);
    for (const cleanup of this.previewInputCleanup) cleanup();
    this.previewInputCleanup.length = 0;
    this.previewChanged = () => {};
    for (const cleanup of this.actionInputCleanup) cleanup();
    this.actionInputCleanup.length = 0;
    this.resetNotifications();
    this.rewardStageLabel.remove();
    for (const token of this.xixiCollectionTokens) token.remove();
  }

  private el<T extends HTMLElement = HTMLElement>(selector: string): T {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`缺少 HUD 元素: ${selector}`);
    return element;
  }
}
