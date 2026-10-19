/**
 * Cabin Storm scene. PLACEHOLDER look (Phase 1): a simple room, shader fire, rain on a window and
 * lightning, enough to drive the long-form pipeline. Every frame is a pure function of t and the
 * cue schedule, and everything that moves repeats exactly over the loop:
 *   - fire noise walks a circle in noise space (one lap per loop),
 *   - flicker, embers and rain complete whole cycles per loop,
 *   - a flash's age is measured modulo the loop, so a strike near the end lights the start too.
 */
import type { RenderCtx } from '@sim/engine';
import { THREE, canvasTexture, draw3D, sceneCache } from '../three-layer';
import type { CabinState } from './index';

/** 4D simplex noise (Ashima / Stefan Gustavson, MIT). */
const NOISE4 = /* glsl */ `
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
float mod289(float x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+10.0)*x);}
float permute(float x){return mod289(((x*34.0)+10.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float taylorInvSqrt(float r){return 1.79284291400159-0.85373472095314*r;}
vec4 grad4(float j, vec4 ip){const vec4 ones=vec4(1.0,1.0,1.0,-1.0);vec4 p,s;p.xyz=floor(fract(vec3(j)*ip.xyz)*7.0)*ip.z-1.0;p.w=1.5-dot(abs(p.xyz),ones.xyz);s=vec4(lessThan(p,vec4(0.0)));p.xyz=p.xyz+(s.xyz*2.0-1.0)*s.www;return p;}
#define F4 0.309016994374947451
float snoise(vec4 v){const vec4 C=vec4(0.138196601125011,0.276393202250021,0.414589803375032,-0.447213595499958);
vec4 i=floor(v+dot(v,vec4(F4)));vec4 x0=v-i+dot(i,C.xxxx);vec4 i0;vec3 isX=step(x0.yzw,x0.xxx);vec3 isYZ=step(x0.zww,x0.yyz);
i0.x=isX.x+isX.y+isX.z;i0.yzw=1.0-isX;i0.y+=isYZ.x+isYZ.y;i0.zw+=1.0-isYZ.xy;i0.z+=isYZ.z;i0.w+=1.0-isYZ.z;
vec4 i3=clamp(i0,0.0,1.0);vec4 i2=clamp(i0-1.0,0.0,1.0);vec4 i1=clamp(i0-2.0,0.0,1.0);
vec4 x1=x0-i1+C.xxxx;vec4 x2=x0-i2+C.yyyy;vec4 x3=x0-i3+C.zzzz;vec4 x4=x0+C.wwww;i=mod289(i);
float j0=permute(permute(permute(permute(i.w)+i.z)+i.y)+i.x);
vec4 j1=permute(permute(permute(permute(i.w+vec4(i1.w,i2.w,i3.w,1.0))+i.z+vec4(i1.z,i2.z,i3.z,1.0))+i.y+vec4(i1.y,i2.y,i3.y,1.0))+i.x+vec4(i1.x,i2.x,i3.x,1.0));
vec4 ip=vec4(1.0/294.0,1.0/49.0,1.0/7.0,0.0);vec4 p0=grad4(j0,ip);vec4 p1=grad4(j1.x,ip);vec4 p2=grad4(j1.y,ip);vec4 p3=grad4(j1.z,ip);vec4 p4=grad4(j1.w,ip);
vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;p4*=taylorInvSqrt(dot(p4,p4));
vec3 m0=max(0.6-vec3(dot(x0,x0),dot(x1,x1),dot(x2,x2)),0.0);vec2 m1=max(0.6-vec2(dot(x3,x3),dot(x4,x4)),0.0);m0=m0*m0;m1=m1*m1;
return 49.0*(dot(m0*m0,vec3(dot(p0,x0),dot(p1,x1),dot(p2,x2)))+dot(m1*m1,vec2(dot(p3,x3),dot(p4,x4))));}
`;

const hash = (n: number) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** A point on a circle in noise space: one lap per loop, moving `speed` noise units per second. */
function timeCircle(out: THREE.Vector2, t: number, L: number, speed: number) {
  const R = (speed * L) / (2 * Math.PI);
  const a = (2 * Math.PI * t) / L;
  return out.set(R * Math.cos(a), R * Math.sin(a));
}

/** A frequency rounded to a whole number of cycles per loop. */
const perLoop = (hz: number, L: number) => Math.max(1, Math.round(hz * L)) / L;

/** Brightest flash allowed (fraction of full white on the sky), so lightning never glares. */
const FLASH_CAP = 0.7;

function flashAt(s: CabinState, t: number): { amount: number; x: number } {
  let amount = 0;
  let x = 0.5;
  for (const st of s.strikes) {
    const age = (((t - st.t) % s.loopS) + s.loopS) % s.loopS;
    if (age > 1) continue;
    for (const p of st.pulses) {
      const d = age - p;
      if (d < 0) continue;
      const a = st.strength * Math.exp(-d * 7) * (d < 0.03 ? d / 0.03 : 1);
      if (a > amount) {
        amount = a;
        x = st.x;
      }
    }
  }
  return { amount: Math.min(FLASH_CAP, amount), x };
}

