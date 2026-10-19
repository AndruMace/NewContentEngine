/**
 * Marble Race 3D's looks: everything that decides how the tower is dressed and lit, one kit per
 * look. Three aim at photorealism (physically based materials with procedural textures at real
 * scale, an image-based studio environment, soft shadows, ambient occlusion and depth of field):
 *
 * - classic: a wall-mounted wooden marble run, as in the Rube Goldberg template (maple lanes with
 *   walnut rails over clear acrylic, spun-brass turns and funnels, green felt, a plywood board).
 * - futuristic: a test rig in a dark hangar (carbon-fibre lanes, brushed titanium, smoked edges
 *   lit by light strips, laser gates, a hex-panelled wall).
 * - arctic: a track carved from ice in a snowfield (frosted ice lanes, snow-capped rails, packed
 *   snow pads, an ice wall, falling snow).
 *
 * And one stylised look (neon), drawn in the video theme's colours with bloom.
 * Rendering only: nothing here touches the race.
 */
import { FONT_FAMILY, lighten, mixRgb, paletteAt, type Ctx2D, type Theme } from '@sim/engine';
import { THREE, canvasTexture, environmentMap, studioEnvironment } from '../three-layer';
import { hash, studio, vaneGeometry, woodTexture } from '../rube-goldberg/view3d';
import type { Team } from '../fx';
import { R } from './course';

export const LOOKS = ['classic', 'futuristic', 'arctic', 'neon'] as const;
export type LookId = (typeof LOOKS)[number];

/** How much of the engine's 2D bloom each look wants (the photoreal ones barely any). */
export const LOOK_GLOW: Record<LookId, number> = { classic: 0.04, futuristic: 0.1, arctic: 0.03, neon: 0.35 };

const rgb = (c: number[]) => new THREE.Color(`rgb(${c.map((v) => Math.round(v)).join(',')})`);

/** Data textures (bump, roughness, emission masks) are linear, not colour. */
const data = (t: THREE.Texture) => {
  t.colorSpace = THREE.NoColorSpace;
  return t;
};
const tile = (t: THREE.Texture, n: number) => {
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(n, n);
  return t;
};

// ---- Textures -------------------------------------------------------------------------------------

/** Frosted ice: milky drifts, fine frost speckle and the odd crack (also used as its bump map). */
function iceTexture(bump: boolean): THREE.Texture {
  const t = canvasTexture(512, 512, (c) => {
    c.fillStyle = bump ? '#808080' : '#d7ecf6';
    c.fillRect(0, 0, 512, 512);
    for (let k = 0; k < 70; k++) {
      c.fillStyle = bump ? `rgba(255,255,255,${(0.04 + hash(k) * 0.08).toFixed(3)})` : `rgba(${hash(k) > 0.45 ? '255,255,255' : '90,140,180'},${(0.12 + hash(k + 1) * 0.28).toFixed(3)})`;
      c.beginPath();
      c.ellipse(hash(k + 2) * 512, hash(k + 3) * 512, 30 + hash(k + 4) * 120, 10 + hash(k + 5) * 40, hash(k + 6) * Math.PI, 0, Math.PI * 2);
      c.fill();
    }
    for (let k = 0; k < 5000; k++) {
      c.fillStyle = bump ? `rgba(255,255,255,${(0.1 + hash(k + 9) * 0.3).toFixed(3)})` : `rgba(255,255,255,${(0.1 + hash(k + 9) * 0.35).toFixed(3)})`;
      c.fillRect(hash(k + 11) * 512, hash(k + 13) * 512, 1 + hash(k + 15) * 1.5, 1 + hash(k + 17) * 1.5);
    }
    // Cracks: jagged branching lines.
    for (let k = 0; k < 14; k++) {
      let x = hash(k * 3 + 100) * 512;
      let y = hash(k * 3 + 101) * 512;
      let a = hash(k * 3 + 102) * Math.PI * 2;
      c.strokeStyle = bump ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.85)';
      c.lineWidth = 0.8 + hash(k + 200) * 1.2;
      c.beginPath();
      c.moveTo(x, y);
      for (let i = 0; i < 18; i++) {
        a += (hash(k * 50 + i) - 0.5) * 0.9;
        x += Math.cos(a) * 12;
        y += Math.sin(a) * 12;
        c.lineTo(x, y);
      }
      c.stroke();
    }
  });
  return tile(bump ? data(t) : t, 1);
}

/** Packed snow: bright, softly lumpy, with sparkle (also its bump map). */
function snowTexture(bump: boolean): THREE.Texture {
  const t = canvasTexture(512, 512, (c) => {
    c.fillStyle = bump ? '#808080' : '#f2f5f8';
    c.fillRect(0, 0, 512, 512);
    for (let k = 0; k < 400; k++) {
      const v = bump ? Math.round(100 + hash(k) * 70) : Math.round(220 + hash(k) * 30);
      c.fillStyle = bump ? `rgba(${v},${v},${v},0.25)` : `rgba(${v - 8},${v - 3},${v + 2},0.18)`;
      c.beginPath();
      c.arc(hash(k + 1) * 512, hash(k + 2) * 512, 4 + hash(k + 3) * 26, 0, Math.PI * 2);
      c.fill();
    }
    for (let k = 0; k < 2500; k++) {
      c.fillStyle = bump ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.9)';
      c.fillRect(hash(k + 5) * 512, hash(k + 7) * 512, 1, 1);
    }
  });
  return tile(bump ? data(t) : t, 1);
}

