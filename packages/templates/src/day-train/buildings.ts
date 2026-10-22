/**
 * The storybook building kit: cottages (half-timbered, stone or plaster, under thatch, slate or red
 * tiles), barns, churches with towers and spires, windmills with turning sails, round towers with
 * tall pointed roofs and pennants, curtain walls with crenellations, keeps.
 *
 * Geometry is plain (boxes, prisms, cones); the look is in the shader, from each vertex's material
 * and its surface coordinates in metres: timber framing on plaster, coursed stone, thatch, rows of
 * slates or tiles, small-paned windows. Detail fades out with distance (a far town is shapes and
 * colours). Each building's vertices carry its base point on the ring (ring position, distance out),
 * and the GPU sets it on the land there (world.ts), so a whole settlement is one mesh.
 */
import { THREE } from '../three-layer';
import { WORLD, type WorldUniforms } from './world';

export const MAT = { timber: 0, stone: 1, thatch: 2, slate: 3, tile: 4, wood: 5, window: 6, cone: 7, sail: 8, flag: 9, plain: 10 } as const;
type Mat = (typeof MAT)[keyof typeof MAT];
type V3 = [number, number, number];

const BUILDING_VERT = /* glsl */ `
${WORLD}
attribute vec3 color;
attribute float aMat;
attribute vec2 aSurf;
attribute vec2 aBase;    // ring position, distance out of the building's base
attribute vec4 aAnim;    // 1 sail (turns about the hub xyz, about the local z axis), 2 flag (waves from xyz)
uniform float uSail;
uniform float uFlag;
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying float vMat;
varying vec2 vSurf;
varying float vY;
void main() {
  vec3 q = position;
  if (aAnim.x > 0.5 && aAnim.x < 1.5) {
    // Each windmill its own pace (whole turns per loop: uSail is a phase per loop).
    float a = uSail * (0.8 + 0.4 * fract(aBase.x * 0.0137)) + aBase.x;
    vec2 r = q.xy - aAnim.yz;
    q.xy = aAnim.yz + mat2(cos(a), sin(a), -sin(a), cos(a)) * r;
  } else if (aAnim.x > 1.5) {
    float along = max(0.0, q.x - aAnim.y);
    q.z += 0.18 * along * sin(uFlag - along * 2.2 + aBase.x);
  }
  float y0 = landY(aBase.x, aBase.y);
  vec4 w = modelMatrix * vec4(worldX(aBase.x) + uDir * q.x, y0 + q.y, TRACK_Z - aBase.y - q.z, 1.0);
  vWorld = w.xyz;
  vNormal = normalize(vec3(uDir * normal.x, normal.y, -normal.z));
  vColor = color;
  vMat = aMat;
  vSurf = aSurf;
  vY = q.y;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

const BUILDING_FRAG = /* glsl */ `
${WORLD}
varying vec3 vWorld;
varying vec3 vNormal;
varying vec3 vColor;
varying float vMat;
varying vec2 vSurf;
varying float vY;

// A line of half-width w (m) at 0 in a repeating coordinate, antialiased by the pixel's size.
float bar(float x, float w, float px) { return 1.0 - smoothstep(w - px, w + px, abs(x)); }

