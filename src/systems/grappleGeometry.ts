import { TABLE } from '../game/constants';
import { cabinetShape } from '../game/cabinetShape';

export const GRAPPLE_HALF = 0.15;
export const GRAPPLE_DEPTH_HALF = 0.6;
export const GRAPPLE_TARGET_Z = TABLE.scoreLineZ - 0.2;
export const GRAPPLE_LIFT_Y = TABLE.pusherTopY + 0.28;
export const GRAPPLE_CLAW_SIZE = {
  mouthRadius: GRAPPLE_HALF * 1.4,
  topRadius: 0.06,
  height: 0.26,
} as const;
export const GRAPPLE_RIG_CLEARANCE = {
  mouthAboveCargo: GRAPPLE_CLAW_SIZE.height / 2 + 0.02,
  beamAboveMouth: GRAPPLE_CLAW_SIZE.height / 2 + 0.2,
  beamHalfHeight: 0.035,
  roofGap: 0.015,
} as const;

/** Keep the cargo, claw, and trolley below the cabinet's real roof envelope. */
export function grappleCargoTopLimit(): number {
  return cabinetShape().hood.underY - GRAPPLE_RIG_CLEARANCE.mouthAboveCargo -
    GRAPPLE_RIG_CLEARANCE.beamAboveMouth - GRAPPLE_RIG_CLEARANCE.beamHalfHeight - GRAPPLE_RIG_CLEARANCE.roofGap;
}
export function grapplePickupTopLimit(): number {
  return cabinetShape().hood.underY - GRAPPLE_CLAW_SIZE.height - 0.18 -
    GRAPPLE_CLAW_SIZE.height / 2 - 0.16 - GRAPPLE_RIG_CLEARANCE.beamHalfHeight - GRAPPLE_RIG_CLEARANCE.roofGap;
}
