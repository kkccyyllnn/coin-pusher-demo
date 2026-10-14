import * as THREE from 'three';
import { TABLE } from '../../game/constants';
import { disposeObject3D, makeRigMaterial, mergedBoxes } from './OwnedVisual';

/**
 * 推板动力缸 rig（EXPERIENCE-3D-UI-V2 P05）。
 *
 * ## 结构与因果
 *
 * - **动力缸壳**（机柜侧，永久件）：贴在后墙上方、落币廊后方的矮盒 ——
 *   普通推币时也有低调的结构存在（+3 draw call：壳 / 杆 / 灯）。
 * - **活塞杆**（推板侧）：一端固定缸壳、另一端叉架**跟着推板真实行程走** ——
 *   杆长每帧从 `pusher.offset` 派生，视觉层不二次推算时钟（纪律 13.2）。
 *   行程加大（加力）时杆随之更长，**这是「加力推得更远」的机械解释本身**。
 * - **状态灯**：待发（已存加力未消费）慢闪；加力行进中常亮 + 缸体徽标闪白；
 *   冲程顶点（extend→holdFront）闪一下后熄灭。全部只压缩视觉脉冲，不动时间轴。
 *
 * ## 已知观感取舍（验收报告必须带）
 *
 * 满加力行程时杆端伸到 z≈-0.75，与**落币下落带**（z -0.85..-0.59）有瞬时重叠：
 * 落下的币会从杆前面掠过（杆 8mm 细杆、无碰撞体、穿廊半透明板后基本被雾化）。
 * 换这个重叠买到的是「缸-杆-推板」的完整因果链；替代方案（侧壁外挂 / 床面走杆）
 * 都与更醒目的东西（币床 / 落币视线）冲突。
 *
 * ## 预算
 *
 * 永久 +2 draw call（壳+灯条 1 / 杆 1），+0 program（全部 `ramp:'device'` 无贴图，
 * 与 `gatePanel` 同一程序）。实测 playing 态 50（含原灯 3 件方案）顶到 perf 硬上限 <50，
 * 灯并入壳几何后 49 过线 —— 这 1 格买不起单独小灯，状态改由整壳脉冲呈现。
 */

/** 缸壳的安装位：后墙内表面之上、币顶（0.236）之上、落币廊之后。 */
const HOUSING = {
  x: 0,
  y: 0.29,
  z: TABLE.backZ + 0.03,
  size: [0.46, 0.09, 0.06] as const,
};
/** 杆端叉架贴着推板后上棱（y 在币顶之上 —— 叉架永不与币床相交）。 */
const ROD_Y = 0.29;
const FORK_BACK_GAP = 0.012; // 叉架离推板后棱的前移量

export type BoostRigState = {
  /** 推板当前行程（真源：`Pusher.offset`）。 */
  offset: number;
  /** 推板当前相位（顶点检测 = extend→holdFront 的沿）。 */
  phase: 'extend' | 'holdFront' | 'retract' | 'holdBack' | 'idle';
  /** 已存加力未消费（准备态慢闪）。 */
  pending: boolean;
  /** 本帧 tick.boostConsumed（加力行程开始）。 */
  consumed: boolean;
  /** True throughout this boosted stroke, supplied by Pusher. */
  boostedStroke?: boolean;
  delta: number;
};

export type BoostRig = {
  group: THREE.Group;
  update(state: BoostRigState): void;
  dispose(): void;
};

