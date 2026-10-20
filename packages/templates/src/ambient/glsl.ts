/**
 * GLSL helpers for long-form scenes. Noise that loops: pass a point from timeCircle() (ambient/loop)
 * as the extra two coordinates of the 4D noise, and the pattern animates and repeats every loop.
 */

/** 4D simplex noise `snoise(vec4)` in [-1, 1] (Ashima Arts / Stefan Gustavson, MIT licence). */
export const NOISE4 = /* glsl */ `
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

/** `fbm4(vec4 p, int octaves)`: fractal sum of snoise, roughly in [-1, 1]. Needs NOISE4. */
export const FBM4 = /* glsl */ `
float fbm4(vec4 p, int octaves){float s=0.0,a=0.5,n=0.0;for(int i=0;i<6;i++){if(i>=octaves)break;s+=a*snoise(p);n+=a;p=p*2.03+vec4(17.1,-3.7,5.3,9.1);a*=0.5;}return s/n;}
`;

/** `hash12(vec2)` and `hash11(float)`: cheap stable hashes in [0, 1). */
export const HASH = /* glsl */ `
float hash11(float p){p=fract(p*0.1031);p*=p+33.33;p*=p+p;return fract(p);}
float hash12(vec2 p){vec3 p3=fract(vec3(p.xyx)*0.1031);p3+=dot(p3,p3.yzx+33.33);return fract((p3.x+p3.y)*p3.z);}
`;

/** A standard vertex shader passing uv and world position. */
export const BASIC_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vWorld;
void main(){
  vUv = uv;
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}
`;

/**
 * `loopNoise1(s, D, scale, seed)` and `loopFbm1(s, D, scale, seed, octaves)`: noise along a line that
 * repeats every D (metres, say), `scale` noise units per metre. The line is wrapped onto a circle in
 * noise space, so a skyline or tree line drawn from it closes on itself (the Night Train's ring of
 * track). Needs NOISE4 (and FBM4 for loopFbm1).
 */
export const LOOP_NOISE1 = /* glsl */ `
vec4 loopPoint1(float s, float D, float scale, float seed){
  float a = 6.28318530718 * s / D;
  float R = scale * D / 6.28318530718;
  return vec4(R * cos(a), R * sin(a), seed, 0.0);
}
float loopNoise1(float s, float D, float scale, float seed){ return snoise(loopPoint1(s, D, scale, seed)); }
float loopFbm1(float s, float D, float scale, float seed, int octaves){ return fbm4(loopPoint1(s, D, scale, seed), octaves); }
`;

/**
 * `causticsLoop(vec2 p, vec2 tc)`: the bright web of sunlight focused by surface waves, in 0..~1,
 * animated by tc (a point from timeCircle(), so it repeats every loop). p in pattern units (one
 * cell ≈ 1). Needs NOISE4.
 */
export const CAUSTICS = /* glsl */ `
float causticsLoop(vec2 p, vec2 tc){
  float a = 1.0 - abs(snoise(vec4(p, tc)));
  float b = 1.0 - abs(snoise(vec4(p * 1.7 + vec2(3.1, -1.7), tc * 1.3 + vec2(5.0, 2.0))));
  return pow(a, 6.0) * 0.55 + pow(b, 8.0) * 0.45 + pow(a * b, 3.0) * 0.4;
}
`;
