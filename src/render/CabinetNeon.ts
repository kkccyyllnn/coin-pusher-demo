import * as THREE from 'three';
import { cabinetPartBox, cabinetShape, partBevel } from '../game/cabinetShape';
import { makeToonMaterial } from './ToonMaterial';

export type CabinetNeon = {
  group: THREE.Group;
  mesh: THREE.InstancedMesh;
  setTheme(accent: THREE.ColorRepresentation, secondary: THREE.ColorRepresentation): void;
  refreshLayout(): void;
  pulse(strength?: number): void;
  /** Game time: paused games hold their current light level. */
  update(delta: number): void;
  dispose(): void;
};

type LightStrip = { position: [number, number, number]; size: [number, number, number] };

/** Two wall-mounted lamps and four strips around the existing marquee face. */
export function cabinetNeonLayout(): readonly LightStrip[] {
  const { wall } = cabinetShape();
  const hood = cabinetPartBox('hoodValance');
  const bevel = partBevel('hoodValance').radius;
  // Dimensions are relative to the supporting panels, not independent cabinet
  // coordinates. The back of every strip embeds into its supporting face.
  const thin = Math.min(wall.thickness * 0.2, (hood.max[1] - hood.min[1]) * 0.04);
  const depth = wall.thickness * 0.12;
  const frontOffset = Math.min(0.002, depth * 0.3);
  const sideBottom = wall.lowRoofBackY + wall.thickness;
  const sideTop = wall.insetTopY - wall.thickness;
  const sideLength = Math.max(thin, sideTop - sideBottom);
  const strips: LightStrip[] = [-1, 1].map((side) => {
    const supportingWall = cabinetPartBox(side < 0 ? 'sideWall.tall.L' : 'sideWall.tall.R');
    return {
      position: [(supportingWall.min[0] + supportingWall.max[0]) / 2,
        sideBottom + sideLength / 2, wall.insetZ + frontOffset],
      size: [thin, sideLength, depth],
    };
  });

  // Stay on the valance's flat face, immediately inside the screen's outer
  // border. This avoids floating over the rounded cabinet corners or covering
  // the screen's content, and keeps all lamps outside the drop/coin-bed space.
  const left = hood.min[0] + bevel + thin / 2;
  const right = hood.max[0] - bevel - thin / 2;
  const bottom = hood.min[1] + bevel + thin / 2;
  const top = hood.max[1] - bevel - thin / 2;
  const z = hood.max[2] + frontOffset;
  const width = Math.max(thin, right - left + thin);
  const height = Math.max(thin, top - bottom - thin);
  strips.push(
    { position: [(left + right) / 2, top, z], size: [width, thin, depth] },
    { position: [(left + right) / 2, bottom, z], size: [width, thin, depth] },
    { position: [left, (top + bottom) / 2, z], size: [thin, height, depth] },
    { position: [right, (top + bottom) / 2, z], size: [thin, height, depth] },
  );
  return strips;
}

/** +1 opaque draw, no lights/contacts/textures/shadow pass/instance-color define. */
export function buildCabinetNeon(
  accent: THREE.ColorRepresentation = '#ee65b2',
  secondary: THREE.ColorRepresentation = '#54c8ff',
): CabinetNeon {
  const group = new THREE.Group();
  group.name = 'cabinetNeon';
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  const material = makeToonMaterial({
    name: 'cabinetNeon', color: accent, ramp: 'device', emissive: secondary, emissiveIntensity: 0.65,
  });
  const strips = cabinetNeonLayout();
  const mesh = new THREE.InstancedMesh(geometry, material, strips.length);
  mesh.name = 'cabinetNeonStrips';
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false;
  mesh.userData.effect = 'cabinetNeon';
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const refreshLayout = () => {
    cabinetNeonLayout().forEach((strip, index) => {
      position.fromArray(strip.position);
      scale.fromArray(strip.size);
      mesh.setMatrixAt(index, matrix.compose(position, rotation, scale));
    });
    mesh.instanceMatrix.needsUpdate = true;
  };
  refreshLayout();
  group.add(mesh);
  let pulseLevel = 0;
  let disposed = false;
  const setLevel = () => { material.emissiveIntensity = 0.65 + pulseLevel * 0.65; };
  return {
    group, mesh, refreshLayout,
    setTheme(nextAccent, nextSecondary) {
      if (disposed) return;
      material.color.set(nextAccent);
      material.emissive.set(nextSecondary);
    },
    pulse(strength = 1) {
      if (disposed) return;
      pulseLevel = Math.max(pulseLevel, Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0);
      setLevel();
    },
    update(delta) {
      if (disposed || !Number.isFinite(delta) || delta <= 0 || !pulseLevel) return;
      pulseLevel *= Math.exp(-delta / 0.18);
      if (pulseLevel < 0.001) pulseLevel = 0;
      setLevel();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      group.removeFromParent();
      group.clear();
      mesh.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
