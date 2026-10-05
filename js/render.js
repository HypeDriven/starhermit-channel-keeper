// Channel Keeper — Three.js renderer.
// Subterranean cross-section: an authored cut-face of soil, rock, clay,
// foul pockets, pipes, and glowing water. Rendering consumes immutable
// snapshots plus an interpolation alpha; it never touches rules state.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CELL, CELL_CAP } from './rules.js';
import { detectPreset, describe, resolve, SHADOW_MAP, PARTICLE_CAP } from './gfx.js';
import { getTheme } from './content.js';
import { makeRng } from './rng.js';

// Camera framing constants (exposed, not magic offsets).
const FRAMING = {
  fov: 34,
  fitMargin: 1.35,       // board scale margin in view
  closeMargin: 1.08,
  tiltDeg: 8,            // slight downward tilt for depth
  transitionSec: 0.6,
};

// Colour grade + vignette (display-space colours in, display-space out):
// gentle S-curve, a touch more saturation, warm highlights / cool shadows.
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 1.0 }, uVignette: { value: 0.3 } },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; uniform float uVignette;
    varying vec2 vUv;
    void main() {
      vec4 src = texture2D(tDiffuse, vUv);
      vec3 c = clamp(src.rgb, 0.0, 1.0);
      vec3 s = mix(c, c * c * (3.0 - 2.0 * c), 0.22);
      float l = dot(s, vec3(0.299, 0.587, 0.114));
      s = mix(vec3(l), s, 1.1);
      s *= mix(vec3(0.95, 0.98, 1.06), vec3(1.05, 1.0, 0.95), smoothstep(0.15, 0.8, l));
      s = s * 0.97 + 0.015;
      c = mix(src.rgb, s, uAmount);
      float d = length((vUv - 0.5) * vec2(1.1, 1.0));
      c *= 1.0 - uVignette * smoothstep(0.38, 0.9, d);
      gl_FragColor = vec4(c, src.a);
    }`,
};

// Shared shader uniforms (time drives water shimmer; frozen under reduced motion).
const U = {
  uTime: { value: 0 },
  uWaterAnim: { value: 1 },
  uDetail: { value: 1 },
};

/** Grey grain texture (soil speckle, pebbles) generated once; multiplied with instance colour. */
function makeGrainTexture(size, seed, pebbles, pebbleAlpha = 1) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(size, size);
  const rng = makeRng(seed, 'grain');
  // Value noise at two octaves for soft mottling plus per-pixel speckle.
  const grid = (n) => { const g = []; for (let i = 0; i < n * n; i++) g.push(rng.next()); return g; };
  const g1 = grid(8), g2 = grid(24);
  const sample = (g, n, x, y) => {
    const fx = x * n, fy = y * n;
    const x0 = Math.floor(fx) % n, y0 = Math.floor(fy) % n, x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
    const tx = fx - Math.floor(fx), ty = fy - Math.floor(fy);
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const a = g[y0 * n + x0] + (g[y0 * n + x1] - g[y0 * n + x0]) * sx;
    const b = g[y1 * n + x0] + (g[y1 * n + x1] - g[y1 * n + x0]) * sx;
    return a + (b - a) * sy;
  };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const n = 0.55 * sample(g1, 8, u, v) + 0.3 * sample(g2, 24, u, v) + 0.15 * rng.next();
    const val = Math.round(255 * (0.78 + 0.3 * (n - 0.5)));
    const k = (y * size + x) * 4;
    img.data[k] = img.data[k + 1] = img.data[k + 2] = Math.max(0, Math.min(255, val));
    img.data[k + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // Pebbles: small lighter/darker blobs.
  for (let i = 0; i < pebbles; i++) {
    const r = 1.5 + rng.next() * size * 0.035;
    const light = rng.next() < 0.5;
    ctx.fillStyle = light ? `rgba(255,255,255,${0.16 * pebbleAlpha})` : `rgba(0,0,0,${0.22 * pebbleAlpha})`;
    ctx.beginPath();
    ctx.ellipse(rng.next() * size, rng.next() * size, r, r * (0.6 + rng.next() * 0.4), rng.next() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Cell material: per-instance kind drives wet channels (glossy) and banded clay. */
function patchCellMaterial(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDetail = U.uDetail;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', 'attribute float aKind;\nvarying float vCkKind;\nvarying vec3 vCkLocal;\n#include <common>')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCkKind = aKind;\nvCkLocal = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', 'uniform float uDetail;\nvarying float vCkKind;\nvarying vec3 vCkLocal;\n#include <common>')
      .replace('#include <color_fragment>', `#include <color_fragment>
        // kind 2 = packed clay: horizontal strata so it reads apart from soil by pattern too.
        float ckClay = step(1.5, vCkKind) * step(vCkKind, 2.5);
        diffuseColor.rgb *= 1.0 - ckClay * uDetail * 0.16 * smoothstep(-0.25, 0.25, sin(vCkLocal.y * 21.0 + vCkLocal.x * 2.0));
        // kind 3 = carved channel: darker damp floor, bevel rim catches light.
        float ckWet = step(2.5, vCkKind) * step(vCkKind, 3.5);`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.32, ckWet * uDetail);`);
  };
  mat.customProgramCacheKey = () => 'ck-cell';
}

