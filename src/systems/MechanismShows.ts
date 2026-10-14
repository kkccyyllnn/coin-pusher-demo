import * as THREE from 'three';
import { COIN, TABLE } from '../game/constants';
import { coinColliderHeight } from '../entities/coinModels';
import {
  MECHANISM_CONSTANTS, type MechanismPlan, type Mechanisms, type MechanismResult,
  type MechanismTarget, type MechanismPosition,
} from './Mechanisms';
import { buildSweepRig, SWEEP_BLADE_SIZE, SWEEP_BLADE_REST_Y, type SweepRig } from '../render/mechanisms/SweepRig';
import { buildGrappleRig, GRAPPLE_CLAW_SIZE, type GrappleRig } from '../render/mechanisms/GrappleRig';
import { GRAPPLE_RIG_CLEARANCE } from './grappleGeometry';
import { buildReloadRig, RELOAD_SHOW_DURATION, RELOAD_OPEN_AT, RELOAD_CLOSE_AT, type ReloadRig } from '../render/mechanisms/ReloadRig';

export type MechanismShowId = 'sweep' | 'grapple' | 'reload';
export type MechanismFeedbackPhase = 'prepare' | 'hit' | 'release' | 'complete';
export type MechanismShowRecord = {
  id: MechanismShowId;
  targeted: number;
  delivered: number;
  skipped: number;
  firstHitAt: number;
  lastHitAt: number;
  deliveredAt: number;
  status: 'running' | 'completed' | 'cancelled';
  carried: number;
  grabbed: number;
  openedAt: number | null;
};
export type MechanismShowReport = {
  active: MechanismShowId | null;
  kind: MechanismShowId | null;
  busy: boolean;
  phase: string | null;
  carried: number;
  current: MechanismShowRecord | null;
  mesh: { name: string; x: number; y: number; z: number; mounted: boolean } | null;
  last: MechanismShowRecord | null;
  /** Start-time selection band; its x is the chosen lane, never the claw centroid. */
  selection: MechanismSelection | null;
};
export type MechanismSelection = {
  id: 'sweeper' | 'grapple';
  x: number;
  z: number;
  width: number;
  depth: number;
  bottomY: number;
  initialTargetCount: number;
};
export type MechanismCancellation = {
  token: number;
  record: MechanismShowRecord;
  reason: 'late-obstruction' | 'reset' | 'dispose';
};
type ShowDeps = {
  mechanisms: Mechanisms;
  reducedMotion: () => boolean;
  /** Physical delivery, rather than button press, is the audio/feedback trigger. */
  onHit?: (id: MechanismShowId, count: number) => void;
  onFeedback?: (id: MechanismShowId, phase: MechanismFeedbackPhase) => void;
  onCancel?: (event: MechanismCancellation) => void;
  onComplete?: (event: { token: number; record: MechanismShowRecord }) => void;
};
const ARM = { drop: 0.12, travel: 0.55, lift: 0.28 } as const;
const CLAW = { descend: 0.34, clamp: 0.2, lift: 0.34, carry: 0.4, open: 0.18, retreat: 0.3 } as const;
function seg01(t: number, start: number, length: number): number { return Math.min(1, Math.max(0, (t - start) / length)); }
function eased(t: number): number { return t * t * (3 - 2 * t); }
function lerp(a: number, b: number, t: number): number { return a + (b - a) * t; }

abstract class Apparatus {
  protected root: THREE.Group | null = null;
  protected probe: THREE.Object3D | null = null;
  protected elapsed = 0;
  protected phase = 'prepare';
  protected carried = 0;
  protected grabbed = 0;
  protected openedAt: number | null = null;
  protected deliveredCount = 0;
  protected failure: MechanismCancellation['reason'] | null = null;
  private skippedCount = 0;
  private firstAt = 0;
  private lastAt = 0;
  private settled = false;
  private status: MechanismShowRecord['status'] = 'running';
  protected readonly targeted: number;
  readonly selection: MechanismSelection | null;

