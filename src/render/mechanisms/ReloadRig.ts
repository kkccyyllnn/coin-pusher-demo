import * as THREE from 'three';
import { TABLE } from '../../game/constants';
import { disposeObject3D, makeRigMaterial, mergedBoxes } from './OwnedVisual';

/**
 * 后装填供料匣 rig（EXPERIENCE-3D-UI-V2 P06 §9.1）。
 *
 * ## 结构与因果
 *
 * 「机械解锁 → 出货口亮起 → 真币出现/落座 → 退回」的短序列（0.7s）：
 * - **料匣壳**：贴后区上空的供币匣（币实际出生点上方），带滑槽口沿。
 * - **翻板**：出货口的滑动挡片，开→币落→合。
 * - **出货口亮**：口沿 emissive 脉冲（与壳同材质整壳亮，省 1 draw call）。
 *
 * ## 为什么是演出期临时件（+0 常驻）
 *
 * perf 硬上限 <50 已被 P05 的 +2 占到 49，常驻没有余量；且供料匣只在
 * 「机器真的在补货」那 0.7 秒才需要解释来源 —— 退场即拆，与机关演出同一约定。
 *
 * ## 时序纪律
 *
 * `MechanismShows` 在开口完成后按预留计划发出真币；rig 和交付读取同一开门时刻。
 */

/** 料匣位置：币出生点（x −0.3/0/+0.3、y ≈0.54..0.64、z ≈0.42..0.5）的正上方。 */
const HOPPER = {
  x: 0,
  y: 0.86,
  z: 0.46,
  size: [0.62, 0.16, 0.2] as const,
};
/** 演出总长（秒）：开 0.22 → 保持 0.26 → 合 0.22。 */
export const RELOAD_SHOW_DURATION = 0.7;
export const RELOAD_OPEN_AT = 0.22;
export const RELOAD_CLOSE_AT = 0.48;

export type ReloadRig = {
  root: THREE.Group;
  /** t ∈ [0, 1] 时间轴推进（show 侧用游戏 delta 累积）。 */
  pose(t: number): void;
  dispose(): void;
};

export function buildReloadRig(): ReloadRig {
  const root = new THREE.Group();
  root.name = 'reloadRig';

  const bodyMaterial = makeRigMaterial('reloadHopper', '#5c6672', '#ff8c2a', 0.22);
  const flapMaterial = makeRigMaterial('reloadFlap', '#8a94a2', '#2a313b');

  // 料匣壳 + 底口沿 + 两侧悬臂（从侧壁挂下来的滑轨吊臂），合并 1 mesh。
  const armLength = TABLE.halfWidth - 0.02 - HOPPER.size[0] / 2;
  const hopper = new THREE.Mesh(
    mergedBoxes([
      { position: [HOPPER.x, HOPPER.y, HOPPER.z], size: [...HOPPER.size] },
      // 底口沿（滑槽喉口）
      {
        position: [HOPPER.x, HOPPER.y - HOPPER.size[1] / 2 - 0.015, HOPPER.z],
        size: [HOPPER.size[0] - 0.08, 0.03, HOPPER.size[2] - 0.06],
      },
      // 左右悬臂：滑轨吊挂，说明「匣子为什么不掉」
      {
        position: [-(HOPPER.size[0] / 2 + armLength / 2), HOPPER.y + 0.03, HOPPER.z],
        size: [armLength, 0.028, 0.028],
      },
      {
        position: [HOPPER.size[0] / 2 + armLength / 2, HOPPER.y + 0.03, HOPPER.z],
        size: [armLength, 0.028, 0.028],
      },
    ]),
    bodyMaterial,
  );
  hopper.name = 'reloadHopper';
  root.add(hopper);

  // 翻板：出货口下方的滑动挡片（沿 z 滑开/合上）。
  const flap = new THREE.Mesh(
    new THREE.BoxGeometry(HOPPER.size[0] - 0.06, 0.016, HOPPER.size[2] - 0.04),
    flapMaterial,
  );
  flap.name = 'reloadFlap';
  flap.position.set(HOPPER.x, HOPPER.y - HOPPER.size[1] / 2 - 0.035, HOPPER.z);
  root.add(flap);

  return {
    root,
    pose(t: number) {
      // 开：0→0.22s 滑开 0.09m；合：0.48→0.7s 滑回。中间保持开。
      const seconds = t * RELOAD_SHOW_DURATION;
      const open = seconds < RELOAD_OPEN_AT
        ? Math.min(1, seconds / RELOAD_OPEN_AT)
        : seconds > RELOAD_CLOSE_AT
          ? Math.max(0, 1 - (seconds - RELOAD_CLOSE_AT) / (RELOAD_SHOW_DURATION - RELOAD_CLOSE_AT))
          : 1;
      flap.position.z = HOPPER.z + open * 0.085;
      // 出货口亮：开门期整壳脉冲，关门回落。
      bodyMaterial.emissiveIntensity = 0.22 + open * 1.5;
    },
    dispose() {
      disposeObject3D(root);
      [bodyMaterial, flapMaterial].forEach((m) => m.dispose());
    },
  };
}