export function buildBoostRig(): BoostRig {
  const group = new THREE.Group();
  group.name = 'boostRig';

  const bodyMaterial = makeRigMaterial('boostHousing', '#5c6672', '#ff8c2a', 0.28);
  const rodMaterial = makeRigMaterial('boostRod', '#8a94a2', '#2a313b');

  // 缸壳 + 两侧吊耳 + 前脸灯条，合并 1 mesh（灯条与壳同一材质：状态用**整壳自发光**
  // 呈现 —— 单独小灯要 +1 draw call，而 perf 硬上限只剩 1 格，见文件头预算段）。
  const housing = new THREE.Mesh(
    mergedBoxes([
      { position: [HOUSING.x, HOUSING.y, HOUSING.z], size: [...HOUSING.size] },
      // 前脸灯条（与壳同材质，靠 emissive 脉冲亮起）
      {
        position: [HOUSING.x, HOUSING.y - 0.028, HOUSING.z + HOUSING.size[2] / 2 + 0.006],
        size: [0.34, 0.022, 0.012],
      },
      {
        position: [HOUSING.x - HOUSING.size[0] / 2 + 0.04, HOUSING.y - 0.055, HOUSING.z],
        size: [0.03, 0.03, 0.05],
      },
      {
        position: [HOUSING.x + HOUSING.size[0] / 2 - 0.04, HOUSING.y - 0.055, HOUSING.z],
        size: [0.03, 0.03, 0.05],
      },
    ]),
    bodyMaterial,
  );
  housing.name = 'boostHousing';
  group.add(housing);

  // 活塞杆 + 端叉架，合并 1 mesh（同一 accent 材质，加力时整杆提亮）。
  // 杆体单位长度、中心在原点；**叉架烘在几何 z=+0.5**（杆端）：scale.z 之后
  // 叉架永远正好落在杆端，z 向厚度随行程轻微变厚（≤1.5cm，读作叉架套筒）。
  const rod = new THREE.Mesh(
    mergedBoxes([
      { position: [0, 0, 0], size: [0.03, 0.03, 1] },
      { position: [0, -0.02, 0.5], size: [0.14, 0.02, 0.03] },
      { position: [-0.06, -0.035, 0.5], size: [0.02, 0.045, 0.03] },
      { position: [0.06, -0.035, 0.5], size: [0.02, 0.045, 0.03] },
    ]),
    rodMaterial,
  );
  rod.name = 'boostRod';
  group.add(rod);

  let wasExtend = false;
  let pendingBlink = 0;

  return {
    group,
    update({ offset, phase, pending, consumed, boostedStroke = consumed, delta }) {
      // 杆长 = 缸壳前缘 → 推板后棱（+offset 随真实行程走）。
      const rodBack = HOUSING.z + HOUSING.size[2] / 2;
      const forkZ = TABLE.pusherBackZ + FORK_BACK_GAP + offset;
      const length = Math.max(0.02, forkZ - rodBack);
      rod.scale.z = length;
      // 几何杆体中心在原点、叉架在 z=+0.5：mesh 放在杆段中点，缩放后两端对齐。
      rod.position.set(0, ROD_Y, rodBack + length / 2);

      // 相位沿：extend → holdFront = 冲程顶点。
      const apex = wasExtend && phase === 'holdFront';
      wasExtend = phase === 'extend';

      // 状态用**整壳自发光**呈现：待发慢闪（1.2s 周期）/ 加力行进常亮 / 顶点爆闪。
      pendingBlink = (pendingBlink + delta) % 1.2;
      let intensity = 0.28;
      if (pending && !consumed) intensity = 0.7 + Math.sin((pendingBlink / 1.2) * Math.PI * 2) * 0.55;
      if (boostedStroke) intensity = 1.8;
      if (apex && boostedStroke) intensity = 2.6;
      bodyMaterial.emissiveIntensity += (intensity - bodyMaterial.emissiveIntensity) * Math.min(1, delta * 18);

      // 加力行进中杆身提亮（accent 材质自抬，回撤落回）。
      const rodGlow = boostedStroke ? 1.6 : (phase === 'extend' || phase === 'holdFront' ? 0.9 : 0.55);
      rodMaterial.emissiveIntensity += (rodGlow - rodMaterial.emissiveIntensity) * Math.min(1, delta * 18);
    },
    dispose() {
      disposeObject3D(group);
      [bodyMaterial, rodMaterial].forEach((m) => m.dispose());
    },
  };
}
