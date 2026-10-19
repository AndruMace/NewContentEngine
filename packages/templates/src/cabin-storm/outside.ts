/**
 * The storm outside the windows: a cloud deck lit by lightning, layers of swaying pines, rain or
 * snow at three depths, the ground, and the bolt itself for the strong strikes. Everything is a
 * function of t (loop-periodic) and the current flash.
 */
import { THREE } from '../three-layer';
import { BASIC_VERT, FBM4, HASH, NOISE4 } from '../ambient/glsl';
import { perLoop, timeCircle } from '../ambient/loop';
import { BACK } from './layout';

const SKY_Z = -45;

const SKY_FRAG = /* glsl */ `
${NOISE4}
${FBM4}
varying vec2 vUv;
varying vec3 vWorld;
uniform vec2 uT;
uniform float uFlash;
uniform float uBoltX;
uniform float uStorm;
void main() {
  vec2 p = vWorld.xy * vec2(0.035, 0.05);
  float cloud = fbm4(vec4(p, uT * 0.08), 5) * 0.5 + 0.5;
  float dense = smoothstep(0.3, 0.75, cloud);
  float h = clamp(vWorld.y / 30.0, 0.0, 1.0);
  vec3 col = mix(vec3(0.020, 0.026, 0.040), vec3(0.008, 0.010, 0.018), h);
  col += vec3(0.020, 0.024, 0.034) * dense * (0.6 + 0.4 * uStorm);
  // Lightning lights the cloud base from inside: brightest near the bolt, through the dense parts.
  float near = exp(-pow((vWorld.x - uBoltX) / 28.0, 2.0));
  col += vec3(0.30, 0.33, 0.45) * uFlash * (0.2 + 0.8 * dense) * (0.3 + 0.7 * near) * (1.0 - 0.5 * h);
  gl_FragColor = vec4(col, 1.0);
}
`;