const view = sceneCache((s: CabinState) => {
  const L = s.loopS;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050403);
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 100);
  camera.position.set(0, 1.6, 5.5);
  camera.lookAt(0, 1.3, 0);

  const woodMap = canvasTexture(512, 512, (g) => {
    for (let y = 0; y < 512; y += 64) {
      g.fillStyle = `hsl(25, 45%, ${18 + hash(y) * 10}%)`;
      g.fillRect(0, y, 512, 62);
      for (let k = 0; k < 40; k++) {
        g.strokeStyle = `rgba(0,0,0,${0.08 + hash(y + k) * 0.1})`;
        g.beginPath();
        g.moveTo(0, y + hash(k * 3 + y) * 62);
        g.lineTo(512, y + hash(k * 7 + y) * 62);
        g.stroke();
      }
    }
  });
  woodMap.wrapS = woodMap.wrapT = THREE.RepeatWrapping;
  woodMap.repeat.set(3, 2);
  woodMap.colorSpace = THREE.SRGBColorSpace;
  const wood = new THREE.MeshStandardMaterial({ map: woodMap, roughness: 0.85, side: THREE.BackSide });
  const room = new THREE.Mesh(new THREE.BoxGeometry(10, 5, 10), wood);
  room.position.set(0, 2.5, 0);
  room.receiveShadow = true;
  scene.add(room);

  const stone = new THREE.MeshStandardMaterial({ color: 0x55504a, roughness: 0.95 });
  for (const [x, w] of [[-0.95, 0.5], [0.95, 0.5]] as const) {
    const jamb = new THREE.Mesh(new THREE.BoxGeometry(w, 1.2, 0.8), stone);
    jamb.position.set(x, 0.6, -4.6);
    jamb.castShadow = jamb.receiveShadow = true;
    scene.add(jamb);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.0, 0.8), stone);
  lintel.position.set(0, 1.7, -4.6);
  lintel.castShadow = lintel.receiveShadow = true;
  scene.add(lintel);
  const back = new THREE.Mesh(new THREE.PlaneGeometry(1.4, 1.2), new THREE.MeshStandardMaterial({ color: 0x0c0806, roughness: 1 }));
  back.position.set(0, 0.6, -4.95);
  scene.add(back);
  for (const [x, z, w, h, d] of [[-2.2, -1.5, 1.2, 1, 1.2], [2.0, -1.8, 1.4, 0.8, 0.8], [0.4, 0.2, 0.9, 0.5, 0.9]] as const) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshStandardMaterial({ color: 0x5a3020, roughness: 0.8 }));
    b.position.set(x, h / 2, z);
    b.castShadow = b.receiveShadow = true;
    scene.add(b);
  }

  const fireMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    uniforms: { uTime: { value: new THREE.Vector2() }, uRise: { value: new THREE.Vector2() }, uSize: { value: s.p.fire } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `${NOISE4}
      varying vec2 vUv; uniform vec2 uTime; uniform vec2 uRise; uniform float uSize;
      void main(){
        vec2 p = vUv * vec2(3.0, 4.0);
        float n = 0.0, amp = 0.5;
        vec4 q = vec4(p, uTime);
        for (int i = 0; i < 4; i++) { n += amp * snoise(q + vec4(0.0, 0.0, uRise)); q *= 2.0; amp *= 0.5; }
        float h = 0.55 + 0.45 * uSize;
        float shape = 1.0 - smoothstep(0.0, 0.5, abs(vUv.x - 0.5) * (1.4 + vUv.y * 2.0 / h));
        float f = clamp(shape * (1.0 - vUv.y / h) * 1.6 + n * 0.6 - vUv.y * 0.4, 0.0, 1.0);
        vec3 col = mix(vec3(0.9, 0.2, 0.02), vec3(1.0, 0.85, 0.4), f * f);
        gl_FragColor = vec4(col * f * 1.6, f);
      }`,
  });
  for (let k = 0; k < 3; k++) {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 1.0), fireMat);
    plane.position.set(0, 0.5, -4.55);
    plane.rotation.y = (k * Math.PI) / 3;
    scene.add(plane);
  }

  const fireLight = new THREE.PointLight(0xff8a3a, 30, 14, 1.6);
  fireLight.position.set(0, 0.8, -3.9);
  fireLight.castShadow = true;
  fireLight.shadow.mapSize.set(1024, 1024);
  scene.add(fireLight);
  scene.add(new THREE.AmbientLight(0x223044, 0.15));

  const rainMat = new THREE.ShaderMaterial({
    uniforms: { uPhase: { value: 0 }, uL: { value: L }, uFlash: { value: 0 }, uRain: { value: s.p.storm } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: `varying vec2 vUv; uniform float uPhase; uniform float uL; uniform float uFlash; uniform float uRain;
      float h(float n){ return fract(sin(n*127.1)*43758.5453); }
      void main(){
        vec3 sky = mix(vec3(0.01,0.015,0.03), vec3(0.03,0.04,0.07), vUv.y) + uFlash * vec3(0.6,0.65,0.8);
        float rain = 0.0;
        for (int layer = 0; layer < 3; layer++) {
          float cols = 80.0 + float(layer) * 60.0;
          float cx = floor(vUv.x * cols);
          float cycles = floor((1.2 + h(cx + float(layer) * 17.0)) * uL + 0.5); // whole cycles per loop
          // uPhase = t / loopS (0..1); cycles * uPhase stays small enough for float32 even on hour loops.
          float y = fract(vUv.y + fract(cycles * uPhase) + h(cx * 3.1));
          float fx = abs(fract(vUv.x * cols) - 0.5);
          rain += smoothstep(0.08, 0.0, fx) * smoothstep(0.0, 0.04, y) * smoothstep(0.12, 0.04, y) * 0.35;
        }
        gl_FragColor = vec4(sky + rain * (0.1 + 0.15 * uRain + uFlash), 1.0);
      }`,
  });
  const win = new THREE.Mesh(new THREE.PlaneGeometry(3, 2.2), rainMat);
  win.position.set(4.95, 2.2, -1);
  win.rotation.y = -Math.PI / 2;
  scene.add(win);
  const flashLight = new THREE.DirectionalLight(0xa8b8ff, 0);
  flashLight.position.set(8, 4, -1);
  scene.add(flashLight);

  const EMBERS = 200;
  const emberGeo = new THREE.BufferGeometry();
  const emberPos = new Float32Array(EMBERS * 3);
  emberGeo.setAttribute('position', new THREE.BufferAttribute(emberPos, 3));
  scene.add(new THREE.Points(emberGeo, new THREE.PointsMaterial({ color: 0xffa040, size: 0.03, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false })));
  const emberPeriod = Array.from({ length: EMBERS }, (_, i) => L / Math.max(1, Math.round(L / (2 + hash(i) * 3))));

  // Film grain against banding in the dark: a few noise tiles, a different one and offset every frame.
  const grain = Array.from({ length: 4 }, (_, k) => {
    const c = typeof document !== 'undefined' ? Object.assign(document.createElement('canvas'), { width: 256, height: 256 }) : new OffscreenCanvas(256, 256);
    const g = c.getContext('2d') as CanvasRenderingContext2D;
    const img = g.createImageData(256, 256);
    for (let i = 0; i < img.data.length; i += 4) {
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.floor(hash(i * 0.013 + k * 91.7) * 255);
      img.data[i + 3] = 14;
    }
    g.putImageData(img, 0, 0);
    return c;
  });

  return { scene, camera, fireMat, fireLight, rainMat, flashLight, emberGeo, emberPos, emberPeriod, grain, patterns: new Map<unknown, CanvasPattern>() };
});

