/**
 * Trees: round broadleaves, tall poplars and dark pines, in woods, along the hedgerows and alone in
 * the fields. Each kind is built once (canopies of soft noise-dented lobes) and instanced in three
 * bands out from the line, each band a window W metres long that divides the ring: an instance keeps
 * a slot in its window and comes round again on each pass as a new tree (its place jittered, its
 * size, turn and colour new, there or not by the woods and hedges where it now stands). The GPU does
 * all of it, and sits each tree on the land, so nothing is done per tree per frame.
 *
 * A band's window is wider than the view at its far edge, so trees only change out of sight.
 */
import { THREE, gpuPass } from '../three-layer';
import { MAX_FAR, MAX_NEAR, MAX_VIL, WORLD, type WorldUniforms } from './world';

/** Bands out from the line: window (m, divides the ring), cell size along and out, distance out. */
export const BANDS = [
  { W: 600, cell: 12, d0: 45, d1: 261, lod: 2 },
  { W: 1200, cell: 20, d0: 261, d1: 561, lod: 1 },
  { W: 4800, cell: 40, d0: 561, d1: 2321, lod: 0 },
] as const;
const cellsOf = (b: (typeof BANDS)[number]) => ({ cols: b.W / b.cell, rows: Math.floor((b.d1 - b.d0) / b.cell) });
/** The first slot's seed in each band (slots are numbered row by row, from 1). */
export const SEED_BASE = BANDS.map((_, i) => 1 + BANDS.slice(0, i).reduce((n, b) => n + cellsOf(b).cols * cellsOf(b).rows, 0));

type Kind = 'round' | 'poplar' | 'pine';
const KINDS: Kind[] = ['round', 'poplar', 'pine'];
/** A slot's kind of tree, for good: three in four broadleaves (an exact pattern the shaders share). */
const kindOf = (seed: number): number => {
  const m = (seed * 7) % 20;
  return m < 15 ? 0 : m < 18 ? 1 : 2;
};

/**
 * The tree in a band's slot on this pass (shared by the trees and the shadows they cast on the
 * ground): its ring position, distance out, height (0: no tree here this pass) and kind; and its
 * turn and own green from the pass's hashes.
 */
export const TREE_AT = /* glsl */ `
float treeKind(float seed) { float m = mod(seed * 7.0, 20.0); return m < 15.0 ? 0.0 : m < 18.0 ? 1.0 : 2.0; }
vec4 treeAt(vec3 inst, float W, float cell, out float turn, out float tint) {
  float rel = mod(inst.x - uS + 0.5 * W, W) - 0.5 * W;
  float pass = mod(floor((uS - inst.x + 0.5 * W) / W), uD / W);
  float h1 = hash12(vec2(inst.z, pass));
  float h2 = hash12(vec2(inst.z + 3.1, pass));
  float h3 = hash12(vec2(inst.z + 7.7, pass));
  float h4 = hash12(vec2(inst.z + 11.3, pass));
  turn = h1 * 6.28318;
  tint = hash12(vec2(inst.z + 19.0, pass));
  float relp = rel + (h1 - 0.5) * cell * 0.9;
  float p = uS + relp;
  float d = inst.y + (h2 - 0.5) * cell * 0.9;
  // There or not: woods, hedgerows, the odd tree alone in a field; never on the line, in a town on
  // its hill, in a river, by a station or on a village's houses.
  float hedge;
  fieldAt(p, d, hedge);
  float wd = woods(p, d);
  float keep = max(wd * 0.93, hedge * 0.45) + 0.035;
  for (int i = 0; i < ${MAX_FAR}; i++) {
    vec4 f = uFar[i];
    if (f.x < 0.5) continue;
    if (f.x < 1.5) keep *= smoothstep(f.w * 0.3, f.w * 0.45, length(vec2(relp - f.y, d - f.z)));
    else keep *= smoothstep(0.0, 1.0, abs(relp - riverAlong(f, uFar2[i], d)) / (f.w + d * 0.1) - 0.4);
  }
  for (int i = 0; i < ${MAX_NEAR}; i++) {
    vec4 f = uNear[i];
    if (f.x < 0.5) continue;
    float m = smoothstep(f.y - 60.0, f.y, relp) * (1.0 - smoothstep(f.z, f.z + 60.0, relp));
    keep *= 1.0 - m * smoothstep(90.0, 40.0, d);
  }
  for (int i = 0; i < ${MAX_VIL}; i++) {
    vec4 f = uVil[i];
    if (f.z < 0.0) continue;
    keep *= mix(0.12, 1.0, smoothstep(f.z * 0.7, f.z, length(vec2(relp - f.x, d - f.y))));
  }
  // Fade out at the window's ends (out of sight anyway).
  float there = step(h3, keep) * smoothstep(0.5 * W, 0.46 * W, abs(rel));
  float kind = treeKind(inst.z);
  // Size: broadleaves 9-17 m, poplars 17-25 m, pines 11-21 m; woodland trees a little taller.
  float H = kind < 0.5 ? mix(9.0, 17.0, h4) : kind < 1.5 ? mix(17.0, 25.0, h4) : mix(11.0, 21.0, h4);
  return vec4(p, d, H * (1.0 + 0.15 * wd) * there, kind);
}
`;

