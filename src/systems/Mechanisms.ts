import type { Coin } from '../entities/Coin';
import type { CoinPool, CoinReservation } from '../entities/CoinPool';
import { COIN, TABLE } from '../game/constants';
import { COIN_SCALE } from '../game/coinScale';
import { GRAPPLE_HALF, GRAPPLE_DEPTH_HALF, GRAPPLE_TARGET_Z, GRAPPLE_LIFT_Y, grappleCargoTopLimit, grapplePickupTopLimit } from './grappleGeometry';
import { coinWorldBounds, planGrappleRelease, planGrappleReturn, safeCargoPositions, type CoinBounds } from './grappleLayout';

export type MechanismId = 'sweeper' | 'grapple' | 'reload';
export type MechanismResult = { ok: boolean; reason?: string; affected?: number };
export type MechanismTarget = { coin: Coin; generation: number };
export type MechanismPosition = { x: number; y: number; z: number };
export type MechanismPlan = MechanismResult & {
  /** Kept for HUD/test consumers; effects use the generation-stamped refs. */
  targets: Coin[];
  refs?: MechanismTarget[];
  x?: number;
  token?: number;
  id?: MechanismId;
};

type PendingPlan = {
  plan: MechanismPlan;
  accepted: boolean;
  reservation?: CoinReservation;
  release?: { refs: MechanismTarget[]; positions: MechanismPosition[] };
};

export const MECHANISM_USES: Record<Exclude<MechanismId, 'reload'>, number> = { sweeper: 1, grapple: 2 };
export const MECHANISM_COST = { sweeper: 0, grapple: 2, reload: 1 } as const;
const SWEEP_ZONE = 0.15;
const SWEEP_BOTTOM_Y = TABLE.floorY + 0.002;
const SWEEP_IMPULSE = 0.12 * COIN_SCALE ** 3;

/** Plans have no cost/usage side effect. The show accepts once, then Game charges once. */
export class Mechanisms {
  private uses: Record<Exclude<MechanismId, 'reload'>, number> = { ...MECHANISM_USES };
  private serial = 0;
  private readonly pending = new Map<number, PendingPlan>();

  constructor(private readonly coins: CoinPool) {}

  reset(): void {
    for (const { plan } of this.pending.values()) this.cancelPlan(plan);
    this.uses = { ...MECHANISM_USES };
  }

  usesLeft(id: MechanismId): number { return id === 'reload' ? Infinity : this.uses[id]; }
  grantUses(id: Exclude<MechanismId, 'reload'>, amount: number): number {
    const n = Math.max(0, Math.floor(amount));
    this.uses[id] += n;
    return n;
  }

  private reject(reason: string): MechanismPlan { return { ok: false, reason, targets: [] }; }
  private collect(predicate: (coin: Coin) => boolean): Coin[] {
    const picked: Coin[] = [];
    this.coins.forEachActive((coin) => {
      if (!coin.mechanismControlled && predicate(coin)) picked.push(coin);
      return false;
    });
    return picked;
  }

  private targetsFor(id: 'sweeper' | 'grapple', centerX = 0): Coin[] {
    return this.collect((coin) => id === 'sweeper'
      ? coin.position.z >= TABLE.scoreLineZ - SWEEP_ZONE
      : Math.abs(coin.position.x - centerX) <= GRAPPLE_HALF &&
        Math.abs(coin.position.z - TABLE.pusherFrontZAtRest) <= GRAPPLE_DEPTH_HALF);
  }

  /** Preview and acceptance use the same selection band; this never creates a plan. */
  preview(id: 'sweeper' | 'grapple', centerX = 0): {
    targets: number; x: number; z: number; width: number; depth: number; bottomY: number;
  } {
    return { targets: this.targetsFor(id, centerX).length,
      x: id === 'grapple' ? centerX : 0,
      z: id === 'grapple' ? TABLE.pusherFrontZAtRest : TABLE.scoreLineZ - SWEEP_ZONE / 2,
      width: id === 'grapple' ? GRAPPLE_HALF * 2 : TABLE.halfWidth * 2,
      depth: id === 'grapple' ? GRAPPLE_DEPTH_HALF * 2 : SWEEP_ZONE,
      bottomY: id === 'grapple' ? TABLE.floorY : SWEEP_BOTTOM_Y };
  }