/** Water: emissive from the instance colour with a flowing shimmer when animated. */
function patchWaterMaterial(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = U.uTime;
    sh.uniforms.uWaterAnim = U.uWaterAnim;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', 'varying vec3 vCkWorld;\n#include <common>')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 ckW = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          ckW = instanceMatrix * ckW;
        #endif
        vCkWorld = (modelMatrix * ckW).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', 'uniform float uTime;\nuniform float uWaterAnim;\nvarying vec3 vCkWorld;\n#include <common>')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        float ckS = sin(vCkWorld.y * 7.0 + uTime * 5.0 + sin(vCkWorld.x * 3.0 + uTime * 1.7) * 1.5);
        float ckRip = 0.5 + 0.5 * ckS;
        float ckGlow = 0.34 + uWaterAnim * 0.2 * ckRip;
        #if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
          totalEmissiveRadiance += vColor * ckGlow;
        #endif`);
  };
  mat.customProgramCacheKey = () => 'ck-water';
}

// Color-vision-safe palette overrides for gameplay-critical hues.
const PALETTES = {
  default:      {},
  deuteranopia: { water: 0x41b6ff, dirty: 0xe0a030, contam: 0xf0c040, target: 0xf0f060 },
  protanopia:   { water: 0x41b6ff, dirty: 0xd09028, contam: 0xe8c048, target: 0xe8e070 },
  tritanopia:   { water: 0x30d0c0, dirty: 0xd05040, contam: 0xd06838, target: 0x70f0a0 },
  contrast:     { water: 0x00e5ff, dirty: 0xffb000, contam: 0xffcf00, target: 0xffffff },
};

const _m4 = new THREE.Matrix4();
const _v3 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

export class BoardRenderer {
  constructor(container, settings) {
    this.container = container;
    this.settings = settings;
    this.gfxSaved = null;
    this.q = resolve({ preset: 'low' }, 'low');
    this.adaptiveScale = 1;
    this._frames = [];
    this.pixelRatio = 1;
    this.size = [0, 0];
    this.composer = null;
    this.postKey = null;
    this.postFailed = false;
    this.fps = 0;
    this.reducedMotion = !!settings.reducedMotion;
    this.palette = settings.palette || 'default';
    this.theme = getTheme('bedrock');
    this.level = null;
    this.running = false;
    this.hidden = false;

    this._sel = null;
    this._ghost = null;
    this._prevFill = null;
    this._curFill = null;
    this._alpha = 1;
    this._time = 0;
    this._shake = 0;
    this._camFrom = null;
    this._camTo = null;
    this._camT = 1;

    this._raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();

    this._buildRenderer();
    this._buildScene();
    this._buildParticles();
    this._buildMotes();
    this._bindContextRecovery();
  }

  // ------------------------------------------------------------- setup

  _buildRenderer() {
    // Canvas MSAA stays off: the MSAA option renders through a multisampled
    // target in the post chain, so anti-aliasing can change without a reload.
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = false;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(1);
    this.gpu = BoardRenderer._gpuName(this.renderer);
    const touch = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || navigator.maxTouchPoints > 0;
    this.detected = detectPreset(this.gpu, touch);
    this.renderer.domElement.id = 'game-canvas';
    this.renderer.domElement.setAttribute('aria-hidden', 'true'); // DOM mirror carries semantics
    this.container.prepend(this.renderer.domElement);
  }