function checkerTexture(): THREE.Texture {
  const tex = canvasTexture(64, 16, (c) => {
    for (let i = 0; i < 16; i++)
      for (let j = 0; j < 4; j++) {
        c.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f4';
        c.fillRect(i * 4, j * 4, 4, 4);
      }
  });
  tex.magFilter = THREE.NearestFilter;
  return tex;
}

/**
 * A marble's paint job: the team colour with its flag (or a roundel with its initial) on two
 * sides, high resolution so it stays crisp close up.
 */
function marbleTexture(team: Team): THREE.Texture {
  return canvasTexture(512, 256, (c) => {
    c.fillStyle = team.color;
    c.fillRect(0, 0, 512, 256);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    for (const x of [128, 384]) {
      if (team.icon) {
        c.font = `156px ${FONT_FAMILY}`;
        c.fillText(team.icon, x, 136);
      } else {
        c.fillStyle = 'rgba(255,255,255,0.94)';
        c.beginPath();
        c.arc(x, 128, 66, 0, Math.PI * 2);
        c.fill();
        c.fillStyle = team.color;
        c.font = `900 88px ${FONT_FAMILY}`;
        c.fillText(team.label[0], x, 134);
      }
    }
  });
}

// ---- Industrial textures (the futuristic look) --------------------------------------------------

/**
 * Worn painted steel deck plate, 1024² with a matching roughness and bump map: panel seams with
 * bolts, chipped paint showing bare metal at the edges, fine scratches, grime collecting low and
 * rust-brown drips. Seeded per variant so plates don't repeat exactly.
 */
function plateTextures(seed: number, paint: [number, number, number]): { map: THREE.Texture; rough: THREE.Texture; bump: THREE.Texture } {
  const N = 1024;
  const P = 256;
  const draw = (c: Ctx2D, layer: 'map' | 'rough' | 'bump') => {
    const base = layer === 'map' ? `rgb(${paint.join(',')})` : layer === 'rough' ? 'rgb(150,150,150)' : 'rgb(128,128,128)';
    c.fillStyle = base;
    c.fillRect(0, 0, N, N);
    // Mottled paint.
    for (let k = 0; k < 900; k++) {
      const x = hash(seed + k) * N;
      const y = hash(seed + k + 1) * N;
      const r = 6 + hash(seed + k + 2) * 40;
      const d = hash(seed + k + 3) > 0.5;
      c.fillStyle = layer === 'map' ? (d ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.03)') : layer === 'rough' ? (d ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)') : 'rgba(0,0,0,0)';
      c.beginPath();
      c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
    }
    // Grime pooling toward each plate's lower edge, and drips.
    for (let py = 0; py < N; py += P)
      for (let px = 0; px < N; px += P) {
        if (layer === 'bump') continue;
        const g = c.createLinearGradient(0, py, 0, py + P);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, layer === 'map' ? 'rgba(20,16,12,0.28)' : 'rgba(255,255,255,0.18)');
        c.fillStyle = g;
        c.fillRect(px, py, P, P);
        for (let k = 0; k < 6; k++) {
          const x = px + hash(seed + px * 3 + py + k) * P;
          const len = 30 + hash(seed + px + py * 5 + k) * 120;
          c.fillStyle = layer === 'map' ? `rgba(${hash(k + px) > 0.6 ? '96,52,24' : '18,15,12'},0.18)` : 'rgba(255,255,255,0.12)';
          c.fillRect(x, py + 8, 2 + hash(k + py) * 3, len);
        }
      }
    // Fine scratches: bare metal shows through, and is smoother.
    for (let k = 0; k < 700; k++) {
      const x = hash(seed + k * 7) * N;
      const y = hash(seed + k * 11) * N;
      const a = (hash(seed + k * 13) - 0.5) * 0.9 + (hash(seed + k * 17) > 0.7 ? Math.PI / 2 : 0);
      const l = 6 + hash(seed + k * 19) * 50;
      c.strokeStyle = layer === 'map' ? 'rgba(170,172,170,0.22)' : layer === 'rough' ? 'rgba(40,40,40,0.35)' : 'rgba(90,90,90,0.4)';
      c.lineWidth = 0.6 + hash(seed + k) * 0.8;
      c.beginPath();
      c.moveTo(x, y);
      c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
      c.stroke();
    }
    // Seams between plates, with chipped paint along them and bolts at the corners.
    for (let k = 0; k <= N; k += P) {
      c.fillStyle = layer === 'map' ? 'rgba(8,8,8,0.85)' : layer === 'rough' ? 'rgb(210,210,210)' : 'rgb(30,30,30)';
      c.fillRect(k - 2, 0, 4, N);
      c.fillRect(0, k - 2, N, 4);
      if (layer === 'map') {
        for (let j = 0; j < 40; j++) {
          const along = hash(seed + k * 31 + j) * N;
          const off = (hash(seed + k + j * 3) - 0.5) * 16;
          c.fillStyle = 'rgba(150,150,146,0.5)';
          c.fillRect(k + off, along, 2 + hash(j + k) * 6, 2 + hash(j * 2 + k) * 8);
          c.fillRect(along, k + off, 2 + hash(j * 3 + k) * 8, 2 + hash(j * 5 + k) * 6);
        }
      }
    }
    for (let py = 0; py < N; py += P)
      for (let px = 0; px < N; px += P)
        for (const [bx, by] of [[14, 14], [P - 14, 14], [14, P - 14], [P - 14, P - 14], [P / 2, 14], [P / 2, P - 14]]) {
          const x = px + bx;
          const y = py + by;
          c.fillStyle = layer === 'map' ? 'rgb(60,62,64)' : layer === 'rough' ? 'rgb(110,110,110)' : 'rgb(200,200,200)';
          c.beginPath();
          c.arc(x, y, 5, 0, Math.PI * 2);
          c.fill();
          if (layer === 'map') {
            c.fillStyle = 'rgba(200,200,196,0.5)';
            c.beginPath();
            c.arc(x - 1.5, y - 1.5, 1.8, 0, Math.PI * 2);
            c.fill();
          }
        }
  };
  const map = canvasTexture(N, N, (c) => draw(c, 'map'));
  const rough = data(canvasTexture(N, N, (c) => draw(c, 'rough')));
  const bump = data(canvasTexture(N, N, (c) => draw(c, 'bump')));
  for (const t of [map, rough, bump]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return { map, rough, bump };
}

