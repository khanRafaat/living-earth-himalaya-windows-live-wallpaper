/*
 * Shared GLSL chunks: camera model, noise, the Himalayan terrain function and
 * the physical atmosphere model. Units: kilometres. Scene frame: +z = panorama
 * centre (config heading), +x = right, +y = up. Camera at (0, cameraAltitude, 0).
 */
(function () {
  'use strict';
  const S = (window.LE.shaders = window.LE.shaders || {});

  S.header = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler3D;
#define PI 3.14159265359
`;

  S.vertex = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

  // Cylindrical panorama projection: horizontal angle is linear across the whole
  // 3840 px span (no stretching at the outer edges), vertical uses a straight
  // horizon with lens shift, so mountains stay upright on both monitors.
  S.camera = `
uniform vec2 uRes;
uniform float uHFov;
uniform float uHorizonY;
uniform vec3 uCamPos;
float pixelAngle() { return uHFov / uRes.x; }
vec3 cameraRay(vec2 fc) {
  float pa = pixelAngle();
  float a = (fc.x - 0.5 * uRes.x) * pa;
  float y = (fc.y - uHorizonY * uRes.y) * pa;
  return normalize(vec3(sin(a), y, cos(a)));
}
`;

  S.octahedral = `
vec2 signNZ(vec2 v) { return vec2(v.x >= 0.0 ? 1.0 : -1.0, v.y >= 0.0 ? 1.0 : -1.0); }
// y is the main axis, so up-facing normals sit in the centre of the encoding
vec2 octEncodeY(vec3 n) {
  vec3 v = vec3(n.x, n.z, n.y);
  v /= (abs(v.x) + abs(v.y) + abs(v.z));
  return v.z >= 0.0 ? v.xy : (1.0 - abs(v.yx)) * signNZ(v.xy);
}
vec3 octDecodeY(vec2 e) {
  vec3 v = vec3(e, 1.0 - abs(e.x) - abs(e.y));
  if (v.z < 0.0) v.xy = (1.0 - abs(v.yx)) * signNZ(v.xy);
  v = normalize(v);
  return vec3(v.x, v.z, v.y);
}
`;

  S.noise = `
// Always 0 (never set). Loops in the terrain code start at "n + uZero" so the Direct3D shader
// compiler (Windows / ANGLE) can't unroll them. Unrolled, the bake shader grows so large that
// a cold compile takes minutes; this keeps the maths, and the output, exactly the same.
uniform int uZero;
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
vec3 hash33(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
// Value noise with analytic derivatives, range [-1, 1]
vec3 noised(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  return vec3(-1.0 + 2.0 * (a + k1 * u.x + k2 * u.y + k4 * u.x * u.y),
              2.0 * du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}
float noise2(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return -1.0 + 2.0 * mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
const mat2 M2 = mat2(0.80, 0.60, -0.60, 0.80);
// Derivative-damped fbm: smooth valleys, sharp ridges — reads like water erosion
float fbmEroded(vec2 p, int oct) {
  float a = 0.0, b = 0.5;
  vec2 d = vec2(0.0);
  for (int i = uZero; i < 14; i++) {
    if (i >= oct) break;
    vec3 n = noised(p);
    d += n.yz;
    a += b * n.x / (1.0 + dot(d, d));
    b *= 0.5;
    p = M2 * p * 2.02;
  }
  return a;
}
// Ridged multifractal: knife-edge aretes of the high Himalaya
float ridged(vec2 p, int oct) {
  float a = 0.0, b = 0.55, w = 1.0;
  for (int i = uZero; i < 12; i++) {
    if (i >= oct) break;
    float n = 1.0 - abs(noised(p).x);
    n *= n;
    a += n * b * w;
    w = clamp(n * 1.9, 0.0, 1.0);
    b *= 0.5;
    p = M2 * p * 2.03 + vec2(1.7, 9.2);
  }
  return a;
}
`;

  // ---------------- terrain ----------------
  S.terrain = `
uniform vec2 uSeedOff;
uniform vec2 uRangeTurn; // cos and sin of the angle the great range is turned by (see terrainBase)
const float EARTH_R = 6371.0;
const float TREE_FAR = 6.5;

int octFor(float t) {
  float fp = max(t * pixelAngle(), 1e-5);
  return int(clamp(floor(log2(4.8 / (fp * 1.6))), 3.0, 12.0));
}

float terrainBase(vec2 p, int oct) {
  vec2 q = p + uSeedOff;
  float r = length(p);
  float ang = atan(p.x, p.y);
  // Foothills: forested ridges and valleys (~5 km features)
  float foot = fbmEroded(q * 0.24, oct);
  // sharp spurs and V-shaped valleys typical of the Himalayan foothills
  float spur = ridged(q * 0.15 + vec2(3.1, 5.7), min(oct, 9));
  float h = 1.25 + 1.15 * foot + 1.25 * (spur - 0.38);
  // a deep valley belt in the middle distance where mist pools
  h -= 0.85 * exp(-pow((r - 8.0) / 3.2, 2.0)) * (0.7 + 0.3 * noise2(q * 0.06));
  // the mountains rise in front of the viewer; behind lie lower hills toward the plains,
  // so the low morning/evening sun is not blocked by an imaginary range at our back
  float front = smoothstep(-0.45, 0.2, p.y / max(r, 1e-3));
  // regional uplift toward the range
  h += 1.1 * smoothstep(9.0, 19.0, r) * front;
  h -= 1.2 * (1.0 - front) * smoothstep(1.5, 6.0, r);
  // the forested ridge just below the viewpoint
  float nearR = exp(-pow((r - 2.8) / 1.4, 2.0)) * front;
  h = mix(h, 2.42 + 0.4 * foot + 0.35 * (spur - 0.38), nearR * 0.9);
  // The Great Himalaya: an arc of 7–8.5 km peaks about 20–28 km away. It can be turned about the eye by uRangeTurn
  // (cos, sin; turned to the right for a positive angle): across two screens the sharpest peak would otherwise stand
  // exactly on the bezel. The foothills, the road and the rock stay where they are; the range still rises in front.
  vec2 pm = vec2(p.x * uRangeTurn.x - p.y * uRangeTurn.y, p.x * uRangeTurn.y + p.y * uRangeTurn.x);
  vec2 qm = pm + uSeedOff;
  float angM = atan(pm.x, pm.y);
  float rr = 21.5 + 2.5 * sin(angM * 2.3 + uSeedOff.y * 0.31) + 1.5 * sin(angM * 5.3 + 1.7);
  float m = smoothstep(rr - 9.0, rr - 0.5, r) * (1.0 - 0.3 * smoothstep(rr + 10.0, rr + 45.0, r)) * front;
  if (m > 0.0005) {
    float rid = ridged(qm * 0.072 + vec2(7.3, 1.9), min(oct + 1, 11));
    float massif = 0.55 + 0.6 * (noise2(qm * 0.024 + 3.3) * 0.5 + 0.5);
    h += m * (6.4 * pow(clamp(rid, 0.0, 1.2), 1.55) * massif + 0.4 * foot);
  }
  // keep the immediate foreground below the viewpoint
  float near = 1.0 - smoothstep(0.4, 1.6, r);
  h = mix(h, min(h, uCamPos.y - 0.55), near);
  // Earth curvature: distant ranges sink below the horizon realistically
  return h - r * r / (2.0 * EARTH_R);
}

// Hill villages: clusters on the lower slopes (q = seeded world xz, h = ground height)
float villageField(vec2 q, float h) {
  float n = noise2(q * 0.5 + vec2(7.1, 3.3)) * 0.65 + noise2(q * 1.7 + 2.3) * 0.35;
  return smoothstep(0.33, 0.55, n) * smoothstep(0.7, 1.0, h) * (1.0 - smoothstep(3.5, 4.0, h));
}

float forestDensity(vec2 q, float h) {
  float n = noise2(q * 1.1 + 3.7) * 0.6 + noise2(q * 4.3 + 1.1) * 0.3 + noise2(q * 17.0) * 0.1;
  float alt = smoothstep(3.9, 3.3, h) * smoothstep(0.1, 0.45, h);
  // villages have cleared most of the forest for fields
  return clamp(alt * (0.6 + 0.8 * n), 0.0, 1.0) * (1.0 - 0.88 * villageField(q, h));
}

// The road (road.js). The map holds the way from a point to the road's centre line, which is far from 0 away from the road.
uniform sampler2D uRoadMap;
uniform vec4 uRoadBox; // x0, z0, 1/width, 1/depth
uniform float uRoadOn;
vec2 roadVec(vec2 p) {
  vec2 uv = (p - uRoadBox.xy) * uRoadBox.zw;
  if (uRoadOn < 0.5 || uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec2(1.0);
  // an explicit level: this runs inside ray-march loops, where the Direct3D compiler rejects derivatives
  return textureLod(uRoadMap, uv, 0.0).xy;
}
// How tall the trees grow here, as a share of their full height. None on the road. From this far up the line of sight
// meets the hillside at a low angle, so full-grown trees between the viewer and the road would hide it altogether:
// on that side they shorten gradually towards it, and the forest keeps its look.
float roadTreeHeight(vec2 p) {
  vec2 v = roadVec(p);
  float d = length(v);
  if (d > 0.09) return 1.0;
  float open = smoothstep(0.009, 0.018, d);
  float nearer = smoothstep(0.0, 0.6, dot(v, normalize(p)) / max(d, 1e-5)); // the road lies beyond this point
  return open * mix(1.0, mix(0.12, 1.0, smoothstep(0.015, 0.09, d)), nearer);
}

float treeSlopeMask(vec2 p) {
  const float e = 0.025;
  // one terrainBase call site in a loop (each call site is otherwise inlined in full)
  float h0 = 0.0, hx = 0.0, hz = 0.0;
  for (int k = uZero; k < 3; k++) {
    vec2 o = k == 0 ? vec2(0.0) : (k == 1 ? vec2(e, 0.0) : vec2(0.0, e));
    float h = terrainBase(p + o, 6);
    if (k == 0) h0 = h; else if (k == 1) hx = h; else hz = h;
  }
  float g = length(vec2(hx - h0, hz - h0)) / e;
  return 1.0 - smoothstep(0.75, 1.15, g);
}

// Individual conifers: x = crown height above ground (km), y = per-tree random, z = radial position
vec3 treeField(vec2 p, float dens) {
  float grows = roadTreeHeight(p);
  if (grows <= 0.0) return vec3(0.0, 0.0, 1.0);
  vec2 q = p * (1000.0 / 7.5);
  vec2 c = floor(q);
  vec2 f = q - c;
  float best = 0.0, bh = 0.0, bd = 1.0;
  for (int j = -1 + uZero; j <= 1; j++)
  for (int i = -1 + uZero; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 h2 = hash22(c + g);
    if (h2.y > dens) continue;
    vec2 o = g + 0.2 + 0.6 * hash22(c + g + 19.19) - f;
    float rad = 0.6 + 0.4 * h2.x;
    float d = length(o) / rad;
    if (d >= 1.0) continue;
    float H = 15.0 + 19.0 * h2.x;
    float hh = H * (1.0 - pow(d, 1.3));
    if (hh > best) { best = hh; bh = hash12(c + g + 7.7); bd = d; }
  }
  return vec3(best * 0.001 * grows, bh, bd);
}

float treeFadeAt(float t) { return 1.0 - smoothstep(TREE_FAR * 0.6, TREE_FAR, t); }

float terrainFull(vec2 p, int oct, float tf) {
  float hb = terrainBase(p, oct);
  if (tf <= 0.0) return hb;
  float dens = forestDensity(p + uSeedOff, hb);
  if (dens <= 0.02) return hb;
  dens *= treeSlopeMask(p);
  return hb + treeField(p, dens).x * tf;
}
`;

  // The ground height at each of a list of points (road.js), read back once before the bake.
  S.roadHeights = () => `${S.header}
${S.camera}
${S.noise}
${S.terrain}
uniform sampler2D uPts;
out vec4 fragColor;
void main() {
  vec2 p = texelFetch(uPts, ivec2(gl_FragCoord.xy), 0).xy;
  // as many octaves as the bake uses at that distance, so a vehicle stands on the ground the bake drew
  fragColor = vec4(terrainBase(p, octFor(length(p) * 1.01)), 0.0, 0.0, 1.0);
}`;

  // ---------------- atmosphere ----------------
  S.atmosphere = `
const float RG = 6360.0;
const float RT = 6460.0;
const vec3 RAY_S = vec3(5.802, 13.558, 33.1) * 1e-3;
const float MIE_S = 3.996e-3;
const float MIE_A = 4.40e-3;
const vec3 OZO_A = vec3(0.650, 1.881, 0.085) * 1e-3;
uniform float uMieScale;

vec3 extinctionAt(float h) {
  float dR = exp(-h / 8.0);
  float dM = exp(-h / 1.2) * uMieScale;
  float dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
  return RAY_S * dR + (MIE_S + MIE_A) * dM + OZO_A * dO;
}
float phaseR(float c) { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
float phaseM(float c) {
  const float g = 0.8;
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
float phaseHG(float c, float g) {
  float g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
`;

  S.atmosphereLookup = `
uniform sampler2D uTransLUT;
uniform sampler2D uSkyLUT;
vec3 transmittance(float h, float mu) {
  float u = 0.5 + 0.5 * sign(mu) * sqrt(abs(mu));
  float v = sqrt(clamp(h, 0.0, 100.0) / 100.0);
  return texture(uTransLUT, vec2(u, v)).rgb;
}
vec3 skyLUT(vec3 d) {
  float az = atan(d.x, d.z);
  float el = asin(clamp(d.y, -1.0, 1.0));
  float e = sign(el) * sqrt(abs(el) / (0.5 * PI));
  return texture(uSkyLUT, vec2(az / (2.0 * PI) + 0.5, e * 0.5 + 0.5)).rgb;
}
// optical length of an exponential layer (scale height H) along a straight ray
float heightOD(float y0, float ry, float t, float H) {
  float a = exp(-y0 / H);
  if (abs(ry) < 1e-4) return a * t;
  return a * H / ry * (1.0 - exp(-ry * t / H));
}
`;
})();
