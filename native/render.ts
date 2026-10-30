// The dig face on starhermit:scene, ported from the browser build's three.js
// renderer (js/render.js): a subterranean cross-section of instanced cells
// (soil, packed clay with strata, rock, wet carved channels), instanced
// glowing water whose fill interpolates between the fixed ticks, spiked
// foul pockets, the spring's metal pipe and glow, the well's pulsing ring
// and light, the cavern wall, floor and boulders, the selection outline and
// ring, the ghost preview, splash particles, dust motes in the lamp light,
// the fitted camera with its transition and event shake, and the look per
// graphics level from quality.ts. It reads rules snapshots and never mutates
// rules state.
//
// What changed from three.js, and why:
// - The cell and water materials' onBeforeCompile patches are WGSL hooks:
//   the cell's kind rides in each instance's custom slot (the old aKind
//   attribute), the clay strata and the wet channel floor are a surface
//   hook, the water's shimmer is a surface hook over its world position.
// - DodecahedronGeometry boulders with flatShading are low-segment spheres
//   made non-indexed (face normals), displaced the same way when detailed.
// - The EffectComposer chain (GTAO, UnrealBloom, OutputPass, the grade
//   ShaderPass, SMAA / FXAA / MSAA) is renderer.ao / bloom / grade /
//   antialias; the grade's GLSL is the built-in display-space grade with the
//   same curve, tints and vignette.
// - The playfield between the rails is a view offset: the camera spans the
//   window and the board is fitted and centred in the free rectangle the
//   screens leave (setPlayfield), where the browser build sized its canvas
//   to the DOM's playfield element.
// - Picking intersects the ray with the board's plane (the old invisible
//   pick plane; the engine's rays skip invisible meshes).
// - Lights, shadows (the fitted shadow box), the room environment and the
//   bump-mapped grain are the page's own values (three.js r166 parity at
//   engine minor 28). Context-loss recovery, the adaptive resolution and the fps
//   meter are gone: the runtime owns them.
import {
  ACESFilmicToneMapping, AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, Color, ConeGeometry,
  CylinderGeometry, DirectionalLight, DoubleSide, EdgesGeometry, Euler, Fog, Group, HemisphereLight, InstancedMesh,
  LineBasicMaterial, LineSegments, Matrix4, Mesh, MeshBasicMaterial, MeshLambertMaterial, MeshPhysicalMaterial,
  MeshStandardMaterial, PMREMGenerator, PerspectiveCamera, PlaneGeometry, Points, PointsMaterial, PointLight,
  Quaternion, Raycaster, RepeatWrapping, RingGeometry, RoomEnvironment, SRGBColorSpace, SphereGeometry, TorusGeometry,
  Vector3, Vector4, pointerToNdc, renderer, scene,
} from "starhermit:scene";
import type { Material, MaterialHooks, Object3D, Texture } from "starhermit:scene";
import { OffscreenCanvas } from "starhermit:canvas";
import { CELL, CELL_CAP } from "../js/rules.js";
import { getTheme } from "../js/content.js";
import { makeRng } from "../js/rng.js";
import type { Look } from "./quality.ts";
import { roundedBox } from "./rounded.ts";

type Theme = ReturnType<typeof getTheme>;
export interface Level { id: string; seed: number; w: number; h: number; cells: number[]; theme?: string }
export interface BoardState { cells: number[]; clean: number[]; dirty: number[] }
export interface RulesEvent { t: string; x?: number; y?: number; hard?: boolean; clean?: number; won?: boolean }

const PI = Math.PI;
// Camera framing constants (exposed, not magic offsets).
const FRAMING = { fov: 34, fitMargin: 1.35, closeMargin: 1.08, tiltDeg: 8, transitionSec: 0.6 };

// Colour-vision-safe palette overrides for gameplay-critical hues.
const PALETTES: Record<string, Partial<Record<"water" | "dirty" | "contam" | "target", number>>> = {
  default: {},
  deuteranopia: { water: 0x41b6ff, dirty: 0xe0a030, contam: 0xf0c040, target: 0xf0f060 },
  protanopia: { water: 0x41b6ff, dirty: 0xd09028, contam: 0xe8c048, target: 0xe8e070 },
  tritanopia: { water: 0x30d0c0, dirty: 0xd05040, contam: 0xd06838, target: 0x70f0a0 },
  contrast: { water: 0x00e5ff, dirty: 0xffb000, contam: 0xffcf00, target: 0xffffff },
};