/** Worn yellow-and-black hazard stripes (bollards, spinner bars, gates). */
function hazardTexture(): THREE.Texture {
  const t = canvasTexture(256, 256, (c) => {
    c.fillStyle = '#1a1a18';
    c.fillRect(0, 0, 256, 256);
    c.fillStyle = '#d9a514';
    for (let k = -256; k < 512; k += 64) {
      c.beginPath();
      c.moveTo(k, 0);
      c.lineTo(k + 32, 0);
      c.lineTo(k + 32 + 256, 256);
      c.lineTo(k + 256, 256);
      c.closePath();
      c.fill();
    }
    for (let k = 0; k < 600; k++) {
      c.fillStyle = `rgba(${hash(k) > 0.5 ? '40,36,30' : '140,140,136'},${(0.1 + hash(k + 1) * 0.35).toFixed(3)})`;
      c.fillRect(hash(k + 2) * 256, hash(k + 3) * 256, 1 + hash(k + 4) * 6, 1 + hash(k + 5) * 2);
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Stained concrete: water streaks, damp patches, formwork lines (and its roughness). */
function concreteTextures(wet: boolean): { map: THREE.Texture; rough: THREE.Texture } {
  const N = 1024;
  const draw = (c: Ctx2D, rough: boolean) => {
    c.fillStyle = rough ? 'rgb(215,215,215)' : 'rgb(92,94,96)';
    c.fillRect(0, 0, N, N);
    for (let k = 0; k < 16000; k++) {
      const v = hash(k) > 0.5;
      c.fillStyle = rough ? `rgba(${v ? 255 : 160},${v ? 255 : 160},${v ? 255 : 160},0.1)` : `rgba(${v ? '140,140,138' : '50,50,50'},${(0.05 + hash(k + 1) * 0.12).toFixed(3)})`;
      c.fillRect(hash(k + 2) * N, hash(k + 3) * N, 1 + hash(k + 4) * 3, 1 + hash(k + 5) * 3);
    }
    if (wet) {
      // Puddles: darker, and mirror-smooth.
      for (let k = 0; k < 26; k++) {
        c.fillStyle = rough ? 'rgba(10,10,10,0.85)' : 'rgba(20,24,28,0.55)';
        c.beginPath();
        c.ellipse(hash(k + 40) * N, hash(k + 41) * N, 40 + hash(k + 42) * 140, 20 + hash(k + 43) * 70, hash(k + 44) * Math.PI, 0, Math.PI * 2);
        c.fill();
      }
    } else {
      // Water streaks running down from the top, and formwork joints.
      for (let k = 0; k < 60; k++) {
        const x = hash(k + 60) * N;
        const g = c.createLinearGradient(0, 0, 0, N * (0.3 + hash(k + 61) * 0.7));
        g.addColorStop(0, rough ? 'rgba(255,255,255,0.2)' : 'rgba(30,28,26,0.35)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        c.fillStyle = g;
        c.fillRect(x, 0, 4 + hash(k + 62) * 22, N);
      }
      c.strokeStyle = rough ? 'rgba(255,255,255,0.4)' : 'rgba(40,40,40,0.5)';
      c.lineWidth = 3;
      for (let k = 0; k <= N; k += N / 2) {
        c.beginPath();
        c.moveTo(0, k);
        c.lineTo(N, k);
        c.stroke();
      }
      for (const [x, y] of [[N / 4, N / 4], [(3 * N) / 4, N / 4], [N / 4, (3 * N) / 4], [(3 * N) / 4, (3 * N) / 4]]) {
        c.fillStyle = rough ? 'rgb(120,120,120)' : 'rgb(56,57,58)';
        c.beginPath();
        c.arc(x, y, 9, 0, Math.PI * 2);
        c.fill();
      }
    }
  };
  const map = canvasTexture(N, N, (c) => draw(c, false));
  const rough = data(canvasTexture(N, N, (c) => draw(c, true)));
  for (const t of [map, rough]) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return { map, rough };
}

/** A sign: text on a plate, lit (neon tubes, LED panels) or printed. */
function signTexture(text: string, o: { w: number; h: number; fg: string; bg: string; font: string; glow?: boolean }): THREE.Texture {
  return canvasTexture(o.w, o.h, (c) => {
    c.fillStyle = o.bg;
    c.fillRect(0, 0, o.w, o.h);
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = o.font;
    if (o.glow) {
      c.shadowColor = o.fg;
      c.shadowBlur = 18;
    }
    c.fillStyle = o.fg;
    const lines = text.split('\n');
    lines.forEach((l, i) => c.fillText(l, o.w / 2, (o.h * (i + 0.5)) / lines.length));
  });
}

// ---- Environments ---------------------------------------------------------------------------------

function panel(scene: THREE.Scene, w: number, h: number, color: number, at: [number, number, number]) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }));
  m.position.set(...at);
  m.lookAt(0, 0, 0);
  scene.add(m);
}

/** A dim industrial hall: grey overhead skylights, one cold and one sodium-warm practical light. */
const hangar = () =>
  studioEnvironment('marble-race-3d-hangar-2', (scene) => {
    scene.add(new THREE.Mesh(new THREE.SphereGeometry(20, 32, 16), new THREE.MeshBasicMaterial({ color: 0x0b0d0f, side: THREE.BackSide })));
    panel(scene, 7, 2.5, 0x7d8a94, [0, 9, 2]);
    panel(scene, 1, 8, 0x5f8f95, [-7, 2, 1]);
    panel(scene, 1.2, 6, 0xa8743a, [7, 1, -1]);
    panel(scene, 10, 1.2, 0x2a2e33, [0, -4, 7]);
  });

/** Bright overcast snowfield: a white sky, a pale blue horizon, snow below. */
const snowfield = () =>
  studioEnvironment('marble-race-3d-snow', (scene) => {
    const g = new THREE.SphereGeometry(20, 48, 24);
    const pos = g.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const u = pos.getY(i) / 20;
      const c = u > 0 ? new THREE.Color(0xcfdceb).lerp(new THREE.Color(0xffffff), Math.min(1, u * 1.6)) : new THREE.Color(0xdfe6ee).lerp(new THREE.Color(0xf6f8fa), Math.min(1, -u * 2));
      colors.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    scene.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
    panel(scene, 5, 5, 0xfff6e8, [6, 7, 4]);
  });

// ---- Kits -----------------------------------------------------------------------------------------

export interface Kit {
  env: THREE.Texture;
  envIntensity: number;
  /** Opaque scene background (null: the video theme's gradient shows through). */
  background: THREE.Color | null;
  /** Haze colour (distance fog), if any. */
  haze: THREE.Color | null;
  floor: (hue: number) => THREE.Material;
  /** Turns, helixes and funnels (lathe-mapped meshes). */
  turn: (hue: number) => THREE.Material;
  /** Lane walls: drawn as clear sheets showing only their edges (photoreal looks), or as a material. */
  wall: { edges: THREE.Color; opacity: number } | THREE.Material;
  /** A strip along the top of every wall (a rail cap, a light strip, a ridge of snow). */
  wallCap: THREE.Material | null;
  capHeight: number;
  peg: THREE.Material;
  pad: THREE.Material;
  gate: THREE.Material;
  spinner: THREE.Material;
  line: THREE.Material;
  finishLine: THREE.Material;
  marble: (team: Team) => THREE.Object3D;
  /** Team-coloured outlines that show through the track (the stylised look only). */
  outlines: boolean;
  /** Edges drawn round turns and funnels (the stylised look only). */
  meshEdges: THREE.Color | null;
  /** Brackets holding each lane to the wall behind (null: free-standing). */
  bracket: THREE.Material | null;
  backdrop: THREE.Material | null;
  ground: THREE.Material | null;
  bench: THREE.Material | null;
  lights: (scene: THREE.Scene) => THREE.DirectionalLight;
  /** Extra set dressing on and around the wall behind the tower. */
  dress?: (scene: THREE.Scene, b: { minX: number; maxX: number; top: number; bottom: number; wallZ: number }) => void;
  post: { composed: boolean; exposure: number; toneMapping: THREE.ToneMapping; aperture: number };
  snow: boolean;
  banner: { text: string; back: string };
}

function paintedMarble(team: Team, o: { roughness: number; metalness?: number }) {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(R, 48, 32),
    new THREE.MeshPhysicalMaterial({ map: marbleTexture(team), roughness: o.roughness, metalness: o.metalness ?? 0, clearcoat: 1, clearcoatRoughness: 0.03 }),
  );
  m.castShadow = true;
  return m;
}