const TREES_VERT = /* glsl */ `
varying vec2 vUv;
uniform vec2 uSway;
uniform float uAmp;
void main() {
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  // Treetops lean with the wind (two gust phases, whole cycles per loop), trunks stay put.
  float bend = uv.y * uv.y;
  w.x += uAmp * bend * (0.6 * sin(uSway.x + w.x * 0.35) + 0.4 * sin(uSway.y + w.x * 0.9));
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const TREES_FRAG = /* glsl */ `
varying vec2 vUv;
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uFlash;
void main() {
  vec4 t = texture2D(uMap, vUv);
  if (t.a < 0.5) discard;
  // Silhouettes, just catching the flash on their edges.
  vec3 col = uColor + vec3(0.12, 0.13, 0.16) * uFlash * (0.3 + 0.7 * t.r);
  gl_FragColor = vec4(col, 1.0);
}
`;

const RAIN_FRAG = /* glsl */ `
${HASH}
varying vec2 vUv;
uniform float uPhase;   // t / loopS
uniform float uLoop;    // loopS
uniform float uSpeed;   // sheet heights per second
uniform float uDensity;
uniform float uFlash;
uniform float uSnow;
uniform vec2 uScale;
uniform vec3 uTint;
void main() {
  vec2 p = vUv * uScale;
  float acc = 0.0;
  for (int layer = 0; layer < 3; layer++) {
    float fl = float(layer);
    float cols = 1.0 + fl * 0.6;
    float cx = floor(p.x * cols);
    float r = hash12(vec2(cx, fl * 13.0));
    if (r > uDensity) continue;
    // Each column falls a whole number of sheet heights per loop, so the pattern loops.
    float cycles = floor(uSpeed * (0.8 + 0.4 * r) * uLoop + 0.5);
    float y = p.y + fract(cycles * uPhase) * uScale.y + hash12(vec2(cx, fl + 5.0)) * 7.0;
    float fx = fract(p.x * cols) - 0.5;
    if (uSnow > 0.5) {
      // Many small flakes per column, each drifting side to side; sizes in cell units, chosen so a
      // flake is a couple of centimetres across on the nearest sheet.
      float yy = y * 10.0;
      float id = floor(yy);
      float h = hash12(vec2(cx * 3.1 + fl, id));
      if (h > 0.55) continue;
      float wx = fx + (h - 0.27) * 0.9 + 0.18 * sin(6.2831 * (yy * 0.15 + r * 5.0));
      float d = length(vec2(wx / 0.12, (fract(yy) - 0.5) / 0.05));
      acc += smoothstep(1.0, 0.2, d) * 0.8;
    } else {
      float len = 0.08 + 0.1 * r;
      float fy = fract(y);
      acc += smoothstep(0.07, 0.0, abs(fx)) * smoothstep(0.0, 0.02, fy) * smoothstep(len, 0.02, fy) * 0.55;
    }
  }
  // Snowflakes are white and catch the room's light: much brighter than rain streaks.
  vec3 col = (uTint * (uSnow > 0.5 ? 3.0 : 1.0) + vec3(0.35, 0.38, 0.48) * uFlash) * acc;
  gl_FragColor = vec4(col, 1.0);
}
`;

const BOLT_FRAG = /* glsl */ `
varying vec2 vUv;
uniform float uBright;
void main() {
  float core = smoothstep(1.0, 0.0, abs(vUv.x - 0.5) * 2.0);
  gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * core * core * uBright, 1.0);
}
`;

/** Pine silhouettes drawn into a canvas (white where there are trees: red channel = edge light). */
/**
 * No canvas filters here: a blur filter makes every fill its own GPU pass, and thousands of them
 * (one per branch tuft) hung the GPU. Far layers are drawn smaller instead (softer when stretched).
 */
function treeTexture(seed: number, count: number, minH: number, maxH: number, res: number) {
  const W = Math.round(2048 * res);
  const H = Math.round(512 * res);
  const c = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: W, height: H }) : new OffscreenCanvas(W, H);
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  let s = seed;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  g.fillStyle = '#fff';
  // The base runs off the bottom (into the ground).
  g.fillRect(0, H - 6 * res, W, 6 * res);
  for (let i = 0; i < count; i++) {
    const x = rnd() * W;
    const h = (minH + rnd() * (maxH - minH)) * H;
    const w = h * (0.24 + rnd() * 0.12);
    // A spruce: drooping branches down the trunk, wider towards the bottom, each with a smooth top
    // edge and needles hanging off its underside (a zigzag), so the outline is ragged, not stepped.
    // Bigger trees get more, finer branches.
    const branches = Math.round(30 + 70 * (h / H));
    for (let k = 0; k < branches; k++) {
      const f = rnd();
      const y = H - h + h * 0.05 + f * h * 0.9;
      const reach = (w / 2) * (0.12 + 0.88 * Math.pow(f, 0.85)) * (0.55 + rnd() * 0.6);
      const side = rnd() < 0.5 ? -1 : 1;
      const droop = h * (0.012 + rnd() * 0.03);
      const thick = Math.max(1, h * (0.004 + rnd() * 0.006));
      const needles = 6 + Math.floor(rnd() * 6);
      g.beginPath();
      g.moveTo(x, y - thick);
      g.quadraticCurveTo(x + side * reach * 0.55, y - thick, x + side * reach, y + droop);
      for (let n = needles; n >= 0; n--) {
        const u = n / needles;
        const px = x + side * reach * u;
        const py = y + droop * u * u + thick;
        g.lineTo(px, py + (n % 2 ? h * (0.008 + rnd() * 0.012) : 0));
      }
      g.closePath();
      g.fill();
    }
    g.fillRect(x - w * 0.015, H - h, w * 0.03, h);
    // A pointed top.
    g.beginPath();
    g.moveTo(x, H - h);
    g.lineTo(x + w * 0.05, H - h + h * 0.1);
    g.lineTo(x - w * 0.05, H - h + h * 0.1);
    g.closePath();
    g.fill();
  }
  const tex = new THREE.CanvasTexture(c as HTMLCanvasElement);
  tex.wrapS = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  return tex;
}

/** A jagged bolt from the cloud base to the ground, with a couple of branches, as camera-facing ribbons. */
function boltGeometry(seed: number, x0: number) {
  let s = seed * 9973 + 17;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const strokes: THREE.Vector3[][] = [];
  const walk = (from: THREE.Vector3, toY: number, spread: number, steps: number) => {
    const pts = [from.clone()];
    const p = from.clone();
    for (let i = 0; i < steps && p.y > toY; i++) {
      p.x += (rnd() - 0.5) * spread;
      p.y -= ((from.y - toY) / steps) * (0.6 + rnd() * 0.8);
      pts.push(p.clone());
    }
    return pts;
  };
  const main = walk(new THREE.Vector3(x0, 30, SKY_Z + 1), 0, 3.2, 26);
  strokes.push(main);
  for (let b = 0; b < 3; b++) {
    const at = main[3 + Math.floor(rnd() * (main.length - 8))];
    strokes.push(walk(at, at.y - 6 - rnd() * 8, 2.6, 8));
  }
  const pos: number[] = [];
  const uv: number[] = [];
  strokes.forEach((pts, k) => {
    const w = k === 0 ? 0.35 : 0.16;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const d = new THREE.Vector3().subVectors(b, a);
      const n = new THREE.Vector3(-d.y, d.x, 0).normalize().multiplyScalar(w);
      const quad = [a.clone().add(n), a.clone().sub(n), b.clone().add(n), b.clone().sub(n)];
      for (const idx of [0, 1, 2, 2, 1, 3]) pos.push(quad[idx].x, quad[idx].y, quad[idx].z);
      for (const u of [0, 1, 0, 0, 1, 1]) uv.push(u, 0);
    }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

export interface Outside {
  group: THREE.Group;
  /** Where a strike's bolt stands (x at the sky), seen through the left or right window. */
  boltX(strikeX: number): number;
  update(o: { t: number; L: number; flash: number; strike: number; strikeX: number; boltVisible: boolean; storm: number; snow: boolean }): void;
}

export function buildOutside(): Outside {
  const group = new THREE.Group();
  const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending } as const;

  const skyU = { uT: { value: new THREE.Vector2() }, uFlash: { value: 0 }, uBoltX: { value: 0 }, uStorm: { value: 0.6 } };
  const sky = new THREE.Mesh(new THREE.PlaneGeometry(160, 70), new THREE.ShaderMaterial({ vertexShader: BASIC_VERT, fragmentShader: SKY_FRAG, uniforms: skyU }));
  sky.position.set(0, 18, SKY_Z);
  group.add(sky);

  const groundMat = new THREE.MeshStandardMaterial({ color: 0x0a0c0e, roughness: 1 });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 60), groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(0, -0.35, BACK - 30);
  ground.receiveShadow = true;
  group.add(ground);

  // Pines: far, middle and near layers (nearer = darker, taller, sways more).
  const treeLayers = [
    { z: -38, w: 150, h: 18, color: [0.028, 0.034, 0.046], seed: 3, n: 60, amp: 0.15 },
    { z: -24, w: 100, h: 14, color: [0.016, 0.02, 0.026], seed: 5, n: 34, amp: 0.25 },
    { z: -12, w: 60, h: 11, color: [0.007, 0.008, 0.01], seed: 8, n: 14, amp: 0.4 },
  ];
  const treeUs = treeLayers.map((l, i) => {
    const u = { uMap: { value: treeTexture(l.seed, l.n, 0.55, 1.0, [0.5, 0.75, 1][i]) }, uColor: { value: new THREE.Color(...l.color) }, uFlash: { value: 0 }, uSway: { value: new THREE.Vector2() }, uAmp: { value: l.amp } };
    const geo = new THREE.PlaneGeometry(l.w, l.h, 64, 8);
    const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({ vertexShader: TREES_VERT, fragmentShader: TREES_FRAG, uniforms: u }));
    m.position.set(0, l.h / 2 - 0.4, l.z);
    group.add(m);
    return u;
  });

  // Rain (or snow) sheets at three depths, just outside the glass, mid-distance and far.
  // Fall speeds in sheet heights per second (rain ~9 m/s; snow ~1 m/s).
  const rainSheets = [
    { z: BACK - 0.6, w: 12, h: 4.5, scale: [90, 1.3], tint: [0.04, 0.036, 0.032], rain: 2.0, snow: 0.22 },
    { z: BACK - 5, w: 26, h: 10, scale: [110, 3], tint: [0.03, 0.033, 0.04], rain: 0.9, snow: 0.1 },
    { z: BACK - 14, w: 50, h: 20, scale: [120, 6], tint: [0.022, 0.025, 0.032], rain: 0.45, snow: 0.05 },
  ];
  const rainMats = rainSheets.map((r) => {
    const u = {
      uPhase: { value: 0 },
      uLoop: { value: 1 },
      uSpeed: { value: r.rain },
      uDensity: { value: 0.6 },
      uFlash: { value: 0 },
      uSnow: { value: 0 },
      uScale: { value: new THREE.Vector2(...r.scale) },
      uTint: { value: new THREE.Vector3(...r.tint) },
    };
    const mat = new THREE.ShaderMaterial({ vertexShader: BASIC_VERT, fragmentShader: RAIN_FRAG, uniforms: u, ...additive });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(r.w, r.h), mat);
    m.position.set(0, r.h / 2 - 0.2, r.z);
    m.renderOrder = 1;
    group.add(m);
    return { u, sheet: r };
  });

  const boltU = { uBright: { value: 0 } };
  const boltMat = new THREE.ShaderMaterial({ vertexShader: BASIC_VERT, fragmentShader: BOLT_FRAG, uniforms: boltU, ...additive, side: THREE.DoubleSide });
  const bolt = new THREE.Mesh(new THREE.BufferGeometry(), boltMat);
  bolt.visible = false;
  group.add(bolt);
  let boltFor = -1;

  const boltX = (sx: number) => (sx < 0.5 ? -22 + (sx / 0.5) * 11 : 11 + ((sx - 0.5) / 0.5) * 11);

  return {
    group,
    boltX,
    update({ t, L, flash, strike, strikeX, boltVisible, storm, snow }) {
      // Snow lies on the ground (it catches what little light there is).
      groundMat.color.setHex(snow ? 0x262b33 : 0x0a0c0e);
      const tc = timeCircle(t, L, 0.6);
      (skyU.uT.value as THREE.Vector2).set(tc[0], tc[1]);
      skyU.uFlash.value = flash;
      skyU.uStorm.value = storm;
      if (strike >= 0) skyU.uBoltX.value = boltX(strikeX);
      const gust = (0.6 + 0.8 * storm) * (0.75 + 0.25 * Math.sin(2 * Math.PI * perLoop(1 / 37, L) * t));
      treeUs.forEach((u, i) => {
        (u.uSway.value as THREE.Vector2).set((2 * Math.PI * perLoop(0.21, L) * t) % (2 * Math.PI), (2 * Math.PI * perLoop(0.47, L) * t) % (2 * Math.PI));
        u.uFlash.value = flash;
        u.uAmp.value = treeLayers[i].amp * gust;
      });
      rainMats.forEach((r) => {
        r.u.uPhase.value = t / L;
        r.u.uLoop.value = L;
        r.u.uSpeed.value = snow ? r.sheet.snow : r.sheet.rain;
        r.u.uDensity.value = 0.25 + 0.7 * storm;
        r.u.uFlash.value = flash;
        r.u.uSnow.value = snow ? 1 : 0;
      });
      if (boltVisible && strike >= 0) {
        if (boltFor !== strike) {
          bolt.geometry.dispose();
          bolt.geometry = boltGeometry(strike + 1, boltX(strikeX));
          boltFor = strike;
        }
        bolt.visible = flash > 0.05;
        boltU.uBright.value = Math.min(1.6, flash * 3);
      } else bolt.visible = false;
    },
  };
}