// --- shared shading hooks ----------------------------------------------------------------------
const cellUniforms = { uDetail: { value: 1 } };
const cellHooks: MaterialHooks = {
  uniforms: cellUniforms,
  // the instance's kind (custom slot x) and the object-space position for the strata
  vertex: `
fn vertex(v: Vertex) -> Vertex {
  var o = v;
  o.v0 = vec4f(v.position, v.instance.x);
  return o;
}`,
  surface: `
fn surface(s: Surface) -> Surface {
  var o = s;
  let kind = s.v0.w;
  // kind 2 = packed clay: horizontal strata so it reads apart from soil by pattern too.
  let clay = step(1.5, kind) * step(kind, 2.5);
  let band = smoothstep(-0.25, 0.25, sin(s.v0.y * 21.0 + s.v0.x * 2.0));
  o.base_color = vec4f(s.base_color.rgb * (1.0 - clay * uniforms.uDetail * 0.16 * band), s.base_color.a);
  // kind 3 = carved channel: damp floor, glossier.
  let wet = step(2.5, kind) * step(kind, 3.5);
  o.roughness = mix(s.roughness, 0.32, wet * uniforms.uDetail);
  return o;
}`,
};
const waterUniforms = { uTime: { value: 0 }, uWaterAnim: { value: 1 } };
const waterHooks: MaterialHooks = {
  uniforms: waterUniforms,
  surface: `
fn surface(s: Surface) -> Surface {
  var o = s;
  let ripple = 0.5 + 0.5 * sin(s.world.y * 7.0 + uniforms.uTime * 5.0 + sin(s.world.x * 3.0 + uniforms.uTime * 1.7) * 1.5);
  let glow = 0.34 + uniforms.uWaterAnim * 0.2 * ripple;
  o.emissive = s.emissive + s.color.rgb * glow;
  return o;
}`,
};