/** Colour teams in the classic look race real glass cat's-eye marbles. */
function glassMarble(team: Team) {
  const c = new THREE.Color(team.color);
  const g = new THREE.Group();
  const vane = new THREE.Mesh(vaneGeometry(R), new THREE.MeshStandardMaterial({ color: c, roughness: 0.4, side: THREE.DoubleSide }));
  const ball = new THREE.Mesh(
    new THREE.SphereGeometry(R, 48, 32),
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.03, transmission: 1, ior: 1.52, thickness: R * 1.8, attenuationColor: c.clone().lerp(new THREE.Color(0xffffff), 0.3), attenuationDistance: 0.02, clearcoat: 1 }),
  );
  ball.castShadow = true;
  g.add(vane, ball);
  return g;
}

const composed = (exposure: number, aperture: number) => ({ composed: true, exposure, toneMapping: THREE.AgXToneMapping, aperture });

function shadowed(key: THREE.DirectionalLight) {
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 0.05;
  key.shadow.camera.far = 6;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.01;
  key.shadow.radius = 4;
  return key;
}

function classic(): Kit {
  const tones: [number, number, number][][] = [
    [[198, 152, 98], [110, 66, 30]], // maple
    [[160, 88, 56], [80, 36, 18]], // cherry
    [[184, 156, 112], [112, 86, 54]], // oak
  ];
  const woods = tones.map(([base, dark], i) => new THREE.MeshPhysicalMaterial({ map: woodTexture(base, dark, 10 + i), roughness: 0.52, clearcoat: 0.3, clearcoatRoughness: 0.35 }));
  const walnut = new THREE.MeshPhysicalMaterial({ map: woodTexture([110, 72, 45], [45, 26, 14], 2), roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.35 });
  const ply = woodTexture([206, 176, 136], [140, 104, 66], 3);
  ply.repeat.set(2.4, 3);
  const brass = new THREE.MeshPhysicalMaterial({ color: 0xc9a352, metalness: 0.9, roughness: 0.38, anisotropy: 0.6, side: THREE.DoubleSide });
  const copper = new THREE.MeshPhysicalMaterial({ color: 0xc27a52, metalness: 0.9, roughness: 0.36, anisotropy: 0.6, side: THREE.DoubleSide });
  return {
    env: studio(),
    envIntensity: 0.9,
    background: new THREE.Color(0x141317),
    haze: null,
    floor: (hue) => woods[Math.floor(hue * 2.999)],
    turn: (hue) => (hue < 0.5 ? brass : copper),
    wall: { edges: new THREE.Color(0xdfeeff), opacity: 0.32 },
    wallCap: walnut,
    capHeight: 0.004,
    peg: brass,
    pad: new THREE.MeshStandardMaterial({ color: 0x1d5a3a, roughness: 1 }),
    gate: brass,
    spinner: walnut,
    line: new THREE.MeshStandardMaterial({ color: 0xf2efe6, roughness: 0.6 }),
    finishLine: new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.6 }),
    marble: (team) => (team.icon ? paintedMarble(team, { roughness: 0.2 }) : glassMarble(team)),
    outlines: false,
    meshEdges: null,
    bracket: brass,
    backdrop: new THREE.MeshPhysicalMaterial({ map: ply, color: 0x5a4a3c, roughness: 0.75 }),
    ground: new THREE.MeshStandardMaterial({ color: 0x232126, roughness: 0.95 }),
    bench: walnut,
    lights: (scene) => {
      scene.add(new THREE.HemisphereLight(0xfff4e6, 0x2a2420, 0.25));
      const key = shadowed(new THREE.DirectionalLight(0xffe9cf, 2.1));
      const fill = new THREE.DirectionalLight(0xcfdcff, 0.35);
      fill.position.set(-2, 1, 3);
      const rim = new THREE.DirectionalLight(0xfff5e8, 1.1);
      rim.position.set(-0.6, 3, -2.5);
      scene.add(key, key.target, fill, rim);
      return key;
    },
    post: composed(0.95, 0.008),
    snow: false,
    banner: { text: '#f4ead8', back: 'rgba(30,20,12,0.7)' },
  };
}