  static _gpuName(r) {
    try {
      const gl = r.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) || '');
    } catch {
      return '';
    }
  }

  _buildScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 200);
    this.camera.position.set(0, 0, 30);

    // One dominant key light (a work lamp above-right) + soft hemisphere fill.
    this.key = new THREE.DirectionalLight(0xffeedd, 3.0);
    this.key.position.set(6, 10, 12);
    this.key.castShadow = false;
    this.key.shadow.mapSize.set(1024, 1024);
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    this.scene.add(this.key);
    this.scene.add(this.key.target);
    this.hemi = new THREE.HemisphereLight(0x9fb8d8, 0x2a2018, 0.9);
    this.scene.add(this.hemi);

    this.boardGroup = new THREE.Group();
    this.scene.add(this.boardGroup);
    this.envGroup = new THREE.Group();
    this.scene.add(this.envGroup);
    this.fxGroup = new THREE.Group();
    this.scene.add(this.fxGroup);
  }

  /** Image-based lighting: a PMREM-filtered room environment for PBR reflections. */
  _buildEnvMap() {
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment(this.renderer);
      this.envRT?.dispose();
      this.envRT = pmrem.fromScene(room, 0.04);
      room.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
      pmrem.dispose();
      // Underground: reflections only hint at shape, the lamp does the lighting.
      this.scene.environmentIntensity = 0.28;
    } catch {
      this.envRT = null;
    }
  }

  /** IBL is part of surface detail: plain keeps the pre-upgrade lighting cost. */
  _applyEnv() {
    if (this.q.detail === 'detailed' && !this.envRT) this._buildEnvMap();
    this.scene.environment = this.q.detail === 'detailed' && this.envRT ? this.envRT.texture : null;
  }

  _bindContextRecovery() {
    const el = this.renderer.domElement;
    el.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      if (this.onContextLost) this.onContextLost(true);
    });
    el.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      // Rebuild GPU resources from retained CPU descriptors.
      this.envRT = null;
      this._applyEnv();
      this.postKey = null;
      if (this.level) this.loadLevel(this.level, this.level.theme);
      if (this.onContextLost) this.onContextLost(false);
    });
  }

  // ------------------------------------------------------------- graphics settings

  /**
   * Apply graphics settings live. `saved` = { preset: 'auto'|preset,
   * render_scale, adaptive, show_fps, <category>: tier } (absent = from preset).
   */
  setGraphics(saved) {
    const json = JSON.stringify(saved || {});
    if (json === this._gfxJson) return;
    this._gfxJson = json;
    const prev = this.q;
    const g = resolve(saved, this.detected);
    this.q = g;
    const size = SHADOW_MAP[g.shadows];
    const shadowsChanged = this.renderer.shadowMap.enabled !== size > 0;
    this.renderer.shadowMap.enabled = size > 0;
    this.key.castShadow = size > 0;
    if (size > 0 && this.key.shadow.mapSize.x !== size) {
      this.key.shadow.mapSize.set(size, size);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    if (shadowsChanged) {
      // Materials pick up shadow-map changes on recompile.
      this.scene.traverse((o) => {
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; });
      });
    }
    const cap = PARTICLE_CAP[g.particles];
    if (cap !== this.particleCap) this._setParticleCap(cap);
    U.uDetail.value = g.detail === 'detailed' ? 1 : 0;
    this._applyEnv();
    this._applyMotion();
    this.adaptiveScale = 1;
    this._frames = [];
    this.postKey = null; // rebuild the post chain on the next frame
    this.postFailed = false;
    this._fpsVisible(g.showFps);
    this.renderer.domElement.dataset.gfxPreset = g.preset;
    // Geometry detail (bevels, textures, boulders) is baked at level build.
    if (this.level && prev && prev.detail !== g.detail) this.loadLevel(this.level, this.level.theme);
  }

  /** What the settings panel shows: GPU, auto choice, resolved tiers, cost and frame rate. */
  graphicsInfo() {
    const px = [Math.round(this.size[0] * this.pixelRatio), Math.round(this.size[1] * this.pixelRatio)];
    return {
      gpu: this.gpu || 'unknown GPU',
      detected: this.detected,
      resolved: this.q,
      pixels: px,
      summary: describe(this.q, px),
      fps: Math.round(this.fps || 0),
      adaptiveScale: Math.round(this.adaptiveScale * 100) / 100,
      postFailed: !!this.postFailed,
    };
  }

  _applyMotion() {
    const moving = !this.reducedMotion;
    U.uWaterAnim.value = this.q.water === 'animated' ? 1 : 0;
    if (this.motes) this.motes.visible = this.q.background === 'animated';
    this.timeFrozen = !moving;
  }

  _fpsVisible(on) {
    let el = document.getElementById('fps-meter');
    if (on && !el) {
      el = document.createElement('div');
      el.id = 'fps-meter';
      el.setAttribute('aria-hidden', 'true');
      el.textContent = '… fps';
      document.body.append(el);
    }
    if (el) el.hidden = !on;
  }

  _postKey(w, h) {
    const g = this.q;
    return g.post && !this.postFailed ? [g.ao, g.bloom, g.grade, g.antialias, w, h, this.pixelRatio].join('|') : 'none';
  }

  _buildPost(w, h) {
    const g = this.q;
    this.composer?.dispose();
    this.composer = null;
    if (!g.post || this.postFailed) return;
    try {
      const pr = this.pixelRatio;
      const target = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w * pr)), Math.max(1, Math.round(h * pr)), {
        type: THREE.HalfFloatType, samples: g.antialias === 'msaa' ? 4 : 0,
      });
      const composer = new EffectComposer(this.renderer, target);
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (g.ao !== 'off') {
        const ao = new GTAOPass(this.scene, this.camera, w * pr, h * pr);
        ao.output = GTAOPass.OUTPUT.Default;
        ao.blendIntensity = g.ao === 'high' ? 0.85 : 0.7;
        ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: g.ao === 'high' ? 16 : 8 });
        ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: g.ao === 'high' ? 6 : 4, rings: 2, samples: g.ao === 'high' ? 16 : 8 });
        composer.addPass(ao);
      }
      if (g.bloom === 'on') {
        // High threshold: only water, the well ring and the spring glow bloom.
        composer.addPass(new UnrealBloomPass(new THREE.Vector2(w, h), 0.6, 0.5, 0.86));
      }
      composer.addPass(new OutputPass());
      if (g.grade === 'on') composer.addPass(new ShaderPass(GradeShader));
      if (g.antialias === 'smaa') composer.addPass(new SMAAPass(w * pr, h * pr));
      if (g.antialias === 'fxaa') {
        const fxaa = new ShaderPass(FXAAShader);
        fxaa.material.uniforms.resolution.value.set(1 / (w * pr), 1 / (h * pr));
        composer.addPass(fxaa);
      }
      this.composer = composer;
    } catch {
      // Post-processing is an enhancement: render directly and say so in the panel.
      this.postFailed = true;
      this.composer = null;
    }
  }

  // Adaptive resolution: step the render scale down when frames are slow, back up when fast.
  _adapt(ms) {
    const f = this._frames;
    f.push(ms);
    if (f.length < 90) return false;
    const avg = f.reduce((a, b) => a + b, 0) / f.length;
    f.length = 0;
    this.fps = 1000 / avg;
    const el = document.getElementById('fps-meter');
    if (el && !el.hidden) el.textContent = `${Math.round(this.fps)} fps · ${Math.round(this.pixelRatio * 100) / 100}×`;
    if (!this.q.adaptive) return false;
    const before = this.adaptiveScale;
    if (avg > 26) this.adaptiveScale = Math.max(0.6, this.adaptiveScale - 0.1);
    else if (avg < 14 && this.adaptiveScale < 1) this.adaptiveScale = Math.min(1, this.adaptiveScale + 0.05);
    return before !== this.adaptiveScale;
  }

  setReducedMotion(b) { this.reducedMotion = b; this._applyMotion(); }

  setPalette(p) {
    this.palette = p;
    if (this.level) this._applyTheme(this.level.theme);
  }

  _color(key) {
    const over = this.settings.highContrast ? PALETTES.contrast : (PALETTES[this.palette] || {});
    return over[key] ?? this.theme[key];
  }

  // ------------------------------------------------------------- level build

  loadLevel(level, themeId) {
    this.level = level;
    this._applyTheme(themeId);
    this._clearBoard();

    const { w, h } = level;
    const rng = makeRng(level.seed, 'decor'); // decoration stream only
    const n = w * h;

    // -- solid cells: one instanced mesh, per-instance color --
    const detailed = this.q.detail === 'detailed';
    const cellGeo = detailed
      ? new RoundedBoxGeometry(0.94, 0.94, 0.55, 2, 0.07)
      : new THREE.BoxGeometry(0.94, 0.94, 0.55);
    this._aKind = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    cellGeo.setAttribute('aKind', this._aKind);
    const cellMat = new THREE.MeshStandardMaterial({ roughness: 0.9, metalness: 0.02 });
    if (detailed) {
      this._grain = this._grain || makeGrainTexture(128, 7, 26);
      cellMat.map = this._grain;
      cellMat.bumpMap = this._grain;
      cellMat.bumpScale = 1.2;
    }
    patchCellMaterial(cellMat);
    this.cellMesh = new THREE.InstancedMesh(cellGeo, cellMat, n);
    this.cellMesh.receiveShadow = true;
    this.cellMesh.castShadow = true;
    this.cellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boardGroup.add(this.cellMesh);

    // deterministic decoration: slight per-cell depth/tone jitter
    this._decor = new Array(n);
    for (let i = 0; i < n; i++) this._decor[i] = rng.next();

    // -- water overlay: instanced emissive boxes --
    const waterGeo = new THREE.BoxGeometry(0.8, 0.8, 0.34);
    const waterMat = new THREE.MeshPhysicalMaterial({
      color: 0x808080, // instance colour carries the hue; keep diffuse low so it stays saturated
      roughness: 0.12, metalness: 0.0, transparent: true, opacity: 0.93,
      clearcoat: 1, clearcoatRoughness: 0.08, envMapIntensity: 1.0,
    });
    patchWaterMaterial(waterMat);
    this.waterMesh = new THREE.InstancedMesh(waterGeo, waterMat, n);
    this.waterMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.waterMesh.count = n;
    this.waterMesh.raycast = () => {}; // effects never intercept raycasts
    this.waterMesh.castShadow = true;
    this.boardGroup.add(this.waterMesh);

    this._prevFill = new Array(n).fill(0);
    this._curFill = new Array(n).fill(0);
    this._prevDirty = new Array(n).fill(false);
    this._curDirty = new Array(n).fill(false);

    // -- foul-pocket spikes (shape reinforcement, not color alone) --
    const contamCount = level.cells.filter((c) => c === CELL.CONTAM).length;
    if (contamCount > 0) {
      const spikeGeo = new THREE.ConeGeometry(0.16, 0.5, 5);
      const spikeMat = new THREE.MeshStandardMaterial({
        color: this._color('contam'), roughness: 0.3, metalness: 0.2,
        emissive: this._color('contam'), emissiveIntensity: 0.35,
      });
      this.spikeMesh = new THREE.InstancedMesh(spikeGeo, spikeMat, contamCount * 3);
      this.spikeMesh.raycast = () => {};
      this.spikeMesh.castShadow = true;
      let k = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (level.cells[y * w + x] !== CELL.CONTAM) continue;
        for (let s = 0; s < 3; s++) {
          const [wx, wy] = this._cellXY(x, y);
          _v3.set(wx + (rng.next() - 0.5) * 0.5, wy + (rng.next() - 0.5) * 0.5, 0.35);
          _q.setFromEuler(new THREE.Euler((rng.next() - 0.5) * 0.7, 0, (rng.next() - 0.5) * 0.7));
          _s.setScalar(0.7 + rng.next() * 0.6);
          _m4.compose(_v3, _q, _s);
          this.spikeMesh.setMatrixAt(k++, _m4);
        }
      }
      this.boardGroup.add(this.spikeMesh);
    }

    // -- source pipe & target beacon --
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const t = level.cells[y * w + x];
      const [wx, wy] = this._cellXY(x, y);
      if (t === CELL.SOURCE) {
        const pipeMat = new THREE.MeshStandardMaterial({ color: 0x6c7682, roughness: 0.45, metalness: 0.9, envMapIntensity: 1.2 });
        const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.9, 20), pipeMat);
        pipe.position.set(wx, wy + 0.4, 0.45);
        pipe.rotation.x = Math.PI / 2.4;
        pipe.castShadow = true;
        this.boardGroup.add(pipe);
        // Flanged lip at the visible pipe end.
        const lip = new THREE.Mesh(new THREE.TorusGeometry(0.33, 0.06, 10, 28), pipeMat);
        lip.position.set(0, 0.42, 0);
        lip.rotation.x = Math.PI / 2;
        lip.raycast = () => {};
        pipe.add(lip);
        this.sourceGlow = new THREE.PointLight(this._color('water'), 6, 6);
        this.sourceGlow.position.set(wx, wy, 1.2);
        this.boardGroup.add(this.sourceGlow);
      } else if (t === CELL.TARGET) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.42, 0.08, 16, 40),
          new THREE.MeshPhysicalMaterial({
            color: this._color('target'), emissive: this._color('target'),
            emissiveIntensity: 1.25, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1,
          }));
        ring.castShadow = true;
        ring.position.set(wx, wy, 0.4);
        this.boardGroup.add(ring);
        this.targetRing = ring;
        this.targetLight = new THREE.PointLight(this._color('target'), 5, 7);
        this.targetLight.position.set(wx, wy, 1.2);
        this.boardGroup.add(this.targetLight);
      }
    }

    // -- environment: cut-face frame, floor, backdrop --
    this._buildEnvironment(rng);

    // -- selection marker (outline + grounded ring, not bloom) --
    this.selOutline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(1.02, 1.02, 0.62)),
      new THREE.LineBasicMaterial({ color: 0xffffff }));
    this.selRing = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.52, 24),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
    this.selRing.position.z = 0.42;
    this.selOutline.visible = this.selRing.visible = false;
    this.selOutline.raycast = this.selRing.raycast = () => {};
    this.fxGroup.add(this.selOutline, this.selRing);

    // -- ghost preview (legal target before commit) --
    this.ghost = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.9, 0.5),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.35, depthWrite: false }));
    this.ghost.visible = false;
    this.ghost.raycast = () => {};
    this.fxGroup.add(this.ghost);

    // invisible pick plane over the board (single raycast target)
    this.pickPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 2, h + 2),
      new THREE.MeshBasicMaterial({ visible: false }));
    this.pickPlane.position.z = 0.3;
    this.boardGroup.add(this.pickPlane);

    this._paintCells(level.cells, level.cells); // full repaint
    this._fitCamera(true);
    this.resize();

    // Prewarm shader variants before play starts.
    this.renderer.compile(this.scene, this.camera);
  }

  _applyTheme(themeId) {
    this.theme = getTheme(themeId);
    this.scene.background = _c.set(this.theme.sky).clone();
    this.scene.fog = new THREE.Fog(this.theme.fog, 30, 90);
    if (this.level) this._paintCells(this.level.cells, this.level.cells);
  }

  _clearBoard() {
    const disposeKids = (group) => {
      for (let i = group.children.length - 1; i >= 0; i--) {
        const o = group.children[i];
        group.remove(o);
        o.traverse((c) => {
          if (c.geometry) c.geometry.dispose();
          if (c.material) {
            (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => {
              if (m.map && m.map !== this._grain && m.map !== this._wallTex) m.map.dispose();
              m.dispose();
            });
          }
        });
      }
    };
    disposeKids(this.boardGroup);
    disposeKids(this.envGroup);
    disposeKids(this.fxGroup);
  }

  _buildEnvironment(rng) {
    const { w, h } = this.level;
    const detailed = this.q.detail === 'detailed';
    const detail = detailed ? 1 : 0.3;
    const wallTex = detailed ? (this._wallTex = this._wallTex || makeGrainTexture(256, 11, 40, 0.45)) : null;
    const texFor = (rx, ry) => {
      if (!wallTex) return null;
      const t = wallTex.clone();
      t.repeat.set(rx, ry);
      t.needsUpdate = true;
      return t;
    };
    // Backdrop slab behind the board — the cavern wall.
    const backMap = texFor((w + 30) / 4, (h + 30) / 4);
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(w + 30, h + 30, 1.5),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(this.theme.rock).multiplyScalar(detailed ? 0.6 : 1),
        roughness: 1, map: backMap, bumpMap: backMap, bumpScale: 2,
      }));
    back.position.set(0, 0, -1.1);
    back.receiveShadow = true;
    this.envGroup.add(back);
    // Floor.
    const floorMap = texFor((w + 30) / 5, 6);
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 30, 30),
      new THREE.MeshStandardMaterial({ color: this.theme.rock, roughness: 0.95, map: floorMap, bumpMap: floorMap, bumpScale: 2 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -h / 2 - 0.5, 6);
    floor.receiveShadow = true;
    this.envGroup.add(floor);
    // Scattered rocks / stalactites by detail tier.
    const rocks = Math.floor(14 * detail) + 4;
    const rockGeo = new THREE.DodecahedronGeometry(0.5, detailed ? 1 : 0);
    if (detailed) {
      // Lumpy boulders: displace the subdivided dodecahedron deterministically.
      const pos = rockGeo.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        _v3.fromBufferAttribute(pos, i);
        const k = 0.85 + 0.3 * (Math.sin(_v3.x * 9.1 + _v3.y * 5.3) * 0.5 + 0.5) * (Math.cos(_v3.z * 7.7) * 0.5 + 0.5);
        _v3.multiplyScalar(k);
        pos.setXYZ(i, _v3.x, _v3.y, _v3.z);
      }
      rockGeo.computeVertexNormals();
    }
    const rockMat = new THREE.MeshStandardMaterial({ color: this.theme.rock, roughness: 0.85, flatShading: true });
    const inst = new THREE.InstancedMesh(rockGeo, rockMat, rocks);
    for (let i = 0; i < rocks; i++) {
      const side = rng.chance(0.5) ? -1 : 1;
      _v3.set(side * (w / 2 + 1.5 + rng.next() * 4), (rng.next() - 0.5) * (h + 4), -0.5 + rng.next() * 2);
      _q.setFromEuler(new THREE.Euler(rng.next() * 3, rng.next() * 3, rng.next() * 3));
      _s.setScalar(0.4 + rng.next() * 1.2);
      _m4.compose(_v3, _q, _s);
      inst.setMatrixAt(i, _m4);
    }
    inst.raycast = () => {};
    inst.castShadow = true;
    inst.receiveShadow = true;
    this.envGroup.add(inst);
    this._fitShadow();
  }

  /** Shadow frustum fitted to the board plus a small margin (texel-dense). */
  _fitShadow() {
    const { w, h } = this.level;
    const ext = Math.max(w, h) / 2 + 2.5;
    const sc = this.key.shadow.camera;
    this.key.target.position.set(0, 0, 0);
    this.key.position.set(6, 10, 12).setLength(30);
    Object.assign(sc, { left: -ext - 1, right: ext + 1, top: ext + 1, bottom: -ext - 1, near: 10, far: 55 });
    sc.updateProjectionMatrix();
    this.key.target.updateMatrixWorld();
  }

  _cellXY(x, y) {
    return [x - (this.level.w - 1) / 2, (this.level.h - 1) / 2 - y];
  }

  // ------------------------------------------------------------- state sync

  /** Repaint instance colors for changed cells. */
  _paintCells(cells, prevCells) {
    if (!this.cellMesh) return;
    const { w, h } = this.level;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const t = cells[i];
        const jitter = this._decor[i];
        const [wx, wy] = this._cellXY(x, y);
        const depth = 0.9 + jitter * 0.2;
        _v3.set(wx, wy, (jitter - 0.5) * 0.08);
        _q.identity();
        _s.set(1, 1, depth);
        _m4.compose(_v3, _q, _s);
        this.cellMesh.setMatrixAt(i, _m4);
        let col;
        switch (t) {
          case CELL.ROCK: col = _c.set(this.theme.rock).offsetHSL(0, 0, (jitter - 0.5) * 0.08); break;
          case CELL.SOIL: col = _c.set(this.theme.soil).offsetHSL(0, 0, (jitter - 0.5) * 0.1); break;
          case CELL.HARD: col = _c.set(this.theme.hard).offsetHSL(0, 0, (jitter - 0.5) * 0.08); break;
          case CELL.CHANNEL: col = _c.set(this.theme.channel); break;
          case CELL.CONTAM: col = _c.set(this.theme.channel).offsetHSL(0, 0, -0.02); break;
          case CELL.SOURCE: col = _c.set(this.theme.rock); break;
          case CELL.TARGET: col = _c.set(this.theme.channel); break;
          default: col = _c.set(this.theme.soil);
        }
        this.cellMesh.setColorAt(i, col);
        if (this._aKind) this._aKind.array[i] = t === CELL.HARD ? 2 : (t === CELL.CHANNEL || t === CELL.CONTAM || t === CELL.TARGET) ? 3 : 1;
      }
    }
    if (this._aKind) this._aKind.needsUpdate = true;
    this.cellMesh.instanceMatrix.needsUpdate = true;
    if (this.cellMesh.instanceColor) this.cellMesh.instanceColor.needsUpdate = true;
  }

  /**
   * Sync from rules snapshots. prev/next are raw states; alpha in [0,1]
   * interpolates water fill for smooth motion between fixed ticks.
   */
  syncState(next, prev, alpha) {
    if (!this.level || !this.cellMesh) return;
    // Repaint solids only when cells changed (carve events).
    if (!prev || prev.cells !== next.cells) {
      let changed = !prev;
      if (prev) {
        changed = false;
        for (let i = 0; i < next.cells.length; i++) {
          if (next.cells[i] !== prev.cells[i]) { changed = true; break; }
        }
      }
      if (changed) this._paintCells(next.cells, prev ? prev.cells : null);
    }
    const n = this.level.w * this.level.h;
    for (let i = 0; i < n; i++) {
      this._prevFill[i] = prev ? prev.clean[i] + prev.dirty[i] : next.clean[i] + next.dirty[i];
      this._curFill[i] = next.clean[i] + next.dirty[i];
      this._prevDirty[i] = prev ? prev.dirty[i] > 0 : next.dirty[i] > 0;
      this._curDirty[i] = next.dirty[i] > 0;
    }
    this._alpha = alpha;
    this._paintWater();
  }

  _paintWater() {
    if (!this.waterMesh) return;
    const { w, h } = this.level;
    const clean = _c.set(this._color('water')).clone();
    const dirty = _c.set(this._color('dirty')).clone();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const f = this._prevFill[i] + (this._curFill[i] - this._prevFill[i]) * this._alpha;
        const [wx, wy] = this._cellXY(x, y);
        if (f <= 0) {
          _s.set(0.0001, 0.0001, 0.0001);
          _v3.set(wx, wy, -10);
        } else {
          const frac = Math.min(1, f / CELL_CAP);
          const sy = 0.9 * frac;
          _v3.set(wx, wy - (0.9 - sy) / 2, 0.32);
          _s.set(0.9, Math.max(0.02, sy), 1);
        }
        _q.identity();
        _m4.compose(_v3, _q, _s);
        this.waterMesh.setMatrixAt(i, _m4);
        this.waterMesh.setColorAt(i, this._curDirty[i] ? dirty : clean);
      }
    }
    this.waterMesh.instanceMatrix.needsUpdate = true;
    if (this.waterMesh.instanceColor) this.waterMesh.instanceColor.needsUpdate = true;
  }

  // ------------------------------------------------------------- feedback

  /** Spawn pooled particles + camera impulse from logical events. */
  events(list, state) {
    if (!list) return;
    for (const e of list) {
      switch (e.t) {
        case 'carve': {
          const [wx, wy] = this._cellXY(e.x, e.y);
          this._burst(wx, wy, 0.5, this.theme.soil, e.hard ? 26 : 14);
          if (e.hard) this._addShake(0.08);
          break;
        }
        case 'deliver': {
          const [wx, wy] = this._cellXY(e.x, e.y);
          this._burst(wx, wy, 0.8, this._color('water'), Math.min(10, 2 + e.clean));
          break;
        }
        case 'contaminate': {
          const [wx, wy] = this._cellXY(e.x, e.y);
          this._burst(wx, wy, 0.7, this._color('contam'), 8);
          break;
        }
        case 'release':
          this._addShake(0.12);
          break;
        case 'end':
          if (!this.reducedMotion) this._addShake(e.won ? 0.22 : 0.3);
          if (e.won && this.targetRing) {
            const [wx, wy] = [this.targetRing.position.x, this.targetRing.position.y];
            this._burst(wx, wy, 1.2, this._color('target'), 60);
          }
          break;
      }
    }
  }

  _addShake(amount) {
    if (this.reducedMotion) return;
    this._shake = Math.min(0.5, this._shake + amount);
  }

  setSelection(x, y, valid) {
    if (x == null) {
      this.selOutline.visible = this.selRing.visible = false;
      return;
    }
    const [wx, wy] = this._cellXY(x, y);
    this.selOutline.position.set(wx, wy, 0.1);
    this.selRing.position.set(wx, wy, 0.42);
    const col = valid === false ? 0xff5040 : 0xffffff;
    this.selOutline.material.color.set(col);
    this.selRing.material.color.set(col);
    this.selOutline.visible = this.selRing.visible = true;
  }

  setGhost(x, y, valid) {
    if (x == null) { this.ghost.visible = false; return; }
    const [wx, wy] = this._cellXY(x, y);
    this.ghost.position.set(wx, wy, 0.1);
    this.ghost.material.color.set(valid ? 0x50ff90 : 0xff5040);
    this.ghost.visible = true;
  }

  // ------------------------------------------------------------- picking

  /** Raycast only against the explicit pick plane; returns grid coords. */
  pick(clientX, clientY) {
    if (!this.level || !this.pickPlane) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._ndc.set(((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1);
    this._raycaster.setFromCamera(this._ndc, this.camera);
    const hit = this._raycaster.intersectObject(this.pickPlane, false)[0];
    if (!hit) return null;
    const lx = hit.point.x + (this.level.w - 1) / 2;
    const ly = (this.level.h - 1) / 2 - hit.point.y;
    const x = Math.round(lx), y = Math.round(ly);
    if (x < 0 || y < 0 || x >= this.level.w || y >= this.level.h) return null;
    return { x, y };
  }

  /** Project a cell to CSS-pixel screen coords (for DOM label alignment). */
  cellScreenPos(x, y) {
    const [wx, wy] = this._cellXY(x, y);
    _v3.set(wx, wy, 0.3).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return {
      x: rect.left + (_v3.x + 1) / 2 * rect.width,
      y: rect.top + (-_v3.y + 1) / 2 * rect.height,
    };
  }

  // ------------------------------------------------------------- camera

  _fitCamera(immediate) {
    const { w, h } = this.level;
    const margin = this.settings.cameraView === 'close' ? FRAMING.closeMargin : FRAMING.fitMargin;
    const halfFov = (FRAMING.fov / 2) * (Math.PI / 180);
    const aspect = this.camera.aspect || 1;
    const distH = (h * margin) / (2 * Math.tan(halfFov));
    const distW = (w * margin) / (2 * Math.tan(halfFov) * aspect);
    const dist = Math.max(distH, distW) + 2;
    const tilt = FRAMING.tiltDeg * (Math.PI / 180);
    const to = new THREE.Vector3(0, Math.sin(tilt) * dist * 0.35, dist);
    if (immediate || this.reducedMotion) {
      this.camera.position.copy(to);
      this.camera.lookAt(0, 0, 0);
      this._camT = 1;
      return;
    }
    this._camFrom = this.camera.position.clone();
    this._camTo = to;
    this._camT = 0;
  }

  resetCamera() { this._fitCamera(false); }

  // ------------------------------------------------------------- frame

  resize() {
    const wpx = this.container.clientWidth || 1;
    const hpx = this.container.clientHeight || 1;
    this.camera.aspect = wpx / hpx;
    this.camera.updateProjectionMatrix();
    this._applySize(wpx, hpx);
    if (this.level) this._fitCamera(true);
  }

  /** Pixel ratio = min(dpr, preset cap) × preset/user scale × adaptive scale. */
  _ratio() {
    // × UIScale: the canvas sits inside the zoomed #app, so its backing store grows with the zoom.
    const base = Math.min(window.devicePixelRatio || 1, this.q.dprCap || 2) * ((window.UIScale && UIScale.value) || 1);
    return Math.max(0.3, base * this.q.scale * this.adaptiveScale);
  }

  _applySize(wpx, hpx) {
    const ratio = this._ratio();
    if (wpx !== this.size[0] || hpx !== this.size[1] || ratio !== this.pixelRatio) {
      this.size = [wpx, hpx];
      this.pixelRatio = ratio;
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(wpx, hpx);
    }
  }

  /** Advance cosmetics + render. dt in seconds. */
  render(dt) {
    if (this.hidden || this.contextLost) return;
    this._time += dt;
    if (!this.timeFrozen) U.uTime.value += dt;
    const now = performance.now();
    const ms = this._lastFrame ? Math.min(250, now - this._lastFrame) : 16;
    this._lastFrame = now;
    const rescale = this._adapt(ms);
    const wpx = this.container.clientWidth || 1;
    const hpx = this.container.clientHeight || 1;
    if (rescale || wpx !== this.size[0] || hpx !== this.size[1] ||
        this._ratio() !== this.pixelRatio) {
      if (wpx !== this.size[0] || hpx !== this.size[1]) {
        this.camera.aspect = wpx / hpx;
        this.camera.updateProjectionMatrix();
      }
      this._applySize(wpx, hpx);
    }
    const key = this._postKey(wpx, hpx);
    if (key !== this.postKey) {
      this.postKey = key;
      this._buildPost(wpx, hpx);
    }

    // Camera transition (authored duration/easing, interruptible).
    if (this._camT < 1 && this._camFrom && this._camTo) {
      this._camT = Math.min(1, this._camT + dt / FRAMING.transitionSec);
      const t = this._camT;
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; // easeInOutCubic
      this.camera.position.lerpVectors(this._camFrom, this._camTo, e);
      this.camera.lookAt(0, 0, 0);
    }
    // Event-tiered, low-amplitude shake; never affects raycast truth
    // (applied to the camera only after picking uses the unshaken pose —
    // we simply restore it after render).
    let shakeX = 0, shakeY = 0;
    if (this._shake > 0.001) {
      shakeX = (Math.sin(this._time * 47) + Math.sin(this._time * 31)) * 0.5 * this._shake * 0.12;
      shakeY = (Math.cos(this._time * 41) + Math.sin(this._time * 29)) * 0.5 * this._shake * 0.12;
      this._shake *= Math.pow(0.001, dt); // fast decay
    }
    this.camera.position.x += shakeX;
    this.camera.position.y += shakeY;

    // Idle cosmetics (skipped entirely under reduced motion).
    if (!this.reducedMotion) {
      if (this.targetRing) {
        const p = 1 + Math.sin(this._time * 2.4) * 0.06;
        this.targetRing.scale.setScalar(p);
      }
      if (this.sourceGlow) this.sourceGlow.intensity = 5 + Math.sin(this._time * 3.1) * 1.5;
      // Lamp shimmer: a slow, subtle key-light breathing (never below readable).
      if (this.q.background === 'animated') {
        this.key.intensity = 3.0 + Math.sin(this._time * 1.3) * 0.08 + Math.sin(this._time * 3.7) * 0.04;
        this._updateMotes(dt);
      }
    }
    this._updateParticles(dt);
    if (this.composer) {
      try { this.composer.render(dt); } catch {
        this.postFailed = true; this.composer = null; this.postKey = null;
        this.renderer.render(this.scene, this.camera);
      }
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    this.camera.position.x -= shakeX;
    this.camera.position.y -= shakeY;
  }

  // ------------------------------------------------------------- particles

  _setParticleCap(cap) {
    this.particleCap = cap;
    this._pLife.fill(0);
    for (let i = 0; i < this._pLife.length; i++) this._pPos[i * 3 + 2] = -50;
    this._pHead = 0;
    this.points.geometry.attributes.position.needsUpdate = true;
  }

  /** Drifting dust motes in the lamp light (background: animated). */
  _buildMotes() {
    const n = 90;
    const rng = makeRng(99, 'decor');
    this._mPos = new Float32Array(n * 3);
    this._mSeed = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this._mPos[i * 3] = (rng.next() - 0.5) * 22;
      this._mPos[i * 3 + 1] = (rng.next() - 0.5) * 22;
      this._mPos[i * 3 + 2] = 0.8 + rng.next() * 6;
      this._mSeed[i] = rng.next() * 100;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._mPos, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({
      size: 0.06, color: 0xffe6c0, transparent: true, opacity: 0.45,
      depthWrite: false, sizeAttenuation: true, blending: THREE.AdditiveBlending,
    });
    this.motes = new THREE.Points(geo, mat);
    this.motes.frustumCulled = false;
    this.motes.raycast = () => {};
    this.motes.visible = false;
    this.scene.add(this.motes);
  }

  _updateMotes(dt) {
    if (!this.motes || !this.motes.visible) return;
    const p = this._mPos, n = this._mSeed.length, t = this._time;
    for (let i = 0; i < n; i++) {
      const s = this._mSeed[i];
      p[i * 3] += Math.sin(t * 0.3 + s) * 0.08 * dt;
      p[i * 3 + 1] += (Math.cos(t * 0.23 + s * 1.7) * 0.06 - 0.05) * dt;
      if (p[i * 3 + 1] < -11) p[i * 3 + 1] = 11;
    }
    this.motes.geometry.attributes.position.needsUpdate = true;
  }

  _buildParticles() {
    this.particleCap = PARTICLE_CAP.low;
    const cap = 2048; // hard allocation cap; active count set by tier
    this._pPos = new Float32Array(cap * 3);
    this._pVel = new Float32Array(cap * 3);
    this._pLife = new Float32Array(cap);
    this._pCol = new Float32Array(cap * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this._pPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(this._pCol, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({
      size: 0.14, vertexColors: true, transparent: true, opacity: 0.9,
      depthWrite: false, sizeAttenuation: true,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.raycast = () => {}; // cosmetic particles never intercept raycasts
    this._pHead = 0;
    this.scene.add(this.points);
  }

  _burst(wx, wy, wz, color, count) {
    if (this.reducedMotion) count = Math.min(count, 4);
    const n = Math.min(count, this.particleCap);
    _c.set(color);
    for (let k = 0; k < n; k++) {
      const i = this._pHead;
      this._pHead = (this._pHead + 1) % this.particleCap;
      this._pPos[i * 3] = wx; this._pPos[i * 3 + 1] = wy; this._pPos[i * 3 + 2] = wz;
      const a = Math.random() * Math.PI * 2;
      const sp = 1 + Math.random() * 3;
      this._pVel[i * 3] = Math.cos(a) * sp;
      this._pVel[i * 3 + 1] = Math.sin(a) * sp + 1.5;
      this._pVel[i * 3 + 2] = 0.5 + Math.random() * 1.5;
      this._pLife[i] = 0.5 + Math.random() * 0.5;
      this._pCol[i * 3] = _c.r; this._pCol[i * 3 + 1] = _c.g; this._pCol[i * 3 + 2] = _c.b;
    }
  }

  _updateParticles(dt) {
    const pos = this.points.geometry.attributes.position;
    let any = false;
    for (let i = 0; i < this.particleCap; i++) {
      if (this._pLife[i] <= 0) continue;
      any = true;
      this._pLife[i] -= dt;
      this._pVel[i * 3 + 1] -= 6 * dt; // gravity
      this._pPos[i * 3] += this._pVel[i * 3] * dt;
      this._pPos[i * 3 + 1] += this._pVel[i * 3 + 1] * dt;
      this._pPos[i * 3 + 2] += this._pVel[i * 3 + 2] * dt;
      if (this._pLife[i] <= 0) this._pPos[i * 3 + 2] = -50; // park dead particles
    }
    if (any) {
      pos.needsUpdate = true;
      this.points.geometry.attributes.color.needsUpdate = true;
    }
  }

  setHidden(hidden) {
    this.hidden = hidden;
  }

  dispose() {
    this._clearBoard();
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.composer?.dispose();
    this.envRT?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
