import {
  COIN_EFFECT_IDS,
  COIN_EFFECT_SPECS,
  EFFECT_POOL,
  EFFECT_SPECS,
  type CoinEffectId,
  type EffectId,
} from '../game/effects';
import { DRAFT_CHOICES, DRAFT_COST, TICKET_INTERVAL_FLOOR, waveTarget } from '../game/waves';
import { RULES } from '../game/constants';
import type { Notify } from '../game/notifications';
import { fineRatio, type FineQuote } from '../game/xixi';
import { createPixelTextSurface, type PixelTextSurface } from '../render/pixelText';
import type { MechanismId } from './Mechanisms';
import type { RunState } from './RunState';
import type { Mechanisms } from './Mechanisms';

/** 一次币种效果的结算记录（Stage 2d 的归因对账吃的是**逐事件**，不是总数）。 */
export type CoinEffectEvent = {
  id: CoinEffectId;
  /**
   * 这一条结算的是哪一档。判据按它选字段，**不再假设"每次触发都有一笔罚款"** ——
   * 2c 之后有两条 act，`applied` 对票币就是恒 0，看数的人需要知道自己在读哪一档。
   */
  act: 'fine' | 'ticket';
  /** 该扣多少（比例制算出来的名义额）；`ticket` 档恒 0。 */
  requested: number;
  applied: number;
  debtAdded: number;
  /**
   * 算 `requested` 时用的余额 —— 与老虎机那条罚款事件同一条理由：
   * 不带输入的话，判据只能退化成区间；带上它就能做逐事件恒等
   * `requested === round(balance × fineRatio(progress))`。
   */
  balance: number;
  progress: number;
  /** `ticket` 档：真的发出去几张（用 `ticketBySource.effect` 的前后差量出来，不是表里的期望值）。 */
  ticketsGranted: number;
  t: number;
};

/** 单条效果币的分账（计划 2d 原话："触发计数 === 归因计数，**逐效果**对账"）。 */
export type CoinEffectTally = {
  triggers: number;
  attributed: number;
  /** 注入尝试次数（含 `coins.acquire()` 拿到 null 的那次 —— 缺席要能归因）。 */
  attempts: number;
  /** 其中真的把币放上盘面的次数。 */
  spawned: number;
};

/** 面板上一张候选的显示数据（`label` / `glyph` / `note` 全部来自 `effects.ts`，这里不重写文案）。 */
export type DraftChoice = { id: EffectId; label: string; glyph: string; note: string; cost: number };

export type CoinEffectsDeps = {
  run: () => RunState;
  /**
   * ★ V3 U04：是否有重要演出在进行（投放演出 / 机关演出）。
   * 为真时不能主动打开三选一，pendingDraft 保持挂起，演出收场后入口恢复可用。
   * 可选：缺省视为「从不忙」（旧语义），模型模式/测试可省。
   */
  showsBusy?: () => boolean;
  /** Game owns pause reasons, so closing a draft cannot release a manual pause. */
  setDraftPaused?: (paused: boolean) => void;
  /** Host UI state (ruin/summary) can forbid opening even if late coins revive the run phase. */
  canOpenDraft?: () => boolean;
  mechanisms: () => Mechanisms;
  /** 抽候选用的 RNG：走游戏那颗种子，同一个种子要能复现同一组三选一。 */
  rng: () => number;
  /** HUD 归因文案（Stage 2d 的"触发计数 === 归因计数"就靠它，不另开一条通道）。 */
  notify: Notify;
  /** 选完/刷新之后推一次 HUD：票券与波次的读数都挂在 HUD 上。 */
  refresh: () => void;
  /** 罚款的比例表取值口（唯一真源在 `xixi.ts`，这里只把两个输入拿来）。 */
  fineQuote: () => FineQuote;
  /** 一次扣款的完整结算（实扣 + shortfall 转欠款），与老虎机罚款**同一条出口**。 */
  settleFine: (amount: number) => { applied: number; shortfall: number; debtAdded: number };
  now: () => number;
  root: ParentNode;
};