/**
 * Futuristic, grounded: an industrial test rig in a dim, damp hall, more Blade Runner than Tron.
 * Worn painted-steel deck plates, gunmetal turns, smoked polycarbonate sides on steel rails,
 * hazard-striped bollards and bars, a stained concrete wall carrying pipes, conduit and signs, a
 * few practical lights, and a wet floor. Colour comes from the light (cold steel, sodium amber,
 * a little teal and a pink sign), not from glowing geometry.
 */
function futuristic(): Kit {
  const plates = ([[96, 100, 104], [104, 100, 90], [84, 92, 100]] as [number, number, number][]).map((paint, i) => {
    const t = plateTextures(40 + i * 17, paint);
    // A plate texture tile covers 0.33 m (about two plates across a lane).
    return new THREE.MeshPhysicalMaterial({ map: t.map, roughnessMap: t.rough, bumpMap: t.bump, bumpScale: 0.8, roughness: 0.9, metalness: 0.35, clearcoat: 0.15, clearcoatRoughness: 0.6 });
  });
  const gun = plateTextures(91, [120, 124, 128]);
  for (const t of [gun.map, gun.rough, gun.bump]) t.repeat.set(1, 1);
  const gunmetal = new THREE.MeshPhysicalMaterial({ map: gun.map, roughnessMap: gun.rough, bumpMap: gun.bump, bumpScale: 0.5, color: 0xe4e8ec, metalness: 0.55, roughness: 0.7, anisotropy: 0.3, side: THREE.DoubleSide });
  const gunmetalDark = gunmetal.clone();
  gunmetalDark.color = new THREE.Color(0xb4b9be);
  // Hazard stripes: a few round each bollard, and a few along each bar.
  const hazardMat = (u: number, v: number) => {
    const t = hazardTexture();
    t.repeat.set(u, v);
    return new THREE.MeshPhysicalMaterial({ map: t, roughness: 0.6, metalness: 0.2 });
  };
  const bars = hazardMat(8, 8);
  const wall = concreteTextures(false);
  wall.map.repeat.set(2.6 / 1.2, 3);
  wall.rough.repeat.copy(wall.map.repeat);
  const floor = concreteTextures(true);
  floor.map.repeat.set(12, 12);
  floor.rough.repeat.set(12, 12);
  const steel = new THREE.MeshPhysicalMaterial({ color: 0x8b9096, metalness: 0.95, roughness: 0.35, anisotropy: 0.5 });
  return {
    env: hangar(),
    envIntensity: 1.2,
    background: new THREE.Color(0x0a0d10),
    haze: new THREE.Color(0x0e1418),
    floor: (hue) => plates[Math.floor(hue * 2.999)],
    turn: (hue) => (hue < 0.5 ? gunmetal : gunmetalDark),
    wall: { edges: new THREE.Color(0x9aa6b0), opacity: 0.2 },
    wallCap: steel,
    capHeight: 0.0035,
    peg: hazardMat(1, 0.5),
    pad: new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.92 }),
    gate: bars,
    spinner: bars,
    line: new THREE.MeshStandardMaterial({ color: 0xd9a514, roughness: 0.7 }),
    finishLine: new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.7 }),
    marble: (team) => paintedMarble(team, { roughness: 0.14, metalness: 0.05 }),
    outlines: false,
    meshEdges: null,
    bracket: steel,
    backdrop: new THREE.MeshPhysicalMaterial({ map: wall.map, roughnessMap: wall.rough, roughness: 1, color: 0x9a9ea2 }),
    ground: new THREE.MeshPhysicalMaterial({ map: floor.map, roughnessMap: floor.rough, roughness: 1, metalness: 0.1, color: 0x7c8084 }),
    bench: null,
    lights: (scene) => {
      scene.add(new THREE.HemisphereLight(0x8fa0ad, 0x1a1d20, 0.45));
      // Cold overhead work light, a sodium-amber practical to one side, a teal bounce to the other.
      const key = shadowed(new THREE.DirectionalLight(0xdfe8f2, 2.8));
      const amber = new THREE.DirectionalLight(0xffa04a, 1.1);
      amber.position.set(2.5, 0.6, 0.6);
      const teal = new THREE.DirectionalLight(0x5fb6b8, 0.7);
      teal.position.set(-2.5, 1, 0.4);
      scene.add(key, key.target, amber, teal);
      return key;
    },
    dress: (scene, b) => dressIndustrial(scene, b, steel),
    post: composed(1.2, 0.008),
    snow: false,
    banner: { text: '#ffb347', back: 'rgba(10,10,10,0.75)' },
  };
}

