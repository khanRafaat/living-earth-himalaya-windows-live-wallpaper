/*
 * Composite — runs every frame at full resolution.
 * Re-lights the baked terrain (sun, moon, sky light, terrain + cloud shadows, snow,
 * wetness), applies aerial perspective, draws the sky (sun, moon with its real phase,
 * stars that rotate with sidereal time, Milky Way, cirrus), merges the volumetric
 * layer with depth-aware upsampling, adds rain / snow / lightning, then tone-maps.
 */
(function () {
  'use strict';
  const S = window.LE.shaders;

  // How the light reaching the eye becomes the picture: exposure, night lift, rain and snow in front, tone
  // curve. Shared by the composite and the tree in front of it (foreground.js), so both are graded alike.
  // Needs uOvercast, uSunDir, uFlash, uTime, uRes, skyLUT() and the hashes declared before it.
  S.post = `
uniform sampler2D uAdapt;
uniform float uNight;
uniform float uRain;
uniform float uSnow;
uniform float uRainSlant;
uniform float uRainLayers;
uniform float uFade;

// ---------------- precipitation ----------------
float streaks(vec2 p, float cellW, float len, float speed, float width, float dens, float seed) {
  p.x += p.y * uRainSlant;
  p.y += uTime * speed;
  float col = floor(p.x / cellW);
  float cellH = len * 2.6;
  float yy = p.y + hash12(vec2(col, seed)) * cellH;
  float row = floor(yy / cellH);
  float fy = fract(yy / cellH);
  if (hash12(vec2(col, row) + seed * 7.13) > dens) return 0.0;
  float x0 = (0.2 + 0.6 * hash12(vec2(row, col) + seed * 3.37)) * cellW;
  float dx = abs(p.x - col * cellW - x0);
  float lf = len / cellH;
  float s = smoothstep(0.0, lf * 0.35, fy) * (1.0 - smoothstep(lf * 0.55, lf, fy));
  return s * exp(-dx * dx / (width * width));
}

float flakes(vec2 p, float cell, float speed, float size, float dens, float seed) {
  p.y += uTime * speed;
  p.x += p.y * uRainSlant * 0.5 + sin(uTime * 0.6 + p.y * 0.004 + seed) * cell * 0.4;
  vec2 c = floor(p / cell);
  vec2 f = p - c * cell;
  float h = hash12(c + seed);
  if (h > dens) return 0.0;
  vec2 o = (0.2 + 0.6 * hash22(c + seed * 1.7)) * cell;
  o.x += sin(uTime * (0.7 + h * 2.0) + h * 40.0) * cell * 0.15;
  float d = length(f - o);
  return exp(-d * d / (size * size));
}

vec3 precipitation(vec3 col, vec2 fc) {
  if (uRain <= 0.003 && uSnow <= 0.003) return col; // most of the time: nothing to do for this pixel
  vec2 p = fc / uRes.y * 1080.0;
  vec3 zen = textureLod(uSkyLUT, vec2(0.5, 1.0), 0.0).rgb; // the zenith, as skyLUT(vec3(0.0, 1.0, 0.0))
  vec3 skyA = vec3(dot(zen, vec3(0.2126, 0.7152, 0.0722))) * vec3(0.9, 0.95, 1.0) * PI * 0.3;
  // Drops catch whatever light is around, so rain still shows on a moonless night
  skyA = max(skyA, vec3(0.036, 0.04, 0.046)) + uFlash * 0.05;
  if (uRain > 0.003) {
    float r = 0.0;
    r += streaks(p, 31.0, 170.0, 2300.0, 1.5, 0.14 * uRain, 1.0) * 0.36;
    r += streaks(p, 17.0, 105.0, 1750.0, 1.05, 0.22 * uRain, 2.0) * 0.28;
    if (uRainLayers > 2.5) r += streaks(p, 9.0, 60.0, 1250.0, 0.8, 0.30 * uRain, 3.0) * 0.2;
    if (uRainLayers > 3.5) r += streaks(p, 5.0, 34.0, 900.0, 0.6, 0.36 * uRain, 4.0) * 0.14;
    r = min(r, 1.0);
    col = col * (1.0 - 0.3 * r) + skyA * r * 4.0;
  }
  if (uSnow > 0.003) {
    float s = 0.0;
    s += flakes(p, 70.0, 75.0, 2.6, 0.35 * uSnow, 5.0) * 0.8;
    s += flakes(p, 40.0, 52.0, 1.7, 0.45 * uSnow, 6.0) * 0.55;
    if (uRainLayers > 2.5) s += flakes(p, 22.0, 34.0, 1.1, 0.55 * uSnow, 7.0) * 0.35;
    col += (skyA * 2.2 + 0.02) * s;
  }
  return col;
}

vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}

// exposure and night lift, and the golden-hour limit on dim greens (t: distance in km, -1 for the sky)
vec3 exposeColor(vec3 col, float t) {
  // camera-like auto exposure (fine correction on top of the astronomical exposure)
  col *= texelFetch(uAdapt, ivec2(0), 0).r;
  // A wallpaper has to stay readable at night, most of all under cloud, where almost no light arrives
  col *= 1.0 + uNight * (0.3 + 1.1 * uOvercast);
  // Low sun turns haze yellow, and dim yellow reads as olive green. Limit how far dim colours can lean from
  // orange towards green. Bright gold and white snow look right and stay as they are, blue sky is under
  // the limit anyway, and only the trees close by keep their own green.
  float gold = smoothstep(0.42, 0.17, uSunDir.y) * smoothstep(-0.14, -0.03, uSunDir.y);
  if (gold > 0.001) {
    float limit = col.b + (col.r - col.b) * 0.36;
    float dim = 1.0 - smoothstep(0.6, 1.6, dot(col, vec3(0.2126, 0.7152, 0.0722)));
    float far = t < 0.0 ? 1.0 : mix(0.75, 1.0, smoothstep(2.5, 8.0, t));
    float notGreen = 1.0 - smoothstep(0.9, 1.25, col.g / max(col.r, 1e-4)) * (1.0 - smoothstep(5.0, 9.0, t)); // real green stays green
    col.g -= max(col.g - limit, 0.0) * gold * dim * far * notGreen;
  }
  return col;
}

// rain and snow in front, low-light vision, tone curve, gamma, fade-in and dither (fc: screen pixel)
vec4 finishColor(vec3 col, vec2 fc) {
  col = precipitation(col, fc);

  // low-light vision: bluer, less saturated
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, lum * vec3(0.6, 0.74, 1.0) * 1.15, uNight * 0.5);
  // ACES crushes dark tones to black. At night, keep them, so the land and clouds can still be told apart.
  col = mix(aces(col), 1.0 - exp(-col * 1.4), uNight);
  col = pow(col, vec3(1.0 / 2.2));
  float l2 = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l2), col, 1.05);
  col *= uFade;
  col += (hash12(fc + fract(uTime * 7.31) * 113.0) - 0.5) / 255.0;
  return vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

  S.composite = () => `${S.header}
${S.camera}
${S.octahedral}
${S.noise}
${S.ledge}
${S.atmosphere}
${S.atmosphereLookup}
${S.volumeCommon}
uniform sampler2D uG0;
uniform sampler2D uG1;
uniform sampler2D uG2;
uniform sampler2D uG3;
uniform sampler2D uShadowA;
uniform sampler2D uShadowB;
uniform sampler2D uVol;
uniform vec2 uVolRes;
uniform float uShadowMix;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uKeyDir;
uniform float uKeyIsSun;
uniform vec3 uSunE;
uniform vec3 uMoonE;
uniform float uMoonDiskE;
uniform float uSunVis;
uniform float uMoonVis;
uniform float uStarVis;
uniform mat3 uStarMat;
uniform float uTime;
uniform float uCirrus;
uniform vec2 uCirrusWind;
uniform float uWet;
uniform float uSnowLine;
uniform float uFlash;
uniform vec2 uFlashPos;
uniform float uFog;
uniform int uDebugView;
uniform float uValleyHaze;
uniform float uLampE;
uniform float uLampDark;
uniform float uLocalHour;
uniform vec2 uGustDir;
uniform vec4 uGrassWind; // the grass: how far its gusts have travelled (x, y, m), its lean (pixels), how strong the wind is
uniform int uGrassOnly; // 1 between scenes: draws nothing but the grass
uniform vec2 uGustTravel;
uniform float uWindAmt;
uniform vec2 uTreeSway;
uniform vec2 uOutScale;
uniform int uMeter;
uniform float uTreeOn;   // the tree on the rock (foreground.js): its crown as an ellipsoid and its trunk, tree-local metres
uniform vec3 uCrownC;
uniform vec3 uCrownR;
uniform vec3 uTrunkTop;
uniform float uTreeSwayT;
out vec4 fragColor;
${S.post}

// ---------------- sky ----------------
vec3 starField(vec3 rd) {
  vec3 e = uStarMat * rd;
  vec3 acc = vec3(0.0);
  float pa = pixelAngle();
  for (int l = 0; l < 2; l++) {
    float sc = l == 0 ? 170.0 : 380.0;
    vec3 p = e * sc;
    vec3 c = floor(p);
    vec3 f = p - c;
    float h = hash13(c + float(l) * 91.7);
    float thr = l == 0 ? 0.022 : 0.016;
    if (h < thr) {
      vec3 sp = 0.25 + 0.5 * hash33(c + 13.1);
      float d = length(f - sp);
      float mag = pow(hash13(c + 7.3), 6.0);
      float bright = (l == 0 ? 1.0 : 0.28) * (0.07 + 2.2 * mag);
      float sg = max(0.75 * pa * sc, 0.02);
      float g = exp(-d * d / (sg * sg));
      vec3 tint = mix(vec3(1.0, 0.78, 0.58), vec3(0.72, 0.84, 1.0), hash13(c + 3.3));
      float tw = 0.7 + 0.3 * sin(uTime * (1.5 + 4.0 * fract(h * 37.0)) + h * 600.0);
      acc += tint * g * bright * mix(1.0, tw, smoothstep(0.35, 0.02, rd.y));
    }
  }
  // Milky Way along the galactic plane (north pole RA 192.86°, Dec 27.13°)
  vec3 gp = vec3(-0.8677, -0.1981, 0.4560);
  float b = dot(e, gp);
  float band = exp(-b * b / 0.018);
  float n1 = texture(uNoise3D, e * 0.9 + 0.2).a;
  float n2 = texture(uNoise3D, e * 2.7).a;
  float n3 = texture(uNoise3D, e * 7.3 + 0.4).a;
  float n = n1 * 0.5 + n2 * 0.32 + n3 * 0.18;
  // the dark rift that winds along the middle of the band
  float bw = b + (n1 - 0.5) * 0.1 + (n2 - 0.5) * 0.04;
  float rift = exp(-bw * bw / 0.0012) * smoothstep(0.35, 0.6, n);
  acc += vec3(0.62, 0.66, 0.8) * band * (0.2 + 1.6 * n * n) * (1.0 - 0.7 * rift) * 0.045;
  return acc;
}

vec3 moonDisk(vec3 rd) {
  float cm = dot(rd, uMoonDir);
  if (cm < 0.9995) return vec3(0.0);
  const float R = 0.0047;
  vec3 up = abs(uMoonDir.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 mx = normalize(cross(up, uMoonDir));
  vec3 my = cross(uMoonDir, mx);
  vec3 off = rd - uMoonDir * cm;
  vec2 q = vec2(dot(off, mx), dot(off, my)) / R;
  float rr = dot(q, q);
  vec3 Tm = transmittance(uCamPos.y, uMoonDir.y);
  float glow = exp(-rr * 0.08) * 0.03 + exp(-rr * 0.6) * 0.05;
  vec3 col = vec3(0.8, 0.85, 1.0) * glow * uMoonDiskE * min(uMieScale, 3.0) * 0.35;
  if (rr < 1.15) {
    float edge = 1.0 - smoothstep(0.93, 1.03, sqrt(rr));
    vec3 n = normalize(mx * q.x + my * q.y - uMoonDir * sqrt(max(0.0, 1.0 - min(rr, 1.0))));
    float lit = smoothstep(-0.02, 0.12, dot(n, uSunDir)) * max(dot(n, uSunDir), 0.0) ;
    float m = texture(uNoise2D, q * 0.32 + 0.5).r * 0.7 + texture(uNoise2D, q * 0.9 + 0.2).a * 0.3;
    float maria = mix(0.62, 1.0, smoothstep(0.38, 0.62, m));
    col += vec3(1.0, 0.97, 0.92) * uMoonDiskE * (lit * 1.6 + 0.012) * maria * edge;
  }
  return col * Tm;
}

vec3 cirrusLayer(vec3 sky, vec3 rd) {
  if (rd.y < 0.01 || uCirrus < 0.01) return sky;
  float hgt = 9.5 - uCamPos.y;
  vec2 uv = rd.xz / rd.y * hgt;
  vec2 q = (uv + uCirrusWind) * 0.016;
  float n = texture(uNoise2D, q * vec2(1.0, 0.33)).g * 0.62 + texture(uNoise2D, q * vec2(3.1, 1.0) + 0.37).a * 0.38;
  float c = smoothstep(1.0 - uCirrus * 0.75, 1.05, n);
  float fade = smoothstep(0.01, 0.1, rd.y) * exp(-length(uv) / 160.0);
  float a = c * fade * 0.6;
  float cs = dot(rd, uSunDir);
  vec3 lightC = uSunE * transmittance(9.5, uSunDir.y) * (0.05 + 0.6 * pow(max(cs, 0.0), 6.0))
              + uMoonE * transmittance(9.5, uMoonDir.y) * 0.05
              + skyLUT(vec3(0.0, 1.0, 0.0)) * 1.3;
  return mix(sky, lightC, a);
}

vec3 shadeSky(vec3 rd) {
  vec3 sky = skyLUT(rd);
  float lum = dot(sky, vec3(0.2126, 0.7152, 0.0722));
  sky = mix(sky, vec3(lum) * vec3(0.93, 0.96, 1.0), uOvercast * 0.95);
  float cs = dot(rd, uSunDir);
  vec3 Tc = transmittance(uCamPos.y, uSunDir.y);
  float vis = (1.0 - 0.9 * uOvercast) * uSunVis;
  if (cs > 0.999) {
    float d = length(cross(rd, uSunDir));
    const float R = 0.0049;
    float x = clamp(d / R, 0.0, 1.0);
    float limb = 1.0 - 0.55 * (1.0 - sqrt(max(0.0, 1.0 - x * x)));
    float disk = 1.0 - smoothstep(0.92, 1.06, d / R);
    sky += uSunE * Tc * disk * limb * 45.0 * vis;
  }
  // the wide glow shrinks as the sun gets low, where the raised exposure would blow it up into a white ball
  if (cs > 0.0) sky += uSunE * Tc * (pow(cs, 2500.0) * 1.6 + pow(cs, 300.0) * mix(0.09, 0.03, 1.0 - smoothstep(0.2, 0.55, uSunDir.y))) * vis;
  if (uMoonVis > 0.0) sky += moonDisk(rd) * (1.0 - 0.9 * uOvercast) * uMoonVis;
  if (uStarVis > 0.002) sky += starField(rd) * uStarVis * transmittance(uCamPos.y, max(rd.y, 0.02));
  return cirrusLayer(sky, rd);
}

// ---------------- terrain ----------------
float cloudShadow(vec3 pos) {
  if (uCoverage < 0.015) return 1.0;
  float hMid = mix(uCloudBase, uCloudTop, 0.35);
  if (pos.y > hMid) return 1.0;
  // fades out towards the cloud layer, or peaks would show a straight line at this altitude
  float reach = smoothstep(hMid, hMid - 1.2, pos.y);
  vec3 L = uKeyDir;
  float ly = max(L.y, 0.06);
  vec3 p = pos + L / ly * (hMid - pos.y);
  vec3 q = p + uWind;
  float d = cloudBody(q, 0.35, cloudCoverageAt(p.xz) * cloudRegion(p.xz));
  float sh = exp(-clamp(d, 0.0, 1.0) * uCloudDensity * 3.2);
  return mix(1.0, mix(max(sh, 0.12), 0.07, uOvercast), reach);
}

// The tree's shadow on the rock around it (pm: eye-frame metres). Dappled: the leaves leave gaps that
// let light through, fewer where the light crosses more of the crown, and the pattern sways in the wind.
float treeShade(vec3 pm) {
  vec3 L = uKeyDir;
  if (uTreeOn < 0.5 || L.y < 0.0) return 1.0;
  vec3 q = pm - uTreeSite.xyz;
  float res = 1.0;
  vec3 o = (q - uCrownC) / uCrownR;
  vec3 dd = L / uCrownR;
  float a = dot(dd, dd);
  float b = dot(o, dd);
  float c = dot(o, o) - 1.0;
  float disc = b * b - a * c;
  if (disc > 0.0) {
    float sq = sqrt(disc);
    float t0 = max((-b - sq) / a, 0.0);
    float t1 = (-b + sq) / a;
    if (t1 > 0.0) {
      float chord = t1 - t0;
      vec3 m = q + L * (t0 + t1) * 0.5 + vec3(uGustDir.x, 0.0, uGustDir.y) * uTreeSwayT;
      float n = noise2(m.xz * 2.3 + m.y * 0.7) * 0.6 + noise2(m.xz * 5.3 - m.y * 1.3 + 3.0) * 0.4;
      float gaps = smoothstep(0.1, 0.6, n) * (1.0 - smoothstep(1.0, 3.2, chord));
      res *= mix(max(exp(-chord * 1.2), 0.28), 1.0, gaps * 0.85);
    }
  }
  // the trunk: nearest distance between the light's ray and its axis
  vec3 ba = uTrunkTop;
  vec3 oa = q;
  float d1 = dot(L, ba);
  float baba = dot(ba, ba);
  float u = clamp((dot(oa, ba) - d1 * dot(oa, L)) / max(baba - d1 * d1, 1e-4), 0.0, 1.0);
  float tt = max(d1 * u - dot(oa, L), 0.0);
  float dist = length(oa + L * tt - ba * u);
  float r = mix(0.2, 0.12, u);
  res *= tt > 0.0 ? smoothstep(r - 0.04, r + 0.08, dist) : 1.0;
  return res;
}

vec3 skyIrradiance(vec3 n) {
  vec3 zen = skyLUT(vec3(0.0, 1.0, 0.0));
  vec2 hd = n.xz;
  float l = length(hd);
  hd = l > 1e-4 ? hd / l : vec2(0.0, 1.0);
  vec3 hor = skyLUT(normalize(vec3(hd.x, 0.18, hd.y)));
  vec3 horB = skyLUT(normalize(vec3(-hd.x, 0.18, -hd.y)));
  float up = n.y * 0.5 + 0.5;
  return PI * (zen * (0.5 * up + 0.08) + hor * (0.3 + 0.2 * l) + horB * 0.1 * (1.0 - 0.5 * l));
}

// Village windows after dusk: each house keeps its own schedule
vec3 villageLight(vec4 g3, float t) {
  if (uLampDark <= 0.001 || g3.r < 0.01) return vec3(0.0);
  float id = g3.g;
  float h = uLocalHour;
  float offAt = 20.8 + fract(id * 7.31) * 3.4;            // most lights go out 21:00–24:00
  float allNight = step(0.87, fract(id * 3.7));
  float earlyRiser = step(0.5, fract(id * 5.3)) * step(4.1 + fract(id * 11.0) * 1.4, h) * step(h, 12.0);
  float evening = h >= 12.0 ? step(h, offAt) : 0.0;
  float on = clamp(evening + allNight + earlyRiser, 0.0, 1.0);
  on *= step(0.1 + fract(id * 13.7) * 0.6, uLampDark);     // switched on one by one as dusk deepens
  if (on <= 0.0) return vec3(0.0);
  vec3 warm = vec3(1.0, 0.62, 0.30);
  vec3 led = vec3(0.92, 0.95, 1.0);
  vec3 c = mix(warm, led, step(0.86, fract(id * 17.9)));
  float fire = step(0.8, fract(id * 23.1));                // oil lamps / fires flicker
  float fl = 1.0 - fire * 0.25 * (0.5 + 0.5 * sin(uTime * 7.3 + id * 60.0) * sin(uTime * 3.1 + id * 21.0));
  float d = clamp(16.0 / (t * t), 0.05, 1.3);              // point source: dimmer with distance
  return c * uLampE * g3.r * on * fl * d * (0.6 + 0.8 * fract(id * 29.3));
}

vec3 shadeTerrain(vec3 rd, float t, vec4 g0, ivec2 ic) {
  vec4 g1 = texelFetch(uG1, ic, 0);
  vec4 g2 = texelFetch(uG2, ic, 0);
  vec3 N = octDecodeY(g0.xy);
  vec3 Ns = octDecodeY(g2.xy);
  float ao = g0.w;
  vec4 g3 = texelFetch(uG3, ic, 0);
  vec3 alb = g1.rgb * g1.rgb;
  float canopy = g1.a;
  vec3 pos = uCamPos + rd * t;

  // Wind. Gust fronts travel downwind across forest and meadow as bands stretched across the wind,
  // and within ~4.5 km each crown also sways by itself. Real sway is under a pixel at this range,
  // so it shows as moving light: crowns lean downwind and catch the sun differently.
  float meadow = canopy > 0.5 ? 0.0 : g3.a;
  float windMask = canopy * 0.8 + meadow;
  bool ledge = t < LEDGE_T_KM;
  if (ledge && uGrassWind.w > 0.001 && g3.a > 0.02) {
    // the grass at our feet: gusts run through it in the real wind direction, as soft waves of lighter and darker,
    // because bent blades show their paler sides. Each blade leans a pixel or so with them, roots still. Measured across the picture and not on the ground: grass stands up, so
    // the low view must not flatten this into stripes. The travel wraps every 50 m, a whole number of noise tiles at
    // these scales, so the wrap never shows.
    float gxA = atan(rd.x, rd.z);
    float gyA = rd.y / length(rd.xz);
    vec2 wm = vec2(gxA, gyA * 2.5) * length(uTreeSite.xz);
    float g = textureLod(uNoise2D, (wm - uGrassWind.xy) * 0.08, 1.0).r - 0.5;
    float fine = textureLod(uNoise2D, (wm - uGrassWind.xy * 1.25) * 0.16 + 0.4, 1.0).g - 0.5;
    float swingM = (g * 2.0 + fine * 0.7) * uGrassWind.w;
    float pa = pixelAngle();
    float now = grassTone(grassBlades(gxA / pa, gyA / pa, swingM * 3.0 + uGrassWind.z));
    float rest = grassTone(grassBlades(gxA / pa, gyA / pa, 0.0));
    alb *= mix(1.0, clamp(now / rest, 0.35, 3.0), g3.a);
    N = normalize(N + vec3(uGustDir.x, 0.0, uGustDir.y) * swingM * 0.2 * g3.a);
    alb *= 1.0 + swingM * 0.35 * g3.a;
  }
  if (!ledge && uWindAmt > 0.001 && t < 14.0 && windMask > 0.02) {
    vec2 across = vec2(-uGustDir.y, uGustDir.x);
    vec2 wc = vec2(dot(pos.xz, uGustDir), dot(pos.xz, across));
    vec2 a = wc - vec2(uGustTravel.x, 0.0);
    vec2 b = wc - vec2(uGustTravel.y, 0.0);
    // soft mip levels: the bands are broad, and an explicit level needs no screen derivatives
    float nearW = 1.0 - smoothstep(4.0, 7.0, t);
    float gNear = nearW > 0.0 ? textureLod(uNoise2D, a * vec2(1.6, 0.4), 2.0).r * 0.65 + textureLod(uNoise2D, b * vec2(1.0, 0.3) + 0.37, 2.0).g * 0.35 : 0.5;
    float gFar = nearW < 1.0 ? textureLod(uNoise2D, a * vec2(0.4, 0.1) + 0.61, 2.0).r : 0.5;
    float gust = (mix(gFar, gNear, nearW) - 0.5) * 2.0;
    float swing = gust;
    if (canopy > 0.5 && t < 4.5) {
      // neighbouring crowns move nearly together, in waves running downwind, and mostly where a
      // gust is passing: that reads as wind, where independent crowns would only twinkle
      float id = g3.a * 6.2832;
      float sway = sin(uTreeSway.x - wc.x * 100.0 + id * 0.6) * 0.6 + sin(uTreeSway.y - wc.x * 70.0 + id * 1.4) * 0.4;
      swing += sway * (0.15 + 0.6 * max(gust, 0.0)) * (1.0 - smoothstep(3.0, 4.5, t));
    }
    swing *= uWindAmt * (1.0 - smoothstep(10.0, 14.0, t)) * min(windMask, 1.0);
    N = normalize(N + vec3(uGustDir.x, 0.0, uGustDir.y) * swing * 0.35);
    alb *= max(1.0 + swing, 0.2);
  }

  // snow (season + recent snowfall), smoothing fine detail where it lies
  float snow = clamp(smoothstep(uSnowLine - 0.18, uSnowLine + 0.28, g2.z) * g2.w, 0.0, 1.0);
  vec3 n = normalize(mix(N, Ns, snow * 0.45));
  alb = mix(alb, vec3(0.84, 0.87, 0.92), snow);
  float wet = uWet * (1.0 - snow);
  alb *= 1.0 - 0.4 * wet * (1.0 - canopy * 0.5);

  float sh = mix(texelFetch(uShadowA, ic, 0).r, texelFetch(uShadowB, ic, 0).r, uShadowMix);
  if (ledge) sh *= treeShade(rd * t * 1000.0);
  float cs = cloudShadow(pos);
  float shS = uKeyIsSun > 0.5 ? sh : 1.0;
  float shM = uKeyIsSun > 0.5 ? 1.0 : sh;
  // While a low sun is in view, this very wide panorama has the hills opposite it front-lit and the hills
  // under it backlit, so the brightest land sits on the far side from the sun. Each face is lit correctly,
  // but the picture reads as light from the wrong way. So ease the far side down, and let light wrap over
  // the ridges on the sun's side.
  float sunInView = (1.0 - smoothstep(0.2, 0.55, uSunDir.y)) * smoothstep(-0.2, 0.3, uSunDir.z);
  float sunSide = dot(normalize(rd.xz + 1e-5), normalize(uSunDir.xz + 1e-5)) * 0.5 + 0.5;
  float wrap = 0.55 * sunInView * sunSide * sunSide;
  vec3 sunL = uSunE * transmittance(pos.y, uSunDir.y) * mix(shS, 1.0, wrap) * cs * mix(1.0, mix(0.6, 1.0, sunSide), sunInView);
  vec3 moonL = uMoonE * transmittance(pos.y, uMoonDir.y) * shM * cs;
  float ndlS = max((dot(n, uSunDir) + wrap) / (1.0 + wrap), 0.0);
  float ndlM = max(dot(n, uMoonDir), 0.0);

  float up = n.y * 0.5 + 0.5;
  vec3 amb = skyIrradiance(n);
  vec3 cloudAmb = (uSunE * transmittance(uCloudBase, uSunDir.y) * clamp(uSunDir.y * 1.1 + 0.06, 0.0, 1.0) * 0.13
                 + uMoonE * transmittance(uCloudBase, uMoonDir.y) * clamp(uMoonDir.y + 0.05, 0.0, 1.0) * 0.13
                 + skyLUT(vec3(0.0, 1.0, 0.0)) * 0.6) * PI * (0.55 + 0.45 * up);
  amb = mix(amb, cloudAmb * vec3(0.95, 0.97, 1.0), uOvercast);
  // The rock we stand on hangs over a wide sunlit valley: light comes back up from it, even into the rock's own shade
  vec3 bounceSun = ledge ? uSunE * transmittance(pos.y, uSunDir.y) * cs * 1.6 : sunL;
  vec3 bounce = vec3(0.10, 0.10, 0.085) * (bounceSun * max(uSunDir.y, 0.0) + amb * 0.25) * (1.0 - up);

  vec3 diffuse = alb / PI * (sunL * ndlS + moonL * ndlM + (amb + bounce) * ao);

  // leaf translucency when the forest is backlit
  float back = pow(max(dot(rd, uSunDir), 0.0), 3.0);
  diffuse += alb * vec3(0.9, 1.1, 0.5) * sunL * back * canopy * 0.12 * ao;

  // specular: wet rock / snow
  vec3 v = -rd;
  vec3 hv = normalize(uSunDir + v);
  float nh = max(dot(n, hv), 0.0);
  float vh = max(dot(v, hv), 0.0);
  float rough = mix(mix(0.7, 0.25, wet), 0.42, snow);
  float a2 = pow(rough, 4.0);
  float dd = nh * nh * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * dd * dd);
  float F = 0.03 + 0.97 * pow(1.0 - vh, 5.0);
  float specMask = max(snow * 0.7, wet * (1.0 - canopy)) + 0.04;
  vec3 spec = sunL * ndlS * D * F * 0.25 * specMask * (1.0 - 0.9 * uOvercast);
  // lightning lights the rock around us for an instant
  if (ledge) diffuse += alb * uFlash * vec3(0.72, 0.78, 1.0) * 1.6 * (0.45 + 0.55 * max(n.y, 0.0));
  return diffuse + spec + villageLight(g3, t);
}

vec3 aerial(vec3 col, vec3 rd, float t, float sunlit) {
  float y0 = uCamPos.y;
  // Rayleigh: the blue of distant ridges, using the sky's own horizon colour
  float odR = heightOD(y0, rd.y, t, 8.0);
  vec3 TR = exp(-RAY_S * odR);
  vec3 hd = normalize(vec3(rd.x, max(rd.y, 0.02), rd.z));
  vec3 skyH = skyLUT(hd);
  float lumH = dot(skyH, vec3(0.2126, 0.7152, 0.0722));
  skyH = mix(skyH, vec3(lumH) * vec3(0.93, 0.96, 1.0), uOvercast * 0.92);
  // Mie haze (sky haze + the denser valley haze), lit explicitly so it is golden
  // toward the sun, cool and dim away from it, and unlit once the valleys fall
  // into the Earth's shadow after sunset
  float odM = heightOD(y0, rd.y, t, 1.2) * uMieScale + heightOD(y0, rd.y, t, 1.7) * uValleyHaze;
  float TM = exp(-(MIE_S + MIE_A) * odM);
  float hazeAlt = clamp(y0 + rd.y * t * 0.5, 0.5, 6.0);
  float cosS = dot(rd, uSunDir);
  float cosM = dot(rd, uMoonDir);
  float lowSun = 1.0 - smoothstep(0.2, 0.55, uSunDir.y);
  // Golden haze belongs where the sun's rays are: looking towards the sun, and in front of land it lights.
  // Everywhere else the air shows no sunlight, so it is a neutral blue-grey, not the sky's orange horizon.
  float natural = lowSun * smoothstep(-0.14, -0.03, uSunDir.y) * (1.0 - max(smoothstep(0.0, 0.8, cosS), sunlit * smoothstep(-0.03, 0.01, uSunDir.y) * 0.25));
  vec3 airSky = mix(skyH, lumH * vec3(0.88, 0.93, 1.0), natural);
  // The air scatters blue most, but an orange horizon times a blue-weighted opacity peaks in green.
  // At low sun the colour comes from the sky itself, so even the opacity out.
  vec3 opR = 1.0 - TR;
  opR = mix(opR, vec3(dot(opR, vec3(0.2126, 0.7152, 0.0722))), lowSun * 0.85);
  float rays = mix(1.0, mix(0.15, 1.0, smoothstep(0.0, 0.8, cosS)) * mix(0.8, 1.0, sunlit), lowSun);
  vec3 direct = uSunE * transmittance(hazeAlt, uSunDir.y) * (phaseHG(cosS, 0.65) * mix(0.85, 0.3, lowSun) + 0.15 / (4.0 * PI)) * rays
              // the night exposure is far higher than the day's, so at full strength the moon's haze
              // covers the hills in flat grey, brighter than the sky behind them
              + uMoonE * transmittance(hazeAlt, uMoonDir.y) * (phaseHG(cosM, 0.65) * 0.22 + 0.06 / (4.0 * PI));
  direct *= 1.0 - 0.85 * uOvercast;
  vec3 ambient = skyLUT(vec3(0.0, 1.0, 0.0)) * 0.55 + airSky * 0.45;
  vec3 hazeS = 0.9 * (direct * 1.7 + ambient);
  // Haze looking towards the sun ends up far brighter than anything else in view and erases the mountains
  // on that side, worst of all with a low sun, whose exposure is higher. Compress only that excess, which
  // keeps a glow around the sun and leaves the rest of the view as it was.
  float hazeL = dot(hazeS, vec3(0.2126, 0.7152, 0.0722));
  float knee = mix(0.5, 0.55, lowSun);
  float soft = mix(0.25, 0.4, lowSun);
  if (hazeL > knee) hazeS *= (knee + (hazeL - knee) / (1.0 + (hazeL - knee) / soft)) / hazeL;
  vec3 c = (col * TR + airSky * opR * 1.05) * TM + hazeS * (1.0 - TM);
  // rain veils the distance in grey, heavier in drifting rain shafts
  float shaft = texture(uNoise2D, vec2(atan(rd.x, rd.z) * 1.4 + uWind.x * 0.004, 0.37)).r;
  float Tr = exp(-uRain * t * 0.06 * (0.45 + 1.1 * shaft));
  return c * Tr + mix(skyH, vec3(lumH), 0.6) * 0.85 * (1.0 - Tr);
}

// ---------------- volumetric upsample ----------------
vec4 sampleVolume(vec2 fc, float tFull) {
  vec2 scale = uVolRes / uRes;
  vec2 vp = fc * scale - 0.5;
  vec2 base = floor(vp);
  vec2 f = vp - base;
  float zf = log(tFull < 0.0 ? 250.0 : max(tFull, 0.01));
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int j = 0; j < 2; j++)
  for (int i = 0; i < 2; i++) {
    ivec2 vc = clamp(ivec2(base) + ivec2(i, j), ivec2(0), ivec2(uVolRes) - 1);
    vec2 fullPos = (vec2(vc) + 0.5) / scale;
    float tv = texelFetch(uG0, ivec2(fullPos), 0).z;
    float zv = log(tv < 0.0 ? 250.0 : max(tv, 0.01));
    float wb = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
    float w = (wb + 1e-3) * exp(-abs(zv - zf) * 5.0);
    acc += texelFetch(uVol, vc, 0) * w;
    wsum += w;
  }
  return wsum > 1e-6 ? acc / wsum : vec4(0.0, 0.0, 0.0, 1.0);
}

// Sheet lightning: the cloud lights up from inside around the strike, in lumps, and fades with distance.
// Kept well below white so it reads as light in the clouds, not as the whole screen blinking. The land
// stays dark against it, the way ridges really look in a flash.
vec3 lightning(vec2 fc, vec3 rd, float t, float cloudA) {
  vec2 d = (fc / uRes - uFlashPos) * vec2(uRes.x / uRes.y, 1.0);
  float near = exp(-dot(d, d) / 0.6);
  // The lumps belong to the cloud overhead. Below the horizon this mapping would smear into vertical streaks.
  float lumps = 0.65;
  if (rd.y > 0.02) {
    vec2 q = rd.xz / (rd.y + 0.2) * 0.06 + uCirrusWind * 0.002;
    float n = texture(uNoise2D, q).r * 0.7 + texture(uNoise2D, q * 2.3 + 0.3).r * 0.3;
    lumps = mix(0.65, mix(0.35, 1.0, smoothstep(0.35, 0.7, n)), smoothstep(0.02, 0.12, rd.y));
  }
  float lit = t < 0.0 ? max(cloudA, 0.55) : cloudA * 0.7;
  return uFlash * vec3(0.72, 0.78, 1.0) * lit * (near * lumps * 0.55 + 0.045);
}

void main() {
  vec2 fc = (floor(gl_FragCoord.xy) + 0.5) * uOutScale;
  ivec2 ic = ivec2(fc);
  vec3 rd = cameraRay(fc);
  vec4 g0 = texelFetch(uG0, ic, 0);
  float t = g0.z;
  if (uGrassOnly == 1 && (t < 0.0 || t >= LEDGE_T_KM || texelFetch(uG3, ic, 0).a <= 0.02)) discard;
  vec3 col;
  if (t < 0.0) {
    col = shadeSky(rd);
  } else {
    col = shadeTerrain(rd, t, g0, ic);
    // The haze in front of the land is lit along nearly all of its length even where the land itself is
    // in shadow, so it follows a softened shadow, weakly: a small shaded hollow must not turn the whole
    // column of air blue (at golden hour that showed as hard blue blotches all over the hills).
    float sunlit = 1.0;
    if (uKeyIsSun > 0.5) {
      sunlit = 0.0;
      for (int k = 0; k < 5; k++) {
        ivec2 o = k == 0 ? ivec2(0) : ivec2(k == 1 || k == 2 ? -6 : 6, k == 1 || k == 3 ? -6 : 6);
        ivec2 c = clamp(ic + o, ivec2(0), ivec2(uRes) - 1);
        sunlit += mix(texelFetch(uShadowA, c, 0).r, texelFetch(uShadowB, c, 0).r, uShadowMix) * (k == 0 ? 0.4 : 0.15);
      }
    }
    col = aerial(col, rd, t, sunlit);
  }
  vec4 vol = sampleVolume(fc, t);
  if (uDebugView > 0) {
    vec4 g1 = texelFetch(uG1, ic, 0);
    vec3 dv = vec3(0.0);
    if (uDebugView == 1) dv = g1.rgb;
    else if (uDebugView == 2) dv = octDecodeY(g0.xy) * 0.5 + 0.5;
    else if (uDebugView == 3) dv = vec3(texelFetch(uShadowA, ic, 0).r);
    else if (uDebugView == 4) dv = vec3(g0.w);
    else if (uDebugView == 5) dv = vec3(t < 0.0 ? 1.0 : log(t + 1.0) / log(60.0));
    else if (uDebugView == 6) dv = vec3(vol.a);
    else if (uDebugView == 7) dv = vec3(g1.a);
    else if (uDebugView == 8) { vec4 g3 = texelFetch(uG3, ic, 0); dv = vec3(g3.r, g3.b * 0.6, g3.a * 0.3); }
    fragColor = vec4(dv, 1.0);
    return;
  }
  col = col * vol.a + vol.rgb;
  // exposure metering pass: write log luminance only
  if (uMeter == 1) {
    fragColor = vec4(log(max(dot(col, vec3(0.2126, 0.7152, 0.0722)), 1e-4)), 0.0, 0.0, 1.0);
    return;
  }
  col = exposeColor(col, t);
  if (uFlash > 0.001) col += lightning(fc, rd, t, 1.0 - vol.a);
  fragColor = finishColor(col, fc);
}
`;
})();