  private create(id: MechanismId, targets: Coin[], x?: number, reservation?: CoinReservation): MechanismPlan {
    const plan: MechanismPlan = {
      ok: true, id, token: ++this.serial, targets, x,
      affected: reservation ? reservation.coins.length : targets.length,
      refs: targets.map((coin) => ({ coin, generation: coin.spawnGeneration })),
    };
    this.pending.set(plan.token!, { plan, accepted: false, reservation });
    return plan;
  }

  acceptPlan(plan: MechanismPlan): MechanismResult {
    const pending = this.pending.get(plan.token ?? -1);
    if (!plan.ok || !pending || pending.plan !== plan || pending.accepted || !plan.id) {
      return { ok: false, reason: '机关计划已经失效' };
    }
    if (plan.id !== 'reload') {
      if (this.uses[plan.id] <= 0) return { ok: false, reason: '本局机关已用完' };
      const refs = this.validTargets(plan);
      if (refs.length === 0) return { ok: false, reason: '目标已经离开作用区域' };
      if (plan.id === 'grapple') {
        if (refs.some(({ coin }) => coinWorldBounds(coin).max.y > grapplePickupTopLimit())) return { ok: false, reason: '目标币塔太高，抓斗暂时无法安全搬运' };
        const positions = planGrappleRelease(plan.x ?? 0, refs, this.obstacles(refs));
        if (!positions) return { ok: false, reason: '前沿币堆太高，抓斗暂时没有安全落点' };
        pending.release = { refs, positions };
      }
      this.uses[plan.id] -= 1;
    }
    pending.accepted = true;
    return { ok: true, affected: plan.affected };
  }

  cancelPlan(plan: MechanismPlan, restoreUse = false): void {
    const pending = this.pending.get(plan.token ?? -1);
    if (!pending || pending.plan !== plan) return;
    if (pending.reservation) this.coins.releaseReservation(pending.reservation);
    if (restoreUse && pending.accepted && plan.id && plan.id !== 'reload') this.uses[plan.id] += 1;
    this.pending.delete(plan.token!);
  }
  finishPlan(plan: MechanismPlan): void { this.cancelPlan(plan); }

  validTargets(plan: MechanismPlan): MechanismTarget[] {
    return (plan.refs ?? []).filter(({ coin, generation }) => coin.active && coin.spawnGeneration === generation);
  }

  sweep(): MechanismPlan {
    if (this.uses.sweeper <= 0) return this.reject('本局扫板已用完');
    const targets = this.targetsFor('sweeper');
    if (!targets.length) return this.reject('得分线附近没有可扫的币');
    return this.create('sweeper', targets);
  }

  sweepHit(coin: Coin, generation = coin.spawnGeneration): boolean {
    if (!coin.active || coin.spawnGeneration !== generation || coin.mechanismControlled) return false;
    coin.body.applyImpulse({ x: 0, y: 0, z: SWEEP_IMPULSE }, true);
    return true;
  }

  /** The original 0.3 m wide / 1.2 m deep selection band is retained. */
  grapple(centerX: number): MechanismPlan {
    if (this.uses.grapple <= 0) return this.reject('本局抓斗已用完');
    if (!Number.isFinite(centerX)) return this.reject('请选择有效的抓取位置');
    const targets = this.targetsFor('grapple', centerX);
    if (!targets.length) return this.reject('这个位置没有可抓的币');
    const refs = targets.map((coin) => ({ coin, generation: coin.spawnGeneration }));
    if (refs.some(({ coin }) => coinWorldBounds(coin).max.y > grapplePickupTopLimit())) return this.reject('目标币塔太高，抓斗暂时无法安全搬运');
    if (!planGrappleRelease(centerX, refs, this.obstacles(refs))) return this.reject('前沿币堆太高，抓斗暂时没有安全落点');
    return this.create('grapple', targets, centerX);
  }

  grappleGrab(plan: MechanismPlan): MechanismTarget[] {
    const pending = this.pending.get(plan.token ?? -1);
    if (!pending || pending.plan !== plan || !pending.accepted) return [];
    return this.validTargets(plan).filter(({ coin, generation }) => coin.beginMechanismControl(generation));
  }