/** Pipes, conduit, cable trays, signs and practical lights on the wall behind the futuristic tower. */
function dressIndustrial(scene: THREE.Scene, b: { minX: number; maxX: number; top: number; bottom: number; wallZ: number }, steel: THREE.Material) {
  const h = b.top - b.bottom + 1;
  const midY = (b.top + b.bottom) / 2;
  const cx = (b.minX + b.maxX) / 2;
  const add = (m: THREE.Mesh, cast = true) => {
    m.castShadow = cast;
    m.receiveShadow = true;
    scene.add(m);
    return m;
  };
  // Vertical pipes either side and behind the tower, held by clamps.
  const pipes: [number, number, number][] = [
    [cx - 0.52, 0.03, 0x5b2f2a],
    [cx - 0.44, 0.016, 0x3d4a52],
    [cx + 0.47, 0.024, 0x4a4f44],
    [cx + 0.56, 0.012, 0x7a7f86],
    [cx - 0.02, 0.01, 0x3d4a52],
  ];
  for (const [x, r, col] of pipes) {
    const mat = new THREE.MeshPhysicalMaterial({ color: col, metalness: 0.6, roughness: 0.55, clearcoat: 0.2 });
    const p = add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 24), mat));
    p.position.set(x, midY, b.wallZ + r + 0.004);
    for (let y = b.bottom - 0.4; y < b.top + 0.4; y += 0.32) {
      const clamp = add(new THREE.Mesh(new THREE.TorusGeometry(r + 0.002, 0.003, 8, 24), steel), false);
      clamp.position.set(x, y, b.wallZ + r + 0.004);
      clamp.rotation.x = Math.PI / 2;
    }
  }
  // Horizontal conduit runs and a cable tray.
  for (let y = b.bottom + 0.15; y < b.top; y += 0.55) {
    const c = add(new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1.6, 12), steel));
    c.rotation.z = Math.PI / 2;
    c.position.set(cx, y, b.wallZ + 0.008);
    const tray = add(new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.004, 0.05), steel));
    tray.position.set(cx, y + 0.24, b.wallZ + 0.025);
    // A bundle of cables lying in it.
    for (let k = 0; k < 5; k++) {
      const cable = add(new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 1.6, 8), new THREE.MeshStandardMaterial({ color: [0x111111, 0x1c1c1c, 0x3a2a12, 0x0e1a24, 0x161616][k], roughness: 0.7 })), false);
      cable.rotation.z = Math.PI / 2;
      cable.position.set(cx, y + 0.246, b.wallZ + 0.008 + k * 0.009);
    }
  }
  // Signs: a pink neon kanji sign, a lit bay number, a printed warning plate.
  const sign = (tex: THREE.Texture, w: number, hh: number, x: number, y: number, lit: boolean) => {
    const mat = lit ? new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }) : new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6, metalness: 0.2 });
    const m = add(new THREE.Mesh(new THREE.PlaneGeometry(w, hh), mat), false);
    m.position.set(x, y, b.wallZ + 0.003);
    return m;
  };
  sign(signTexture('競\n走', { w: 128, h: 256, fg: '#ff4f9a', bg: '#0b0709', font: '900 96px sans-serif', glow: true }), 0.07, 0.14, cx - 0.36, b.top - 0.25, true);
  sign(signTexture('BAY 07', { w: 256, h: 96, fg: '#9fe6e8', bg: '#0b1214', font: '700 54px monospace', glow: true }), 0.12, 0.045, cx + 0.38, b.top - 0.6, true);
  sign(signTexture('CAUTION\nMOVING PARTS', { w: 256, h: 160, fg: '#111111', bg: '#d9a514', font: '900 34px sans-serif' }), 0.1, 0.062, cx - 0.4, midY, false);
  sign(signTexture('MR-3D TEST RIG\nLOAD 16 / CLASS B', { w: 256, h: 96, fg: '#c8cdd2', bg: '#1b1f23', font: '600 24px monospace' }), 0.12, 0.045, cx + 0.42, midY - 0.3, false);
  // Practical lights: caged tube fittings on the wall, every so often down the tower.
  for (let y = b.top - 0.1; y > b.bottom - 0.3; y -= 0.45) {
    for (const x of [cx - 0.45, cx + 0.45]) {
      const warm = Math.round((y * 7 + x * 3) * 10) % 3 === 0;
      const tube = add(new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 0.14, 12), new THREE.MeshBasicMaterial({ color: warm ? 0xffc27a : 0xd8f2ff, toneMapped: false })), false);
      tube.rotation.z = Math.PI / 2;
      tube.position.set(x, y, b.wallZ + 0.02);
      const housing = add(new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.012, 0.012), steel), false);
      housing.position.set(x, y + 0.01, b.wallZ + 0.012);
    }
  }
}

