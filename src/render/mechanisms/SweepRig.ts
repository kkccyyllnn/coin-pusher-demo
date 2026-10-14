import * as THREE from 'three';
import { TABLE } from '../../game/constants';
import { MECHANISM_CONSTANTS } from '../../systems/Mechanisms';
import { COIN_SCALE } from '../../game/coinScale';
import { disposeObject3D, makeRigMaterial, mergedBoxes } from './OwnedVisual';

/**
 * 扫板实体 rig（EXPERIENCE-3D-UI-V2 P03）。
 *
 * ## 结构（从哪里来 → 怎么动 → 怎么离场）
 *
 * - **龙门导轨**（静态，1 draw call）：一根横梁架在左右侧壁之间、悬在扫板带上方，
 *   两端**插进侧壁**；梁下两端各一块限位块 —— 行程的机械解释。
 *   位置全部从 `TABLE.halfWidth` 与扫板带派生，不写第二份真源。
 * - **行车**（随 x）：骑在梁上的滑车壳，横扫时沿梁走。
 * - **刀杆组件**（随 x + 竖直滑移）：立柱穿过行车（像龙门压头的滑道），橙色
 *   **工作面**固定在柱底 —— 它的尺寸、位置与命中判定完全沿用旧 `ARM_SIZE`；
 *   落下/抬起 = 整个刀杆组件沿竖直方向滑，柱顶在行车里穿行（真实滑道语义，
 *   不是刀面悬空升降）。
 * - **警示灯**：装在柱顶前方，下降段点亮、命中瞬间闪白。
 *
 * ## 与交付时间轴的关系
 *
 * `pose()` 只吃 `SweepArmShow` 已经算好的量：`x`（刀面中心横移）、`bladeY`
 * （刀面高度）与阶段分数。命中判定 `leading = x + ARM_SIZE.width/2` 在 show 里算，
 * 这里不重复 —— 视觉层不出现第二份扫程公式。
 *
 * ## 预算
 *
 * 静态架 1 + 行车 1 + 柱 1 + 刀面 1 + 灯 1 = **5 draw call**（演出期峰值，拆台归零）；
 * 材质全部 `ramp:'device'` 无贴图 → 与 `gatePanel` 同一程序，+0 program。
 */

/** 刀面观感尺寸：与旧版逐字节一致（`MechanismShows.ARM_SIZE` 搬家而非重写）。 */
export const SWEEP_BLADE_SIZE = {
  width: 0.045 * COIN_SCALE,
  height: 0.22 * COIN_SCALE,
  depth: MECHANISM_CONSTANTS.sweepZone + 0.05 * COIN_SCALE,
} as const;

/** 扫板带中心的 z（刀面工作带正中）。 */
export const SWEEP_BAND_Z = TABLE.scoreLineZ - MECHANISM_CONSTANTS.sweepZone / 2;

/** Workface reaches the actual lower coin bed; preview shares this baseline. */
export const SWEEP_BLADE_REST_Y = MECHANISM_CONSTANTS.sweepBottomY + SWEEP_BLADE_SIZE.height / 2;

/** 龙门梁的高度（币塔顶 ~0.29 米之上、檐板之下，不遮 XIXI 标牌带）。 */
const BEAM_Y = 0.62;
/** 行车壳尺寸（比梁大一圈，读得出「骑在上面」）。 */
const TROLLEY = { w: 0.13, h: 0.08, d: 0.1 } as const;
/** 立柱截面。 */
const COLUMN = { w: 0.05, d: 0.055 } as const;

export type SweepRigPose = {
  /** 刀面中心的世界 x（show 的行程曲线现成输出）。 */
  x: number;
  /** 刀面中心的世界 y。 */
  bladeY: number;
  /** 0→1 下降段（准备态灯用）。 */
  dropped: number;
  /** 0→1 横扫段。 */
  swept: number;
  /** 命中闪白（0=灭，1=刚命中，show 侧按帧衰减）。 */
  hitFlash: number;
};

export type SweepRig = {
  /** 装置根（静态架 + 行车 + 刀杆组件）。挂进场景用。 */
  root: THREE.Group;
  /** report() 的探针：刀杆组件（真正在扫币的那个部件）。 */
  probe: THREE.Group;
  pose(p: SweepRigPose): void;
  dispose(): void;
};