// --- textures -------------------------------------------------------------------------------------
/** Grey grain (soil speckle, pebbles) generated once per size; multiplied with the instance colour. */
function grainCanvas(size: number, seed: number, pebbles: number, pebbleAlpha = 1): OffscreenCanvas {
  const cv = new OffscreenCanvas(size, size);
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(size, size);
  const rng = makeRng(seed, "grain");
  const grid = (n: number): number[] => { const g: number[] = []; for (let i = 0; i < n * n; i++) g.push(rng.next()); return g; };
  const g1 = grid(8), g2 = grid(24);
  const sample = (g: number[], n: number, x: number, y: number): number => {
    const fx = x * n, fy = y * n;
    const x0 = Math.floor(fx) % n, y0 = Math.floor(fy) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
    const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = g[y0 * n + x0]! + (g[y0 * n + x1]! - g[y0 * n + x0]!) * sx;
    const b = g[y1 * n + x0]! + (g[y1 * n + x1]! - g[y1 * n + x0]!) * sx;
    return a + (b - a) * sy;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const nz = 0.55 * sample(g1, 8, u, v) + 0.3 * sample(g2, 24, u, v) + 0.15 * rng.next();
    const val = Math.max(0, Math.min(255, Math.round(255 * (0.78 + 0.3 * (nz - 0.5)))));
    const k = (y * size + x) * 4;
    img.data[k] = img.data[k + 1] = img.data[k + 2] = val;
    img.data[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  for (let i = 0; i < pebbles; i++) {
    const r = 1.5 + rng.next() * size * 0.035;
    const light = rng.next() < 0.5;
    ctx.fillStyle = light ? `rgba(255,255,255,${0.16 * pebbleAlpha})` : `rgba(0,0,0,${0.22 * pebbleAlpha})`;
    ctx.beginPath();
    ctx.ellipse(rng.next() * size, rng.next() * size, r, r * (0.6 + rng.next() * 0.4), rng.next() * 3, 0, PI * 2);
    ctx.fill();
  }
  return cv;
}
interface Grain { canvas: OffscreenCanvas }
const grains = new Map<string, Grain>();
function grain(size: number, seed: number, pebbles: number, alpha: number): Grain {
  const key = `${size}:${seed}`;
  let g = grains.get(key);
  if (!g) {
    const canvas = grainCanvas(size, seed, pebbles, alpha);
    g = { canvas };
    grains.set(key, g);
  }
  return g;
}
function colorMap(g: Grain, rx: number, ry: number): Texture {
  const t = new CanvasTexture(g.canvas);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.anisotropy = 4;
  t.repeat.set(rx, ry);
  grainMaps.add(t);
  return t;
}
// --- colour helpers -------------------------------------------------------------------------------
/** three.js Color.set(hex).offsetHSL(0, 0, dl): the lightness moved in sRGB HSL. (The
 * engine's Color.setHSL takes the components as they are, without three.js's
 * sRGB-to-linear step, so the colour is made here and set as a hex number.) */
function offsetL(hex: number, dl: number, target: Color): Color {
  const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, b = (hex & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l0 = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l0 > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  const l = Math.max(0, Math.min(1, l0 + dl));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const hue = (t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
  };
  const to = (v: number): number => Math.max(0, Math.min(255, Math.round(v * 255)));
  return target.set((to(hue(h + 1 / 3)) << 16) | (to(hue(h)) << 8) | to(hue(h - 1 / 3)));
}

// --- scene state --------------------------------------------------------------------------------
const camera = new PerspectiveCamera(FRAMING.fov, 16 / 9, 0.1, 200);
const key = new DirectionalLight(0xffeedd, 3.0);
const hemi = new HemisphereLight(0x9fb8d8, 0x2a2018, 0.9);
const boardGroup = new Group();
const envGroup = new Group();
const fxGroup = new Group();
let built = false;
let look: Look | null = null;
let theme: Theme = getTheme("bedrock");
let palette = "default";
let highContrast = false;
let reducedMotion = false;
let cameraView = "fit";
let level: Level | null = null;
let envTex: Texture | null = null;

let cellMesh: InstancedMesh | null = null;
let waterMesh: InstancedMesh | null = null;
let decor: number[] = [];
let prevFill: number[] = [], curFill: number[] = [], curDirty: boolean[] = [];
let lastCells: number[] = [];
let fillAlpha = 1;
let targetRing: Mesh | null = null;
let sourceGlow: PointLight | null = null;
let selOutline: LineSegments | null = null;
let selRing: Mesh<MeshBasicMaterial> | null = null;
let ghost: Mesh<MeshBasicMaterial> | null = null;

const _m4 = new Matrix4();
const _v3 = new Vector3();
const _q = new Quaternion();
const _s = new Vector3();
const _c = new Color();
const _v4 = new Vector4();

function setup(): void {
  built = true;
  key.position.set(6, 10, 12);
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target, hemi, boardGroup, envGroup, fxGroup, points, motes);
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
}

function colorOf(k: "water" | "dirty" | "contam" | "target"): number {
  const over = highContrast ? PALETTES.contrast! : (PALETTES[palette] ?? {});
  return over[k] ?? theme[k];
}

/** A lit material for the preset budget: Lambert on Low, standard on Balanced, physical (clearcoat) above. */
interface LitParams { color?: number | Color; roughness?: number; metalness?: number; transparent?: boolean; opacity?: number; clearcoat?: number; clearcoatRoughness?: number; emissive?: number; emissiveIntensity?: number; map?: Texture | null; bumpMap?: Texture | null; bumpScale?: number }
function lit(p: LitParams): Material {
  const kind = look!.budget.material;
  const { clearcoat, clearcoatRoughness, roughness, metalness, ...common } = p;
  if (kind === "lambert") return new MeshLambertMaterial(common);
  if (kind === "physical" && clearcoat) return new MeshPhysicalMaterial({ ...common, roughness, metalness, clearcoat, clearcoatRoughness });
  return new MeshStandardMaterial({ ...common, roughness, metalness });
}

// --- level build ----------------------------------------------------------------------------------
function disposeGroup(group: Group): void {
  for (let i = group.children.length - 1; i >= 0; i--) {
    const o = group.children[i]!;
    group.remove(o);
    const kill = (c: Object3D): void => {
      const m = c as unknown as { geometry?: BufferGeometry; material?: Material | Material[] };
      if (m.geometry) m.geometry.dispose();
      if (m.material) for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
        mat.dispose();
      }
      for (const k of c.children) kill(k);
    };
    kill(o);
  }
}
const grainMaps = new Set<Texture>();

function cellXY(x: number, y: number): [number, number] {
  return [x - (level!.w - 1) / 2, (level!.h - 1) / 2 - y];
}

/** Builds the board for a level (and again when the look's assets change). */
export function loadLevel(lv: Level): void {
  if (!built) setup();
  level = lv;
  theme = getTheme(lv.theme ?? "bedrock");
  scene.background = new Color(theme.sky);
  scene.fog = new Fog(theme.fog, 30, 90);
  if (!look) return;
  disposeGroup(boardGroup);
  disposeGroup(envGroup);
  disposeGroup(fxGroup);
  for (const t of grainMaps) t.dispose();
  grainMaps.clear();
  const { w, h } = lv;
  const n = w * h;
  const rng = makeRng(lv.seed, "decor"); // decoration stream only
  const detailed = look.detailed;
  const B = look.budget;

  // -- solid cells: one instanced mesh, per-instance colour and kind --
  const cellGeo = detailed ? roundedBox(0.94, 0.94, 0.55, B.bevel, 0.07) : new BoxGeometry(0.94, 0.94, 0.55);
  const cellMap = detailed ? colorMap(grain(B.grain, 7, 26, 1), 1, 1) : null;
  const cellMat = lit({ roughness: 0.9, metalness: 0.02, map: cellMap, bumpMap: cellMap, bumpScale: 1.2 });
  if (detailed) cellMat.hooks = cellHooks;
  cellUniforms.uDetail.value = detailed ? 1 : 0;
  cellMesh = new InstancedMesh(cellGeo, cellMat, n);
  cellMesh.customSlots = 1;
  cellMesh.receiveShadow = true;
  cellMesh.castShadow = true;
  boardGroup.add(cellMesh);
  decor = [];
  for (let i = 0; i < n; i++) decor.push(rng.next());

  // -- water overlay: instanced emissive boxes --
  const waterMat = lit({ color: 0x808080, roughness: 0.12, metalness: 0, transparent: true, opacity: 0.93, clearcoat: 1, clearcoatRoughness: 0.08 });
  waterMat.hooks = waterHooks;
  waterMesh = new InstancedMesh(new BoxGeometry(0.8, 0.8, 0.34), waterMat, n);
  boardGroup.add(waterMesh);
  prevFill = new Array<number>(n).fill(0);
  curFill = new Array<number>(n).fill(0);
  curDirty = new Array<boolean>(n).fill(false);

  // -- foul-pocket spikes (shape reinforcement, not colour alone) --
  const contamCount = lv.cells.filter((c) => c === CELL.CONTAM).length;
  if (contamCount > 0) {
    const spikeMat = lit({ color: colorOf("contam"), roughness: 0.3, metalness: 0.2, emissive: colorOf("contam"), emissiveIntensity: 0.35 });
    const spikes = new InstancedMesh(new ConeGeometry(0.16, 0.5, 5), spikeMat, contamCount * 3);
    spikes.castShadow = true;
    let k = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (lv.cells[y * w + x] !== CELL.CONTAM) continue;
      for (let s = 0; s < 3; s++) {
        const [wx, wy] = cellXY(x, y);
        _v3.set(wx + (rng.next() - 0.5) * 0.5, wy + (rng.next() - 0.5) * 0.5, 0.35);
        _q.setFromEuler(new Euler((rng.next() - 0.5) * 0.7, 0, (rng.next() - 0.5) * 0.7));
        _s.setScalar(0.7 + rng.next() * 0.6);
        spikes.setMatrixAt(k++, _m4.compose(_v3, _q, _s));
      }
    }
    boardGroup.add(spikes);
  }

  // -- the spring's pipe and the well's beacon --
  targetRing = null;
  sourceGlow = null;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = lv.cells[y * w + x];
    const [wx, wy] = cellXY(x, y);
    if (t === CELL.SOURCE) {
      const pipeMat = new MeshStandardMaterial({ color: 0x6c7682, roughness: 0.45, metalness: 0.9 });
      const pipe = new Mesh(new CylinderGeometry(0.3, 0.34, 0.9, 20), pipeMat);
      pipe.position.set(wx, wy + 0.4, 0.45);
      pipe.rotation.x = PI / 2.4;
      pipe.castShadow = true;
      boardGroup.add(pipe);
      const lip = new Mesh(new TorusGeometry(0.33, 0.06, 10, 28), new MeshStandardMaterial({ color: 0x6c7682, roughness: 0.45, metalness: 0.9 }));
      lip.position.set(0, 0.42, 0);
      lip.rotation.x = PI / 2;
      pipe.add(lip);
      sourceGlow = new PointLight(colorOf("water"), 6, 6);
      sourceGlow.position.set(wx, wy, 1.2);
      boardGroup.add(sourceGlow);
    } else if (t === CELL.TARGET) {
      const ring = new Mesh(new TorusGeometry(0.42, 0.08, 16, 40), new MeshPhysicalMaterial({
        color: colorOf("target"), emissive: colorOf("target"), emissiveIntensity: 1.25, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1,
      }));
      ring.castShadow = true;
      ring.position.set(wx, wy, 0.4);
      boardGroup.add(ring);
      targetRing = ring;
      const tl = new PointLight(colorOf("target"), 5, 7);
      tl.position.set(wx, wy, 1.2);
      boardGroup.add(tl);
    }
  }

  buildEnvironment(rng);

  // -- selection marker (outline + grounded ring) and the ghost preview --
  selOutline = new LineSegments(new EdgesGeometry(new BoxGeometry(1.02, 1.02, 0.62)), new LineBasicMaterial({ color: 0xffffff }));
  selRing = new Mesh(new RingGeometry(0.4, 0.52, 24), new MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, side: DoubleSide }));
  selRing.position.z = 0.42;
  selOutline.visible = selRing.visible = false;
  ghost = new Mesh(new BoxGeometry(0.9, 0.9, 0.5), new MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false }));
  ghost.visible = false;
  fxGroup.add(selOutline, selRing, ghost);

  lastCells = [];
  paintCells(lv.cells);
  fitCamera(true);
  resetParticles();
}