function arctic(): Kit {
  const iceMap = iceTexture(false);
  const iceBump = iceTexture(true);
  iceMap.repeat.set(3, 3);
  iceBump.repeat.set(3, 3);
  const snowMap = snowTexture(false);
  const snowBump = snowTexture(true);
  const ice = (tint: number) =>
    new THREE.MeshPhysicalMaterial({ map: iceMap, color: tint, bumpMap: iceBump, bumpScale: 0.6, roughness: 0.1, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.03, ior: 1.31, specularIntensity: 1, sheen: 0.4, sheenColor: new THREE.Color(0xe8f6ff), side: THREE.DoubleSide });
  // Glacier blue, deepening down the tower.
  const ices = [0x86c3e6, 0x6db1dd, 0x5aa0cf].map(ice);
  const snow = new THREE.MeshStandardMaterial({ map: snowMap, bumpMap: snowBump, bumpScale: 1.2, roughness: 0.92 });
  const groundSnow = new THREE.MeshStandardMaterial({ map: tile(snowTexture(false), 40), bumpMap: tile(snowTexture(true), 40), bumpScale: 1.5, roughness: 0.95 });
  const wallIce = ice(0x6f98b8);
  (wallIce.map as THREE.Texture).repeat.set(3, 3);
  return {
    env: snowfield(),
    envIntensity: 0.55,
    background: new THREE.Color(0x6d8daa),
    haze: new THREE.Color(0x89a3ba),
    floor: (hue) => ices[Math.floor(hue * 2.999)],
    turn: (hue) => ices[Math.floor(hue * 2.999)],
    wall: { edges: new THREE.Color(0xd8f0ff), opacity: 0.35 },
    wallCap: snow,
    capHeight: 0.006,
    peg: ice(0xb9e1f6),
    pad: snow,
    gate: new THREE.MeshPhysicalMaterial({ color: 0xb8bec6, metalness: 0.9, roughness: 0.35 }),
    spinner: ice(0xb0d8f0),
    line: new THREE.MeshStandardMaterial({ color: 0xd62a32, roughness: 0.5 }),
    finishLine: new THREE.MeshStandardMaterial({ map: checkerTexture(), roughness: 0.5 }),
    marble: (team) => paintedMarble(team, { roughness: 0.16 }),
    outlines: false,
    meshEdges: null,
    bracket: new THREE.MeshPhysicalMaterial({ color: 0xc7ced6, metalness: 0.9, roughness: 0.4 }),
    backdrop: wallIce,
    ground: groundSnow,
    bench: null,
    lights: (scene) => {
      scene.add(new THREE.HemisphereLight(0xcfe0f2, 0xf4f7fa, 0.35));
      // Low winter sun: hard, warm light and long blue shadows.
      const key = shadowed(new THREE.DirectionalLight(0xffe8c8, 3));
      const sky = new THREE.DirectionalLight(0xbcd6f0, 0.5);
      sky.position.set(-2, 2, 1);
      scene.add(key, key.target, sky);
      return key;
    },
    post: composed(0.85, 0.007),
    snow: true,
    banner: { text: '#ffffff', back: 'rgba(20,40,64,0.7)' },
  };
}

