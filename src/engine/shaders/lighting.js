/*
 * Slow-changing lighting passes:
 *  • shadow     — soft terrain + tree shadows for the key light (sun or moon), refreshed
 *                 progressively whenever the light has moved ~0.35°
 *  • transLUT   — atmospheric transmittance (Rayleigh, Mie haze, ozone, Earth's shadow)
 *  • skyLUT     — physically based single-scattering sky radiance for all directions,
 *                 lit by the sun and the moon, plus night airglow
 *  • noise2D/3D — tileable noise textures generated once on the GPU
 */
(function () {
  'use strict';
  const S = window.LE.shaders;

  S.shadow = () => `${S.header}
${S.camera}
${S.octahedral}
${S.noise}
${S.terrain}
${S.ledge}
uniform sampler2D uG0;
uniform sampler2D uG2;
uniform vec3 uLightDir;
out vec4 o;
void main() {
  ivec2 ic = ivec2(gl_FragCoord.xy);
  vec4 g0 = texelFetch(uG0, ic, 0);
  float t = g0.z;
  if (t < 0.0) { o = vec4(1.0); return; }
  if (uLightDir.y < -0.08) { o = vec4(0.0); return; }
  vec3 rd = cameraRay(gl_FragCoord.xy);
  vec3 p = uCamPos + rd * t;
  vec3 ns = octDecodeY(texelFetch(uG2, ic, 0).xy);
  float fp = t * pixelAngle();
  vec3 ro = p + ns * max(fp * 1.2, 0.0015);
  float tf = treeFadeAt(t);
  float res = 1.0;
  float s = max(fp * 1.5, 0.002);
  for (int i = 0; i < 150; i++) {
    vec3 q = ro + uLightDir * s;
    if (q.y > 9.6) break;
    float lod = s * 0.0025 + fp;
    int oct = int(clamp(floor(log2(4.8 / (lod * 1.6))), 3.0, 10.0));
    float h = terrainBase(q.xz, oct);
    if (tf > 0.0 && s < 0.09) {
      float dens = forestDensity(q.xz + uSeedOff, h);
      if (dens > 0.02) h += treeField(q.xz, dens).x * tf;
    }
    h = max(h, ledgeHeightKm(q)); // the rock we stand on shades itself, and the slope below it
    float d = q.y - h;
    res = min(res, 12.0 * d / s);
    if (res < 0.0) break;
    s += clamp(d * 0.55, max(0.0015, s * 0.01), 2.0);
    if (s > 80.0) break;
  }
  res = clamp(res, 0.0, 1.0);
  o = vec4(res * res * (3.0 - 2.0 * res));
}
`;

  S.transLUT = () => `${S.header}
${S.atmosphere}
uniform vec2 uSize;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float e = uv.x * 2.0 - 1.0;
  float mu = sign(e) * e * e;
  float h = uv.y * uv.y * 100.0;
  float r = RG + h;
  // does the ray toward the light hit the ground? (precise form)
  float horizonSq = (2.0 * RG * h + h * h) / (r * r);
  float muH = -sqrt(max(horizonSq, 0.0));
  if (mu < muH) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }
  float disc = r * r * (mu * mu - 1.0) + RT * RT;
  float tTop = -r * mu + sqrt(max(disc, 0.0));
  vec3 od = vec3(0.0);
  const int N = 40;
  float dt = tTop / float(N);
  for (int i = 0; i < N; i++) {
    float s = (float(i) + 0.5) * dt;
    float hs = sqrt(r * r + s * s + 2.0 * r * s * mu) - RG;
    od += extinctionAt(max(hs, 0.0)) * dt;
  }
  // soften the terminator a little (sun is a disc, not a point)
  float soft = smoothstep(muH - 0.004, muH + 0.004, mu);
  o = vec4(exp(-od) * soft, 1.0);
}
`;

  S.skyLUT = () => `${S.header}
${S.atmosphere}
${S.atmosphereLookupTransOnly}
uniform vec2 uSize;
uniform float uCamAlt;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunE;
uniform vec3 uMoonE;
uniform vec3 uAirglow;
uniform float uTwilight;
out vec4 o;
void main() {
  vec2 uv = gl_FragCoord.xy / uSize;
  float az = (uv.x - 0.5) * 2.0 * PI;
  float e = uv.y * 2.0 - 1.0;
  float el = sign(e) * e * e * 0.5 * PI;
  vec3 rd = vec3(sin(az) * cos(el), sin(el), cos(az) * cos(el));
  float h0 = max(uCamAlt, 0.01);
  float r = RG + h0;
  float mu = rd.y;
  float horizonSq = (2.0 * RG * h0 + h0 * h0) / (r * r);
  bool ground = mu < -sqrt(horizonSq);
  float tMax;
  if (ground) {
    float disc = r * r * mu * mu - (2.0 * RG * h0 + h0 * h0);
    tMax = -r * mu - sqrt(max(disc, 0.0));
  } else {
    float disc = r * r * (mu * mu - 1.0) + RT * RT;
    tMax = -r * mu + sqrt(max(disc, 0.0));
  }
  float cosS = dot(rd, uSunDir);
  float cosM = dot(rd, uMoonDir);
  float prS = phaseR(cosS), pmS = phaseM(cosS);
  float prM = phaseR(cosM), pmM = phaseM(cosM);
  vec3 L = vec3(0.0);
  vec3 Tv = vec3(1.0);
  const int N = 36;
  float prev = 0.0;
  for (int i = 0; i < N; i++) {
    float f1 = (float(i) + 1.0) / float(N);
    float s1 = tMax * f1 * f1;
    float ds = s1 - prev;
    float s = prev + 0.5 * ds;
    prev = s1;
    float rs = sqrt(r * r + s * s + 2.0 * r * s * mu);
    float hs = max(rs - RG, 0.0);
    float muS = (r * uSunDir.y + s * cosS) / rs;
    float muM = (r * uMoonDir.y + s * cosM) / rs;
    float dR = exp(-hs / 8.0);
    float dM = exp(-hs / 1.2) * uMieScale;
    float dO = max(0.0, 1.0 - abs(hs - 25.0) / 15.0);
    vec3 ext = RAY_S * dR + (MIE_S + MIE_A) * dM + OZO_A * dO;
    vec3 Ts = transmittance(hs, muS);
    vec3 Tm = transmittance(hs, muM);
    vec3 sR = RAY_S * dR;
    vec3 sM = vec3(MIE_S * dM);
    vec3 S = uSunE * Ts * (sR * prS + sM * pmS) + uMoonE * Tm * (sR * prM + sM * pmM);
    // cheap multiple-scattering term: keeps daytime horizons bright and twilight deep blue
    vec3 Tz = transmittance(hs, max(muS, 0.0) * 0.9 + 0.1);
    S += (sR + sM) * uSunE * Tz * (0.09 / (4.0 * PI)) * smoothstep(-0.12, 0.25, muS) * 3.0;
    vec3 Tseg = exp(-ext * ds);
    L += Tv * (S - S * Tseg) / max(ext, vec3(1e-7));
    Tv *= Tseg;
  }
  float horizonGlow = 0.35 + 0.65 * pow(1.0 - abs(rd.y), 3.0);
  L += uAirglow * horizonGlow;
  // twilight: deep blue dome brightest toward the set (or rising) sun, warm band low on that horizon
  if (uTwilight > 0.0) {
    vec2 sh = normalize(uSunDir.xz + 1e-5);
    vec2 dh = normalize(rd.xz + 1e-5);
    float toward = dot(sh, dh) * 0.5 + 0.5;
    float el = max(rd.y, 0.0);
    vec3 dome = vec3(0.16, 0.24, 0.50) * (0.35 + 0.65 * exp(-el / 0.35)) * (0.35 + 0.65 * toward * toward);
    vec3 band = vec3(0.95, 0.45, 0.22) * exp(-el / 0.06) * pow(toward, 6.0) * smoothstep(-0.2, -0.04, uSunDir.y);
    L += uTwilight * (dome * 0.4 + band * 0.3) * step(-0.02, rd.y);
  }
  o = vec4(min(L, vec3(6e4)), 1.0);
}
`;

  // transmittance-only lookup (the sky LUT cannot sample itself)
  S.atmosphereLookupTransOnly = `
uniform sampler2D uTransLUT;
vec3 transmittance(float h, float mu) {
  float u = 0.5 + 0.5 * sign(mu) * sqrt(abs(mu));
  float v = sqrt(clamp(h, 0.0, 100.0) / 100.0);
  return texture(uTransLUT, vec2(u, v)).rgb;
}
`;

  // ---------------- auto exposure adaptation (1×1) ----------------
  S.adapt = () => `${S.header}
uniform sampler2D uMeterTex;
uniform sampler2D uPrev;
uniform float uMaxLod;
uniform float uRate;
uniform float uKey;
out vec4 o;
void main() {
  float avg = exp(textureLod(uMeterTex, vec2(0.5), uMaxLod).r);
  float target = clamp(uKey / max(avg, 1e-4), 0.5, 1.35);
  float prev = texelFetch(uPrev, ivec2(0), 0).r;
  o = vec4(prev <= 0.0 ? target : mix(prev, target, uRate), avg, 0.0, 1.0);
}
`;

  // ---------------- tileable noise generation ----------------
  const tileNoise = `
vec3 hash33t(vec3 p3) {
  p3 = fract(p3 * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yxx) * p3.zyx);
}
float gradTile(vec3 x, float per) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float n[8];
  for (int k = 0; k < 8; k++) {
    vec3 o = vec3(float(k & 1), float((k >> 1) & 1), float((k >> 2) & 1));
    vec3 g = hash33t(mod(i + o, per) + 0.5) * 2.0 - 1.0;
    n[k] = dot(g, f - o);
  }
  return mix(mix(mix(n[0], n[1], u.x), mix(n[2], n[3], u.x), u.y),
             mix(mix(n[4], n[5], u.x), mix(n[6], n[7], u.x), u.y), u.z);
}
float worleyTile(vec3 x, float per) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  float md = 1.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int xx = -1; xx <= 1; xx++) {
    vec3 g = vec3(float(xx), float(y), float(z));
    vec3 o = hash33t(mod(i + g, per) + 0.5);
    vec3 d = g + o - f;
    md = min(md, dot(d, d));
  }
  return 1.0 - sqrt(md);
}
float perlinFbm(vec3 p, float freq, int oct) {
  float a = 0.0, b = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= oct) break;
    a += b * gradTile(p * freq, freq);
    norm += b;
    b *= 0.5;
    freq *= 2.0;
  }
  return a / norm;
}
float worleyFbm(vec3 p, float freq) {
  return worleyTile(p * freq, freq) * 0.625 + worleyTile(p * freq * 2.0, freq * 2.0) * 0.25 + worleyTile(p * freq * 4.0, freq * 4.0) * 0.125;
}
float remap(float x, float a, float b, float c, float d) { return c + (x - a) / (b - a) * (d - c); }
`;

  S.noise3D = () => `${S.header}
${tileNoise}
uniform float uSlice;
uniform float uSize;
out vec4 o;
void main() {
  vec3 p = vec3(gl_FragCoord.xy / uSize, (uSlice + 0.5) / uSize);
  float pf = perlinFbm(p, 4.0, 6) * 0.5 + 0.5;
  pf = clamp(remap(pf, 0.15, 0.85, 0.0, 1.0), 0.0, 1.0);
  float wf = worleyFbm(p, 4.0);
  float pw = clamp(remap(pf, wf - 1.0, 1.0, 0.0, 1.0), 0.0, 1.0);
  float w2 = worleyFbm(p, 8.0);
  float w3 = worleyFbm(p, 16.0);
  float mist = perlinFbm(p + 0.37, 3.0, 5) * 0.5 + 0.5;
  mist = clamp(remap(mist, 0.2, 0.8, 0.0, 1.0), 0.0, 1.0);
  o = vec4(pw, w2, w3, mist);
}
`;

  S.noise2D = () => `${S.header}
${tileNoise}
uniform float uSize;
out vec4 o;
void main() {
  vec3 p = vec3(gl_FragCoord.xy / uSize, 0.25);
  // 2D tiling via a constant z slice of tileable 3D noise
  float a = perlinFbm(p, 4.0, 8) * 0.5 + 0.5;
  float b = perlinFbm(p + vec3(0.31, 0.77, 0.5), 6.0, 7) * 0.5 + 0.5;
  float c = worleyFbm(p, 6.0);
  float d = perlinFbm(p + vec3(0.13, 0.41, 0.2), 16.0, 4) * 0.5 + 0.5;
  o = vec4(clamp(remap(a, 0.2, 0.8, 0.0, 1.0), 0.0, 1.0),
           clamp(remap(b, 0.2, 0.8, 0.0, 1.0), 0.0, 1.0),
           c,
           clamp(remap(d, 0.2, 0.8, 0.0, 1.0), 0.0, 1.0));
}
`;
})();