  constructor(protected readonly deps: ShowDeps, readonly plan: MechanismPlan, protected readonly mount: THREE.Group) {
    this.targeted = plan.id === 'reload' ? (plan.affected ?? 0) : plan.targets.length;
    if (plan.id === 'sweeper' || plan.id === 'grapple') {
      const { targets, ...footprint } = deps.mechanisms.preview(plan.id, plan.x);
      this.selection = Object.freeze({ id: plan.id, ...footprint, initialTargetCount: targets });
    } else this.selection = null;
  }
  get currentProbe(): THREE.Object3D | null { return this.probe; }
  get currentPhase(): string { return this.phase; }
  get carryCount(): number { return this.carried; }
  get cancellationReason(): MechanismCancellation['reason'] | null { return this.failure; }
  abstract readonly id: MechanismShowId;
  protected abstract duration(): number;
  protected abstract build(): { root: THREE.Group; probe: THREE.Object3D };
  protected abstract destroy(): void;
  protected abstract animate(t: number): void;
  protected abstract settleTargets(): void;
  protected cancelTargets(): void {}

  protected mark(ok: boolean): void {
    if (!ok) { this.skippedCount += 1; return; }
    if (!this.deliveredCount) this.firstAt = this.elapsed;
    this.deliveredCount += 1;
    this.lastAt = this.elapsed;
    this.deps.onHit?.(this.id, 1);
    this.deps.onFeedback?.(this.id, 'hit');
  }
  update(delta: number): boolean {
    if (!this.root) {
      const built = this.build();
      this.root = built.root;
      this.probe = built.probe;
      this.mount.add(this.root);
      this.deps.onFeedback?.(this.id, 'prepare');
    }
    this.elapsed += Math.max(0, delta) * (this.deps.reducedMotion() ? 3 : 1);
    this.animate(this.elapsed);
    if (this.failure) {
      this.status = 'cancelled';
      this.phase = 'cancelled';
      this.skippedCount = this.targeted - this.deliveredCount;
      return false;
    }
    if (this.elapsed < this.duration()) return true;
    this.settle();
    this.status = 'completed';
    this.phase = 'complete';
    this.deps.onFeedback?.(this.id, 'complete');
    return false;
  }
  settle(): void {
    if (this.settled) return;
    this.settled = true;
    this.settleTargets();
  }
  cancel(reason: MechanismCancellation['reason']): void {
    this.cancelTargets();
    this.failure = reason;
    this.carried = 0;
    this.skippedCount = this.targeted - this.deliveredCount;
    this.status = 'cancelled';
    this.phase = 'cancelled';
  }
  record(): MechanismShowRecord {
    return {
      id: this.id, targeted: this.targeted, delivered: this.deliveredCount, skipped: this.skippedCount,
      firstHitAt: Number(this.firstAt.toFixed(4)), lastHitAt: Number(this.lastAt.toFixed(4)),
      deliveredAt: Number((this.id === 'grapple' ? this.firstAt : this.lastAt).toFixed(4)),
      status: this.status, carried: this.carried, grabbed: this.grabbed, openedAt: this.openedAt,
    };
  }
  dispose(): void {
    this.destroy();
    this.root = null;
    this.probe = null;
  }
}

class SweepArmShow extends Apparatus {
  readonly id = 'sweep' as const;
  private readonly pending: MechanismTarget[];
  private rig: SweepRig | null = null;
  private hitAt = -1;
  constructor(deps: ShowDeps, plan: MechanismPlan, mount: THREE.Group) {
    super(deps, plan, mount);
    this.pending = [...(plan.refs ?? [])];
  }
  protected duration(): number { return ARM.drop + ARM.travel + ARM.lift; }
  protected build(): { root: THREE.Group; probe: THREE.Object3D } {
    this.rig = buildSweepRig();
    return { root: this.rig.root, probe: this.rig.probe };
  }
  protected destroy(): void { this.rig?.dispose(); this.rig = null; }
  protected animate(t: number): void {
    const dropped = seg01(t, 0, ARM.drop);
    const swept = seg01(t, ARM.drop, ARM.travel);
    const lifted = seg01(t, ARM.drop + ARM.travel, ARM.lift);
    const x = -TABLE.halfWidth + 2 * TABLE.halfWidth * swept;
    this.phase = dropped < 1 ? 'lower' : swept < 1 ? 'sweep' : 'retreat';
    this.rig?.pose({ x, bladeY: SWEEP_BLADE_REST_Y + 0.08 * (1 - dropped) + 0.12 * lifted,
      dropped, swept, hitFlash: Math.max(0, 1 - (t - this.hitAt) / 0.12) });
    if (dropped < 1) return;
    const leading = x + SWEEP_BLADE_SIZE.width / 2;
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const ref = this.pending[i];
      if (ref.coin.position.x > leading) continue;
      this.pending.splice(i, 1);
      const ok = this.deps.mechanisms.sweepHit(ref.coin, ref.generation);
      this.mark(ok);
      if (ok) this.hitAt = this.elapsed;
    }
  }
  protected settleTargets(): void {
    while (this.pending.length) {
      const ref = this.pending.pop()!;
      this.mark(this.deps.mechanisms.sweepHit(ref.coin, ref.generation));
    }
  }
  protected cancelTargets(): void { this.pending.length = 0; }
}

