/**
 * Gear Sync, rendered (only): a compound clockwork train on a dark backplate. Wheels sit in three
 * layers on steel arbors: the front layer in brass, copper and steel, the layers behind (the compound
 * drive) in darker steel and brass. Each ringing arbor wears an enamel hub ring and a clock hand in its
 * colour on its front wheel; the hand starts pointing straight up and the gear rings each time it
 * comes back up. Optionally the ringing wheel flashes and sends out a pulse, and gears ringing
 * together are linked by a line of light between their hands.
 */
import { hexToRgb, lighten, mixRgb, paletteAt, type Ctx2D, type RGB, type Theme } from '@sim/engine';
import { THREE, canvasTexture, draw3D, sceneCache, studioEnvironment } from '../three-layer';
import { ADDENDUM, arborAngle, trainExtent, type Arbor } from './gears';

export interface GearView {
  arbors: Arbor[];
  p: { loopSeconds: number; gearFlash: boolean; gearLinks: boolean };
  colorShift: number;
  flash: number[];
}

/**
 * The space the train fills (world units, in the plane of the front wheels): the frame's full width,
 * from just under the sync counter to the bottom of the frame.
 */
const BOX_W = 3.74;
const BOX_TOP = 1.75;
const BOX_BOTTOM = -3.19;
/** How far the train may run past the frame on its tighter side (edge wheels slightly cut off) to be drawn bigger. */
const SPILL = 1.06;
const THICK = 0.11;
/** How far apart the wheel layers sit (front at 0, each further one behind), and the backplate behind them. */
const LAYER_GAP = 0.16;
const PLATE_Z = -0.48;
/** A gear that rang this recently (by its flash, which decays from 1) counts as ringing together. */
const LINKED = 0.25;

const linear = (c: RGB) => new THREE.Color().setRGB(c[0] / 255, c[1] / 255, c[2] / 255, THREE.SRGBColorSpace);

/**
 * A spur gear's outline (pitch radius r, z teeth, module m), with lightening cut-outs for big gears
 * unless `plain` (wheels that don't turn whole times per loop must look the same tooth to tooth).
 */
function gearShape(z: number, r: number, m: number, plain = false): THREE.Shape {
  const ro = r + m * ADDENDUM;
  const rr = r - 1.25 * m;
  const pitch = (2 * Math.PI) / z;
  const shape = new THREE.Shape();
  for (let k = 0; k < z; k++) {
    const c = k * pitch;
    // Root, flank up, flat tip, flank down: a tooth narrowing toward its tip.
    const pts: [number, number][] = [
      [rr, c - pitch * 0.5],
      [rr, c - pitch * 0.27],
      [ro, c - pitch * 0.14],
      [ro, c + pitch * 0.14],
      [rr, c + pitch * 0.27],
    ];
    for (const [rad, a] of pts) {
      const x = rad * Math.cos(a);
      const y = rad * Math.sin(a);
      if (k === 0 && rad === rr && a === c - pitch * 0.5) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
  }
  shape.closePath();
  const bore = new THREE.Path();
  bore.absarc(0, 0, Math.max(0.03, r * 0.08), 0, Math.PI * 2, true);
  shape.holes.push(bore);
  // Big gears get spokes: rounded windows between hub and rim.
  const hub = Math.max(r * 0.28, 0.08);
  const rim = rr - Math.max(r * 0.12, 0.05);
  if (!plain && rim - hub > 0.12) {
    const spokes = z >= 40 ? 6 : z >= 24 ? 5 : 4;
    const web = 0.3; // fraction of each sector left as spoke
    for (let k = 0; k < spokes; k++) {
      const a0 = (k / spokes) * Math.PI * 2 + (web * Math.PI) / spokes;
      const a1 = ((k + 1) / spokes) * Math.PI * 2 - (web * Math.PI) / spokes;
      const w = new THREE.Path();
      w.absarc(0, 0, rim, a0, a1, false);
      w.absarc(0, 0, hub, a1, a0, true);
      w.closePath();
      shape.holes.push(w);
    }
  }
  return shape;
}

/**
 * Reflections for the metal: a dark room with a broad, dim warm wall behind the camera (what the
 * gear faces mirror), a brighter warm softbox up to the left and a cool strip to the right, so brass
 * and steel read as metal with soft highlights instead of glaring.
 */
const clockworkStudio = () =>
  studioEnvironment('polyrhythm-gears-2', (scene) => {
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(20, 32, 16), new THREE.MeshBasicMaterial({ color: 0x07070a, side: THREE.BackSide })));
    const panel = (w: number, h: number, color: number, at: [number, number, number]) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
      m.position.set(...at);
      m.lookAt(0, 0, 0);
      scene.add(m);
    };
    panel(16, 12, 0x6e604f, [0, 1, 12]);
    panel(6, 4, 0xd8b88c, [-6, 7, 6]);
    panel(1.2, 7, 0x5d6a80, [8, 0, 3]);
    panel(8, 1, 0x26221e, [0, -6, 6]);
  });

