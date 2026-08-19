// Channel Keeper — Three.js renderer.
// Subterranean cross-section: an authored cut-face of soil, rock, clay,
// foul pockets, pipes, and glowing water. Rendering consumes immutable
// snapshots plus an interpolation alpha; it never touches rules state.

import * as THREE from 'three';
import { CELL, CELL_CAP } from './rules.js';
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

const QUALITY_TIERS = {
  low:    { dpr: 1.0, shadows: false, particles: 300,  antialias: false, envDetail: 0.3 },
  medium: { dpr: 1.5, shadows: false, particles: 800,  antialias: true,  envDetail: 0.6 },
  high:   { dpr: 2.0, shadows: true,  particles: 2000, antialias: true,  envDetail: 1.0 },
};

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
    this.quality = 'medium';
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
    this._bindContextRecovery();
  }

  // ------------------------------------------------------------- setup

  _buildRenderer() {
    const tier = QUALITY_TIERS[this.quality];
    this.renderer = new THREE.WebGLRenderer({
      antialias: tier.antialias,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = tier.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.dpr));
    this.renderer.domElement.id = 'game-canvas';
    this.renderer.domElement.setAttribute('aria-hidden', 'true'); // DOM mirror carries semantics
    this.container.prepend(this.renderer.domElement);
  }

  _buildScene() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FRAMING.fov, 1, 0.1, 200);
    this.camera.position.set(0, 0, 30);

    // One dominant key light + soft hemisphere fill (PBR, tone mapped).
    this.key = new THREE.DirectionalLight(0xfff2e0, 3.2);
    this.key.position.set(6, 10, 12);
    this.key.castShadow = QUALITY_TIERS[this.quality].shadows;
    this.key.shadow.mapSize.set(1024, 1024);
    this.scene.add(this.key);
    this.hemi = new THREE.HemisphereLight(0x9fb8d8, 0x2a2018, 1.1);
    this.scene.add(this.hemi);

    this.boardGroup = new THREE.Group();
    this.scene.add(this.boardGroup);
    this.envGroup = new THREE.Group();
    this.scene.add(this.envGroup);
    this.fxGroup = new THREE.Group();
    this.scene.add(this.fxGroup);
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
      if (this.level) this.loadLevel(this.level, this.level.theme);
      if (this.onContextLost) this.onContextLost(false);
    });
  }

  setQuality(q) {
    if (!QUALITY_TIERS[q]) return;
    this.quality = q;
    const tier = QUALITY_TIERS[q];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, tier.dpr));
    this.renderer.shadowMap.enabled = tier.shadows;
    this.key.castShadow = tier.shadows;
    this.particleCap = tier.particles;
    if (this.level) this.loadLevel(this.level, this.level.theme);
  }

  setReducedMotion(b) { this.reducedMotion = b; }

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
    const cellGeo = new THREE.BoxGeometry(0.94, 0.94, 0.55);
    const cellMat = new THREE.MeshStandardMaterial({ roughness: 0.93, metalness: 0.02 });
    this.cellMesh = new THREE.InstancedMesh(cellGeo, cellMat, n);
    this.cellMesh.receiveShadow = true;
    this.cellMesh.castShadow = QUALITY_TIERS[this.quality].shadows;
    this.cellMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boardGroup.add(this.cellMesh);

    // deterministic decoration: slight per-cell depth/tone jitter
    this._decor = new Array(n);
    for (let i = 0; i < n; i++) this._decor[i] = rng.next();

    // -- water overlay: instanced emissive boxes --
    const waterGeo = new THREE.BoxGeometry(0.8, 0.8, 0.34);
    const waterMat = new THREE.MeshStandardMaterial({
      roughness: 0.15, metalness: 0.0, transparent: true, opacity: 0.92,
      emissiveIntensity: 1.4,
    });
    this.waterMesh = new THREE.InstancedMesh(waterGeo, waterMat, n);
    this.waterMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.waterMesh.count = n;
    this.waterMesh.raycast = () => {}; // effects never intercept raycasts
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
        color: this._color('contam'), roughness: 0.4,
        emissive: this._color('contam'), emissiveIntensity: 0.35,
      });
      this.spikeMesh = new THREE.InstancedMesh(spikeGeo, spikeMat, contamCount * 3);
      this.spikeMesh.raycast = () => {};
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
        const pipe = new THREE.Mesh(
          new THREE.CylinderGeometry(0.3, 0.34, 0.9, 12),
          new THREE.MeshStandardMaterial({ color: 0x707a88, roughness: 0.5, metalness: 0.7 }));
        pipe.position.set(wx, wy + 0.4, 0.45);
        pipe.rotation.x = Math.PI / 2.4;
        this.boardGroup.add(pipe);
        this.sourceGlow = new THREE.PointLight(this._color('water'), 6, 6);
        this.sourceGlow.position.set(wx, wy, 1.2);
        this.boardGroup.add(this.sourceGlow);
      } else if (t === CELL.TARGET) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.42, 0.08, 10, 28),
          new THREE.MeshStandardMaterial({
            color: this._color('target'), emissive: this._color('target'),
            emissiveIntensity: 0.9, roughness: 0.3,
          }));
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
        if (o.geometry) o.geometry.dispose();
        if (o.material) {
          (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
        }
      }
    };
    disposeKids(this.boardGroup);
    disposeKids(this.envGroup);
    disposeKids(this.fxGroup);
  }

  _buildEnvironment(rng) {
    const { w, h } = this.level;
    const detail = QUALITY_TIERS[this.quality].envDetail;
    // Backdrop slab behind the board — the cavern wall.
    const back = new THREE.Mesh(
      new THREE.BoxGeometry(w + 6, h + 6, 1.5),
      new THREE.MeshStandardMaterial({ color: this.theme.rock, roughness: 1 }));
    back.position.set(0, 0, -1.1);
    back.receiveShadow = true;
    this.envGroup.add(back);
    // Floor.
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(w + 30, 30),
      new THREE.MeshStandardMaterial({ color: this.theme.rock, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(0, -h / 2 - 0.5, 6);
    floor.receiveShadow = true;
    this.envGroup.add(floor);
    // Scattered rocks / stalactites by detail tier.
    const rocks = Math.floor(14 * detail) + 4;
    const rockGeo = new THREE.DodecahedronGeometry(0.5, 0);
    const rockMat = new THREE.MeshStandardMaterial({ color: this.theme.rock, roughness: 0.95 });
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
    this.envGroup.add(inst);
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
      }
    }
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
    this.renderer.setSize(wpx, hpx);
    if (this.level) this._fitCamera(true);
  }

  /** Advance cosmetics + render. dt in seconds. */
  render(dt) {
    if (this.hidden || this.contextLost) return;
    this._time += dt;

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
    }
    this._updateParticles(dt);
    this.renderer.render(this.scene, this.camera);
    this.camera.position.x -= shakeX;
    this.camera.position.y -= shakeY;
  }

  // ------------------------------------------------------------- particles

  _buildParticles() {
    this.particleCap = QUALITY_TIERS[this.quality].particles;
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
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