/** The page's shadow frustum fitted to the board plus a small margin (texel-dense). */
function fitShadow(): void {
  const { w, h } = level!;
  const ext = Math.max(w, h) / 2 + 2.5;
  const sc = key.shadow.camera;
  key.target.position.set(0, 0, 0);
  key.position.set(6, 10, 12).setLength(30);
  Object.assign(sc, { left: -ext - 1, right: ext + 1, top: ext + 1, bottom: -ext - 1, near: 10, far: 55 });
  sc.updateProjectionMatrix();
  key.target.updateMatrixWorld();
}

function buildEnvironment(rng: ReturnType<typeof makeRng>): void {
  const { w, h } = level!;
  const detailed = look!.detailed;
  let backMap: Texture | null = null, floorMap: Texture | null = null;
  if (detailed) {
    const g = grain(look!.budget.grain * 2, 11, 40, 0.45);
    backMap = colorMap(g, (w + 30) / 4, (h + 30) / 4);
    floorMap = colorMap(g, (w + 30) / 5, 6);
  }
  // Backdrop slab behind the board: the cavern wall.
  const back = new Mesh(new BoxGeometry(w + 30, h + 30, 1.5), lit({
    color: new Color(theme.rock).multiplyScalar(detailed ? 0.6 : 1), roughness: 1, map: backMap, bumpMap: backMap, bumpScale: 2,
  }));
  back.position.set(0, 0, -1.1);
  back.receiveShadow = true;
  envGroup.add(back);
  // Floor.
  const floor = new Mesh(new PlaneGeometry(w + 30, 30), lit({ color: theme.rock, roughness: 0.95, map: floorMap, bumpMap: floorMap, bumpScale: 2 }));
  floor.rotation.x = -PI / 2;
  floor.position.set(0, -h / 2 - 0.5, 6);
  floor.receiveShadow = true;
  envGroup.add(floor);
  fitShadow();
  // Scattered boulders by detail tier.
  const count = Math.round(look!.budget.rocks * (detailed ? 1 : 0.5)) + 4;
  const rockGeo: BufferGeometry = new SphereGeometry(0.5, detailed ? 7 : 5, detailed ? 5 : 3).toNonIndexed();
  if (detailed) {
    // Lumpy boulders: displace the vertices deterministically.
    const pos = rockGeo.getAttribute("position")!;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const x = arr[i]!, y = arr[i + 1]!, z = arr[i + 2]!;
      const k = 0.85 + 0.3 * (Math.sin(x * 9.1 + y * 5.3) * 0.5 + 0.5) * (Math.cos(z * 7.7) * 0.5 + 0.5);
      arr[i] = x * k; arr[i + 1] = y * k; arr[i + 2] = z * k;
    }
    pos.needsUpdate = true;
  }
  rockGeo.computeVertexNormals();
  const rocks = new InstancedMesh(rockGeo, lit({ color: theme.rock, roughness: 0.85 }), count);
  for (let i = 0; i < count; i++) {
    const side = rng.chance(0.5) ? -1 : 1;
    _v3.set(side * (w / 2 + 1.5 + rng.next() * 4), (rng.next() - 0.5) * (h + 4), -0.5 + rng.next() * 2);
    _q.setFromEuler(new Euler(rng.next() * 3, rng.next() * 3, rng.next() * 3));
    _s.setScalar(0.4 + rng.next() * 1.2);
    rocks.setMatrixAt(i, _m4.compose(_v3, _q, _s));
  }
  rocks.castShadow = true;
  rocks.receiveShadow = true;
  envGroup.add(rocks);
}

