import type * as RAPIER from '@dimforge/rapier3d-compat';
import type { Coin } from '../entities/Coin';
import type { Pusher } from '../entities/Pusher';

export type PusherPressureSample = {
  t: number; cycle: number; contacts: number; impulse: number;
  x: number; y: number; z: number;
};
export type PlayerPressedSample = {
  coin: Coin; generation: number; t: number; impulse: number;
  x: number; y: number; z: number;
};
type ContactFeedbackDeps = {
  world: RAPIER.World;
  pusher: Pusher;
  coins: readonly Coin[];
  now: () => number;
  /** Must check the same original player-drop generation, not playerDropped alone. */
  hasLanded: (coin: Coin, generation: number) => boolean;
  onPressure: (sample: PusherPressureSample) => void;
  onPlayerPressed: (sample: PlayerPressedSample) => void;
};

/** Presentation observer only: call AFTER each world.step, never in the before-step callback. */
export class PusherContactFeedback {
  private readonly byHandle = new Map<number, Coin>();
  private pressed = new WeakMap<Coin, number>();
  private lastPressureCycle = -1;
  constructor(private readonly deps: ContactFeedbackDeps) {
    for (const coin of deps.coins) this.byHandle.set(coin.body.collider(0).handle, coin);
  }
  reset(): void { this.pressed = new WeakMap(); this.lastPressureCycle = -1; }
  afterSubStep(): void {
    const { world, pusher } = this.deps;
    if (!pusher.running || pusher.velocityZ === 0) return;
    const cycle = pusher.cyclesCompleted;
    const frontActive = pusher.running && pusher.currentPhase === 'extend' && pusher.velocityZ > 0 && cycle !== this.lastPressureCycle;
    let contacts = 0, impulse = 0, x = 0, y = 0, z = 0;
    // Iterate real narrow-phase pairs, rather than scanning every coin by distance.
    for (let colliderIndex = 0; colliderIndex < pusher.body.numColliders(); colliderIndex += 1) {
      const plate = pusher.body.collider(colliderIndex);
      const wantsFront = colliderIndex === 0 && frontActive;
      world.contactPairsWith(plate, collider => {
      const coin = this.byHandle.get(collider.handle);
      if (!coin?.active || coin.mechanismControlled || !coin.body.isEnabled()) return;
      const generation = coin.spawnGeneration;
      const wantsPlayer = colliderIndex === 1 && pusher.running && pusher.velocityZ !== 0 && coin.playerDropped && this.pressed.get(coin) !== generation && this.deps.hasLanded(coin, generation);
      if (!wantsFront && !wantsPlayer) return;
      world.contactPair(plate, collider, (manifold, flipped) => {
        const normal = manifold.normal();
        const sign = flipped ? -1 : 1;
        const nx = normal.x * sign, ny = normal.y * sign, nz = normal.z * sign;
        let normalImpulse = 0, tangentImpulse = 0;
        for (let i = 0; i < manifold.numContacts(); i += 1) {
          normalImpulse += Math.max(0, manifold.contactImpulse(i));
          tangentImpulse += Math.hypot(manifold.contactTangentImpulseX(i), manifold.contactTangentImpulseY(i));
        }
        // These are geometric faces and strictly positive actual solved impulses,
        // not a new force/physics threshold or an inferred proximity collision.
        if (wantsFront && nz > 0 && nz > Math.abs(nx) && nz > Math.abs(ny) && normalImpulse > 0) {
          const point = manifold.numSolverContacts() ? manifold.solverContactPoint(0) : coin.position;
          contacts += 1; impulse += normalImpulse;
          x += point.x * normalImpulse; y += point.y * normalImpulse; z += point.z * normalImpulse;
        }
        if (wantsPlayer && ny > 0 && ny > Math.abs(nx) && ny > Math.abs(nz) && tangentImpulse > 0 && this.pressed.get(coin) !== generation) {
          this.pressed.set(coin, generation);
          const p = coin.position;
          this.deps.onPlayerPressed({ coin, generation, t: this.deps.now(), impulse: tangentImpulse, x: p.x, y: p.y, z: p.z });
        }
      });
      });
    }
    if (impulse > 0) {
      this.lastPressureCycle = cycle;
      this.deps.onPressure({ t: this.deps.now(), cycle, contacts, impulse, x: x / impulse, y: y / impulse, z: z / impulse });
    }
  }
}