/** Coins enter a controlled, contact-free carry and restore real dynamics on release. */
class GrappleClawShow extends Apparatus {
  readonly id = 'grapple' as const;
  private rig: GrappleRig | null = null;
  private refs: MechanismTarget[] = [];
  private origins: MechanismPosition[] = [];
  private destinations: MechanismPosition[] = [];
  private grabbedOnce = false;
  private released = false;
  private returning = false;
  private returnStarted = 0;
  private returnOrigins: MechanismPosition[] = [];
  private returnDestinations: MechanismPosition[] = [];
  private readonly at: { x: number; z: number; topY: number };
  private readonly aboveY: number;
  private releaseMouthY = MECHANISM_CONSTANTS.grappleLiftY;
  private beamY: number;
  constructor(deps: ShowDeps, plan: MechanismPlan, mount: THREE.Group) {
    super(deps, plan, mount);
    const refs = deps.mechanisms.validTargets(plan);
    const n = Math.max(1, refs.length);
    this.at = { x: 0, z: 0, topY: TABLE.floorY + COIN.halfThickness };
    for (const { coin } of refs) {
      const p = coin.position;
      this.at.x += p.x / n;
      this.at.z += p.z / n;
      this.at.topY = Math.max(this.at.topY, p.y + coinColliderHeight(coin.kind) / 2);
    }
    this.aboveY = this.at.topY + GRAPPLE_CLAW_SIZE.height + 0.18;
    this.beamY = this.aboveY + GRAPPLE_CLAW_SIZE.height / 2 + 0.16;
  }
  protected duration(): number {
    return this.returning ? Infinity : Object.values(CLAW).reduce((sum, value) => sum + value, 0);
  }
  protected build(): { root: THREE.Group; probe: THREE.Object3D } {
    this.rig = buildGrappleRig(this.at, MECHANISM_CONSTANTS.grappleTargetZ);
    return { root: this.rig.root, probe: this.rig.probe };
  }
  protected destroy(): void { this.rig?.dispose(); this.rig = null; }
  protected animate(t: number): void {
    if (this.returning) { this.animateReturn(t); return; }
    const descend = eased(seg01(t, 0, CLAW.descend));
    const clampT = eased(seg01(t, CLAW.descend, CLAW.clamp));
    const liftStart = CLAW.descend + CLAW.clamp;
    const lift = eased(seg01(t, liftStart, CLAW.lift));
    const carry = eased(seg01(t, liftStart + CLAW.lift, CLAW.carry));
    const open = eased(seg01(t, liftStart + CLAW.lift + CLAW.carry, CLAW.open));
    const retreat = eased(seg01(t, this.duration() - CLAW.retreat, CLAW.retreat));
    this.phase = descend < 1 ? 'descend' : clampT < 1 ? 'grip' : lift < 1 ? 'lift' : carry < 1 ? 'carry' : open < 1 ? 'release' : 'retreat';
    if (t >= liftStart && !this.grabbedOnce) {
      this.grabbedOnce = true;
      this.refs = this.deps.mechanisms.grappleGrab(this.plan);
      this.origins = this.refs.map(({ coin }) => ({ ...coin.position }));
      this.destinations = this.deps.mechanisms.grappleReleasePositions(this.plan, this.refs);
      this.grabbed = this.refs.length;
      this.carried = this.refs.length;
      const top = this.destinations.reduce((max, p, index) => Math.max(max,
        p.y + coinColliderHeight(this.refs[index].coin.kind) / 2), MECHANISM_CONSTANTS.grappleLiftY);
      this.releaseMouthY = top + GRAPPLE_RIG_CLEARANCE.mouthAboveCargo;
      this.beamY = Math.max(this.beamY, this.releaseMouthY + GRAPPLE_RIG_CLEARANCE.beamAboveMouth);
    }
    const catchMouthY = this.at.topY + GRAPPLE_CLAW_SIZE.height / 2;
    const mouthY = lerp(this.aboveY, catchMouthY, descend) +
      (this.releaseMouthY - catchMouthY) * lift + 0.22 * retreat;
    const destinationCenterX = this.destinations.length
      ? (this.destinations[0].x + (this.destinations[1]?.x ?? this.destinations[0].x)) / 2 : this.at.x;
    const mouthX = lerp(this.at.x, destinationCenterX, carry);
    const mouthZ = lerp(this.at.z, MECHANISM_CONSTANTS.grappleTargetZ, carry);
    this.rig?.pose({ x: mouthX, y: mouthY, z: mouthZ,
      grip: 1 - 0.45 * clampT + 0.51 * open, descend, beamY: this.beamY });
    if (this.grabbedOnce && !this.released) {
      // Lift and spread the real load continuously, then carry the packed load
      // to its release footprint. No velocities are imparted by the crane.
      this.refs.forEach(({ coin, generation }, index) => {
        const from = this.origins[index];
        const to = this.destinations[index];
        coin.moveMechanismControlled(generation, {
          x: lerp(from.x, to.x - (destinationCenterX - this.at.x), lift) + (destinationCenterX - this.at.x) * carry,
          y: lerp(from.y, to.y, lift),
          z: lerp(from.z, to.z - (MECHANISM_CONSTANTS.grappleTargetZ - this.at.z), lift) +
            (MECHANISM_CONSTANTS.grappleTargetZ - this.at.z) * carry,
        });
      });
      if (carry >= 1) this.settle();
    }
  }
  protected settleTargets(): void {
    if (this.released) return;
    const result = this.deps.mechanisms.grappleRelease(this.plan, this.refs);
    if (!result.ok) {
      this.returning = true;
      this.returnStarted = this.elapsed;
      this.returnOrigins = this.refs.map(({ coin }) => ({ ...coin.position }));
      this.returnDestinations = this.deps.mechanisms.grappleReturnPositions(this.refs, this.origins) ?? [];
      this.phase = 'return';
      return;
    }
    this.released = true;
    this.deps.onFeedback?.(this.id, 'release');
    this.carried = 0;
    for (let i = 0; i < result.delivered; i += 1) this.mark(true);
    for (let i = 0; i < result.skipped; i += 1) this.mark(false);
  }
  private animateReturn(t: number): void {
    this.phase = 'return';
    if (this.returnDestinations.length !== this.refs.length) {
      // Leave real bodies disabled when no legal return exists. Retry against the
      // moving bed; reset/dispose can still synchronously restore and clean them.
      const positions = this.deps.mechanisms.grappleReturnPositions(this.refs, this.origins);
      if (!positions) { this.phase = 'return-wait'; return; }
      this.returnDestinations = positions;
      this.returnOrigins = this.refs.map(({ coin }) => ({ ...coin.position }));
      this.returnStarted = t;
    }
    const progress = eased(seg01(t, this.returnStarted, CLAW.carry));
    let x = 0, z = 0;
    let top: number = TABLE.floorY;
    this.refs.forEach(({ coin, generation }, index) => {
      const from = this.returnOrigins[index], to = this.returnDestinations[index];
      const p = { x: lerp(from.x, to.x, progress), y: lerp(from.y, to.y, progress), z: lerp(from.z, to.z, progress) };
      coin.moveMechanismControlled(generation, p);
      x += p.x / this.refs.length;
      z += p.z / this.refs.length;
      top = Math.max(top, p.y + coinColliderHeight(coin.kind) / 2);
    });
    const mouthY = top + GRAPPLE_RIG_CLEARANCE.mouthAboveCargo;
    this.rig?.pose({ x, y: mouthY, z, grip: 0.55, descend: 1, beamY: Math.max(this.beamY,
      mouthY + GRAPPLE_RIG_CLEARANCE.beamAboveMouth) });
    if (progress < 1) return;
    if (!this.deps.mechanisms.grappleReturn(this.refs, this.returnDestinations)) {
      // The return footprint can also be occupied late. Do not enable inside it.
      this.returnDestinations = [];
      return;
    }
    this.carried = 0;
    this.released = true;
    this.failure = 'late-obstruction';
  }
  protected cancelTargets(): void {
    if (!this.released) this.deps.mechanisms.grappleCancel(this.refs);
  }
}