/** Brushed dark metal for the backplate, tinted by the theme. */
function plateTexture(base: RGB) {
  return canvasTexture(512, 1024, (ctx) => {
    ctx.fillStyle = `rgb(${base.map(Math.round).join(',')})`;
    ctx.fillRect(0, 0, 512, 1024);
    for (let k = 0; k < 2600; k++) {
      const y = (Math.sin(k * 12.9898) * 43758.5453) % 1;
      const yy = Math.abs(y) * 1024;
      const l = 0.5 + 0.5 * Math.sin(k * 3.7);
      ctx.strokeStyle = `rgba(${l > 0.5 ? '255,255,255' : '0,0,0'},${0.012 + 0.018 * Math.abs(Math.sin(k))})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, yy);
      ctx.lineTo(512, yy + 6 * Math.sin(k));
      ctx.stroke();
    }
  });
}

const view = sceneCache((s: GearView, theme: Theme) => {
  const scene = new THREE.Scene();
  scene.environment = clockworkStudio();
  scene.environmentIntensity = 1;
  const camera = new THREE.PerspectiveCamera(35, 1080 / 1920, 0.1, 60);

  scene.add(new THREE.HemisphereLight(0xfff4e6, 0x141018, 0.25));
  const key = new THREE.DirectionalLight(0xfff0dc, 1.6);
  key.position.set(-3, 4, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -4.5, right: 4.5, top: 4.5, bottom: -4.5, near: 1, far: 20 });
  key.shadow.bias = -0.0006;
  key.shadow.radius = 4;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xbcd2ff, 0.4);
  rim.position.set(4, -2, 3);
  scene.add(rim);

  // Backplate.
  const bg = mixRgb(hexToRgb(theme.bg[1]), [26, 22, 20], 0.6);
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(9, 14), new THREE.MeshStandardMaterial({ map: plateTexture(bg), metalness: 0.15, roughness: 0.8 }));
  plate.position.set(0, 0, PLATE_Z);
  plate.receiveShadow = true;
  scene.add(plate);

  // Fill the space, letting the tighter side spill a little past the frame. The top stays put under
  // the counter, so a tall train spills off the bottom instead.
  const ext = trainExtent(s.arbors);
  const kw = BOX_W / (2 * ext.w);
  const kh = (BOX_TOP - BOX_BOTTOM) / (2 * ext.h);
  const k = Math.min(SPILL * Math.min(kw, kh), Math.max(kw, kh));
  const trainY = BOX_TOP - ext.h * k;
  const n = s.flash.length;
  const brass = new THREE.MeshStandardMaterial({ color: 0xd4ab5c, metalness: 1, roughness: 0.36 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xc4c9d2, metalness: 1, roughness: 0.32 });
  const copper = new THREE.MeshStandardMaterial({ color: 0xcf855a, metalness: 1, roughness: 0.38 });
  // The back layer recedes: darker, rougher steel and brass.
  const backSteel = new THREE.MeshStandardMaterial({ color: 0x8a8f99, metalness: 1, roughness: 0.45 });
  const backBrass = new THREE.MeshStandardMaterial({ color: 0x9c7d45, metalness: 1, roughness: 0.48 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2a30, metalness: 0.9, roughness: 0.35 });
  const metals = [brass, brass, steel, brass, copper];
  // Links between gears that ring together: a pool of glowing bars, one fewer than the ringing gears.
  const linkMat = new THREE.MeshBasicMaterial({ color: 0xfff2d8, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const linkGeo = new THREE.CylinderGeometry(0.014, 0.014, 1, 8);
  linkGeo.rotateZ(Math.PI / 2); // along x
  const links = Array.from({ length: Math.max(0, n - 1) }, () => {
    const mat = linkMat.clone();
    const bar = new THREE.Mesh(linkGeo, mat);
    bar.visible = false;
    scene.add(bar);
    return { bar, mat };
  });

  const ringers: { a: Arbor; spin: THREE.Group; metal: THREE.MeshStandardMaterial; handMat: THREE.MeshStandardMaterial; enamel: THREE.MeshStandardMaterial; pulse: THREE.Mesh; pulseMat: THREE.MeshBasicMaterial; tip: THREE.Vector3 }[] = [];
  const spinners: { a: Arbor; spin: THREE.Group }[] = [];
  s.arbors.forEach((a, ai) => {
    const holder = new THREE.Group();
    holder.position.set(a.x * k, a.y * k + trainY, 0);
    const spin = new THREE.Group();
    holder.add(spin);
    scene.add(holder);
    spinners.push({ a, spin });
    // The arbor: a steel pin from the backplate through both layers.
    const pinR = Math.max(0.018, Math.min(0.04, k * 0.45));
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(pinR, pinR, -PLATE_Z + THICK, 16), dark);
    pin.rotation.x = Math.PI / 2;
    pin.position.z = (PLATE_Z + THICK / 2) / 2;
    holder.add(pin);
    const ringing = a.element >= 0;
    // In-between arbors don't turn whole times per loop, so their wheels stay plain to loop seamlessly.
    const plain = !ringing;
    let frontMetal: THREE.MeshStandardMaterial | null = null;
    for (const w of a.wheels) {
      const r = (w.z / 2) * k;
      const geo = new THREE.ExtrudeGeometry(gearShape(w.z, r, k, plain), { depth: THICK, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.01, bevelSegments: 2, curveSegments: 10 });
      geo.translate(0, 0, -THICK / 2);
      const metal = (w.layer === 0 ? (ringing ? metals[a.element % metals.length] : steel) : ai % 2 ? backBrass : backSteel).clone();
      const body = new THREE.Mesh(geo, metal);
      // The outline has tooth 0 at angle 0; turn it to this wheel's starting phase.
      body.rotation.z = w.theta0;
      body.position.z = -LAYER_GAP * w.layer;
      body.castShadow = true;
      body.receiveShadow = true;
      spin.add(body);
      if (w.layer === 0) frontMetal = metal;
    }
    if (!ringing) return;
    const col = paletteAt(theme.palette, ((a.element / Math.max(1, n - 1)) * 0.95 + s.colorShift) % 1);
    const front = a.wheels.find((w) => w.layer === 0)!;
    const r = (front.z / 2) * k;
    const m = k;
    const metal = frontMetal!;
    metal.emissive = linear(col);
    metal.emissiveIntensity = 0;
    // Hub: an enamel ring in the gear's colour round a dark axle cap.
    const hubR = Math.max(r * 0.2, 0.06);
    const enamel = new THREE.MeshStandardMaterial({ color: linear(col), metalness: 0.2, roughness: 0.25, emissive: linear(col), emissiveIntensity: 0.15 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(hubR, Math.max(0.012, hubR * 0.22), 12, 48), enamel);
    ring.position.z = THICK / 2 + 0.01;
    spin.add(ring);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(hubR * 0.62, hubR * 0.62, THICK + 0.08, 32), dark);
    cap.rotation.x = Math.PI / 2;
    spin.add(cap);
    // The hand: a tapered blade with an arrowhead from the hub almost to the teeth, pointing straight up
    // at the start (the arbor's angle is 0 then), with a short counterweight tail.
    const len = Math.max(r - 1.25 * m - Math.max(0.02, r * 0.06), r * 0.6);
    const hw = Math.max(0.02, r * 0.07);
    const blade = new THREE.Shape();
    blade.moveTo(-0.25 * len, -hw * 0.75);
    blade.lineTo(0.68 * len, -hw * 0.5);
    blade.lineTo(0.68 * len, -hw * 1.6);
    blade.lineTo(len, 0);
    blade.lineTo(0.68 * len, hw * 1.6);
    blade.lineTo(0.68 * len, hw * 0.5);
    blade.lineTo(-0.25 * len, hw * 0.75);
    blade.closePath();
    const handMat = new THREE.MeshStandardMaterial({ color: linear(lighten(col, 0.15)), metalness: 0.25, roughness: 0.3, emissive: linear(col), emissiveIntensity: 0.25 });
    const hand = new THREE.Mesh(new THREE.ExtrudeGeometry(blade, { depth: 0.022, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.005, bevelSegments: 1 }), handMat);
    hand.position.z = THICK / 2 + 0.014;
    hand.rotation.z = Math.PI / 2;
    hand.castShadow = true;
    spin.add(hand);
    // The ring pulse: a thin band at the rim that swells and fades after each note.
    const pulseMat = new THREE.MeshBasicMaterial({ color: linear(lighten(col, 0.3)), transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
    const ro = r + m * ADDENDUM;
    const pulse = new THREE.Mesh(new THREE.RingGeometry(ro * 0.97, ro * 1.03, 96), pulseMat);
    pulse.position.z = THICK / 2 + 0.03;
    holder.add(pulse);
    // Where the hand's tip is at the start (and at every note): straight up from the arbor.
    const tip = new THREE.Vector3(holder.position.x, holder.position.y + len, THICK / 2 + 0.04);
    ringers[a.element] = { a, spin, metal, handMat, enamel, pulse, pulseMat, tip };
  });
  return { scene, camera, ringers, spinners, links };
});

export function drawGears(ctx: Ctx2D, theme: Theme, s: GearView, t: number) {
  const v = view(s, theme);
  const u = t / s.p.loopSeconds;
  for (const sp of v.spinners) sp.spin.rotation.z = arborAngle(sp.a, u);
  v.ringers.forEach((gv, i) => {
    const fl = s.flash[i];
    gv.handMat.emissiveIntensity = 0.25 + 2.2 * fl;
    gv.enamel.emissiveIntensity = 0.15 + 0.8 * fl;
    // The ring flash: the whole gear glows in its colour and a pulse swells off its rim.
    const on = s.p.gearFlash ? fl : 0;
    gv.metal.emissiveIntensity = 0.55 * on;
    gv.pulse.visible = on > 0.02;
    gv.pulse.scale.setScalar(1 + 0.4 * (1 - on));
    gv.pulseMat.opacity = on * 0.9;
  });
  // Gears ringing together, linked left to right by bars of light between their hands' tips.
  const ringing = s.p.gearLinks ? v.ringers.map((gv, i) => ({ gv, f: s.flash[i] })).filter((x) => x.f > LINKED).sort((a, b) => a.gv.tip.x - b.gv.tip.x) : [];
  v.links.forEach((link, k) => {
    const a = ringing[k];
    const b = ringing[k + 1];
    link.bar.visible = !!(a && b);
    if (!a || !b) return;
    const d = b.gv.tip.clone().sub(a.gv.tip);
    link.bar.position.copy(a.gv.tip).addScaledVector(d, 0.5);
    link.bar.scale.set(d.length(), 1, 1);
    link.bar.rotation.z = Math.atan2(d.y, d.x);
    link.mat.opacity = Math.min(1, ((Math.min(a.f, b.f) - LINKED) / (1 - LINKED)) * 1.2);
  });
  // A gentle sway, whole cycles per loop so the loop stays seamless.
  const sway = Math.sin(2 * Math.PI * u);
  v.camera.position.set(0.55 * sway, 1.1 + 0.15 * Math.cos(2 * Math.PI * u), 10.5);
  v.camera.lookAt(0, 0.25, 0);
  draw3D(ctx, v.scene, v.camera);
}