/**
 * 波间三选一（1c）+ 构筑奖励的落地编排（Stage 2 的表在 `game/effects.ts`）。
 *
 * ## 为什么单独一个系统
 *
 * `Game.ts` 只允许减少（计划 0d）。这里带着一整块 DOM 与四条 apply 分支，
 * 塞进 Game 就是又一次"什么都在那个文件里"。先例是 `CollectionPanel`：
 * 自己拿元素、自己听点击、只通过 deps 与游戏对话。
 *
 * 达标只保留领取资格。玩家主动打开时申请 draft 暂停原因；收起后继续推币。
 * 同一波的候选只抽一次，避免收起重开重抽，也避免额外消耗游戏 RNG。
 *
 * ## 票券不够怎么办
 *
 * **不发明第三种状态**：按钮全部禁用、面板赖着不走，直到玩家把票券挣够或这一局沉降。
 * 半途"免费送一张"会让 `ticketSpent === draftCost × draftsTaken` 这条恒等式失去意义。
 */
export class CoinEffects {
  private readonly panel: HTMLElement | null;
  private readonly choices: HTMLElement | null;
  private readonly meta: HTMLElement | null;
  private current: DraftChoice[] = [];
  private cachedWave: number | null = null;
  visible = false;
  /** 逐事件流水（每条自带 `id` 与 `act`）；`tally` 是它的计数视图，两份都由这一个人的手写成。 */
  private coinEffectEvents: CoinEffectEvent[] = [];
  /** 每张候选的像素徽章面（Stage 3b 的 pixelText 消费者；面板关掉后会被 dispose）。 */
  private badges: PixelTextSurface[] = [];
  /**
   * 币种效果的分账，**按效果 id 键着**（计划 2d）。
   *
   * 为什么不留一个总数口袋：两条效果币都往 `triggers` 上加时，"这局遇到催债币"
   * 那条存在性判据就变成"这局遇到过**某条**效果"——那是把两条规则混读成一条。
   * 名单来自 `COIN_EFFECT_IDS`（`effects.ts` 的真源），加一档不用回来补键。
   */
  private readonly tally = new Map<CoinEffectId, CoinEffectTally>(
    COIN_EFFECT_IDS.map((id) => [id, { triggers: 0, attributed: 0, attempts: 0, spawned: 0 }]),
  );

  constructor(private readonly deps: CoinEffectsDeps) {
    this.panel = (deps.root.querySelector('#draft-panel') as HTMLElement | null) ?? null;
    this.choices = (deps.root.querySelector('#draft-choices') as HTMLElement | null) ?? null;
    this.meta = (deps.root.querySelector('#draft-meta') as HTMLElement | null) ?? null;
    // 面板存在与否不该决定游戏能不能跑（模型模式 / 截图模式可能没有这块 DOM）。
    // ⚠️ 拿不到元素时 `visible` 永远 false ⇒ `tick()` 会每帧重试渲染，所以有下面那个哨兵。
    this.missingDom = this.panel === null || this.choices === null;
  }

  private readonly missingDom: boolean;

  /**
   * 只同步已打开的面板。达标与演出结束都不会自动打开，资格由 report 提供给入口。
   */
  tick(): void {
    if (this.missingDom) return;
    if (!this.visible) return;
    this.sync();
  }

  /** 组一批候选并显示。抽法 = 洗牌后取前 `DRAFT_CHOICES` 个（池子 ≤ 3 时就是全摆出来）。 */
  openDraft(): boolean {
    if (this.visible) return true;
    const run = this.deps.run();
    if (this.missingDom || !run.pendingDraft || (run.phase !== 'ready' && run.phase !== 'playing') ||
      this.deps.canOpenDraft?.() === false || this.deps.showsBusy?.()) return false;
    if (this.cachedWave !== run.wave) {
      this.current = this.draw();
      this.cachedWave = run.wave;
    }
    if (this.panel) this.panel.hidden = false;
    this.visible = true;
    this.render();
    this.deps.setDraftPaused?.(true);
    this.deps.refresh();
    // 键盘可达：面板立起时焦点进第一张卡（Esc/Tab 语义仍由浏览器接管）。
    this.choices?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return true;
  }