export function drawCabin(rc: RenderCtx, s: CabinState) {
  const v = view(s, rc.theme);
  const L = s.loopS;
  const t = rc.t;
  timeCircle(v.fireMat.uniforms.uTime.value, t, L, 0.6);
  timeCircle(v.fireMat.uniforms.uRise.value, t, L, 1.4);
  const w = (hz: number) => 2 * Math.PI * perLoop(hz, L) * t;
  const flick = 0.75 + 0.12 * Math.sin(w(1.3)) + 0.08 * Math.sin(w(3.7) + 1) + 0.05 * Math.sin(w(7.9) + 2);
  v.fireLight.intensity = 30 * (0.5 + 0.5 * s.p.fire) * flick;
  const flash = flashAt(s, t);
  v.rainMat.uniforms.uPhase.value = t / L;
  v.rainMat.uniforms.uFlash.value = flash.amount;
  v.flashLight.intensity = flash.amount * 2.5;
  for (let i = 0; i < v.emberPeriod.length; i++) {
    const period = v.emberPeriod[i];
    const ph = ((t + hash(i + 7) * period) % period) / period;
    v.emberPos[i * 3] = (hash(i + 3) - 0.5) * 0.8 + Math.sin(ph * 12 + i) * 0.08;
    v.emberPos[i * 3 + 1] = 0.3 + ph * 2.0;
    v.emberPos[i * 3 + 2] = -4.4 + (hash(i + 5) - 0.5) * 0.4;
  }
  v.emberGeo.attributes.position.needsUpdate = true;
  v.camera.aspect = rc.width / rc.height;
  v.camera.updateProjectionMatrix();
  draw3D(rc.ctx, v.scene, v.camera);

  const ctx = rc.ctx;
  const tile = v.grain[rc.frame % 4];
  let pattern = v.patterns.get(tile);
  if (!pattern) {
    pattern = ctx.createPattern(tile as CanvasImageSource, 'repeat')!;
    v.patterns.set(tile, pattern);
  }
  ctx.save();
  ctx.translate(-((rc.frame * 37) % 256), -((rc.frame * 91) % 256));
  ctx.globalCompositeOperation = 'overlay';
  ctx.fillStyle = pattern;
  ctx.fillRect(0, 0, rc.width + 256, rc.height + 256);
  ctx.restore();
}