  private obstacles(refs: readonly MechanismTarget[]): CoinBounds[] {
    const held = new Map(refs.map(({ coin, generation }) => [coin, generation]));
    const obstacles: CoinBounds[] = [];
    this.coins.forEachActive((coin) => {
      if (!coin.mechanismControlled && held.get(coin) !== coin.spawnGeneration) obstacles.push(coinWorldBounds(coin));
      return false;
    });
    return obstacles;
  }

  /** Acceptance locks one layout; delivery must use these very same positions. */
  grappleReleasePositions(plan: MechanismPlan, refs: readonly MechanismTarget[]): MechanismPosition[] {
    const pending = this.pending.get(plan.token ?? -1);
    const locked = pending?.plan === plan ? pending.release : undefined;
    if (!locked) return [];
    return refs.map(({ coin, generation }) => {
      const index = locked.refs.findIndex((ref) => ref.coin === coin && ref.generation === generation);
      return index < 0 ? null : { ...locked.positions[index] };
    }).filter((p): p is MechanismPosition => p !== null);
  }

  grappleRelease(plan: MechanismPlan, carried?: readonly MechanismTarget[]): { ok: boolean; delivered: number; skipped: number } {
    const refs = carried ?? this.grappleGrab(plan);
    const positions = this.grappleReleasePositions(plan, refs);
    if (!safeCargoPositions(refs, positions, this.obstacles(refs))) {
      return { ok: false, delivered: 0, skipped: plan.targets.length };
    }
    let delivered = 0;
    refs.forEach(({ coin, generation }, index) => {
      if (!coin.moveMechanismControlled(generation, positions[index])) return;
      if (coin.endMechanismControl(generation)) delivered += 1;
    });
    return { ok: true, delivered, skipped: plan.targets.length - delivered };
  }

  grappleReturnPositions(refs: readonly MechanismTarget[], origins: readonly MechanismPosition[]): MechanismPosition[] | null {
    return planGrappleReturn(refs, origins, this.obstacles(refs));
  }
  grappleReturn(refs: readonly MechanismTarget[], positions: readonly MechanismPosition[]): boolean {
    if (!safeCargoPositions(refs, positions, this.obstacles(refs))) return false;
    for (let index = 0; index < refs.length; index += 1) {
      const { coin, generation } = refs[index];
      if (coin.active && coin.spawnGeneration === generation && coin.mechanismControlled) {
        coin.moveMechanismControlled(generation, positions[index]);
      }
    }
    for (const { coin, generation } of refs) coin.endMechanismControl(generation);
    return true;
  }

  grappleCancel(refs: readonly MechanismTarget[]): void {
    for (const { coin, generation } of refs) coin.endMechanismControl(generation, true);
  }

  /** Capacity is reserved immediately, but no coin exists before the hopper opens. */
  reload(count = 3): MechanismPlan {
    const reservation = this.coins.reserve(count);
    if (!reservation) return this.reject(`盘面已满，装不下 ${count} 枚`);
    return this.create('reload', [], undefined, reservation);
  }

  reloadDeliver(plan: MechanismPlan, index: number): boolean {
    const pending = this.pending.get(plan.token ?? -1);
    if (!pending || pending.plan !== plan || !pending.accepted || !pending.reservation) return false;
    return this.coins.emitReserved(pending.reservation, index, (coin) => {
      coin.spawn('bronze', -0.3 + index * 0.3,
        TABLE.pusherTopY + 0.34 + index * 0.05, 0.42 + (index % 2) * 0.08,
        index * 0.7, false);
    });
  }
}

export const MECHANISM_CONSTANTS = {
  grappleHalf: GRAPPLE_HALF,
  grappleDepthHalf: GRAPPLE_DEPTH_HALF,
  sweepZone: SWEEP_ZONE,
  sweepBottomY: SWEEP_BOTTOM_Y,
  sweepImpulse: SWEEP_IMPULSE,
  grappleTargetZ: GRAPPLE_TARGET_Z,
  grappleLiftY: GRAPPLE_LIFT_Y,
  grappleCargoTopLimit: grappleCargoTopLimit(),
  coinBudget: COIN.budget,
} as const;
