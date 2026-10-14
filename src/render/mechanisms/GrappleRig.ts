import * as THREE from 'three';
import { GRAPPLE_CLAW_SIZE } from '../../systems/grappleGeometry';
export { GRAPPLE_CLAW_SIZE } from '../../systems/grappleGeometry';
import { disposeObject3D, makeRigMaterial, mergedBoxes } from './OwnedVisual';

/**
 * 抓斗实体 rig：天车与三指姿态由真实币的受控搬运时间轴驱动。
 *
 * ## 结构（从哪里来 → 怎么动 → 碰/放 → 怎么离场）
 *
 * - **天车导梁**（静态，1 draw call）：一根沿 z 的梁悬在抓取点与前沿落点上方，
 *   两端带限位块（合并几何）——爪「沿这条线来回」的机械解释。位置从 show 给的
 *   抓取点 `at` 与 `grappleTargetZ` 派生。
 * - **行车**（随 z）：骑在梁上的滑车。
 * - **绳缆**（随升降伸缩）：圆柱半径 8mm，上端行车、下端爪顶，长度 = 实际距离
 *   （`scale.y`，不是每帧新几何）。
 * - **爪体**（探针，命名 `grappleClaw` 供 report 兼容）：顶部轮毂 +
 *   **3 只独立铰接指**（各 1 pivot，绕切向轴开合，开 ~40°/合 ~6°）——
 *   取代旧的「整只锥台等比缩放」。开口外接半径沿用旧 `CLAW_SIZE.mouthRadius`
 *   （从 `grappleHalf` 派生，罩住 0.3×0.3 米作用格）。
 * - **落点指示环**（地面，随下降收缩消失）：标示准备抓取的位置。
 *
 * ## 搬运
 *
 * 真币夹紧后进入无接触的受控状态，随爪升降与平移；松手恢复动态碰撞。
 * 几何层只接收姿态，不持有物理体或创建重复的视觉币。
 *
 * ## 预算
 *
 * 梁 1 + 行车 1 + 绳 1 + 轮毂 1 + 指 3 + 指示环 1 = **8 draw call** 峰值（~1.8s）。
 * 三只独立指是「可辨认机械结构」的最低配置，比预算多出的 3 格买的就是它；
 * 材质全 `ramp:'device'` 无贴图，+0 program。
 */

/** 爪的观感尺寸：与旧版逐字节一致（开口半径从 `grappleHalf` 派生）。 */
/** 指的几何长度（略短于爪高，指尖从轮毂斜伸到 mouth 半径处）。 */
const FINGER_LENGTH = GRAPPLE_CLAW_SIZE.height * 0.92;
/** 指根铰点到爪轴心的半径。 */
const FINGER_HUB_RADIUS = 0.035;
/** 开/合姿态的指倾角（度）：正 = 向内抱，负 = 向外张。 */
const TILT_OPEN_DEG = -38;
const TILT_CLOSED_DEG = 6;

export type GrappleRigPose = {
  /** 爪心的世界坐标（show 的 mouthY / carry 曲线现成输出）。 */
  x: number;
  y: number;
  z: number;
  /** 旧 grip 值（1=张口，0.55=咬合，1.06=松手吐币的张口）。 */
  grip: number;
  /** 0→1 下降段：指示环随它收缩消失。 */
  descend: number;
  /** 天车高度（梁的世界 y）。 */
  beamY: number;
};

export type GrappleRig = {
  root: THREE.Group;
  /** report() 的探针：爪体（对应旧 `grappleClaw` 网格）。 */
  probe: THREE.Group;
  pose(p: GrappleRigPose): void;
  dispose(): void;
};