export function buildSweepRig(): SweepRig {
  const root = new THREE.Group();
  root.name = 'sweepRig';

  const frameMaterial = makeRigMaterial('sweepFrame', '#5c6672', '#20262e');
  const bladeMaterial = makeRigMaterial('sweepBlade', '#d9542f', '#4d1a0c');
  const lampMaterial = makeRigMaterial('sweepLamp', '#3a3f46', '#ffb03a', 0.9);

  // ── 静态架：龙门梁 + 两端限位，合并成 1 mesh ──
  const beamLength = TABLE.halfWidth * 2 + 0.12; // 两端插进侧壁各 6cm
  const frame = new THREE.Mesh(
    mergedBoxes([
      { position: [0, BEAM_Y, SWEEP_BAND_Z], size: [beamLength, 0.055, 0.075] },
      {
        position: [-(TABLE.halfWidth - 0.06), BEAM_Y - 0.055, SWEEP_BAND_Z],
        size: [0.035, 0.05, 0.08],
      },
      {
        position: [TABLE.halfWidth - 0.06, BEAM_Y - 0.055, SWEEP_BAND_Z],
        size: [0.035, 0.05, 0.08],
      },
    ]),
    frameMaterial,
  );
  frame.name = 'sweepFrame';
  root.add(frame);

  // ── 行车（只随 x）：骑在梁上的滑车 ──
  const trolley = new THREE.Mesh(
    new THREE.BoxGeometry(TROLLEY.w, TROLLEY.h, TROLLEY.d),
    frameMaterial,
  );
  trolley.name = 'sweepTrolley';
  trolley.position.set(0, BEAM_Y, SWEEP_BAND_Z);
  root.add(trolley);

  // ── 刀杆组件（随 x + 竖直滑移；探针，原点 = 刀面中心 —— 与旧版 report 坐标同语义）──
  const carriage = new THREE.Group();
  carriage.name = 'sweepArm';

  const columnTop = BEAM_Y + 0.02; // 柱顶穿进行车里（滑道语义）
  const columnBottom = SWEEP_BLADE_REST_Y - SWEEP_BLADE_SIZE.height / 2 - 0.02;
  const columnCenterY = (columnTop + columnBottom) / 2;
  const column = new THREE.Mesh(
    new THREE.BoxGeometry(COLUMN.w, columnTop - columnBottom, COLUMN.d),
    frameMaterial,
  );
  column.name = 'sweepColumn';
  carriage.add(column);

  const blade = new THREE.Mesh(
    new THREE.BoxGeometry(SWEEP_BLADE_SIZE.width, SWEEP_BLADE_SIZE.height, SWEEP_BLADE_SIZE.depth),
    bladeMaterial,
  );
  blade.name = 'sweepBlade';
  carriage.add(blade);

  // 警示灯：柱顶前方的小灯，亮 = 「准备/工作中」，命中闪白。
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.03, 0.014), lampMaterial);
  lamp.name = 'sweepLamp';
  carriage.add(lamp);

  root.add(carriage);

  return {
    root,
    probe: carriage,
    pose({ x, bladeY, dropped, hitFlash }) {
      // 行车贴梁走 x；探针原点 = 刀面中心：横移吃 x，竖直吃 bladeY。
      // 柱与灯是**世界高度固定**的结构件（刀沿柱滑），局部 y = 世界高 − bladeY 逐帧反算。
      trolley.position.x = x;
      carriage.position.set(x, bladeY, SWEEP_BAND_Z);
      column.position.y = columnCenterY - bladeY;
      lamp.position.set(0, BEAM_Y - 0.09 - bladeY, COLUMN.d / 2 + 0.008);
      // 灯：下降段渐亮（准备），横扫段保持，命中瞬间叠一层闪白。
      lampMaterial.emissiveIntensity = 0.9 + dropped * 1.4 + hitFlash * 3;
    },
    dispose() {
      disposeObject3D(root);
      [frameMaterial, bladeMaterial, lampMaterial].forEach((m) => m.dispose());
    },
  };
}
