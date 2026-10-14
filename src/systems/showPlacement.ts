import type { Coin } from '../entities/Coin';
import { coinColliderSpec } from '../entities/coinModels';
import { cabinetShape } from '../game/cabinetShape';
import { TABLE, type CoinKind } from '../game/constants';
import { boundsOverlap, coinWorldBounds, type CoinBounds } from './grappleLayout';

export type ShowSpawnPose = { x: number; y: number; z: number; yaw: number };
type ActiveCoins = { forEachActive(visit: (coin: Coin) => void): void };
/** Existing tower drop gap; shared by all true deliveries, independent of RNG. */
export const SHOW_SPAWN_CLEARANCE = 0.012;
const EPSILON = 1e-7;

export function showSpawnTopLimit(): number {
  return cabinetShape().hood.underY - SHOW_SPAWN_CLEARANCE;
}

/** Fresh show coins have yaw only; current obstacles use their actual full rotation. */
export function showSpawnBounds(kind: CoinKind, pose: ShowSpawnPose): CoinBounds {
  const spec = coinColliderSpec(kind);
  const half = spec.shape === 'cylinder'
    ? [spec.radius, spec.halfHeight, spec.radius]
    : [Math.abs(Math.cos(pose.yaw)) * spec.halfExtents[0] + Math.abs(Math.sin(pose.yaw)) * spec.halfExtents[2],
        spec.halfExtents[1],
        Math.abs(Math.sin(pose.yaw)) * spec.halfExtents[0] + Math.abs(Math.cos(pose.yaw)) * spec.halfExtents[2]];
  return { min: { x: pose.x - half[0], y: pose.y - half[1], z: pose.z - half[2] },
    max: { x: pose.x + half[0], y: pose.y + half[1], z: pose.z + half[2] } };
}

function overlapsXZ(a: CoinBounds, b: CoinBounds): boolean {
  return a.min.x < b.max.x - EPSILON && a.max.x > b.min.x + EPSILON &&
    a.min.z < b.max.z - EPSILON && a.max.z > b.min.z + EPSILON;
}

/** Plan without spawning, allocating pool capacity, drawing RNG, or moving any body.
 * All requested coins fit together or none is delivered. A late full-height
 * obstruction returns null so the real show can retry without losing its quota.
 */
export function planShowSpawns(coins: ActiveCoins, kind: CoinKind,
  requests: readonly ShowSpawnPose[], aboveSurface = false): ShowSpawnPose[] | null {
  const occupied: CoinBounds[] = [];
  coins.forEachActive(coin => occupied.push(coinWorldBounds(coin)));
  const positions: ShowSpawnPose[] = [];
  for (const request of requests) {
    const pose = { ...request };
    let box = showSpawnBounds(kind, pose);
    const halfY = (box.max.y - box.min.y) / 2;
    // Enlarged model rewards must clear the real back-wall plane too.
    pose.z += Math.max(0, TABLE.backZ + SHOW_SPAWN_CLEARANCE - box.min.z);
    pose.y = Math.max(pose.y, TABLE.floorY + halfY + SHOW_SPAWN_CLEARANCE);
    box = showSpawnBounds(kind, pose);
    if (box.min.x < -TABLE.halfWidth + SHOW_SPAWN_CLEARANCE ||
        box.max.x > TABLE.halfWidth - SHOW_SPAWN_CLEARANCE) return null;
    if (aboveSurface) {
      for (const other of occupied) if (overlapsXZ(box, other)) {
        pose.y = Math.max(pose.y, other.max.y + halfY + SHOW_SPAWN_CLEARANCE);
      }
      box = showSpawnBounds(kind, pose);
    }
    // Each iteration rises above at least one actual intersecting collider.
    // No search threshold can authorize an overlapping birth.
    for (let attempt = 0; attempt <= occupied.length; attempt += 1) {
      const colliding = occupied.filter(other => boundsOverlap(box, other));
      if (!colliding.length) break;
      pose.y = Math.max(...colliding.map(other => other.max.y)) + halfY + SHOW_SPAWN_CLEARANCE;
      box = showSpawnBounds(kind, pose);
    }
    if (![pose.x, pose.y, pose.z, pose.yaw].every(Number.isFinite) ||
        box.max.y > showSpawnTopLimit() + EPSILON ||
        occupied.some(other => boundsOverlap(box, other))) return null;
    positions.push(pose);
    occupied.push(box);
  }
  return positions;
}