/** Instances per row of a band's state texture (two texels each). */
export const STATE_ROW = 128;

/**
 * Where each slot's tree stands this frame, worked out once per tree (not once per vertex): a band's
 * state texture has two texels per slot, (ring position, distance out, height, ground height) and
 * (kind, turn, tint, -), slots in cell order (row by row). The trees and their shadows read it.
 */
const STATE_FRAG = /* glsl */ `
${WORLD}
${TREE_AT}
uniform float uW;
uniform float uCell;
uniform float uD0;
uniform float uCols;
uniform float uCount;
uniform float uSeed0;
void main() {
  vec2 px = floor(gl_FragCoord.xy);
  float idx = px.y * ${STATE_ROW}.0 + floor(px.x / 2.0);
  if (idx >= uCount) { gl_FragColor = vec4(0.0); return; }
  float c = mod(idx, uCols);
  float r = floor(idx / uCols);
  float turn, tint;
  vec4 t = treeAt(vec3((c + 0.5) * uCell, uD0 + (r + 0.5) * uCell, uSeed0 + idx), uW, uCell, turn, tint);
  if (mod(px.x, 2.0) < 0.5) gl_FragColor = vec4(t.xyz, t.z > 0.0 ? landY(t.x, t.y) : 0.0);
  else gl_FragColor = vec4(t.w, turn, tint, 0.0);
}
`;

/** Reads slot idx's two texels from a band's state texture (texture height uStateH). */
export const STATE_READ = /* glsl */ `
void readTree(sampler2D tex, float h, float idx, out vec4 s0, out vec4 s1) {
  vec2 uv = vec2(mod(idx, ${STATE_ROW}.0) * 2.0 + 0.5, floor(idx / ${STATE_ROW}.0) + 0.5) / vec2(${STATE_ROW * 2}.0, h);
  s0 = texture2D(tex, uv);
  s1 = texture2D(tex, uv + vec2(1.0 / ${STATE_ROW * 2}.0, 0.0));
}
`;