class ReloadHopperShow extends Apparatus {
  readonly id = 'reload' as const;
  private rig: ReloadRig | null = null;
  private nextCoin = 0;
  protected duration(): number { return RELOAD_SHOW_DURATION; }
  protected build(): { root: THREE.Group; probe: THREE.Object3D } {
    this.rig = buildReloadRig();
    return { root: this.rig.root, probe: this.rig.root };
  }
  protected destroy(): void { this.rig?.dispose(); this.rig = null; }
  protected animate(t: number): void {
    this.rig?.pose(Math.min(1, t / this.duration()));
    this.phase = t < RELOAD_OPEN_AT ? 'open' : t < RELOAD_CLOSE_AT ? 'deliver' : 'close';
    if (t < RELOAD_OPEN_AT) return;
    this.openedAt ??= RELOAD_OPEN_AT;
    while (this.nextCoin < this.targeted && t >= RELOAD_OPEN_AT + 0.02 + this.nextCoin * 0.08) {
      this.mark(this.deps.mechanisms.reloadDeliver(this.plan, this.nextCoin));
      this.nextCoin += 1;
    }
  }
  protected settleTargets(): void {
    while (this.nextCoin < this.targeted) {
      this.mark(this.deps.mechanisms.reloadDeliver(this.plan, this.nextCoin));
      this.nextCoin += 1;
    }
  }
}

