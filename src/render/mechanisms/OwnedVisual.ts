import * as THREE from 'three';
import { makeToonMaterial } from '../ToonMaterial';

/**
 * 机关 rig 的共用件（EXPERIENCE-3D-UI-V2 P03/P04）。
 *
 * ## 分工
 *
 * `MechanismShows` 是**交付时间轴与对账**（谁被影响、什么时候生效）；
 * 这里的 rig 只回答「装置长什么样、怎么动」。rig 不 import 任何游戏状态，
 * 输入只有 pose 参数 —— 视觉层永远不二次推算时钟（纪律：动画用游戏的 delta）。
 *
 * ## 资源生命周期
 *
 * 每场演出 build 出来的几何与材质**全部归演出独有**：`disposeObject3D` 遍历整棵树，
 * 几何与材质逐个 dispose（`userData.sharedMaterial` 标记的共享材质跳过——目前 rig
 * 内没有共享件，这个标记是给未来「预建 rig 池」留的口）。共享材质/几何**不得**
 * 无条件 dispose，这条与计划的 13.2 一致。
 */

/** 遍历拆毁一棵演出临时树：几何全 dispose、材质按标记 dispose。 */
export function disposeObject3D(root: THREE.Object3D): void {
  root.traverse((child) => {
    if (child instanceof THREE.Mesh || child instanceof THREE.InstancedMesh) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) {
        material.forEach((m) => {
          if (!m.userData.sharedMaterial) m.dispose();
        });
      } else if (material && !material.userData.sharedMaterial) {
        material.dispose();
      }
    }
  });
  root.removeFromParent();
}

/**
 * rig 专用材质：统一走 `ramp: 'device'`、无贴图 —— defines 与
 * `gatePanel` / `towerCylinder` 完全一致，命中同一份已编译程序（+0 program）。
 * 发光件（警示灯）用高 emissiveIntensity，仍然不换 program。
 */
export function makeRigMaterial(
  name: string,
  color: string,
  emissive?: string,
  emissiveIntensity = 0.55,
): ReturnType<typeof makeToonMaterial> {
  return makeToonMaterial({
    name,
    color,
    ramp: 'device',
    ...(emissive ? { emissive, emissiveIntensity } : {}),
  });
}

/**
 * 把若干个**平移后的盒体**合并成一块几何（静态结构件省 draw call 用）。
 *
 * 盒子参数用世界坐标（中心 + 尺寸），合并前 bake 进顶点，运行期零开销。
 * 同一材质 ⇒ 合并后 1 个 draw call。
 */
export function mergedBoxes(
  boxes: ReadonlyArray<{ position: [number, number, number]; size: [number, number, number] }>,
): THREE.BufferGeometry {
  const parts = boxes.map(({ position: [x, y, z], size: [w, h, d] }) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    return g;
  });
  const merged = mergeGeometries(parts);
  parts.forEach((g) => g.dispose());
  if (!merged) {
    // mergeGeometries 只在数组空/属性不一致时返回 null：这里全是同构 BoxGeometry，
    // 走到这里说明上游把入参改坏了 —— 宁可炸在 build 期也不要静默少一件结构。
    throw new Error('mergedBoxes: 合并失败（入参必须非空且同构）');
  }
  return merged;
}

function mergeGeometries(geometries: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  // three 0.184：`BufferGeometryUtils.mergeGeometries`。为避免在本文件顶部挂一整条
  // addons 依赖链，这里手写同构 BoxGeometry 合并：position/normal/uv 三属性逐份拼接。
  // （ rigs 的静态件全是 BoxGeometry，属性集合恒一致；以后要合异构件再引 addons。 ）
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of geometries) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }
  if (geometries.length === 0) return null;

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const index = new Uint16Array(indexCount);

  let vOffset = 0;
  let iOffset = 0;
  let uOffset = 0;
  for (const g of geometries) {
    const pos = g.attributes.position as THREE.BufferAttribute;
    const nor = g.attributes.normal as THREE.BufferAttribute;
    const tex = g.attributes.uv as THREE.BufferAttribute;
    position.set(pos.array as Float32Array, vOffset * 3);
    normal.set(nor.array as Float32Array, vOffset * 3);
    if (tex) uv.set(tex.array as Float32Array, uOffset * 2);
    const count = pos.count;
    if (g.index) {
      const idx = g.index.array as ArrayLike<number>;
      for (let i = 0; i < g.index.count; i += 1) index[iOffset + i] = idx[i] + vOffset;
      iOffset += g.index.count;
    } else {
      for (let i = 0; i < count; i += 1) index[iOffset + i] = i + vOffset;
      iOffset += count;
    }
    vOffset += count;
    uOffset += count;
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  return out;
}
