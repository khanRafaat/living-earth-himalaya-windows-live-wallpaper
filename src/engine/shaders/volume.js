/*
 * Volumetrics (reduced resolution, temporally accumulated):
 *  • valley mist and weather fog — layered, drifting, lit by sun/moon, shadowed in valleys
 *  • mist lifting off wet forest — billowing columns that rise from the canopy and spread into small clouds
 *  • cumulus / stratus cloud deck — 3D Perlin-Worley clouds with self-shadowing,
 *    powder effect and dual-lobe phase function; they pass in front of the peaks
 * Output: rgb = in-scattered light (pre-exposed), a = transmittance.
 */
(function () {
  'use strict';
  const S = window.LE.shaders;

  S.volumeCommon = `
uniform sampler3D uNoise3D;
uniform sampler2D uNoise2D;
uniform vec3 uWind;
uniform vec3 uMistWind;
uniform float uCoverage;
uniform float uOvercast;
uniform float uCloudBase;
uniform float uCloudTop;
uniform float uCloudDensity;
uniform vec2 uCoverFront;
uniform vec2 uCoverWind;
float remap(float x, float a, float b, float c, float d) { return c + (x - a) / (b - a) * (d - c); }
// A thick deck thins out gradually towards its base, so peaks fade into it instead of being cut off
float cloudProfile(float hf) {
  return smoothstep(0.0, 0.16 + 0.34 * uOvercast, hf) * smoothstep(1.0, 0.62 - 0.32 * uOvercast, hf);
}
// xz is fixed to the ground. Cover drifts slower than the cloud shapes, so clouds build on one side and
// fade on the other as they travel, instead of sliding past as a rigid sheet. uCoverFront is non-zero
// only while the cover is changing, and makes the change arrive from upwind.
float cloudCoverageAt(vec2 xz) {
  float wm = textureLod(uNoise2D, (xz + uCoverWind) * 0.0042 + 0.13, 0.0).r;
  float front = clamp(dot(xz, uCoverFront), -0.5, 0.5);
  return clamp(uCoverage + front + (wm - 0.5) * 0.6 * (1.0 - uOvercast), 0.0, 1.0);
}
// In fair weather, clouds build over the mountains (orographic lift) and leave the
// sky above the viewpoint open; as cover rises they spread across the whole sky.
float cloudRegion(vec2 camXZ) {
  float r = length(camXZ);
  float fair = smoothstep(8.0, 15.0, r) * (1.0 - 0.5 * smoothstep(50.0, 80.0, r));
  return mix(fair, 1.0, smoothstep(0.55, 0.9, uCoverage));
}
float cloudShape(vec3 q) {
  return textureLod(uNoise3D, q * vec3(0.10, 0.14, 0.10), 0.0).r * 0.7
       + textureLod(uNoise3D, q * 0.027 + 0.41, 0.0).r * 0.3;
}
// The shape noise centres near 0.63, so using cover directly as a threshold drew far more cloud than
// the data says, and the clouds merged into a wall. This leaves about the reported share of sky covered.
float cloudThreshold(float cov) {
  return mix(1.0, 0.75 - 0.29 * cov - 0.25 * smoothstep(0.8, 1.0, cov), smoothstep(0.0, 0.08, cov));
}
// > 0 inside a cloud, reaching 1 in its dense core
float cloudBody(vec3 q, float hf, float cov) {
  return (cloudShape(q) * cloudProfile(hf) - cloudThreshold(cov)) / 0.32;
}
// cloud bases are ragged and vary in height (up to ~0.6 km lower than the deck base)
float cloudBaseAt(vec2 qxz) {
  return uCloudBase - 0.9 * textureLod(uNoise2D, qxz * 0.045 + 0.7, 0.0).b * (0.6 + 0.4 * textureLod(uNoise2D, qxz * 0.011, 0.0).g);
}
`;

  S.volume = () => `${S.header}
${S.camera}
${S.atmosphere}
${S.atmosphereLookup}
${S.volumeCommon}
uniform sampler2D uG0;
uniform sampler2D uShadow;
uniform sampler2D uHistory;
uniform vec2 uVolRes;
uniform float uFrame;
uniform float uBlend;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunE;
uniform vec3 uMoonE;
uniform vec3 uLightMarchDir;
uniform float uCloudDark;
uniform float uMist;
uniform float uMistBottom;
uniform float uMistTop;
uniform float uFog;
uniform float uFogTop;
uniform int uCloudSteps;
uniform int uCloudFine;
uniform int uMistSteps;
uniform int uLightSteps;
uniform float uAirExt;
uniform float uKeyIsSun;
uniform vec3 uDetailDrift;
uniform int uZero; // always 0: stops the Direct3D compiler from unrolling these loops (see chunks.js)
uniform int uPlumes;       // mist off the forest and smoke from houses and fires now, nearest first (life.js)
uniform vec4 uPlumeA[16];  // its foot (km, scene axes), its height (km)
uniform vec4 uPlumeB[16];  // its radius at the foot (km), how much of it there is, where the wind has carried its top (km)
uniform vec4 uPlumeC[16];  // its own noise, its foot on the picture (px), which (0 mist, 1 house, 2 field) + half its fire
uniform int uPlumeSteps;
uniform float uTime;       // s, wrapped at 2400
uniform float uHeadE;      // how bright a lamp's light is against this exposure (renderer.js): the glow of a fire
uniform int uBanners;      // banner clouds streaming from the high summits now (renderer.js _bannerUniforms)
uniform vec4 uBannerA[4];  // the summit (km, scene axes), how much cloud it makes now (0..1)
uniform vec4 uBannerB[4];  // which way the wind blows there (unit vector, scene x and z), the banner's length (km), its own noise
uniform float uBannerFlow; // how far the air has flowed through them (km), wrapped at 2 km where their noise repeats
out vec4 o;

vec2 slab(float y0, float ry, float a, float b) {
  if (abs(ry) < 1e-5) return (y0 >= a && y0 <= b) ? vec2(0.0, 1e5) : vec2(1.0, 0.0);
  float t0 = (a - y0) / ry;
  float t1 = (b - y0) / ry;
  return vec2(max(min(t0, t1), 0.0), max(t0, t1));
}

float cloudDensity(vec3 p) {
  if (p.y < uCloudBase - 0.9 || p.y > uCloudTop) return 0.0;
  float region = cloudRegion(p.xz);
  if (region <= 0.001) return 0.0;
  vec3 q = p + uWind;
  float base = cloudBaseAt(q.xz);
  float hf = (p.y - base) / (uCloudTop - base);
  if (hf <= 0.0 || hf >= 1.0) return 0.0;
  float d = cloudBody(q, hf, cloudCoverageAt(p.xz) * region);
  if (d <= 0.0) return 0.0;
  // Two sizes of billow churn against the body. Near the base they eat wisps, higher up they leave
  // round puffs (the Worley channels are highest at the centre of each cell).
  vec3 qd = q + uDetailDrift;
  float w = textureLod(uNoise3D, qd * 0.2, 0.0).g * 0.7 + textureLod(uNoise3D, qd * 0.7, 0.0).b * 0.3;
  float det = mix(w, 1.0 - w, clamp(hf * 6.0, 0.0, 1.0));
  d = remap(min(d, 1.0), det * 0.62 * (1.0 - 0.35 * hf), 1.0, 0.0, 1.0);
  return clamp(d, 0.0, 1.0) * uCloudDensity;
}

// Cloud mass without fine detail, for finding clouds and for shading. Errs towards finding cloud.
float cloudBulk(vec3 p) {
  if (p.y < uCloudBase - 0.9 || p.y > uCloudTop) return 0.0;
  float region = cloudRegion(p.xz);
  if (region <= 0.001) return 0.0;
  float hf = (p.y - uCloudBase + 0.45) / (uCloudTop - uCloudBase + 0.45);
  float d = cloudBody(p + uWind, clamp(hf, 0.17, 1.0), cloudCoverageAt(p.xz) * region);
  return clamp(d, 0.0, 1.0) * uCloudDensity;
}

float mistDensity(vec3 p) {
  float d = 0.0;
  if (uMist > 0.005) {
    float hf = (p.y - uMistBottom) / (uMistTop - uMistBottom);
    if (hf < 1.0) {
      vec3 q = (p + uMistWind) * vec3(0.30, 1.0, 0.30);
      // the top of the layer rises and falls, so it does not draw a straight line across the mountains
      float swell = texture(uNoise3D, vec3(q.x, 0.3, q.z) * 0.14).a - 0.5;
      float prof = 1.0 - smoothstep(0.1, 1.0, hf + swell * 1.1);
      float n = texture(uNoise3D, q).a * 0.68 + texture(uNoise3D, q * 2.9 + 0.3).a * 0.32;
      // never fully solid: thick mist still has thinner patches
      float lo = 1.0 - min(uMist, 0.82) * 0.95;
      float m = smoothstep(lo, lo + 0.42, n) * prof;
      d += m * (0.22 + 0.75 * uMist);
    }
  }
  if (uFog > 0.005) {
    float f = 1.0 - smoothstep(uFogTop - 1.0, uFogTop, p.y);
    float low = 1.0 + 1.5 * (1.0 - smoothstep(0.8, 2.0, p.y)); // denser in the valleys
    vec3 q2 = (p + uMistWind * 0.6) * vec3(0.45, 1.3, 0.45);
    float n2 = texture(uNoise3D, q2).a;
    d += f * uFog * (0.25 + 0.6 * n2) * 0.75 * low;
  }
  return d;
}

// Mist lifting off a wet forest, as it looks from a hill: small clouds of it over the canopy, thickest a little above
// the trees and settling into the dips below, in clumps of about 100 m with torn edges, drawn out downwind as it rises
// (B.zw: where the wind has carried its top). Built as the cloud deck is: the billow noise shows only where it rises
// above what the envelope allows, so its heart is whole and its edges break into fragments. The billows drift with the
// valley mist (uMistWind); their scales times 5000 km are whole numbers of noise tiles, so that offset's wrap never shows.
float plumeDensity(vec3 p, vec4 A, vec4 B, float seed) {
  float h = (p.y - A.y) / A.w;
  if (h < -0.3 || h > 1.0) return 0.0;
  float hc = max(h, 0.0);
  vec2 rel = p.xz - A.xz - B.zw * hc * hc;
  float wl = length(B.zw);
  vec2 wd = wl > 1e-4 ? B.zw / wl : vec2(1.0, 0.0);
  vec2 d = vec2(dot(rel, wd) / (1.0 + 0.7 * hc), dot(rel, vec2(-wd.y, wd.x))) / (B.x * (1.0 + 0.6 * hc));
  float env = exp(-dot(d, d) * 1.5) * smoothstep(-0.3, 0.05, h) * (1.0 - smoothstep(0.35, 1.0, h));
  if (env < 0.04) return 0.0;
  vec3 q = (p + uMistWind) * 2.5 + seed;
  float c = clamp(remap(textureLod(uNoise3D, q, 0.0).r, 1.0 - env * 0.78, 1.0, 0.0, 1.0), 0.0, 1.0);
  if (c <= 0.0) return 0.0;
  float w = textureLod(uNoise3D, q * 3.0 + 0.2, 0.0).g;
  c = clamp(remap(c, w * 0.55, 1.0, 0.0, 1.0), 0.0, 1.0);
  return c * (0.5 + 0.5 * env) * 1.6;
}

// How wide smoke is at this height (h 0..1 of its rise), as a multiple of its radius at the foot: it widens as it draws
// in air, and spreads out flat where it stops rising. field: a burning field's big plume (1) or a house's (0).
// Every village's smoke has its own character, from its seed, so no two look alike: from one hearth or many, where it
// stops rising and spreads and how far, how big its puffs are, how much it wanders.
vec4 smokeLook(float seed) {
  return fract(sin(vec4(seed * 1.37 + 0.1, seed * 2.11 + 1.7, seed * 0.73 + 3.1, seed * 1.91 + 5.3)) * 43758.5453);
}

float smokeRadius(float hc, float field, float seed) {
  // a field's column widens steadily and spreads at its top
  if (field > 0.5) return 0.6 + 2.2 * hc + 1.8 * smoothstep(0.65, 1.0, hc);
  // a village's rises from one hearth (narrow) or many (broad), and spreads low or high, a little or a lot
  vec4 k = smokeLook(seed);
  return mix(0.6, 1.6, k.x) + 1.5 * hc + mix(1.2, 4.0, k.y) * smoothstep(mix(0.15, 0.6, k.z), 1.0, hc);
}

// Smoke from a house or a burning field: a column rising from its fire, widening and thinning as it climbs, bent over
// downwind (its top carried B.zw, along the curve a plume in a cross wind takes) and spreading where it stops rising.
// Seen across, a bent plume's slice is drawn out along the wind, as a slanting tube's is. Billows the size of the
// column pour up through it: whole low down, scattered puffs and wisps higher up. The noise scales times 5000 km are
// whole numbers, as for the mist, and the climb is a whole number of noise tiles every 2400 s, so neither wrap shows.
float smokeDensity(vec3 p, vec4 A, vec4 B, float seed, float field) {
  float h = (p.y - A.y) / A.w;
  if (h < -0.05 || h > 1.0) return 0.0;
  float hc = max(h, 0.0);
  float rk = smokeRadius(hc, field, seed);
  vec4 k = smokeLook(seed);
  vec4 k2 = fract(k * 7.13 + 0.31);
  // it never rises quite straight: its axis wanders a little, more as it climbs, and the wander moves up it (periods
  // of 100 and 75 s, whole numbers of them in 2400 s); some villages' smoke far more than others'
  float ph = seed + hc * mix(4.0, 9.0, k2.x);
  float wa = field > 0.5 ? 0.35 : mix(0.1, 0.45, k.w);
  vec2 wander = vec2(sin(ph - uTime * 0.0628319), cos(ph * 0.8 - uTime * 0.0837758)) * B.x * rk * wa * hc;
  vec2 rel = p.xz - A.xz - B.zw * hc * sqrt(hc) - wander;
  float wl = length(B.zw);
  vec2 wd = wl > 1e-4 ? B.zw / wl : vec2(1.0, 0.0);
  float slope = 1.5 * wl / A.w * sqrt(hc);      // how far it goes downwind per km it climbs, at this height
  // a village's veil drifts out long downwind and stays narrower across it
  float spread = (1.0 - field) * smoothstep(0.25, 1.0, hc) * k2.w;
  vec2 d = vec2(dot(rel, wd) / sqrt(1.0 + slope * slope), dot(rel, vec2(-wd.y, wd.x)) / (1.0 - 0.5 * spread)) / (B.x * rk);
  float top = field > 0.5 ? 0.7 : mix(0.3, 0.65, k2.z);
  // a village's is thin where it leaves the chimneys and gathers as it rises; a field's pours up thick
  // and fades out softly as it climbs, a village's over most of its height (a sharp top read as a flat lid)
  float env = exp(-dot(d, d) * 2.0) * smoothstep(-0.05, mix(0.45, 0.03, field), h) * (1.0 - smoothstep(top * mix(0.45, 1.0, field), 1.0, h));
  if (env < 0.04) return 0.0;
  float s = field > 0.5 ? 4.0 : mix(4.0, 7.5, k2.y); // puffs of 35 to 60 m in a village's smoke, 60 m in a field's
  vec3 q = (p + uMistWind) * s + seed;
  q.y -= uTime * mix(0.025, 0.02, field);         // climbing, about 4 m/s
  float n = textureLod(uNoise3D, q, 0.0).r;
  float w = textureLod(uNoise3D, q * 2.7 + 0.4, 0.0).g;
  if (field < 0.5) {
    // A village's smoke: a see-through haze over the houses, no hard edge anywhere, densest low down and fading as it
    // rises and drifts. Low down it stands in separate threads from the hearths, bent with the rest, that merge as
    // they rise.
    float c = smoothstep(0.25, 0.8, n - w * mix(0.15, 0.35, k.z)) * env;
    // torn into streaks a few hundred metres long, drawn out along the wind, that move with it
    vec2 sw = vec2(dot(rel, wd) * 0.35, dot(rel, vec2(-wd.y, wd.x)));
    float big = textureLod(uNoise3D, vec3(sw.x, p.y * 0.8, sw.y) * 1.6 + vec3(seed * 0.37, seed * 0.11, 0.0) + uMistWind * 0.5, 0.0).a;
    c *= mix(0.45, 1.0, smoothstep(0.3, 0.75, big)); // never right through it: a small one far off would show a hole
    float tf = mix(4.0, 10.0, k2.x);                   // a few hearths, or many close together
    float th = textureLod(uNoise3D, vec3(rel.x * tf + seed, 0.37, rel.y * tf + seed * 0.7), 0.0).r;
    c *= mix(mix(1.0, smoothstep(0.4, 0.75, th), k.x * 0.6), 1.0, smoothstep(0.1, mix(0.3, 0.6, k2.y), hc));
    return c * 2.4 / rk * (1.0 - 0.45 * hc); // thinning as it rises and spreads
  }
  // a field's smoke pours up whole, in billows
  float c = clamp(remap(n, 1.0 - env * mix(0.82, 0.55, hc), 1.0, 0.0, 1.0), 0.0, 1.0);
  if (c <= 0.0) return 0.0;
  c = clamp(remap(c, w * mix(0.35, 0.55, hc), 1.0, 0.0, 1.0), 0.0, 1.0);
  return c * (0.6 / rk) * 2.0;                    // thinning as it spreads
}

float plumeD(vec3 p, vec4 A, vec4 B, float seed, int kind) {
  return kind == 0 ? plumeDensity(p, A, B, seed) : smokeDensity(p, A, B, seed, kind == 2 ? 1.0 : 0.0);
}

// A banner cloud ("cloud factory"): moist air carried past a steep summit is drawn up in the eddy on its lee side and
// condenses there, so a cloud streams downwind from the top while the sky around stays clear. The cloud stays where it
// is and the air flows through it: its envelope is fixed to the summit and along the wind, its billows travel with the
// cloud wind (uWind) and are torn apart towards the far end, where the air sinks and dries again. It forms in thin
// shreds right at the top, is fullest a third of the way out, hangs a little below the summit and sinks slowly
// downstream. In the summit's frame: u along the wind, v across it, y up from the summit (km).
vec3 bannerFrame(vec3 p, vec4 A, vec4 B) {
  vec3 rel = p - A.xyz;
  return vec3(dot(rel.xz, B.xy), rel.y, dot(rel.xz, vec2(-B.y, B.x)));
}
float bannerDensity(vec3 p, vec4 A, vec4 B) {
  vec3 l = bannerFrame(p, A, B);
  float len = B.z;
  float f = l.x / len;
  if (f < -0.15 || f > 1.0) return 0.0;
  float fc = max(f, 0.0);
  float yc = -0.08 - 0.16 * len * fc;              // where its middle hangs
  float hv = 0.09 + 0.2 * len * sqrt(fc);          // half its depth
  float hw = 0.1 + 0.2 * len * fc;                 // half its width across the wind
  vec2 e2 = vec2(l.z / hw, (l.y - yc) / hv);
  // whole right at the summit, where it forms in the eddy behind it, thinning out gradually downwind
  float env = exp(-dot(e2, e2)) * smoothstep(-0.1, 0.0, f) * (1.0 - smoothstep(0.55, 1.0, f)) * mix(1.0, 0.65, fc) * A.w;
  if (env < 0.03) return 0.0;
  // drawn out along the wind into fibres and streaks, as a banner cloud is: the air flows along them, so they need no
  // carrying, and they bend a little along their length
  float st = textureLod(uNoise3D, vec3(l.z * 2.4 + B.w, l.y * 3.0, fc * 0.35 + B.w * 0.7), 0.0).b;
  env *= mix(1.0, 0.3 + 0.7 * smoothstep(0.3, 0.7, st), smoothstep(0.0, 0.25, fc));
  // In its own frame: long along the wind, fine across it and up, the air flowing through at the wind's speed. So its
  // lumps are drawn out into the flag shape of a banner cloud instead of round billows.
  vec3 q = vec3((l.x - uBannerFlow) * 0.5, l.y * 2.2, l.z * 1.6) + B.w;
  float c = clamp(remap(textureLod(uNoise3D, q, 0.0).r, 1.0 - env * 0.95, 1.0, 0.0, 1.0), 0.0, 1.0);
  if (c <= 0.0) return 0.0;
  float w = textureLod(uNoise3D, q * vec3(2.0, 3.2, 3.2) + 0.37, 0.0).g;
  // fine wisps eat its edges, more of it towards the far end where it falls apart
  return clamp(remap(c, w * (0.35 + 0.4 * fc), 1.0, 0.0, 1.0), 0.0, 1.0);
}
// The summit's own shade: a steep cone under the summit stands in for the peak. 0 in its shadow, 1 in the light.
float bannerLit(vec3 p, vec4 A, vec3 toL) {
  float lit = 1.0;
  for (int k = uZero; k < 3; k++) {
    float s = 0.25 * pow(2.6, float(k));
    vec3 q = p + toL * s;
    float cone = A.y - 1.3 * length(q.xz - A.xz);
    lit = min(lit, smoothstep(-0.08, 0.08, q.y - cone));
  }
  return lit;
}

void main() {
  ivec2 vc = ivec2(gl_FragCoord.xy);
  vec2 fcf = (vec2(vc) + 0.5) * (uRes / uVolRes);
  ivec2 fci = ivec2(fcf);
  float t = texelFetch(uG0, fci, 0).z;
  vec3 rd = cameraRay(fcf);
  float tEnd = t < 0.0 ? 1e5 : t;
  float jit = fract(52.9829189 * fract(dot(vec2(vc) + uFrame * vec2(5.588238, 3.17), vec2(0.06711056, 0.00583715))));

  vec3 skyZen = skyLUT(vec3(0.0, 1.0, 0.0));
  vec3 skyHor = skyLUT(normalize(vec3(rd.x, 0.06, rd.z)));
  // under an overcast deck the horizon is grey, not sky-blue
  skyHor = mix(skyHor, vec3(dot(skyHor, vec3(0.2126, 0.7152, 0.0722))) * vec3(0.93, 0.96, 1.0), uOvercast * 0.92);
  float cosS = dot(rd, uSunDir);
  float cosM = dot(rd, uMoonDir);
  // light that filters through an overcast deck: diffuse and grey, not sky-blue
  float lz = dot(skyZen, vec3(0.2126, 0.7152, 0.0722));
  vec3 greyAmb = (uSunE * transmittance(uCloudTop, uSunDir.y) * clamp(uSunDir.y + 0.08, 0.0, 1.0) * 0.16
                + uMoonE * transmittance(uCloudTop, uMoonDir.y) * clamp(uMoonDir.y + 0.08, 0.0, 1.0) * 0.16
                + vec3(lz) * 0.5) * vec3(0.95, 0.97, 1.0);
  float underCloud = 1.0 - 0.85 * uOvercast;
  vec3 L = vec3(0.0);
  float T = 1.0;

  // ---------------- mist & fog, and mist lifting off the forest ----------------
  if (uPlumes > 0 || uMist > 0.005 || uFog > 0.005) {
    {
      float shadowS = t < 0.0 ? 1.0 : texelFetch(uShadow, fci, 0).r;
      float phS = mix(phaseHG(cosS, 0.55), 1.0 / (4.0 * PI), 0.4) * 4.0 * PI;
      float phM = mix(phaseHG(cosM, 0.55), 1.0 / (4.0 * PI), 0.4) * 4.0 * PI;
      // with a low sun, mist is golden only looking towards it or in front of land the sun lights.
      // Elsewhere it is the same neutral blue-grey as the air (aerial() in composite.js).
      float lowSun = 1.0 - smoothstep(0.2, 0.55, uSunDir.y);
      phS *= mix(1.0, mix(0.15, 1.0, smoothstep(0.0, 0.8, cosS)), lowSun);
      float natural = lowSun * smoothstep(-0.14, -0.03, uSunDir.y) * (1.0 - max(smoothstep(0.0, 0.8, cosS), shadowS * smoothstep(-0.03, 0.01, uSunDir.y) * 0.6));
      vec3 mistHor = mix(skyHor, vec3(dot(skyHor, vec3(0.2126, 0.7152, 0.0722))) * vec3(0.88, 0.93, 1.0), natural);
      // under dark storm cloud the mist is in the same gloom, so it must not glow brighter than the sky
      vec3 amb = mix(skyZen * 0.75 + mistHor * 0.55, greyAmb, uOvercast) * mix(1.0, 0.5, uCloudDark);

      // Mist off the forest and smoke from houses and fires first: they rise from slopes a few km off, in front of the
      // valley mist further out. Each is marched only inside the box it can fill, and only where the ground behind
      // does not hide it.
      vec3 inv = 1.0 / mix(rd, vec3(1e-6), lessThan(abs(rd), vec3(1e-6)));
      // By night the eye's adaptation lifts the scene, and this close mist would glow white against the black forest;
      // moonlit mist reads as a dim grey
      float nightDim = mix(0.35, 1.0, smoothstep(-0.2, 0.02, uSunDir.y));
      for (int i = uZero; i < 16; i++) {
        if (i >= uPlumes || T < 0.02) break;
        vec4 A = uPlumeA[i];
        vec4 B = uPlumeB[i];
        vec4 C = uPlumeC[i];
        int kind = int(C.w);                        // 0 mist, 1 smoke from a house, 2 a burning field
        float fire = fract(C.w) * 2.0;              // the glow of its fire, by night
        float field = kind == 2 ? 1.0 : 0.0;
        float wl = length(B.zw);
        float stretchTop = sqrt(1.0 + (1.5 * wl / max(A.w, 1e-3)) * (1.5 * wl / max(A.w, 1e-3)));
        // (a village's smoke wanders further from its axis, up to 0.45 of its width)
        float reachK = kind == 1 ? 1.75 : 1.3;
        float rMax = kind == 0 ? B.x * 4.0 : B.x * smokeRadius(1.0, field, C.x) * stretchTop * reachK;
        vec3 lo = vec3(min(A.x, A.x + B.z) - rMax, A.y - (kind == 0 ? 0.3 : 0.05) * A.w, min(A.z, A.z + B.w) - rMax);
        vec3 hi = vec3(max(A.x, A.x + B.z) + rMax, A.y + A.w, max(A.z, A.z + B.w) + rMax);
        vec3 ta = (lo - uCamPos) * inv;
        vec3 tb = (hi - uCamPos) * inv;
        vec3 tn = min(ta, tb);
        vec3 tf = max(ta, tb);
        float a0 = max(max(tn.x, tn.y), max(tn.z, 0.0));
        float b0 = min(min(tf.x, tf.y), min(tf.z, tEnd));
        if (b0 <= a0) continue;
        // Nearly all of it lies close round its axis: march only through that, so every step counts and it is smooth
        // instead of grainy. Where this ray passes closest to the axis, taken at the foot and again where the wind has
        // carried the axis at that height.
        vec2 rxz = rd.xz;
        float rr = max(dot(rxz, rxz), 1e-6);
        float sc = dot(A.xz - uCamPos.xz, rxz) / rr;
        float hs = clamp((uCamPos.y + rd.y * sc - A.y) / A.w, 0.0, 1.0);
        vec2 ax = A.xz + B.zw * (kind == 0 ? hs * hs : hs * sqrt(hs));
        sc = dot(ax - uCamPos.xz, rxz) / rr;
        hs = clamp((uCamPos.y + rd.y * sc - A.y) / A.w, 0.0, 1.0);
        ax = A.xz + B.zw * (kind == 0 ? hs * hs : hs * sqrt(hs));
        // how far out it reaches at that height, along its long axis (downwind)
        float slope = 1.5 * wl / max(A.w, 1e-3) * sqrt(hs);
        float rad = kind == 0 ? B.x * (1.0 + 0.6 * hs) * (1.0 + 0.7 * hs) * 1.4
                              : B.x * smokeRadius(hs, field, C.x) * sqrt(1.0 + slope * slope) * reachK;
        vec2 off = uCamPos.xz + rxz * sc - ax;
        float miss = rad * rad - dot(off, off);
        if (miss <= 0.0) continue;
        float chord = sqrt(miss / rr);
        a0 = max(a0, sc - chord);
        b0 = min(b0, sc + chord);
        if (b0 <= a0) continue;
        // in the hills' shadow where it rises from, out of it higher up
        float footSh = texelFetch(uShadow, clamp(ivec2(C.yz), ivec2(0), ivec2(uRes) - 1), 0).r;
        // per km. Mist: about two thirds of the light through its heart, little at its edges. A village's smoke is a
        // thin blue-grey veil; a field's is thick and brown low down, paler and thinner as it spreads.
        float sigma = B.y * (kind == 0 ? 4.5 : kind == 1 ? 12.0 : 40.0);
        // how far it shades itself: steps towards the light in proportion to its size there
        float ls = kind == 0 ? 0.05 : rad * 0.3;
        float dtp = (b0 - a0) / float(uPlumeSteps);
        for (int k = uZero; k < 16; k++) {
          if (k >= uPlumeSteps || T < 0.02) break;
          float s = a0 + (float(k) + jit) * dtp;
          vec3 p = uCamPos + rd * s;
          float d = plumeD(p, A, B, C.x, kind);
          if (d < 1e-3) continue;
          // light reaching it through its own billows: bright tops and sunward sides, grey underneath; and the sky's
          // light, which reaches its lower parts through what lies above them
          float od = plumeD(p + uLightMarchDir * ls * 1.5, A, B, C.x, kind) * ls * 3.0 * sigma;
          float odUp = plumeD(p + vec3(0.0, ls * 2.0, 0.0), A, B, C.x, kind) * ls * 2.0 * sigma;
          float Tl = (exp(-od) + 0.35 * exp(-od * 0.3)) / 1.35;
          float hh = clamp((p.y - A.y) / A.w, 0.0, 1.0);
          float sh = mix(footSh, 1.0, smoothstep(0.15, 0.8, hh));
          vec3 direct = uSunE * transmittance(p.y, uSunDir.y) * phS * 0.2 * (uKeyIsSun > 0.5 ? sh : 1.0)
                      + uMoonE * transmittance(p.y, uMoonDir.y) * phM * 0.08 * (uKeyIsSun > 0.5 ? 1.0 : sh);
          // what it is made of: mist white; wood smoke a little blue; a field's smoke brown where it is thick
          vec3 alb = kind == 0 ? vec3(0.92) : kind == 1 ? vec3(0.4, 0.45, 0.56)
                   : mix(vec3(0.34, 0.31, 0.28), vec3(0.62, 0.61, 0.6), smoothstep(0.05, 0.7, hh));
          vec3 Sc = (direct * Tl * underCloud + amb * (0.55 + 0.45 * hh) * mix(0.45, 1.0, exp(-odUp))) * alb;
          // lit from below by its fire, only just above it
          Sc += vec3(1.0, 0.45, 0.15) * uHeadE * fire * (kind == 2 ? 0.08 : 0.02) * exp(-hh * 14.0);
          Sc = mix(Sc, mistHor, (1.0 - exp(-s * uAirExt)) * 0.75) * nightDim;
          float Ti = exp(-d * sigma * dtp);
          L += T * Sc * (1.0 - Ti);
          T *= Ti;
        }
      }

      float top = max(uMistTop, uFog > 0.005 ? uFogTop : 0.0);
      vec2 seg = slab(uCamPos.y, rd.y, uMistBottom - 1.0, top);
      seg.y = min(seg.y, min(tEnd, 75.0));
      if (uMist <= 0.005 && uFog <= 0.005) seg = vec2(0.0);
      float dt = (seg.y - seg.x) / float(uMistSteps);
      for (int i = 0; i < 16; i++) {
        if (i >= uMistSteps || seg.y <= seg.x) break;
        float s = seg.x + (float(i) + jit) * dt;
        vec3 p = uCamPos + rd * s;
        float sig = mistDensity(p);
        if (sig < 1e-4) continue;
        // samples near the surface share its shadow (valleys in shade keep dim mist)
        float nearSurf = t < 0.0 ? 0.0 : smoothstep(0.25, 0.9, s / tEnd);
        float sh = mix(1.0, shadowS, nearSurf * 0.85);
        float shS = uKeyIsSun > 0.5 ? sh : 1.0;
        float shM = uKeyIsSun > 0.5 ? 1.0 : sh;
        vec3 direct = uSunE * transmittance(p.y, uSunDir.y) * phS * 0.2 * shS
                    + uMoonE * transmittance(p.y, uMoonDir.y) * phM * 0.08 * shM;
        vec3 Sc = (direct * underCloud + amb) * 0.92;
        float air = 1.0 - exp(-s * uAirExt);
        Sc = mix(Sc, mistHor, air * 0.75);
        float Ti = exp(-sig * dt);
        L += T * Sc * (1.0 - Ti);
        T *= Ti;
        if (T < 0.01) break;
      }
    }
  }

  // ---------------- banner clouds on the high summits ----------------
  // Marched here into a light and a transmittance of their own, then laid into the deck below at the distance where
  // the ray meets them, so deck cloud nearer than the summit passes in front of them and cloud beyond stays behind.
  vec3 Lb = vec3(0.0);
  float Tb = 1.0;
  float sB = 1e9;
  if (uBanners > 0 && T > 0.01) {
    float phS = (phaseHG(cosS, 0.62) * 0.7 + phaseHG(cosS, -0.25) * 0.3) * 4.0 * PI;
    float phM = (phaseHG(cosM, 0.62) * 0.7 + phaseHG(cosM, -0.25) * 0.3) * 4.0 * PI;
    float darken = mix(1.0, 0.32, uCloudDark);
    for (int i = uZero; i < 4; i++) {
      if (i >= uBanners || Tb < 0.02) break;
      vec4 A = uBannerA[i];
      vec4 B = uBannerB[i];
      float len = B.z;
      // the box it can fill, in its own frame
      vec3 ol = bannerFrame(uCamPos, A, B);
      vec3 dl = vec3(dot(rd.xz, B.xy), rd.y, dot(rd.xz, vec2(-B.y, B.x)));
      vec3 il = 1.0 / mix(dl, vec3(1e-6), lessThan(abs(dl), vec3(1e-6)));
      vec3 lo = vec3(-0.15 * len, -0.3 - 0.62 * len, -0.25 - 0.4 * len);
      vec3 hi = vec3(len, 0.12 + 0.25 * len, 0.25 + 0.4 * len);
      vec3 ta = (lo - ol) * il;
      vec3 tb = (hi - ol) * il;
      vec3 tn = min(ta, tb);
      vec3 tf = max(ta, tb);
      float a0 = max(max(tn.x, tn.y), max(tn.z, 0.0));
      float b0 = min(min(tf.x, tf.y), min(tf.z, tEnd));
      if (b0 <= a0) continue;
      sB = min(sB, a0);
      float dtb = (b0 - a0) / float(uPlumeSteps + 4);
      for (int k = uZero; k < 20; k++) {
        if (k >= uPlumeSteps + 4 || Tb < 0.02) break;
        float s = a0 + (float(k) + jit) * dtb;
        vec3 p = uCamPos + rd * s;
        float d = bannerDensity(p, A, B);
        if (d < 1e-3) continue;
        float sigma = d * 6.0;
        // its own billows shade it, and the peak shades its far side from the light
        float od = (bannerDensity(p + uLightMarchDir * 0.12, A, B) * 0.12 + bannerDensity(p + uLightMarchDir * 0.4, A, B) * 0.28) * 6.0;
        float odUp = bannerDensity(p + vec3(0.0, 0.25, 0.0), A, B) * 0.25 * 6.0;
        float Tl = (exp(-od * 1.4) + 0.3 * exp(-od * 0.45) + 0.08 * exp(-od * 0.15)) / 1.38;
        float powder = mix(1.0 - 0.5 * exp(-(od + sigma * 0.1) * 5.0), 1.0, smoothstep(0.3, 0.95, max(cosS, cosM)));
        float peakSh = bannerLit(p, A, uLightMarchDir);
        vec3 direct = (uSunE * transmittance(p.y, uSunDir.y) * phS * (uKeyIsSun > 0.5 ? peakSh : 1.0)
                     + uMoonE * transmittance(p.y, uMoonDir.y) * phM * (uKeyIsSun > 0.5 ? 1.0 : peakSh)) * Tl * powder * 0.26;
        direct *= mix(1.0, 0.12, uOvercast);
        float up = clamp((bannerFrame(p, A, B).y + 0.6) / 0.8, 0.0, 1.0);
        vec3 amb = mix(skyZen * mix(0.45, 1.0, up) + skyHor * 0.22, greyAmb, uOvercast) * mix(0.45, 1.0, exp(-odUp));
        vec3 Sc = (direct + amb) * darken;
        Sc = mix(Sc, skyHor, (1.0 - exp(-s * uAirExt)) * 0.8);
        float Ti = exp(-sigma * dtb);
        Lb += Tb * Sc * (1.0 - Ti);
        Tb *= Ti;
      }
    }
  }

  // ---------------- clouds ----------------
  if (uCoverage > 0.015 && T > 0.01) {
    vec2 seg = slab(uCamPos.y, rd.y, uCloudBase - 0.9, uCloudTop);
    seg.y = min(seg.y, min(tEnd, 130.0));
    if (seg.y > seg.x) {
      float phS = (phaseHG(cosS, 0.62) * 0.7 + phaseHG(cosS, -0.25) * 0.3) * 4.0 * PI;
      float phM = (phaseHG(cosM, 0.62) * 0.7 + phaseHG(cosM, -0.25) * 0.3) * 4.0 * PI;
      float darken = mix(1.0, 0.32, uCloudDark);
      // Search in coarse steps that grow with distance, find the cloud's surface, then take fine steps
      // through the part you can actually see. Clouds turn opaque within a few hundred metres, so even
      // steps of several km would stop at a random depth in each pixel, which shows as noise.
      float start = max(seg.x, 1.0);
      float grow = pow(max(seg.y, start + 0.01) / start, 1.0 / float(uCloudSteps));
      float s = start * pow(grow, jit);
      float dt = 0.0;
      int fine = 0;
      float belly = -1.0;
      for (int i = uZero; i < uCloudSteps + uCloudFine; i++) {
        if (s >= seg.y || T < 0.015) break;
        if (s > sB) { // the banner cloud lies in front of the deck from here on
          L += T * Lb;
          T *= Tb;
          sB = 1e9;
        }
        vec3 p = uCamPos + rd * s;
        if (fine == 0) {
          if (cloudBulk(p) <= 0.0) {
            s *= grow;
            continue;
          }
          float a = max(s / grow, seg.x);
          float b = s;
          for (int k = uZero; k < 4; k++) {
            float m = 0.5 * (a + b);
            if (cloudBulk(uCamPos + rd * m) > 0.0) b = m;
            else a = m;
          }
          s = b;
          dt = max(0.1, s * 0.005); // about what one pixel of this pass covers at that distance
          fine = uCloudFine;
          s += dt * jit;
          p = uCamPos + rd * s;
        }
        fine--;
        float d = cloudDensity(p);
        if (d > 0.001) {
          float sigma = d * 5.0;
          // The first look towards the light sees the billows, so they shade each other. Further on,
          // only the mass of the cloud matters. Under a thick deck little direct light survives
          // (see below), so that costly work would show no difference.
          // The two meet over a band of overcast, so a change of weather goes smoothly from one to the other: switched at
          // one value, the clouds turned a twentieth darker in a single frame as the sky closed in.
          float od = 0.0;
          float ls = 0.2;
          float thick = smoothstep(0.6, 0.7, uOvercast);
          if (thick < 1.0) {
            od = cloudDensity(p + uLightMarchDir * 0.18) * 0.18;
            for (int j = uZero; j < uLightSteps; j++) {
              od += cloudBulk(p + uLightMarchDir * ls * 1.5) * ls;
              ls *= 2.6;
            }
          }
          if (thick > 0.0) od = mix(od, cloudBulk(p + uLightMarchDir * 0.6) * 1.5, thick);
          // Three orders of scattering: crisp shadow from the first, the soft inner glow from the others
          float Tl = (exp(-od * 3.5) + 0.3 * exp(-od * 1.1) + 0.08 * exp(-od * 0.35)) / 1.38;
          // Dark edges where little light has gathered yet, except looking towards the sun (silver lining)
          float powder = mix(1.0 - 0.6 * exp(-(od + sigma * 0.1) * 5.0), 1.0, smoothstep(0.3, 0.95, max(cosS, cosM)));
          float hf = clamp((p.y - uCloudBase) / (uCloudTop - uCloudBase), 0.0, 1.0);
          vec3 direct = (uSunE * transmittance(p.y, uSunDir.y) * phS + uMoonE * transmittance(p.y, uMoonDir.y) * phM) * Tl * powder * 0.26;
          // beneath a thick deck little direct light survives, and lower layers are darker
          direct *= mix(1.0, 0.12, uOvercast);
          vec3 amb = mix(skyZen * mix(0.22, 1.0, hf * hf) + skyHor * 0.22, greyAmb * mix(0.5, 1.3, hf), smoothstep(0.5, 0.95, uCoverage));
          amb *= mix(1.0, 0.45 + 0.55 * hf, uOvercast);
          amb *= mix(0.4, 1.0, exp(-od * 0.8)); // the shaded sides and undersides also see less sky
          // A thick deck is not one flat sheet: dark sagging bellies with thinner, paler patches between.
          // Sampled once per pixel, at the point you actually see.
          if (belly < 0.0) {
            vec3 qb = (p + uWind) * vec3(0.05, 0.1, 0.05);
            belly = textureLod(uNoise3D, qb, 0.0).a * 0.62 + textureLod(uNoise3D, qb * 2.7 + 0.2, 0.0).a * 0.38;
            belly = smoothstep(0.34, 0.66, belly);
          }
          amb *= mix(1.0, mix(0.5, 1.4, belly), uOvercast);
          vec3 Sc = (direct + amb) * darken;
          float air = 1.0 - exp(-s * uAirExt);
          Sc = mix(Sc, skyHor, air * 0.8);
          float Ti = exp(-sigma * dt);
          L += T * Sc * (1.0 - Ti);
          T *= Ti;
        }
        s += dt;
        dt *= 1.3;
      }
    }
  }
  if (sB < 1e8) { // no deck cloud in front of it on this ray
    L += T * Lb;
    T *= Tb;
  }

  vec4 cur = vec4(min(L, vec3(6e4)), T);
  vec4 hist = texelFetch(uHistory, vc, 0);
  o = mix(hist, cur, uBlend);
}
`;
})();