export class MechanismShows {
  readonly group = new THREE.Group();
  private active: Apparatus | null = null;
  private lastRecord: MechanismShowRecord | null = null;
  private readonly world = new THREE.Vector3();
  constructor(private readonly deps: ShowDeps) {}
  get busy(): boolean { return this.active !== null; }
  runSweep(plan: MechanismPlan): MechanismResult { return this.start(plan, () => new SweepArmShow(this.deps, plan, this.group)); }
  runGrapple(plan: MechanismPlan): MechanismResult { return this.start(plan, () => new GrappleClawShow(this.deps, plan, this.group)); }
  runReload(plan: MechanismPlan): MechanismResult { return this.start(plan, () => new ReloadHopperShow(this.deps, plan, this.group)); }
  private start(plan: MechanismPlan, build: () => Apparatus): MechanismResult {
    if (this.active) {
      if (this.active.plan !== plan) this.deps.mechanisms.cancelPlan(plan);
      return { ok: false, reason: '机关正在动作，请等它完成' };
    }
    const accepted = this.deps.mechanisms.acceptPlan(plan);
    if (!accepted.ok) { this.deps.mechanisms.cancelPlan(plan); return accepted; }
    this.active = build();
    return accepted;
  }
  update(delta: number): void {
    const show = this.active;
    if (!show || show.update(delta)) return;
    this.lastRecord = show.record();
    if (show.cancellationReason) {
      this.deps.mechanisms.cancelPlan(show.plan, show.cancellationReason === 'late-obstruction' && this.lastRecord.delivered === 0);
      this.deps.onCancel?.({ token: show.plan.token!, record: this.lastRecord, reason: show.cancellationReason });
    } else {
      this.deps.mechanisms.finishPlan(show.plan);
      this.deps.onComplete?.({ token: show.plan.token!, record: this.lastRecord });
    }
    show.dispose();
    this.active = null;
  }
  /** Reset/dispose cancels instead of emitting coins into the next run. */
  abort(reason: 'reset' | 'dispose' = 'reset'): void {
    const show = this.active;
    if (!show) return;
    show.cancel(reason);
    this.lastRecord = show.record();
    this.deps.mechanisms.cancelPlan(show.plan);
    this.deps.onCancel?.({ token: show.plan.token!, record: this.lastRecord, reason });
    show.dispose();
    this.active = null;
  }
  dispose(): void { this.abort('dispose'); this.group.clear(); }
  report(): MechanismShowReport {
    const show = this.active;
    const probe = show?.currentProbe ?? null;
    const common = { active: show?.id ?? null, kind: show?.id ?? null, busy: !!show, phase: show?.currentPhase ?? null,
      carried: show?.carryCount ?? 0, current: show?.record() ?? null, last: this.lastRecord,
      selection: show?.selection ?? null };
    if (!probe) return { ...common, mesh: null };
    probe.getWorldPosition(this.world);
    return { ...common, mesh: { name: probe.name, mounted: probe.parent !== null,
      x: Number(this.world.x.toFixed(4)), y: Number(this.world.y.toFixed(4)), z: Number(this.world.z.toFixed(4)) } };
  }
}