/** Instance colours, depths and kinds for every cell. */
function paintCells(cells: number[]): void {
  if (!cellMesh || !level) return;
  const { w, h } = level;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const t = cells[i]!;
    const jitter = decor[i]!;
    const [wx, wy] = cellXY(x, y);
    _v3.set(wx, wy, (jitter - 0.5) * 0.08);
    _q.identity();
    _s.set(1, 1, 0.9 + jitter * 0.2);
    cellMesh.setMatrixAt(i, _m4.compose(_v3, _q, _s));
    switch (t) {
      case CELL.ROCK: offsetL(theme.rock, (jitter - 0.5) * 0.08, _c); break;
      case CELL.SOIL: offsetL(theme.soil, (jitter - 0.5) * 0.1, _c); break;
      case CELL.HARD: offsetL(theme.hard, (jitter - 0.5) * 0.08, _c); break;
      case CELL.CONTAM: offsetL(theme.channel, -0.02, _c); break;
      case CELL.SOURCE: _c.set(theme.rock); break;
      case CELL.CHANNEL: case CELL.TARGET: _c.set(theme.channel); break;
      default: _c.set(theme.soil);
    }
    cellMesh.setColorAt(i, _c);
    const kind = t === CELL.HARD ? 2 : (t === CELL.CHANNEL || t === CELL.CONTAM || t === CELL.TARGET) ? 3 : 1;
    cellMesh.setCustomAt(i, _v4.set(kind, 0, 0, 0));
  }
  cellMesh.instanceMatrix.needsUpdate = true;
  if (cellMesh.instanceColor) cellMesh.instanceColor.needsUpdate = true;
  if (cellMesh.instanceCustom) cellMesh.instanceCustom.needsUpdate = true;
  lastCells = cells.slice();
}

/**
 * Sync from rules snapshots: `prev` the state before the last tick (null when
 * none), `alpha` 0–1 between them for the water's fill.
 */
export function syncState(next: BoardState, prev: BoardState | null, alpha: number): void {
  if (!level || !cellMesh) return;
  let changed = lastCells.length !== next.cells.length;
  for (let i = 0; !changed && i < next.cells.length; i++) if (next.cells[i] !== lastCells[i]) changed = true;
  if (changed) paintCells(next.cells);
  const n = level.w * level.h;
  for (let i = 0; i < n; i++) {
    prevFill[i] = prev ? prev.clean[i]! + prev.dirty[i]! : next.clean[i]! + next.dirty[i]!;
    curFill[i] = next.clean[i]! + next.dirty[i]!;
    curDirty[i] = next.dirty[i]! > 0;
  }
  fillAlpha = alpha;
  paintWater();
}

function paintWater(): void {
  if (!waterMesh || !level) return;
  const { w, h } = level;
  const clean = new Color(colorOf("water"));
  const dirty = new Color(colorOf("dirty"));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const f = prevFill[i]! + (curFill[i]! - prevFill[i]!) * fillAlpha;
    const [wx, wy] = cellXY(x, y);
    if (f <= 0) {
      _s.set(0.0001, 0.0001, 0.0001);
      _v3.set(wx, wy, -10);
    } else {
      const sy = 0.9 * Math.min(1, f / CELL_CAP);
      _v3.set(wx, wy - (0.9 - sy) / 2, 0.32);
      _s.set(0.9, Math.max(0.02, sy), 1);
    }
    _q.identity();
    waterMesh.setMatrixAt(i, _m4.compose(_v3, _q, _s));
    waterMesh.setColorAt(i, curDirty[i] ? dirty : clean);
  }
  waterMesh.instanceMatrix.needsUpdate = true;
  if (waterMesh.instanceColor) waterMesh.instanceColor.needsUpdate = true;
}