export function buildGrappleRig(at: { x: number; z: number }, targetZ: number): GrappleRig {
  const root = new THREE.Group();
  root.name = 'grappleRig';

  const frameMaterial = makeRigMaterial('grappleFrame', '#5c6672', '#20262e');
  const clawMaterial = makeRigMaterial('grappleClawBody', '#7d8794', '#232a33');
  const ropeMaterial = makeRigMaterial('grappleRope', '#454c58', '#161a20');
  const ringMaterial = makeRigMaterial('grappleRing', '#3fd2c0', '#2fd8c4', 1.0);

  // ── 静态梁：沿 z 覆盖「抓取点 → 落点」全程 ──
  const zBack = Math.min(at.z, targetZ) - 0.25;
  const zFront = Math.max(at.z, targetZ) + 0.18;
  const beamLength = zFront - zBack;
  const beamCenterZ = (zBack + zFront) / 2;
  const beam = new THREE.Mesh(
    mergedBoxes([
      { position: [at.x, 0, beamCenterZ], size: [0.07, 0.055, beamLength] },
      // 两端限位块
      { position: [at.x, -0.05, zBack + 0.03], size: [0.05, 0.05, 0.06] },
      { position: [at.x, -0.05, zFront - 0.03], size: [0.05, 0.05, 0.06] },
    ]),
    frameMaterial,
  );
  beam.name = 'grappleBeam';
  root.add(beam);

  // ── 行车 + 绳 ──
  const trolley = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.07, 0.12), frameMaterial);
  trolley.name = 'grappleTrolley';
  root.add(trolley);

  const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 1, 6), ropeMaterial);
  rope.name = 'grappleRope';
  root.add(rope);

  // ── 落点指示环 ──
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(GRAPPLE_CLAW_SIZE.mouthRadius * 0.88, GRAPPLE_CLAW_SIZE.mouthRadius, 24),
    ringMaterial,
  );
  ring.name = 'grappleRing';
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(at.x, 0.012, at.z);
  ring.scale.set(0.001, 0.001, 1); // 挂载首帧先藏（与 towerHalo 同款防闪）
  root.add(ring);

  // ── 爪体：轮毂 + 3 只独立铰接指 ──
  const claw = new THREE.Group();
  claw.name = 'grappleClaw';
  root.add(claw);

  const hub = new THREE.Mesh(
    new THREE.CylinderGeometry(
      GRAPPLE_CLAW_SIZE.topRadius,
      GRAPPLE_CLAW_SIZE.topRadius * 1.25,
      0.055,
      10,
    ),
    clawMaterial,
  );
  hub.name = 'grappleHub';
  hub.position.y = GRAPPLE_CLAW_SIZE.height / 2;
  claw.add(hub);

  const fingers: THREE.Group[] = [];
  for (let i = 0; i < 3; i += 1) {
    const angle = (i / 3) * Math.PI * 2 + Math.PI / 2;
    const pivot = new THREE.Group();
    pivot.name = `grappleFinger${i}`;
    pivot.position.set(
      Math.sin(angle) * FINGER_HUB_RADIUS,
      GRAPPLE_CLAW_SIZE.height * 0.34,
      Math.cos(angle) * FINGER_HUB_RADIUS,
    );
    pivot.rotation.y = angle; // pivot 的 +z 指向爪轴心的**外侧**半径方向

    const fingerGeometry = new THREE.CylinderGeometry(0.013, 0.026, FINGER_LENGTH, 5);
    // 几何顶端平移到铰点：旋转发生在指根，不是指心。
    fingerGeometry.translate(0, -FINGER_LENGTH / 2, 0);
    const finger = new THREE.Mesh(fingerGeometry, clawMaterial);
    pivot.add(finger);
    claw.add(pivot);
    fingers.push(pivot);
  }

  const clawTopOffset = GRAPPLE_CLAW_SIZE.height / 2 + 0.02;

  return {
    root,
    probe: claw,
    pose({ x, y, z, grip, descend, beamY: beamWorldY }) {
      // 梁与行车的高度由 show 传入（取决于本次抓取点的币顶）。
      beam.position.y = beamWorldY;
      trolley.position.set(x, beamWorldY, z);
      // 绳：行车底 → 爪顶，长度实时等于实际间距。
      const ropeTop = beamWorldY - 0.035;
      const ropeBottom = y + clawTopOffset;
      const ropeLength = Math.max(0.02, ropeTop - ropeBottom);
      rope.scale.set(1, ropeLength, 1);
      rope.position.set(x, (ropeTop + ropeBottom) / 2, z);

      claw.position.set(x, y, z);
      // grip → 指倾角：1=张开(-38°)，0.55=咬合(+6°)，>1 线性外推到 ~-44°（吐币张口）。
      const t = Math.max(-0.15, Math.min(1, (1 - grip) / (1 - 0.55)));
      const tilt = ((TILT_OPEN_DEG + (TILT_CLOSED_DEG - TILT_OPEN_DEG) * t) * Math.PI) / 180;
      for (const pivot of fingers) pivot.rotation.x = tilt;

      // 指示环：下降段收缩消失 —— 「准备抓这里」只在准备阶段说。
      const ringScale = Math.max(0.001, 1 - descend);
      ring.scale.set(ringScale, ringScale, 1);
    },
    dispose() {
      disposeObject3D(root);
      [frameMaterial, clawMaterial, ropeMaterial, ringMaterial].forEach((m) => m.dispose());
    },
  };
}