  private draw(): DraftChoice[] {
    // 洗牌走游戏 RNG（可复现），并且**不动** EFFECT_POOL 本身 —— 那是导出的只读名单，
    // 判据按它互证"池里没有死项"，被洗过一次就再也不是那份名单了。
    const pool = [...EFFECT_POOL];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.deps.rng() * (i + 1));
      const swap = pool[i];
      pool[i] = pool[j];
      pool[j] = swap;
    }
    return pool.slice(0, DRAFT_CHOICES).map((id) => ({
      id,
      label: EFFECT_SPECS[id].label,
      glyph: EFFECT_SPECS[id].glyph,
      note: EFFECT_SPECS[id].note,
      cost: DRAFT_COST,
    }));
  }

  private render(): void {
    if (!this.choices) return;
    for (const badge of this.badges) badge.dispose();
    this.choices.replaceChildren();
    this.badges.length = 0;
    this.current.forEach((choice, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.effect = choice.id;
      button.dataset.price = String(choice.cost);
      // 铭牌上的图案走**像素字**（Stage 3b：与招牌屏同一套"小画布 fillText + 整数倍放大"），
      // 名字与价格留作 DOM 文本 —— 无障碍树与判据都要能读到文字，全画布等于把信息藏进像素里。
      const badge = createPixelTextSurface({ width: 36, height: 36, scale: 3 });
      badge.canvas.className = 'draft-badge';
      badge.draw({ text: choice.glyph, fontPx: 11, fill: '#e0b061' });
      this.badges.push(badge);
      const label = document.createElement('span');
      label.textContent = `${choice.label} — ${choice.note}（${choice.cost} 券）`;
      button.append(badge.canvas, label);
      button.addEventListener('click', () => this.pick(index));
      this.choices?.appendChild(button);
    });
    this.sync();
  }

  /**
   * 同步读数与可买状态（每帧调用，见 `tick()`）。
   *
   * 收起期间玩家会继续玩；重开时重新计算实际收益，不重抽候选。
   */
  private sync(): void {
    const run = this.deps.run();
    if (this.meta) {
      this.meta.textContent =
        `第 ${run.wave} 波 · 本波 ${run.waveTickets}/${waveTarget(run.wave)} 券 · ` +
        `票券 ${run.tickets}（挣 ${run.ticketEarned} / 花 ${run.ticketSpent}）`;
    }
    for (const button of this.choices?.querySelectorAll('button') ?? []) {
      const index = [...(this.choices?.children ?? [])].indexOf(button);
      const choice = this.current[index];
      if (choice) {
        const preview = this.preview(choice.id);
        button.disabled = run.tickets < choice.cost || !preview.available;
        const label = button.querySelector('span');
        if (label) label.textContent = `${choice.label} — ${preview.note}（${choice.cost} 券）`;
      }
    }
  }

  private preview(id: EffectId): { available: boolean; note: string } {
    const spec = EFFECT_SPECS[id];
    const run = this.deps.run();
    if (spec.act === 'boost') {
      if (run.boostUsesLeft <= 0) return { available: false, note: '本局加力次数已用完，暂不可领取' };
      const actual = Math.min(Math.max(0, RULES.boostStoreCap - run.boostCharges), spec.payload.strokes ?? 0);
      return { available: actual > 0, note: actual > 0 ? `实际 +${actual} 发加力` : '加力已存满，暂不可领取' };
    }
    if (spec.act === 'ticketInterval') {
      const actual = Math.min(Math.max(0, run.ticketEvery - TICKET_INTERVAL_FLOOR), spec.payload.step ?? 0);
      return {
        available: actual > 0,
        note: actual > 0 ? `发券间隔 −${actual} 枚，变为每 ${run.ticketEvery - actual} 枚一张` : '发券间隔已到下限，暂不可领取',
      };
    }
    return { available: true, note: spec.note };
  }

  /**
   * 选第 `index` 张。返回 false = 什么都没发生（票券不够 / 面板没立着）。
   *
   * ★ 顺序是**先付票再生效**：反过来会留一条"拿了奖励但票券没扣"的路，
   * 而那条路在 `tickets === earned − spent` 上表现为凭空多一笔汇。
   */
  pick(index: number): boolean {
    if (!this.visible) return false;
    const choice = this.current[index];
    if (!choice) return false;
    const run = this.deps.run();
    if (!run.pendingDraft || (run.phase !== 'ready' && run.phase !== 'playing') || this.deps.canOpenDraft?.() === false ||
      this.cachedWave !== run.wave || !this.preview(choice.id).available) return false;
    if (!run.spendTickets(choice.cost)) return false;
    this.apply(choice.id);
    run.advanceWave();
    this.clearDraft();
    this.deps.refresh();
    return true;
  }

  /** 兑现一张候选。每条分支都不往筹码账里加东西 —— 这是 `effects.ts` 文件头的硬约束。 */
  private apply(id: EffectId): void {
    const spec = EFFECT_SPECS[id];
    const run = this.deps.run();
    switch (spec.act) {
      case 'boost': {
        const strokes = spec.payload.strokes ?? 0;
        let granted = 0;
        for (let i = 0; i < strokes; i += 1) if (run.grantBoost()) granted += 1;
        this.deps.notify(
          granted > 0
            ? `波间奖励：${spec.label} ⇒ 实际加力 +${granted} 发`
            : `波间奖励：${spec.label} —— 加力已经存满，这 ${strokes} 发没处放`,
          { event: 'draft-boost', priority: 2, tone: 'reward', amount: granted, minVisibleSeconds: 2.5 },
        );
        return;
      }
      case 'mechanism': {
        // reload 本来就是无限次，给它加次数是空操作 ⇒ 候选只在扫板/抓斗里挑。
        const pool: Exclude<MechanismId, 'reload'>[] = ['sweeper', 'grapple'];
        const id2 = pool[Math.floor(this.deps.rng() * pool.length)] ?? 'sweeper';
        const added = this.deps.mechanisms().grantUses(id2, 1);
        this.deps.notify(
          added > 0
            ? `波间奖励：${spec.label} ⇒ ${id2 === 'sweeper' ? '扫板' : '抓斗'} +${added} 次`
            : `波间奖励：${spec.label} —— 这次没能充上电`,
          { event: 'draft-mechanism', priority: 2, tone: 'reward', amount: added, minVisibleSeconds: 2.5 },
        );
        return;
      }
      case 'ticketInterval': {
        const applied = run.tightenTicketInterval(spec.payload.step ?? 0);
        this.deps.notify(
          applied > 0
            ? `波间奖励：${spec.label} ⇒ 越线每 ${run.ticketEvery} 枚发一张（本局生效，不跨局）`
            : `波间奖励：${spec.label} —— 间隔已经到下限 ${run.ticketEvery} 枚`,
          { event: 'draft-ticket-interval', priority: 2, tone: 'reward', amount: applied, minVisibleSeconds: 2.5 },
        );
        return;
      }
    }
  }

  hideDraft(): void {
    if (this.panel) this.panel.hidden = true;
    this.visible = false;
    this.deps.setDraftPaused?.(false);
    this.deps.refresh();
    // 收起时清画布和节点，保留候选数据；重开同一波不会消耗 RNG。
    for (const badge of this.badges) badge.dispose();
    this.badges = [];
    /*
     * ★ 候选节点也要一起摘掉。`hidden` 只挡住鼠标：`element.click()` 与键盘焦点仍能打到
     * 一张**已经作废**的卡（实测：economy 机器人点了 23 次、引擎只记 12 张 —— 那 11 次
     * 全打在收起后的旧按钮上，被 `pick()` 的 `!visible` 挡回去）。留着它们等于让 DOM
     * 说"这里有三张可选卡"而真相是"没有"，这是本项目零容忍的那类画面/账不一致。
     */
    this.choices?.replaceChildren();
  }

  /** Compatibility entry point for lifecycle callers; ordinary close preserves this wave. */
  close(): void {
    this.hideDraft();
  }

  /** End/dispose the draft lifecycle without erasing this run's effect audit records. */
  resetDraft(): void {
    this.clearDraft();
  }

  private clearDraft(): void {
    this.hideDraft();
    this.current = [];
    this.cachedWave = null;
  }

  /**
   * 币种效果结算（Stage 2）：一枚带 `payout.mode === 'effect'` 的币越线时调用。
   *
   * 分派链从 `Game.settleCrossing` 进来，**币种名单不在那里写**（`kinds.ts` 的
   * `payout.effect` 才是真源）——那正是 S16 之前"币种能干什么"散在分派处的老毛病。
   *
   * ★ 三条硬规矩：
   *   ① 出账只走 `settleFine`（唯一扣减口）⇒ 三账本恒等式不需要为新币种改一个字；
   *   ② 入账只走 `RunState.earnTicket`（票券唯一的源入口）⇒ 它同样碰不到筹码账；
   *   ③ 每次触发**必须**留一条 HUD 归因，并且按效果 id 把 `triggers` 与 `attributed` 一起记 ——
   *      两者相等是 Stage 2d 的判据内容，不相等就是"发生了而玩家看不见"。
   */
  dispatchCoin(effect: CoinEffectId): void {
    const spec = COIN_EFFECT_SPECS[effect];
    const tally = this.tally.get(effect);
    if (tally) tally.triggers += 1;
    const event: CoinEffectEvent = {
      id: effect,
      act: spec.act,
      requested: 0,
      applied: 0,
      debtAdded: 0,
      // `balance` / `progress` 是**罚款档的输入**，票币档不填（0 = 这一档没有这两个量），
      // 免得读数里出现一个看着像"票币也读了余额"的值。
      balance: 0,
      progress: 0,
      ticketsGranted: 0,
      t: this.deps.now(),
    };
    switch (spec.act) {
      case 'fine': {
        const quote = this.deps.fineQuote();
        const { applied, debtAdded } = this.deps.settleFine(quote.amount);
        event.requested = quote.amount;
        event.applied = applied;
        event.debtAdded = debtAdded;
        event.balance = quote.balance;
        event.progress = quote.progress;
        const percent = Math.round(fineRatio(quote.progress) * 100);
        const balanceChange = `余额 ${quote.balance} → ${quote.balance - applied}`;
        this.coinEffectEvents.push(event);
        this.deps.notify(
          debtAdded > 0
            ? `催债币越线：不返筹码，扣余额 ${percent}%（${applied} 筹码），另 ${debtAdded} 记在账上；${balanceChange}`
            : `催债币越线：不返筹码，扣余额 ${percent}%（${applied} 筹码）；${balanceChange}`,
          { event: 'debt-coin', priority: 3, tone: 'danger', amount: -applied, minVisibleSeconds: 3 },
        );
        break;
      }
      case 'ticket': {
        // 凭据取**差量**而不是表里的期望值：表说给 1 张、`earnTicket` 真给了几张，
        // 是两个口袋。读 `ticketBySource.effect` 的前后差，恒等式才有第二条腿可核。
        const run = this.deps.run();
        const before = run.ticketBySource.effect;
        run.earnTicket('effect', spec.payload.tickets ?? 0);
        event.ticketsGranted = run.ticketBySource.effect - before;
        this.coinEffectEvents.push(event);
        this.deps.notify(
          event.ticketsGranted > 0
            ? `票币越线：不返筹码，票券 +${event.ticketsGranted}（现在 ${run.tickets} 张可用）`
            : `票币越线：不返筹码，但这次一张券也没发出去（${spec.payload.tickets}）`,
          { event: 'ticket-coin', priority: 1, tone: 'reward', amount: event.ticketsGranted, minVisibleSeconds: 2 },
        );
        break;
      }
      default: {
        // 表里写了第三种 act 而这里没分支 —— 出声，不能静默当"已处理"。
        this.deps.notify(`币种效果 ${spec.label} 没有实现分支（不该发生）`);
        return;
      }
    }
    if (tally) tally.attributed += 1;
    this.deps.refresh();
  }

  /**
   * 记一次效果币注入尝试（`Game.spawnEffectCoin` 按表调，效果 id 由调用方给）。
   *
   * 为什么要把"尝试"和"成功"都记下来、还要按 id 分开：批里报"0 次结算"有三种完全不同的原因 ——
   * ① 注入条件根本没满足（投数不够 / 取模没对上）；② 条件满足了但 `coins.acquire()`
   * 返回 null（池满）；③ 币注进去了但没走完台面（局先结束）。
   * 只报"结算 0 次"分不出这三条，而那三条的处置完全不同。这是"缺席要能归因"的最低配置。
   */
  noteInjectAttempt(effect: CoinEffectId, spawned: boolean): void {
    const tally = this.tally.get(effect);
    if (!tally) return;
    tally.attempts += 1;
    if (spawned) tally.spawned += 1;
  }

  /** 判据读数：面板立着没、当前候选是谁、池子里有没有拿不到 DOM。 */
  report(): { visible: boolean; choices: EffectId[]; cost: number; missingDom: boolean; canOpen: boolean; blockedReason: string | null } {
    const run = this.deps.run();
    const blockedReason = run.phase === 'settled' || this.deps.canOpenDraft?.() === false ? '本局已经结束' :
      this.missingDom ? '奖励面板不可用' : run.phase === 'drainOut' ? '盘面沉降中，续玩后可领取' :
      !run.pendingDraft ? '本波目标尚未达成' : this.deps.showsBusy?.() ? '演出结束后可领取' : null;
    return {
      visible: this.visible,
      choices: this.current.map((choice) => choice.id),
      cost: DRAFT_COST,
      missingDom: this.missingDom,
      canOpen: blockedReason === null,
      blockedReason,
    };
  }

  /** 币种效果的逐事件与**逐效果**计数（归因门吃每个 id 上的 `triggers === attributed === 该 id 的事件数`）。 */
  coinEffectReport(): {
    byEffect: Record<CoinEffectId, CoinEffectTally & { events: number }>;
    events: CoinEffectEvent[];
  } {
    const byEffect = Object.fromEntries(
      COIN_EFFECT_IDS.map((id) => {
        const tally = this.tally.get(id) ?? { triggers: 0, attributed: 0, attempts: 0, spawned: 0 };
        return [
          id,
          {
            ...tally,
            events: this.coinEffectEvents.filter((event) => event.id === id).length,
          },
        ];
      }),
    ) as Record<CoinEffectId, CoinEffectTally & { events: number }>;
    return { byEffect, events: this.coinEffectEvents.map((event) => ({ ...event })) };
  }

  /**
   * 每局开始清一次（调用点在 `Game.startRun`，紧跟 `mechanisms.reset()`）。
   *
   * ⚠️ 少了这个调用点，分账就变成**会话累计**，
   * 而判据把逐局读数当本局数在求和 —— 10-07 就是因为要算「注入了几枚、排掉了几枚」才发现的。
   */
  resetCoinEffects(): void {
    for (const id of COIN_EFFECT_IDS) {
      this.tally.set(id, { triggers: 0, attributed: 0, attempts: 0, spawned: 0 });
    }
    this.coinEffectEvents = [];
    // ★ V3 U04：本局作废时**面板一起收**。旧版只清计数不关面板 ——
    // 上一局立着的三选一跨进新局还挂在屏幕中央，而它的 pendingDraft 属于
    // 已经作废的旧 RunState；残卡如果被点击，`pick()` 只挡 `visible`，
    // 效果会落进**新局**（零报错的静默跨局生效）。
    this.clearDraft();
  }
}