// --- feedback -------------------------------------------------------------------------------------
let shakeAmt = 0;
function addShake(amount: number): void {
  if (reducedMotion) return;
  shakeAmt = Math.min(0.5, shakeAmt + amount);
}
/** Particles and camera impulses from the rules' events. */
export function events(list: readonly RulesEvent[]): void {
  if (!level) return;
  for (const e of list) {
    switch (e.t) {
      case "carve": {
        const [wx, wy] = cellXY(e.x!, e.y!);
        burst(wx, wy, 0.5, theme.soil, e.hard ? 26 : 14);
        if (e.hard) addShake(0.08);
        break;
      }
      case "deliver": {
        const [wx, wy] = cellXY(e.x!, e.y!);
        burst(wx, wy, 0.8, colorOf("water"), Math.min(10, 2 + (e.clean ?? 0)));
        break;
      }
      case "contaminate": {
        const [wx, wy] = cellXY(e.x!, e.y!);
        burst(wx, wy, 0.7, colorOf("contam"), 8);
        break;
      }
      case "release": addShake(0.12); break;
      case "end":
        if (!reducedMotion) addShake(e.won ? 0.22 : 0.3);
        if (e.won && targetRing) burst(targetRing.position.x, targetRing.position.y, 1.2, colorOf("target"), 60);
        break;
    }
  }
}

export function setSelection(x: number | null, y = 0, valid = true): void {
  if (!selOutline || !selRing) return;
  if (x == null) { selOutline.visible = selRing.visible = false; return; }
  const [wx, wy] = cellXY(x, y);
  selOutline.position.set(wx, wy, 0.1);
  selRing.position.set(wx, wy, 0.42);
  const col = valid ? 0xffffff : 0xff5040;
  (selOutline.material as Material).color.set(col);
  selRing.material.color.set(col);
  selOutline.visible = selRing.visible = true;
}
export function setGhost(x: number | null, y = 0, valid = true): void {
  if (!ghost) return;
  if (x == null) { ghost.visible = false; return; }
  const [wx, wy] = cellXY(x, y);
  ghost.position.set(wx, wy, 0.1);
  ghost.material.color.set(valid ? 0x50ff90 : 0xff5040);
  ghost.visible = true;
}

// --- picking -------------------------------------------------------------------------------------
const _ray = new Raycaster();
/** The cell under a window pixel: the ray meets the board's plane (z 0.3). */
export function pick(px: number, py: number): { x: number; y: number } | null {
  if (!level || !renderer.camera) return null;
  _ray.setFromCamera(pointerToNdc(px, py), camera);
  const o = _ray.ray.origin, d = _ray.ray.direction;
  if (Math.abs(d.z) < 1e-6) return null;
  const t = (0.3 - o.z) / d.z;
  if (t <= 0) return null;
  const lx = o.x + d.x * t + (level.w - 1) / 2;
  const ly = (level.h - 1) / 2 - (o.y + d.y * t);
  const x = Math.round(lx), y = Math.round(ly);
  if (x < 0 || y < 0 || x >= level.w || y >= level.h) return null;
  return { x, y };
}

// --- camera -------------------------------------------------------------------------------------
let winW = 1, winH = 1;
let free = { x: 0, y: 0, w: 1, h: 1 };
const camPos = new Vector3(0, 0, 30);
let camFrom: Vector3 | null = null, camTo: Vector3 | null = null, camT = 1;

function fitPosition(): Vector3 {
  const { w, h } = level!;
  const margin = cameraView === "close" ? FRAMING.closeMargin : FRAMING.fitMargin;
  const tanHalf = Math.tan((FRAMING.fov / 2) * (PI / 180));
  const aspect = winW / winH;
  // the board fills the free rectangle as it filled the old playfield canvas
  const distH = ((h * margin) / (2 * tanHalf)) * (winH / Math.max(1, free.h));
  const distW = ((w * margin) / (2 * tanHalf * aspect)) * (winW / Math.max(1, free.w));
  const dist = Math.max(distH, distW) + 2;
  const tilt = FRAMING.tiltDeg * (PI / 180);
  return new Vector3(0, Math.sin(tilt) * dist * 0.35, dist);
}
function fitCamera(immediate: boolean): void {
  if (!level) return;
  const to = fitPosition();
  if (immediate || reducedMotion) { camPos.copy(to); camT = 1; return; }
  camFrom = camPos.clone();
  camTo = to;
  camT = 0;
}
export function resetCamera(): void { fitCamera(false); }