const TREE_VERT = /* glsl */ `
${WORLD}
${STATE_READ}
attribute float aIndex;  // the slot (cell order in its band)
attribute float aAO;     // 0 deep inside / below the canopy .. 1 its sunlit outside
attribute float aLeaf;   // 0 trunk, 1 foliage
uniform sampler2D uState;
uniform float uStateH;
uniform float uSeed0;
uniform float uWind;     // sway phase
varying vec3 vWorld;
varying vec3 vNormal;
varying float vAO;
varying float vLeaf;
varying vec3 vTint;
varying vec3 vLocal;

void main() {
  vec4 s0, s1;
  readTree(uState, uStateH, aIndex, s0, s1);
  float p = s0.x;
  float d = s0.y;
  float H = s0.z;
  float kind = s1.x;
  float a = s1.y;
  float t = s1.z;
  float seed = uSeed0 + aIndex;
  // No tree in this slot this pass: nothing to draw.
  if (H <= 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vWorld = vec3(0.0);
    vNormal = vec3(0.0, 1.0, 0.0);
    vAO = 0.0;
    vLeaf = 0.0;
    vTint = vec3(0.0);
    vLocal = vec3(0.0);
    return;
  }
  vec3 q = position * H;
  q.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * q.xz;
  // The canopy sways a little in the wind.
  q.x += aLeaf * 0.012 * H * position.y * sin(uWind + seed * 3.7);
  vec3 n = normal;
  n.xz = mat2(cos(a), -sin(a), sin(a), cos(a)) * n.xz;
  float y = s0.w - 0.3;
  vec4 w = modelMatrix * vec4(worldX(p) + q.x, y + q.y, TRACK_Z - d + q.z, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(vec3(uDir * n.x, n.y, -n.z));
  vAO = aAO;
  vLeaf = aLeaf;
  vLocal = position * 9.0 + seed;
  // Each tree its own green.
  vTint = kind > 1.5 ? mix(vec3(0.05, 0.13, 0.07), vec3(0.08, 0.18, 0.08), t)
        : kind > 0.5 ? mix(vec3(0.13, 0.25, 0.06), vec3(0.2, 0.32, 0.07), t)
        : mix(mix(vec3(0.09, 0.21, 0.04), vec3(0.2, 0.33, 0.06), t), vec3(0.32, 0.36, 0.08), step(0.93, t) * 0.6);
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const TREE_FRAG = /* glsl */ `
${WORLD}
varying vec3 vWorld;
varying vec3 vNormal;
varying float vAO;
varying float vLeaf;
varying vec3 vTint;
varying vec3 vLocal;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vWorld - uEye);
  if (dot(n, v) > 0.0) n = -n;
  // Clumps of leaves: lighter and darker dabs across the crown.
  float dab = snoise(vec4(vLocal, 0.0)) * 0.6 + snoise(vec4(vLocal * 2.3, 5.0)) * 0.4;
  vec3 albedo = vLeaf > 0.5 ? vTint * (0.85 + 0.3 * dab) : vec3(0.18, 0.13, 0.09);
  float ao = mix(0.45, 1.0, vAO);
  vec3 c = lit(albedo, n, mix(0.55, 1.0, vAO), ao);
  // Sunlight through the leaves when the tree is against the sun: a glowing edge.
  float back = pow(max(dot(v, uSunDir), 0.0), 3.0) * pow(1.0 - abs(dot(n, v)), 2.0);
  c += albedo * uSunCol * back * 0.9 * vLeaf * (1.0 - uRain);
  gl_FragColor = vec4(hazed(c, vWorld), 1.0);
}
`;

interface Part {
  g: THREE.BufferGeometry;
  ao: (p: THREE.Vector3, n: THREE.Vector3) => number;
  leaf: number;
  /** Soft normals (round from a lobe's centre), for a painted look rather than facets. */
  centre?: THREE.Vector3;
}

function merge(parts: Part[]) {
  const pos: number[] = [];
  const nor: number[] = [];
  const ao: number[] = [];
  const leaf: number[] = [];
  const v = new THREE.Vector3();
  const n = new THREE.Vector3();
  for (const part of parts) {
    part.g.computeVertexNormals();
    const g = part.g.index ? part.g.toNonIndexed() : part.g;
    const P = g.getAttribute('position');
    const N = g.getAttribute('normal');
    for (let i = 0; i < P.count; i++) {
      v.fromBufferAttribute(P, i);
      n.fromBufferAttribute(N, i);
      if (part.centre) n.subVectors(v, part.centre).normalize().addScaledVector(new THREE.Vector3(0, 1, 0), 0.25).normalize();
      pos.push(v.x, v.y, v.z);
      nor.push(n.x, n.y, n.z);
      ao.push(part.ao(v, n));
      leaf.push(part.leaf);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aAO', new THREE.Float32BufferAttribute(ao, 1));
  g.setAttribute('aLeaf', new THREE.Float32BufferAttribute(leaf, 1));
  return g;
}

/** A lobe of foliage: an icosphere dented by a cheap repeatable noise, at c with radii r. */
function lobe(detail: number, c: [number, number, number], r: [number, number, number], seed: number) {
  const g = new THREE.IcosahedronGeometry(1, detail);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 1 + 0.16 * Math.sin(x * 5.3 + seed) * Math.sin(y * 4.7 + seed * 2) * Math.sin(z * 6.1 + seed * 3);
    p.setXYZ(i, c[0] + x * r[0] * k, c[1] + y * r[1] * k, c[2] + z * r[2] * k);
  }
  return g;
}

/**
 * A tree of the kind, 1 high (scaled per instance), its base at the origin, at a level of detail:
 * 2 near (six lobes of 80 triangles), 1 (four lobes of 20), 0 far (one lobe).
 */
function treeGeometry(kind: Kind, lod: number) {
  const detail = lod > 0 ? 1 : 0;
  const trunk = (h: number, r: number) => {
    const g = new THREE.CylinderGeometry(r * 0.7, r, h, 6, 1, true);
    g.translate(0, h / 2, 0);
    return { g, ao: () => 0.4, leaf: 0 } as Part;
  };
  // Outer and upper foliage is lit; inner and lower in shade.
  const canopyAO = (cy: number, spread: number) => (p: THREE.Vector3) => Math.min(1, Math.max(0, 0.35 + 0.5 * (p.y - cy) / spread + 0.45 * (Math.hypot(p.x, p.z) / spread)));
  if (kind === 'round') {
    // A broad crown of lobes, low on a short trunk.
    const all: [number, number, number, number][] = [
      [0, 0.58, 0, 0.32],
      [0.22, 0.45, 0.08, 0.24],
      [-0.21, 0.47, -0.1, 0.25],
      [0.06, 0.76, -0.05, 0.24],
      [-0.08, 0.42, 0.22, 0.22],
      [0.1, 0.44, -0.24, 0.21],
    ];
    const lobes = lod === 2 ? all : lod === 1 ? [[0, 0.58, 0, 0.34], all[1], all[2], all[3]] : [[0, 0.55, 0, 0.38]];
    return merge([
      ...(detail ? [trunk(0.34, 0.035)] : []),
      ...lobes.map(([x, y, z, r], i): Part => ({ g: lobe(lod === 2 ? 1 : 0, [x, y, z], [r, r * 0.85, r], i * 1.7), ao: canopyAO(0.55, 0.4), leaf: 1, centre: new THREE.Vector3(x, y, z) })),
    ]);
  }
  if (kind === 'poplar') {
    return merge([
      ...(detail ? [trunk(0.25, 0.025)] : []),
      // A column of narrow lobes, tapering to its tip.
      ...(detail
        ? ([
            [0.0, 0.32, 0.0, 0.11, 0.16],
            [0.02, 0.5, -0.01, 0.12, 0.17],
            [-0.01, 0.68, 0.02, 0.1, 0.16],
            [0.0, 0.85, 0.0, 0.06, 0.13],
          ] as const)
        : ([[0, 0.55, 0, 0.11, 0.45]] as const)
      ).map(([x, y, z, r, h], i): Part => ({ g: lobe(lod === 2 ? 1 : 0, [x, y, z], [r, h, r], i * 2.1 + 0.5), ao: canopyAO(0.55, 0.25), leaf: 1, centre: new THREE.Vector3(x, y, z) })),
    ]);
  }
  // Pines: a bare lower trunk, then tiers of cones.
  const tiers = detail ? 4 : 2;
  const cones = Array.from({ length: tiers }, (_, i) => {
    const y0 = 0.28 + (i / tiers) * 0.62;
    const h = 0.34 - i * 0.04;
    const r = 0.22 * (1 - i / (tiers + 1));
    const g = new THREE.ConeGeometry(r, h, detail ? 9 : 6, 1, true);
    g.translate(0, y0 + h / 2, 0);
    return { g, ao: (p: THREE.Vector3) => Math.min(1, 0.4 + 2.2 * (Math.hypot(p.x, p.z) / r) * 0.3 + 0.3 * (p.y - y0) / h), leaf: 1 };
  });
  return merge([...(detail ? [trunk(0.4, 0.03)] : []), ...cones]);
}

export function buildTrees(U: WorldUniforms) {
  const group = new THREE.Group();
  const meshes: { u: Record<string, THREE.IUniform> }[] = [];
  const passes: ReturnType<typeof gpuPass>[] = [];
  const states: { texture: THREE.Texture; height: number }[] = [];
  for (const [bi, band] of BANDS.entries()) {
    const { cols, rows } = cellsOf(band);
    const count = cols * rows;
    const height = Math.ceil(count / STATE_ROW);
    const pass = gpuPass(STATE_FRAG, { ...U, uW: { value: band.W }, uCell: { value: band.cell }, uD0: { value: band.d0 }, uCols: { value: cols }, uCount: { value: count }, uSeed0: { value: SEED_BASE[bi] } }, STATE_ROW * 2, height);
    passes.push(pass);
    states.push({ texture: pass.texture, height });
    // Every cell of the band is a candidate slot; each slot belongs to one kind of tree for good.
    const slots: number[][] = [[], [], []];
    for (let i = 0; i < count; i++) slots[kindOf(SEED_BASE[bi] + i)].push(i);
    for (const [ki, kind] of KINDS.entries()) {
      const base = treeGeometry(kind, band.lod);
      const g = new THREE.InstancedBufferGeometry();
      g.setAttribute('position', base.getAttribute('position'));
      g.setAttribute('normal', base.getAttribute('normal'));
      g.setAttribute('aAO', base.getAttribute('aAO'));
      g.setAttribute('aLeaf', base.getAttribute('aLeaf'));
      g.setAttribute('aIndex', new THREE.InstancedBufferAttribute(new Float32Array(slots[ki]), 1));
      g.instanceCount = slots[ki].length;
      const u = { ...U, uState: { value: pass.texture }, uStateH: { value: height }, uSeed0: { value: SEED_BASE[bi] }, uWind: { value: 0 } };
      const mesh = new THREE.Mesh(g, new THREE.ShaderMaterial({ vertexShader: TREE_VERT, fragmentShader: TREE_FRAG, uniforms: u, side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      group.add(mesh);
      meshes.push({ u });
    }
  }
  return {
    group,
    /** Each band's state texture (the nearest band's trees cast shadows on the ground). */
    states,
    /** Before drawing: where every tree stands this frame (after the world's uniforms are set). */
    place() {
      for (const p of passes) p.run();
    },
    update(wind: number) {
      for (const m of meshes) m.u.uWind.value = wind;
    },
  };
}