function neon(theme: Theme): Kit {
  const accent = new THREE.Color(theme.accent);
  const paints = new Map<number, THREE.Material>();
  const paint = (hue: number) => {
    const k = Math.round(hue * 100);
    let m = paints.get(k);
    if (!m) {
      // A shade darker than the palette: bright neon floors under light (and bloom) wash out white.
      m = new THREE.MeshStandardMaterial({ color: rgb(mixRgb(paletteAt(theme.palette, hue), [0, 0, 0], 0.35)), roughness: 0.62, side: THREE.DoubleSide, envMapIntensity: 0.22 });
      paints.set(k, m);
    }
    return m;
  };
  return {
    env: environmentMap(),
    envIntensity: 1,
    background: null,
    haze: new THREE.Color(theme.bg[1]),
    floor: paint,
    turn: paint,
    wall: new THREE.MeshPhysicalMaterial({ color: rgb(lighten(paletteAt(theme.palette, 0.5), 0.5)), transparent: true, opacity: 0.14, roughness: 0.05, depthWrite: false, envMapIntensity: 0.5 }),
    wallCap: new THREE.MeshBasicMaterial({ color: accent }),
    capHeight: 0.0016,
    peg: new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.35, metalness: 0.3, roughness: 0.3, envMapIntensity: 0.4 }),
    pad: new THREE.MeshStandardMaterial({ color: rgb(mixRgb(paletteAt(theme.palette, 0.5), [0, 0, 0], 0.7)), roughness: 1 }),
    gate: new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: new THREE.Color(0xffffff), emissiveIntensity: 0.9, roughness: 0.3, transparent: true, opacity: 0.85 }),
    spinner: new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.6, roughness: 0.3 }),
    line: new THREE.MeshBasicMaterial({ color: accent }),
    finishLine: new THREE.MeshBasicMaterial({ map: checkerTexture() }),
    marble: (team) => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(R, 40, 24), new THREE.MeshPhysicalMaterial({ map: marbleTexture(team), roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.05, envMapIntensity: 0.6 }));
      m.castShadow = true;
      return m;
    },
    outlines: true,
    meshEdges: accent,
    bracket: null,
    backdrop: null,
    ground: null,
    bench: null,
    lights: (scene) => {
      scene.add(new THREE.HemisphereLight(new THREE.Color('#ffffff'), new THREE.Color(theme.bg[1]), 0.25));
      const key = shadowed(new THREE.DirectionalLight(0xffffff, 0.8));
      const rim = new THREE.DirectionalLight(accent, 0.45);
      rim.position.set(-0.6, 0.3, -0.8);
      scene.add(key, key.target, rim);
      return key;
    },
    post: { composed: false, exposure: 0.85, toneMapping: THREE.ACESFilmicToneMapping, aperture: 0 },
    snow: false,
    banner: { text: theme.accent, back: 'rgba(0,0,0,0.45)' },
  };
}

export function kitFor(look: LookId, theme: Theme): Kit {
  switch (look) {
    case 'classic':
      return classic();
    case 'futuristic':
      return futuristic();
    case 'arctic':
      return arctic();
    case 'neon':
      return neon(theme);
  }
}