let freeKey = "";
/** The free rectangle the screens leave for the board and the window's size, in window pixels. */
export function setPlayfield(x: number, y: number, w: number, h: number, ww: number, wh: number): void {
  const k = [x, y, w, h, ww, wh].map((v) => Math.round(v)).join(",");
  if (k === freeKey) return;
  freeKey = k;
  free = { x, y, w: Math.max(1, w), h: Math.max(1, h) };
  winW = Math.max(1, ww); winH = Math.max(1, wh);
  fitCamera(true);
}

// --- particles and motes -------------------------------------------------------------------------
const PCAP = 2048;
const pPos = new Float32Array(PCAP * 3);
const pVel = new Float32Array(PCAP * 3);
const pLife = new Float32Array(PCAP);
const pCol = new Float32Array(PCAP * 3);
const pGeo = new BufferGeometry();
pGeo.setAttribute("position", new BufferAttribute(pPos, 3));
pGeo.setAttribute("color", new BufferAttribute(pCol, 3));
const points = new Points(pGeo, new PointsMaterial({ size: 0.14, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, sizeAttenuation: true }));
points.frustumCulled = false;
let pHead = 0;
let particleCap = 300;
function resetParticles(): void {
  pLife.fill(0);
  for (let i = 0; i < PCAP; i++) pPos[i * 3 + 2] = -50;
  pHead = 0;
  (pGeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
}
function burst(wx: number, wy: number, wz: number, color: number, count: number): void {
  if (reducedMotion) count = Math.min(count, 4);
  const n = Math.min(count, particleCap);
  _c.set(color);
  for (let k = 0; k < n; k++) {
    const i = pHead;
    pHead = (pHead + 1) % particleCap;
    pPos[i * 3] = wx; pPos[i * 3 + 1] = wy; pPos[i * 3 + 2] = wz;
    const a = Math.random() * PI * 2;
    const sp = 1 + Math.random() * 3;
    pVel[i * 3] = Math.cos(a) * sp;
    pVel[i * 3 + 1] = Math.sin(a) * sp + 1.5;
    pVel[i * 3 + 2] = 0.5 + Math.random() * 1.5;
    pLife[i] = 0.5 + Math.random() * 0.5;
    pCol[i * 3] = _c.r; pCol[i * 3 + 1] = _c.g; pCol[i * 3 + 2] = _c.b;
  }
}
function updateParticles(dt: number): void {
  let any = false;
  for (let i = 0; i < particleCap; i++) {
    if (pLife[i]! <= 0) continue;
    any = true;
    pLife[i] = pLife[i]! - dt;
    pVel[i * 3 + 1] = pVel[i * 3 + 1]! - 6 * dt;
    pPos[i * 3] = pPos[i * 3]! + pVel[i * 3]! * dt;
    pPos[i * 3 + 1] = pPos[i * 3 + 1]! + pVel[i * 3 + 1]! * dt;
    pPos[i * 3 + 2] = pPos[i * 3 + 2]! + pVel[i * 3 + 2]! * dt;
    if (pLife[i]! <= 0) pPos[i * 3 + 2] = -50;
  }
  if (any) {
    (pGeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
    (pGeo.getAttribute("color") as BufferAttribute).needsUpdate = true;
  }
}

const MOTES = 90;
const mPos = new Float32Array(MOTES * 3);
const mSeed = new Float32Array(MOTES);
{
  const rng = makeRng(99, "decor");
  for (let i = 0; i < MOTES; i++) {
    mPos[i * 3] = (rng.next() - 0.5) * 22;
    mPos[i * 3 + 1] = (rng.next() - 0.5) * 22;
    mPos[i * 3 + 2] = 0.8 + rng.next() * 6;
    mSeed[i] = rng.next() * 100;
  }
}
const mGeo = new BufferGeometry();
mGeo.setAttribute("position", new BufferAttribute(mPos, 3));
const motes = new Points(mGeo, new PointsMaterial({ size: 0.06, color: 0xffe6c0, transparent: true, opacity: 0.45, depthWrite: false, sizeAttenuation: true, blending: AdditiveBlending }));
motes.frustumCulled = false;
motes.visible = false;
function updateMotes(dt: number, t: number): void {
  for (let i = 0; i < MOTES; i++) {
    const s = mSeed[i]!;
    mPos[i * 3] = mPos[i * 3]! + Math.sin(t * 0.3 + s) * 0.08 * dt;
    mPos[i * 3 + 1] = mPos[i * 3 + 1]! + (Math.cos(t * 0.23 + s * 1.7) * 0.06 - 0.05) * dt;
    if (mPos[i * 3 + 1]! < -11) mPos[i * 3 + 1] = 11;
  }
  (mGeo.getAttribute("position") as BufferAttribute).needsUpdate = true;
}

// --- settings ------------------------------------------------------------------------------------
function updateEnvironment(): void {
  if (!look!.detailed) { scene.environment = null; return; }
  if (!envTex) {
    try { envTex = new PMREMGenerator(renderer).fromScene(new RoomEnvironment(renderer), 0.04).texture; }
    catch (e) { console.warn(`environment: ${e instanceof Error ? e.message : String(e)}`); envTex = null; }
  }
  scene.environment = envTex;
  // Underground: reflections only hint at shape, the lamp does the lighting.
  scene.environmentIntensity = 0.28;
}

/** The look for the frame's graphics level; rebuilds what it changes, cheap when nothing did. */
export function applyLook(next: Look): void {
  if (look && JSON.stringify(look) === JSON.stringify(next)) return;
  const prev = look;
  look = next;
  if (!built) setup();
  const shadows = next.shadows > 0;
  renderer.shadowMap.enabled = shadows;
  key.castShadow = shadows;
  if (shadows) key.shadow.mapSize = next.shadows;
  updateEnvironment();
  particleCap = Math.max(1, Math.min(PCAP, next.budget.particles));
  waterUniforms.uWaterAnim.value = next.animatedWater ? 1 : 0;
  motes.visible = next.animatedBackground;
  renderer.ao = next.ao === "off" ? null : {
    blendIntensity: next.ao === "high" ? 0.85 : 0.7, radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.0,
    samples: next.ao === "high" ? 16 : 8, resolution: next.budget.aoRes,
    denoise: { lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: next.ao === "high" ? 6 : 4, rings: 2, samples: next.ao === "high" ? 16 : 8, radiusExponent: 2 },
  };
  // High threshold: only the water, the well's ring and the spring's glow bloom.
  // The page's three r166 UnrealBloomPass at its own strength (bloom model r160, r169 and older).
  renderer.bloom = next.bloom ? { model: "r160", strength: 0.6, radius: 0.5, threshold: 0.86, resolution: next.budget.bloomRes } : null;
  // The grade pass: 0.22 of a smoothstep S-curve, +10 % saturation, cool
  // shadows / warm highlights (split 0.15–0.8), a 0.3 vignette from 0.38 to 0.9.
  renderer.grade = next.grade ? {
    space: "display", contrastCurve: "s", contrast: 0.22, saturation: 1.1, levels: [0.97, 0.015],
    shadows: [0.95, 0.98, 1.06], highlights: [1.05, 1.0, 0.95], split: [0.15, 0.8],
    vignette: { amount: 0.3, inner: 0.38, outer: 0.9, scale: [1.1, 1] },
  } : null;
  renderer.antialias = next.antialias;
  const assets = (l: Look): string => [l.detailed, l.budget.material, l.budget.bevel, l.budget.grain, l.budget.rocks].join("|");
  if (level && (!prev || assets(prev) !== assets(next))) loadLevel(level);
}
export function setReducedMotion(v: boolean): void { reducedMotion = v; }
export function setCameraView(v: string): void {
  if (v === cameraView) return;
  cameraView = v;
  fitCamera(false);
}
/** The colour-vision palette and the runtime's high contrast (the gameplay hues). */
export function setPalette(p: string, contrast: boolean): void {
  if (p === palette && contrast === highContrast) return;
  palette = p;
  highContrast = contrast;
  if (level && look) loadLevel(level);
}
/** Whether the board draws (only in play; menus are flat screens). */
export function setVisible(on: boolean): void {
  if (!built) setup();
  renderer.camera = on && level ? camera : null;
}

// --- per frame ----------------------------------------------------------------------------------
let clock = 0;
/** Advances the cosmetics; `dt` seconds. */
export function update(dtRaw: number): void {
  if (!built || !look || !level || !renderer.camera) return;
  const dt = Math.min(0.1, Math.max(0, dtRaw));
  clock += dt;
  if (!reducedMotion) waterUniforms.uTime.value += dt;
  camera.aspect = winW / winH;
  const cx = free.x + free.w / 2, cy = free.y + free.h / 2;
  camera.setViewOffset(winW, winH, winW / 2 - cx, winH / 2 - cy, winW, winH);
  // camera transition (authored duration and easing, interruptible)
  if (camT < 1 && camFrom && camTo) {
    camT = Math.min(1, camT + dt / FRAMING.transitionSec);
    const t = camT;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
    camPos.copy(camFrom).lerp(camTo, e);
  }
  // event-tiered, low-amplitude shake (picking uses the frame's camera; the shake is a few hundredths)
  let sx = 0, sy = 0;
  if (shakeAmt > 0.001) {
    sx = (Math.sin(clock * 47) + Math.sin(clock * 31)) * 0.5 * shakeAmt * 0.12;
    sy = (Math.cos(clock * 41) + Math.sin(clock * 29)) * 0.5 * shakeAmt * 0.12;
    shakeAmt *= Math.pow(0.001, dt);
  }
  camera.position.set(camPos.x + sx, camPos.y + sy, camPos.z);
  camera.lookAt(sx, sy, 0);
  camera.updateProjectionMatrix();
  key.target.position.set(0, 0, 0);
  // idle cosmetics (skipped entirely under reduced motion)
  if (!reducedMotion) {
    if (targetRing) targetRing.scale.setScalar(1 + Math.sin(clock * 2.4) * 0.06);
    if (sourceGlow) sourceGlow.intensity = 5 + Math.sin(clock * 3.1) * 1.5;
    if (look.animatedBackground) {
      key.intensity = 3.0 + Math.sin(clock * 1.3) * 0.08 + Math.sin(clock * 3.7) * 0.04;
      updateMotes(dt, clock);
    }
  }
  updateParticles(dt);
}
