// three.js's RoundedBoxGeometry (examples/jsm/geometries), which
// starhermit:scene does not carry: a BoxGeometry of 2 × segments + 1 slices a
// side whose vertices are pushed onto rounded edges, with three.js's normals
// and per-face UVs. Built once per preset budget, so its per-vertex script
// work (a few thousand vertices) is a one-off.
import { BoxGeometry, BufferAttribute, BufferGeometry } from "starhermit:scene";

type Axis = 0 | 1 | 2;

function uvAlong(face: [number, number, number], n: [number, number, number], uvAxis: Axis, projectionAxis: Axis, radius: number, sideLength: number): number {
  const totArcLength = (2 * Math.PI * radius) / 4;
  const centerLength = Math.max(sideLength - 2 * radius, 0);
  const halfArc = Math.PI / 4;
  const p: [number, number, number] = [n[0], n[1], n[2]];
  p[projectionAxis] = 0;
  const len = Math.hypot(p[0], p[1], p[2]) || 1;
  p[0] /= len; p[1] /= len; p[2] /= len;
  const arcUvRatio = (0.5 * totArcLength) / (totArcLength + centerLength);
  const dot = Math.max(-1, Math.min(1, p[0] * face[0] + p[1] * face[1] + p[2] * face[2]));
  const arcAngleRatio = 1.0 - Math.acos(dot) / halfArc;
  if (Math.sign(p[uvAxis]) === 1) return arcAngleRatio * arcUvRatio;
  const lenUv = centerLength / (totArcLength + centerLength);
  return lenUv + arcUvRatio + arcUvRatio * (1.0 - arcAngleRatio);
}

export function roundedBox(width = 1, height = 1, depth = 1, segments = 2, radius = 0.1): BufferGeometry {
  const seg = segments * 2 + 1;
  radius = Math.min(width / 2, height / 2, depth / 2, radius);
  const base = new BoxGeometry(1, 1, 1, seg, seg, seg);
  if (seg === 1) {
    base.scale(width, height, depth);
    return base;
  }
  const geo = base.toNonIndexed();
  base.dispose();
  const positions = Float32Array.from(geo.getAttribute("position")!.array as Float32Array);
  const normals = new Float32Array(positions.length);
  const uvs = new Float32Array((positions.length / 3) * 2);
  const box = [width / 2 - radius, height / 2 - radius, depth / 2 - radius];
  const faceTris = positions.length / 6;
  const half = 0.5 / seg;
  const n: [number, number, number] = [0, 0, 0];
  const FACES: [number, number, number][] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let i = 0, j = 0; i < positions.length; i += 3, j += 2) {
    const px = positions[i]!, py = positions[i + 1]!, pz = positions[i + 2]!;
    n[0] = px - Math.sign(px) * half;
    n[1] = py - Math.sign(py) * half;
    n[2] = pz - Math.sign(pz) * half;
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    n[0] /= l; n[1] /= l; n[2] /= l;
    positions[i] = box[0]! * Math.sign(px) + n[0] * radius;
    positions[i + 1] = box[1]! * Math.sign(py) + n[1] * radius;
    positions[i + 2] = box[2]! * Math.sign(pz) + n[2] * radius;
    normals[i] = n[0]; normals[i + 1] = n[1]; normals[i + 2] = n[2];
    const side = Math.floor(i / faceTris);
    const f = FACES[side]!;
    // x 0, y 1, z 2: the face's two UV axes, each projected along the other
    switch (side) {
      case 0: uvs[j] = uvAlong(f, n, 2, 1, radius, depth); uvs[j + 1] = 1 - uvAlong(f, n, 1, 2, radius, height); break;
      case 1: uvs[j] = 1 - uvAlong(f, n, 2, 1, radius, depth); uvs[j + 1] = 1 - uvAlong(f, n, 1, 2, radius, height); break;
      case 2: uvs[j] = 1 - uvAlong(f, n, 0, 2, radius, width); uvs[j + 1] = uvAlong(f, n, 2, 0, radius, depth); break;
      case 3: uvs[j] = 1 - uvAlong(f, n, 0, 2, radius, width); uvs[j + 1] = 1 - uvAlong(f, n, 2, 0, radius, depth); break;
      case 4: uvs[j] = 1 - uvAlong(f, n, 0, 1, radius, width); uvs[j + 1] = 1 - uvAlong(f, n, 1, 0, radius, height); break;
      default: uvs[j] = uvAlong(f, n, 0, 1, radius, width); uvs[j + 1] = 1 - uvAlong(f, n, 1, 0, radius, height); break;
    }
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(positions, 3));
  out.setAttribute("normal", new BufferAttribute(normals, 3));
  out.setAttribute("uv", new BufferAttribute(uvs, 2));
  out.computeBoundingSphere();
  geo.dispose();
  return out;
}