void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(vWorld - uEye);
  if (dot(n, v) > 0.0) n = -n;
  vec2 s = vSurf;
  vec2 fw = fwidth(s);
  float px = max(max(fw.x, fw.y), 1e-4);
  // Detail fades out once a pixel covers too much of the wall.
  float detail = smoothstep(0.45, 0.12, px);
  vec3 col = vColor;
  float m = vMat;
  float ao = 1.0;
  if (m < 0.5) {
    // Timber framing on plaster: posts, a sill, floor beams, braces in some panels.
    float bay = 1.1;
    vec2 cell = vec2(s.x / bay, s.y / 2.7);
    vec2 f = fract(cell);
    float beam = max(bar(f.x, 0.065, px / bay), bar(f.y, 0.04, px / 2.7));
    float h = hash12(floor(cell));
    float diag = h > 0.55 ? bar(f.x - (h > 0.78 ? f.y : 1.0 - f.y), 0.05, px / bay) : 0.0;
    float t = max(beam, diag) * detail * step(0.0, s.y);
    col = mix(col, vec3(0.2, 0.13, 0.08), t);
    ao = 0.7 + 0.3 * smoothstep(0.0, 1.5, vY);
  } else if (m < 1.5) {
    // Coursed stone: rows 0.42 m, blocks staggered, each its own shade.
    float row = floor(s.y / 0.42);
    float bx = s.x / 0.8 + 0.5 * mod(row, 2.0);
    float hb = hash12(vec2(floor(bx), row));
    col *= mix(1.0, 0.82 + 0.3 * hb, detail);
    float mortar = max(bar(fract(s.y / 0.42), 0.04, px / 0.42), bar(fract(bx), 0.025, px / 0.8));
    col = mix(col, col * 1.25 + 0.03, mortar * detail * 0.6);
    ao = 0.7 + 0.3 * smoothstep(0.0, 1.5, vY);
  } else if (m < 2.5) {
    // Thatch: straw streaks down the slope, darker and weathered at the eaves.
    float st = snoise(vec4(s.x * 5.0, s.y * 0.6, 0.0, 3.0));
    col *= 1.0 + 0.16 * st * detail;
    col *= 0.78 + 0.22 * smoothstep(0.0, 1.2, s.y);
  } else if (m < 4.5) {
    // Slates or tiles in rows (staggered), the lower edge of each row in shadow.
    float rh = m < 3.5 ? 0.26 : 0.3;
    float row = floor(s.y / rh);
    float tx = s.x / (m < 3.5 ? 0.36 : 0.3) + 0.5 * mod(row, 2.0);
    float hb = hash12(vec2(floor(tx), row));
    col *= mix(1.0, 0.85 + 0.25 * hb, detail);
    col *= 1.0 - 0.25 * detail * (1.0 - smoothstep(0.0, 0.35, fract(s.y / rh)));
  } else if (m < 5.5) {
    // Boards.
    float hb = hash12(vec2(floor(s.x / 0.22), 1.0));
    col *= mix(1.0, 0.82 + 0.3 * hb, detail);
    col *= 1.0 - 0.3 * bar(fract(s.x / 0.22), 0.04, px / 0.22) * detail;
  } else if (m < 6.5) {
    // A small-paned window: dark glass with the sky in it, white glazing bars.
    vec3 r = reflect(v, n);
    vec3 glass = mix(vec3(0.03, 0.04, 0.05), mix(uSkyHorizon, uSkyTop, max(r.y, 0.0)) * 0.35, 0.6);
    float bars = max(bar(fract(s.x / 0.4) - 0.5, 0.025, px / 0.4), bar(fract(s.y / 0.45) - 0.5, 0.025, px / 0.45)) * detail;
    col = mix(glass, vec3(0.82, 0.8, 0.74), bars);
  } else if (m < 7.5) {
    // A tower's pointed roof: rows of scales.
    float row = floor(s.y / 0.38);
    float hb = hash12(vec2(floor(s.x / 0.4 + 0.5 * mod(row, 2.0)), row));
    col *= mix(1.0, 0.88 + 0.2 * hb, detail);
    col *= 1.0 - 0.2 * detail * (1.0 - smoothstep(0.0, 0.4, fract(s.y / 0.38)));
  } else if (m < 8.5) {
    // A sail: a wooden lattice, half of it clothed.
    float lat = max(bar(fract(s.x / 0.6), 0.05, px / 0.6), bar(fract(s.y / 0.6), 0.05, px / 0.6));
    col = lat < 0.5 && s.x > 0.9 ? vec3(0.86, 0.82, 0.72) : vec3(0.3, 0.22, 0.15);
  }
  vec3 c = lit(col, n, 1.0, ao);
  gl_FragColor = vec4(hazed(c, vWorld), 1.0);
}
`;

/** Accumulates buildings into one geometry: local x along the track, y up, z away from it. */
export class Kit {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private mat: number[] = [];
  private surf: number[] = [];
  private base: number[] = [];
  private anim: number[] = [];
  /** The current building: its base on the ring, its turn and its offset (m) from that base. */
  private p = 0;
  private d = 0;
  private yaw = 0;
  private ox = 0;
  private oz = 0;
  private animNow: [number, number, number, number] = [0, 0, 0, 0];

  /** Start a building at ring position p, d metres out, turned by yaw. */
  at(p: number, d: number, yaw = 0) {
    this.p = p;
    this.d = d;
    this.yaw = yaw;
    this.ox = 0;
    this.oz = 0;
    return this;
  }
  /** Subsequent parts belong to an animated piece (sails, flags), hub in the building's own frame. */
  animate(kind: 0 | 1 | 2, hub: V3 = [0, 0, 0]) {
    const [hx, hy, hz] = this.rot(hub);
    this.animNow = [kind, hx, hy, hz];
    return this;
  }
  private rot([x, y, z]: V3): V3 {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    return [this.ox + c * x - s * z, y, this.oz + s * x + c * z];
  }
  private rotN([x, y, z]: V3): V3 {
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    return [c * x - s * z, y, s * x + c * z];
  }
  private vert(p: V3, n: V3, col: V3, mat: Mat, uv: [number, number]) {
    const [x, y, z] = this.rot(p);
    const [nx, ny, nz] = this.rotN(n);
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(...col);
    this.mat.push(mat);
    this.surf.push(...uv);
    this.base.push(this.p, this.d);
    this.anim.push(...this.animNow);
  }
  /** A triangle; normal from its winding (a, b, c counter-clockwise seen from outside). */
  tri(a: V3, b: V3, c: V3, col: V3, mat: Mat, ua: [number, number], ub: [number, number], uc: [number, number]) {
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n: V3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const l = Math.hypot(...n) || 1;
    const nn: V3 = [n[0] / l, n[1] / l, n[2] / l];
    this.vert(a, nn, col, mat, ua);
    this.vert(b, nn, col, mat, ub);
    this.vert(c, nn, col, mat, uc);
  }
  /** A quad a b c d (counter-clockwise from outside); surface coords from a: u along a→b, v along a→d. */
  quad(a: V3, b: V3, c: V3, d: V3, col: V3, mat: Mat, u0 = 0, v0 = 0) {
    const lu = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const lv = Math.hypot(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
    this.tri(a, b, c, col, mat, [u0, v0], [u0 + lu, v0], [u0 + lu, v0 + lv]);
    this.tri(a, c, d, col, mat, [u0, v0], [u0 + lu, v0 + lv], [u0, v0 + lv]);
  }
  /** A box from (x0, y0, z0) to (x1, y1, z1); walls' v is height (y), so patterns sit on the ground. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: V3, mat: Mat, top: Mat = mat, topCol: V3 = col) {
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], col, mat, x0, y0); // front (towards the track)
    this.quad([x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1], col, mat, x0, y0);
    this.quad([x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1], col, mat, z0, y0);
    this.quad([x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0], col, mat, z0, y0);
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], topCol, top, x0, z0);
  }
  /**
   * Walls and a gable roof over a w × dp footprint centred on (cx, cz), walls to height h, the ridge
   * rh above them running along x; eaves overhang by ov. Walls run down to y = -3 (into the slope).
   */
  house(cx: number, cz: number, w: number, dp: number, h: number, rh: number, wall: V3, wallMat: Mat, roof: V3, roofMat: Mat, ov = 0.45) {
    const x0 = cx - w / 2;
    const x1 = cx + w / 2;
    const z0 = cz - dp / 2;
    const z1 = cz + dp / 2;
    const g = -3;
    this.quad([x0, g, z0], [x1, g, z0], [x1, h, z0], [x0, h, z0], wall, wallMat, 0, g);
    this.quad([x1, g, z1], [x0, g, z1], [x0, h, z1], [x1, h, z1], wall, wallMat, 0, g);
    this.quad([x0, g, z1], [x0, g, z0], [x0, h, z0], [x0, h, z1], wall, wallMat, 0, g);
    this.quad([x1, g, z0], [x1, g, z1], [x1, h, z1], [x1, h, z0], wall, wallMat, 0, g);
    // Gables.
    this.tri([x0, h, z1], [x0, h, z0], [x0, h + rh, cz], wall, wallMat, [0, h], [dp, h], [dp / 2, h + rh]);
    this.tri([x1, h, z0], [x1, h, z1], [x1, h + rh, cz], wall, wallMat, [0, h], [dp, h], [dp / 2, h + rh]);
    // Roof slopes (v runs up the slope from the eaves).
    const e = h - ov * (rh / (dp / 2));
    const ex0 = x0 - ov * 0.8;
    const ex1 = x1 + ov * 0.8;
    this.quad([ex0, e, z0 - ov], [ex1, e, z0 - ov], [ex1, h + rh, cz], [ex0, h + rh, cz], roof, roofMat, 0, 0);
    this.quad([ex1, e, z1 + ov], [ex0, e, z1 + ov], [ex0, h + rh, cz], [ex1, h + rh, cz], roof, roofMat, 0, 0);
    // Under the eaves (so the roof isn't paper-thin from below).
    this.quad([ex1, e, z0 - ov], [ex0, e, z0 - ov], [ex0, e + 0.05, z0], [ex1, e + 0.05, z0], [roof[0] * 0.5, roof[1] * 0.5, roof[2] * 0.5], MAT.plain);
    this.quad([ex0, e, z1 + ov], [ex1, e, z1 + ov], [ex1, e + 0.05, z1], [ex0, e + 0.05, z1], [roof[0] * 0.5, roof[1] * 0.5, roof[2] * 0.5], MAT.plain);
  }
  /** A window (or door: mat wood) on the face z = zf facing -z (towards the track), or facing +z. */
  opening(x0: number, y0: number, x1: number, y1: number, zf: number, facing: -1 | 1, mat: Mat = MAT.window, col: V3 = [0.3, 0.2, 0.12]) {
    const z = zf + facing * 0.04;
    if (facing < 0) this.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], col, mat, 0, 0);
    else this.quad([x1, y0, z], [x0, y0, z], [x0, y1, z], [x1, y1, z], col, mat, 0, 0);
  }
  /** The same on a face x = xf facing -x or +x. */
  openingX(z0: number, y0: number, z1: number, y1: number, xf: number, facing: -1 | 1, mat: Mat = MAT.window, col: V3 = [0.3, 0.2, 0.12]) {
    const x = xf + facing * 0.04;
    if (facing > 0) this.quad([x, y0, z0], [x, y0, z1], [x, y1, z1], [x, y1, z0], col, mat, 0, 0);
    else this.quad([x, y0, z1], [x, y0, z0], [x, y1, z0], [x, y1, z1], col, mat, 0, 0);
  }
  /** A round tower's wall: n sides, radius r0 at the bottom, r1 at the top, from y0 to y1. */
  drum(cx: number, cz: number, r0: number, r1: number, y0: number, y1: number, n: number, col: V3, mat: Mat) {
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const P = (a: number, r: number, y: number): V3 => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
      this.quad(P(a1, r0, y0), P(a0, r0, y0), P(a0, r1, y1), P(a1, r1, y1), col, mat, a0 * r0, y0);
    }
  }
  /** A cone (pointed roof, spire) of n sides over (cx, cz), radius r at y0, apex at y0 + h. */
  cone(cx: number, cz: number, r: number, y0: number, h: number, n: number, col: V3, mat: Mat) {
    const slant = Math.hypot(r, h);
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2;
      const a1 = ((i + 1) / n) * Math.PI * 2;
      const w = 2 * Math.PI * r / n;
      this.tri([cx + Math.cos(a1) * r, y0, cz + Math.sin(a1) * r], [cx + Math.cos(a0) * r, y0, cz + Math.sin(a0) * r], [cx, y0 + h, cz], col, mat, [i * w, 0], [(i + 1) * w, 0], [(i + 0.5) * w, slant]);
    }
  }
  /** A pole with a pennant flying from its top (towards +x). */
  pennant(cx: number, cz: number, y0: number, h: number, col: V3) {
    this.box(cx - 0.06, y0, cz - 0.06, cx + 0.06, y0 + h, cz + 0.06, [0.3, 0.25, 0.2], MAT.plain);
    this.animate(2, [cx, y0 + h, cz]);
    const top = y0 + h - 0.1;
    this.tri([cx, top, cz], [cx, top - 1.2, cz], [cx + 2.6, top - 0.5, cz], col, MAT.flag, [0, 0], [0, 1], [2.6, 0.5]);
    this.tri([cx, top - 1.2, cz], [cx, top, cz], [cx + 2.6, top - 0.5, cz], col, MAT.flag, [0, 1], [0, 0], [2.6, 0.5]);
    this.animate(0);
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aMat', new THREE.Float32BufferAttribute(this.mat, 1));
    g.setAttribute('aSurf', new THREE.Float32BufferAttribute(this.surf, 2));
    g.setAttribute('aBase', new THREE.Float32BufferAttribute(this.base, 2));
    g.setAttribute('aAnim', new THREE.Float32BufferAttribute(this.anim, 4));
    return g;
  }
  get empty() {
    return this.pos.length === 0;
  }
}

export function buildingMaterial(U: WorldUniforms, anim: { uSail: THREE.IUniform; uFlag: THREE.IUniform }) {
  return new THREE.ShaderMaterial({ vertexShader: BUILDING_VERT, fragmentShader: BUILDING_FRAG, uniforms: { ...U, ...anim }, side: THREE.DoubleSide });
}

// ---- colours -----------------------------------------------------------------------------------------
export const PLASTER: V3[] = [
  [0.86, 0.82, 0.72],
  [0.9, 0.88, 0.84],
  [0.84, 0.7, 0.46],
  [0.86, 0.72, 0.66],
  [0.74, 0.8, 0.84],
];
export const STONE: V3[] = [
  [0.7, 0.64, 0.54],
  [0.64, 0.6, 0.54],
  [0.74, 0.66, 0.5],
];
export const THATCH: V3 = [0.62, 0.5, 0.28];
export const SLATE: V3 = [0.3, 0.32, 0.36];
export const TILE: V3 = [0.62, 0.3, 0.18];
export const CONES: V3[] = [
  [0.2, 0.3, 0.58],
  [0.62, 0.18, 0.14],
  [0.28, 0.31, 0.38],
  [0.3, 0.55, 0.5],
];
export const FLAGS: V3[] = [
  [0.75, 0.12, 0.1],
  [0.85, 0.7, 0.15],
  [0.15, 0.3, 0.7],
  [0.9, 0.9, 0.88],
];
export const WOOD: V3[] = [
  [0.42, 0.26, 0.16],
  [0.5, 0.2, 0.14],
  [0.36, 0.34, 0.3],
];

export type Pick = <T>(a: readonly T[]) => T;
