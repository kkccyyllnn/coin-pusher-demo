import type { Coin } from '../entities/Coin';
import { coinColliderHeight, coinColliderSpec } from '../entities/coinModels';
import { COIN, TABLE } from '../game/constants';
import { COIN_SCALE } from '../game/coinScale';
import { clamp } from '../utils/numeric';
import { GRAPPLE_LIFT_Y, GRAPPLE_TARGET_Z, grappleCargoTopLimit } from './grappleGeometry';

export type CargoPosition = { x: number; y: number; z: number };
export type CargoRef = { coin: Coin; generation: number };
export type CoinBounds = { min: CargoPosition; max: CargoPosition };
const CLEARANCE = 0.008 * COIN_SCALE;
const EPSILON = 1e-7;

function halfExtents(coin: Coin): [number, number, number] {
  const spec = coinColliderSpec(coin.kind);
  return spec.shape === 'cylinder' ? [spec.radius, spec.halfHeight, spec.radius] : spec.halfExtents;
}
function boundsAt(p: CargoPosition, half: readonly number[]): CoinBounds {
  return { min: { x: p.x - half[0], y: p.y - half[1], z: p.z - half[2] },
    max: { x: p.x + half[0], y: p.y + half[1], z: p.z + half[2] } };
}
export function coinPlacementBounds(coin: Coin, p: CargoPosition): CoinBounds { return boundsAt(p, halfExtents(coin)); }

/** The actual oriented collider's world AABB; a yawed box is not a coin-sized cylinder. */
export function coinWorldBounds(coin: Coin): CoinBounds {
  const q = coin.body.rotation();
  const rows = [
    [1 - 2 * (q.y * q.y + q.z * q.z), 2 * (q.x * q.y - q.z * q.w), 2 * (q.x * q.z + q.y * q.w)],
    [2 * (q.x * q.y + q.z * q.w), 1 - 2 * (q.x * q.x + q.z * q.z), 2 * (q.y * q.z - q.x * q.w)],
    [2 * (q.x * q.z - q.y * q.w), 2 * (q.y * q.z + q.x * q.w), 1 - 2 * (q.x * q.x + q.y * q.y)],
  ];
  const spec = coinColliderSpec(coin.kind);
  const half = rows.map((row) => spec.shape === 'cylinder'
    ? spec.halfHeight * Math.abs(row[1]) + spec.radius * Math.sqrt(Math.max(0, 1 - row[1] * row[1]))
    : row.reduce((sum, value, axis) => sum + Math.abs(value) * spec.halfExtents[axis], 0));
  return boundsAt(coin.position, half);
}
function overlapsXZ(a: CoinBounds, b: CoinBounds): boolean {
  return a.min.x < b.max.x - EPSILON && a.max.x > b.min.x + EPSILON &&
    a.min.z < b.max.z - EPSILON && a.max.z > b.min.z + EPSILON;
}
export function boundsOverlap(a: CoinBounds, b: CoinBounds): boolean {
  return overlapsXZ(a, b) && a.min.y < b.max.y - EPSILON && a.max.y > b.min.y + EPSILON;
}

/** Every group of four pays only for its own tallest collider. */
export function packedGrapplePositions(center: number, refs: readonly CargoRef[]): CargoPosition[] {
  const radius = refs.reduce((max, { coin }) => Math.max(max, ...halfExtents(coin).filter((_, axis) => axis !== 1)), COIN.radius);
  const pitch = radius * 2 + CLEARANCE;
  const centerX = clamp(center, -TABLE.drop.halfLane + pitch / 2, TABLE.drop.halfLane - pitch / 2);
  let bottom = GRAPPLE_LIFT_Y - COIN.halfThickness;
  const positions: CargoPosition[] = [];
  for (let first = 0; first < refs.length; first += 4) {
    const layer = refs.slice(first, first + 4);
    for (let offset = 0; offset < layer.length; offset += 1) positions.push({
      x: centerX + (offset % 2 - 0.5) * pitch,
      y: bottom + coinColliderHeight(layer[offset].coin.kind) / 2,
      z: GRAPPLE_TARGET_Z - Math.floor(offset / 2) * pitch,
    });
    bottom += Math.max(...layer.map(({ coin }) => coinColliderHeight(coin.kind))) + 0.008;
  }
  return positions;
}

export function safeCargoPositions(refs: readonly CargoRef[], positions: readonly CargoPosition[], obstacles: readonly CoinBounds[]): boolean {
  if (refs.length !== positions.length || !refs.length) return false;
  const bounds = refs.map(({ coin }, index) => coinPlacementBounds(coin, positions[index]));
  const topLimit = grappleCargoTopLimit();
  return bounds.every((box, index) => Number.isFinite(box.max.y) && box.max.y <= topLimit + EPSILON &&
    box.min.y >= TABLE.floorY && !obstacles.some((other) => boundsOverlap(box, other)) &&
    !bounds.slice(0, index).some((other) => boundsOverlap(box, other)));
}

/** Raise the locked footprint above real non-held surfaces, without changing its x/z slots. */
export function planGrappleRelease(center: number, refs: readonly CargoRef[], obstacles: readonly CoinBounds[]): CargoPosition[] | null {
  const positions = packedGrapplePositions(center, refs);
  let rise = 0;
  for (let index = 0; index < refs.length; index += 1) {
    const box = coinPlacementBounds(refs[index].coin, positions[index]);
    for (const other of obstacles) if (overlapsXZ(box, other)) rise = Math.max(rise, other.max.y + CLEARANCE - box.min.y);
  }
  for (const p of positions) p.y += rise;
  return safeCargoPositions(refs, positions, obstacles) ? positions : null;
}

/** Restore to the source footprints, finding a clear vertical gap before enabling any body. */
export function planGrappleReturn(refs: readonly CargoRef[], origins: readonly CargoPosition[], obstacles: readonly CoinBounds[]): CargoPosition[] | null {
  const positions: CargoPosition[] = [];
  const occupied = [...obstacles];
  for (let index = 0; index < refs.length; index += 1) {
    const coin = refs[index].coin;
    const half = halfExtents(coin);
    const p = { ...origins[index], y: Math.max(origins[index].y, TABLE.floorY + half[1] + CLEARANCE) };
    let box = coinPlacementBounds(coin, p);
    // Each iteration clears at least one occupied AABB. No unbounded search or physics step.
    for (let attempt = 0; attempt <= occupied.length; attempt += 1) {
      const colliding = occupied.filter((other) => boundsOverlap(box, other));
      if (!colliding.length) break;
      p.y = Math.max(...colliding.map((other) => other.max.y)) + half[1] + CLEARANCE;
      box = coinPlacementBounds(coin, p);
    }
    if (box.max.y > grappleCargoTopLimit() || occupied.some((other) => boundsOverlap(box, other))) return null;
    positions.push(p);
    occupied.push(box);
  }
  return positions;
}
