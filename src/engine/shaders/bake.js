/*
 * Terrain bake — runs once (spread over many frames). The camera never moves, so the
 * expensive part (ray-marching ~20 octaves of terrain, individual trees, normals,
 * ambient occlusion, materials) is computed a single time into a G-buffer.
 * Every frame afterwards only re-lights it.
 *
 * G0 (RGBA16F): detail normal (oct), distance t (km, -1 = sky), ambient occlusion
 * G1 (RGBA8):   sqrt(albedo), canopy weight
 * G2 (RGBA16F): smooth normal (oct), snow altitude field (km), snow suitability
 * G3 (RGBA8):   house-light coverage, light id, village weight,
 *               meadow weight (or, on tree crowns where G1.a > 0.5, the tree's random id)
 */
(function () {
  'use strict';
  const S = window.LE.shaders;

  S.bake = () => `${S.header}
${S.camera}
${S.octahedral}
${S.noise}
${S.terrain}
${S.ledge}
uniform vec2 uNorth;
uniform vec4 uSeason; // summer, autumn, winter, spring weights
layout(location = 0) out vec4 o0;
layout(location = 1) out vec4 o1;
layout(location = 2) out vec4 o2;
layout(location = 3) out vec4 o3;

// ---------------- the rock we stand on (see ledge.js) ----------------
// noise that keeps its grain on a surface of any steepness: seen from above on flat rock, from the side on walls
float triNoise(vec3 p, vec3 w, float f, float seed) {
  return noise2(p.xz * f + seed) * w.y + noise2(p.zy * f + seed + 5.1) * w.x + noise2(p.xy * f + seed + 9.3) * w.z;
}

// One call site in a loop: each call is inlined in full by the shader compiler
vec3 hillNormal(vec3 p, float e) {
  vec3 n = vec3(0.0);
  for (int i = uZero; i < 4; i++) {
    vec3 k = i == 0 ? vec3(1.0, -1.0, -1.0) : (i == 1 ? vec3(-1.0, -1.0, 1.0) : (i == 2 ? vec3(-1.0, 1.0, -1.0) : vec3(1.0)));
    n += k * hillSolid(p + k * e);
  }
  return normalize(n);
}

void shadeLedge(vec3 rd, float t) {
  vec3 p = rd * t * 1000.0; // metres from the eye
  float pa = pixelAngle();
  float fp = t * 1000.0 * pa;
  vec3 L = hillFrame(p);
  vec3 N = hillNormal(p, max(fp * 1.1, 0.012));
  float facing = dot(N, rd);
  if (facing > -0.08) N = normalize(N - rd * (facing + 0.08));
  // the broad form, for snow and for where soil can lie
  vec3 Ns = hillNormal(p, max(fp * 4.0, 0.3));
  float slope = 1.0 - N.y;

  vec3 tw = pow(abs(N), vec3(4.0));
  tw /= tw.x + tw.y + tw.z;
  float n1 = triNoise(p, tw, 0.31, 3.0);
  float n2 = triNoise(p, tw, 1.6, 1.0);
  float n3 = triNoise(p, tw, 5.5, 4.0);
  float n4 = triNoise(p, tw, 17.0, 9.0);

  // Which surface this is: the top of the rock, or its face
  vec2 m = L.xz;
  float onTop = step(hillTop(m) - 0.14, L.y);
  float rocky = onTop > 0.5 ? hillRocky(m) : 1.0;

  // ---- rock: dark gneiss. Each bed and block has its own tone, fine layers run along the bed, pale veins cross it, and
  // water and lichen have marked it
  vec4 bed = onTop > 0.5 ? rockBeds(m.x, m.y * 0.7) : rockBeds(L.x, L.y);
  float joint = (1.0 - onTop) * (1.0 - smoothstep(0.0, max(fp * 1.7, 0.04), rockJoint));
  float tone = clamp(0.12 + 0.42 * bed.w + 0.26 * bed.z + 0.28 * n1 + 0.14 * n2, 0.0, 1.0);
  vec3 rock = mix(vec3(0.042, 0.04, 0.039), vec3(0.15, 0.14, 0.125), tone);
  rock = mix(rock, rock * vec3(1.2, 1.02, 0.84), smoothstep(-0.2, 0.5, n2 * 0.6 + n1 * 0.4)); // iron stain, warm
  rock *= 0.8 + 0.34 * noise2(vec2(L.x * 0.9, (bed.y + bed.w * 9.0) * 6.0)) + 0.12 * noise2(vec2(L.x * 2.2, (bed.y + bed.w * 9.0) * 15.0)); // the layers inside a bed
  rock *= 0.66 + 0.3 * (n3 * 0.5 + 0.5) + 0.42 * (n4 * 0.5 + 0.5); // grit
  float vein = 1.0 - smoothstep(0.0, 0.035, abs(noise2(vec2(L.x * 0.8 + L.y * 0.5, L.y * 1.7 + 9.0)) - 0.15));
  rock = mix(rock, vec3(0.25, 0.24, 0.22), vein * 0.3 * smoothstep(-0.1, 0.4, n2));
  float streak = smoothstep(0.1, 0.7, noise2(vec2(L.x * 3.1, L.y * 0.2 + n1 * 0.2))) * (1.0 - onTop);
  rock *= 1.0 - 0.3 * streak;
  float lichen = smoothstep(0.3, 0.72, triNoise(p, tw, 2.3, 6.0) * 0.6 + n3 * 0.4) * (1.0 - streak);
  rock = mix(rock, vec3(0.2, 0.21, 0.17), lichen * lichen * 0.45 * smoothstep(-0.2, 0.3, n4));

  rock *= 1.0 - 0.58 * joint; // a joint is narrow and deep, and the sun doesn't reach in
  // Light from the sky. A block that sits back or lies under one standing out gets less, and is damp and darker.
  float below = max(-L.y, 0.0);
  float ao = 1.0;
  if (onTop < 0.5) {
    vec4 upper = rockBeds(L.x, L.y + 0.22);
    float over = clamp((upper.x - bed.x) * 1.5, 0.0, 1.0);
    ao = (1.0 - 0.45 * over) * mix(0.8, 1.0, smoothstep(0.1, 0.9, bed.x)) * (1.0 - 0.15 * smoothstep(0.0, 3.5, below)) * (1.0 - 0.5 * joint);
    rock *= 1.0 - 0.28 * over;
  }
  // moss on the ledges, broken up
  float moss = smoothstep(0.5, 0.88, N.y) * smoothstep(0.0, 0.55, n2 * 0.5 + n3 * 0.5 + n4 * 0.45);
  rock = mix(rock, vec3(0.05, 0.075, 0.028) * (0.7 + 0.7 * (n4 * 0.5 + 0.5)), moss * 0.7);
  // a roughness finer than the blocks
  N = normalize(N + vec3(n3, n4, n2 * 0.5) * 0.22);

  // ---- the top: grass in the soil between the rocks. The camera never moves, so it is drawn in picture pixels: sharp
  // blades a pixel or two wide, narrow and upright the way grass looks from this far off, combed the same way within a
  // clump. Grass stands up, so the low view must not flatten it, as it would anything laid on the ground.
  float gx = atan(rd.x, rd.z) / pa;
  float gy = rd.y / length(rd.xz) / pa;
  float blade = grassBlades(gx, gy, 0.0);
  float tuft = noise2(vec2(gx / 7.0 + 1.7, gy / 4.5 + 5.0)) * 0.6 + noise2(vec2(gx / 16.0 + 9.0, gy / 8.0 + 2.0)) * 0.5;
  float bright = clamp(0.16 + 0.75 * blade + 0.35 * tuft, 0.0, 1.0);
  // its edge against the rock is made of blades too
  float soil = onTop * smoothstep(0.42, 0.58, smoothstep(0.7, 0.35, rocky + 0.3 * n2 + 0.15 * n3) * smoothstep(0.5, 0.8, Ns.y) + (blade - 0.4) * 0.4);
  vec3 grass = uSeason.x * vec3(0.046, 0.082, 0.026)
             + uSeason.y * vec3(0.058, 0.078, 0.030)
             + uSeason.z * vec3(0.088, 0.084, 0.052)
             + uSeason.w * vec3(0.052, 0.090, 0.028);
  vec3 dry = vec3(0.14, 0.12, 0.075);
  float lush = smoothstep(-0.7, 0.7, noise2(vec2(gx / 90.0 + 3.0, gy / 30.0 + 8.0)) + tuft * 0.25);
  float isDry = smoothstep(0.25, 0.6, noise2(vec2(gx / 4.0 + 11.0, gy / 9.0)) * 0.7 + uSeason.z * 0.4 + uSeason.y * 0.12 - lush * 0.15);
  vec3 sward = mix(mix(grass * 0.8, grass * 1.15, lush), dry, isDry * 0.4) * mix(0.3, 1.25, bright);
  sward = mix(vec3(0.018, 0.016, 0.012), sward, smoothstep(0.06, 0.28, bright)); // dark earth in the gaps
  // dark soil and moss at the foot of the tree, where the grass gives out
  float dT = length(m);
  float under = 1.0 - smoothstep(0.45, 1.5, dT + n2 * 0.35);
  sward = mix(sward, mix(vec3(0.04, 0.032, 0.024), vec3(0.035, 0.055, 0.022), smoothstep(-0.1, 0.5, n2)), under * 0.85);
  vec3 alb = mix(rock, sward, soil);
  ao *= mix(1.0, 0.6 + 0.4 * bright, soil);
  // blades stand up from the ground, each facing its own way
  vec3 right = normalize(vec3(rd.z, 0.0, -rd.x));
  vec3 nBlade = normalize(vec3(0.0, 0.85, 0.0) - rd * 0.45 + right * (blade - 0.4) * 1.2);
  N = normalize(mix(N, nBlade, soil * 0.8));

  float snowAlt = uCamPos.y + p.y * 0.001 + 0.06 * n1 + 0.02 * n2;
  float suit = (1.0 - smoothstep(0.25, 0.55, slope)) * (0.5 + 0.5 * onTop);
  o0 = vec4(octEncodeY(N), t, ao);
  o1 = vec4(sqrt(clamp(alb, 0.0, 1.0)), 0.0);
  o2 = vec4(octEncodeY(Ns), snowAlt, suit);
  o3 = vec4(0.0, 0.0, 0.0, soil * (1.0 - under)); // grass, for the wind in the composite
}

float march(vec3 ro, vec3 rd) {
  float pxa = pixelAngle();
  float t = 0.03;
  float tPrev = t;
  for (int i = uZero; i < 1000; i++) {
    vec3 p = ro + rd * t;
    if (rd.y > 0.0 && p.y > 9.8) return -1.0;
    if (t > 190.0) return -1.0;
    int oct = octFor(t);
    float hb = terrainBase(p.xz, oct);
    float h = hb;
    float tf = treeFadeAt(t);
    float above = p.y - hb;
    bool inTrees = tf > 0.0 && above < 0.045;
    if (inTrees) {
      float dens = forestDensity(p.xz + uSeedOff, hb);
      if (dens > 0.02) h += treeField(p.xz, dens * treeSlopeMask(p.xz)).x * tf;
    }
    float dh = p.y - h;
    float fp = t * pxa;
    if (dh < 0.0) {
      float a = tPrev, b = t;
      for (int k = uZero; k < 8; k++) {
        float mid = 0.5 * (a + b);
        vec3 q = ro + rd * mid;
        if (q.y - terrainFull(q.xz, octFor(mid), treeFadeAt(mid)) < 0.0) b = mid; else a = mid;
      }
      return b;
    }
    if (dh < fp * 0.3) return t;
    tPrev = t;
    float k = inTrees ? 0.2 : 0.4;
    t += max(dh * k, fp * 0.45);
  }
  return -1.0;
}

// Central differences. The four samples share one call site in a loop: each terrain call
// site is inlined in full by the shader compiler, so this keeps the shader (and compile) small.
vec2 diffOffset(int k, float eps) {
  return k == 0 ? vec2(-eps, 0.0) : (k == 1 ? vec2(eps, 0.0) : (k == 2 ? vec2(0.0, -eps) : vec2(0.0, eps)));
}
vec3 normalFull(vec2 xz, float eps, int oct, float tf) {
  float hL = 0.0, hR = 0.0, hD = 0.0, hU = 0.0;
  for (int k = uZero; k < 4; k++) {
    float h = terrainFull(xz + diffOffset(k, eps), oct, tf);
    if (k == 0) hL = h; else if (k == 1) hR = h; else if (k == 2) hD = h; else hU = h;
  }
  return normalize(vec3(hL - hR, 2.0 * eps, hD - hU));
}
vec3 normalBase(vec2 xz, float eps, int oct) {
  float hL = 0.0, hR = 0.0, hD = 0.0, hU = 0.0;
  for (int k = uZero; k < 4; k++) {
    float h = terrainBase(xz + diffOffset(k, eps), oct);
    if (k == 0) hL = h; else if (k == 1) hR = h; else if (k == 2) hD = h; else hU = h;
  }
  return normalize(vec3(hL - hR, 2.0 * eps, hD - hU));
}

float horizonAO(vec3 p, float t) {
  float sc = clamp(t * 0.01, 0.02, 0.5);
  float vis = 0.0;
  for (int i = uZero; i < 6; i++) {
    float a = float(i) * (PI / 3.0) + 0.4;
    vec2 dir = vec2(cos(a), sin(a));
    float maxs = 0.0;
    float d = sc;
    for (int j = uZero; j < 5; j++) {
      float h = terrainBase(p.xz + dir * d, 7);
      maxs = max(maxs, (h - p.y) / d);
      d *= 2.15;
    }
    vis += 1.0 - maxs / sqrt(1.0 + maxs * maxs);
  }
  return vis / 6.0;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec3 rd = cameraRay(fc);
  vec3 ro = uCamPos;
  float tl = ledgeMarch(rd);
  if (tl > 0.0) {
    shadeLedge(rd, tl);
    return;
  }
  float t = march(ro, rd);
  if (t < 0.0) {
    o0 = vec4(0.0, 0.0, -1.0, 1.0);
    o1 = vec4(0.0);
    o2 = vec4(0.0);
    o3 = vec4(0.0);
    return;
  }
  vec3 p = ro + rd * t;
  float fp = t * pixelAngle();
  int oct = octFor(t);
  float tf = treeFadeAt(t);

  vec3 N = normalFull(p.xz, max(fp * 0.9, 0.0004), min(oct + 1, 13), tf);
  vec3 Ns = normalBase(p.xz, max(fp * 5.0, 0.018), max(oct - 3, 4));
  float hb = terrainBase(p.xz, oct);
  float slope = 1.0 - Ns.y;
  vec2 q = p.xz + uSeedOff;

  // ---- tree crown info ----
  float dens = 0.0;
  vec3 tree = vec3(0.0);
  if (tf > 0.0) {
    dens = forestDensity(q, hb) * treeSlopeMask(p.xz);
    tree = treeField(p.xz, dens);
  }
  float crown = tf * smoothstep(0.0015, 0.004, p.y - hb + 0.0005) * step(0.0001, tree.x);

  // ---- noise fields ----
  float nA = noise2(q * 0.9);
  float nB = noise2(q * 4.7 + 13.1);
  float nC = noise2(q * 23.0 + 5.3);
  float nD = noise2(q * 110.0 + 2.1);
  float alt = hb;

  // ---- rock: gneiss, granite, dark schist, horizontal strata ----
  vec3 rockA = vec3(0.105, 0.098, 0.090);
  vec3 rockB = vec3(0.185, 0.170, 0.150);
  vec3 rockC = vec3(0.065, 0.060, 0.056);
  // faint, warped bedding planes (kept subtle so faces don't look layered like a cake)
  float strata = sin(alt * 31.0 + nB * 5.0 + nA * 2.2 + nC * 1.4) * 0.5 + 0.5;
  vec3 rock = mix(rockA, rockB, smoothstep(0.3, 0.9, strata * 0.28 + nC * 0.42 + nB * 0.15 + 0.25));
  rock = mix(rock, rockC, smoothstep(0.25, 0.95, nA * 0.45 + slope * 0.7));
  rock *= 0.82 + 0.36 * (nD * 0.5 + 0.5);

  // ---- grass by season ----
  vec3 grass = uSeason.x * vec3(0.060, 0.092, 0.030)
             + uSeason.y * vec3(0.165, 0.118, 0.052)
             + uSeason.z * vec3(0.110, 0.092, 0.064)
             + uSeason.w * vec3(0.085, 0.105, 0.036);
  grass *= 0.78 + 0.44 * (nC * 0.5 + 0.5);
  vec3 scrub = vec3(0.050, 0.058, 0.032) * (0.8 + 0.4 * (nB * 0.5 + 0.5));

  float rockiness = smoothstep(0.30, 0.58, slope + nB * 0.12);
  rockiness = max(rockiness, smoothstep(4.3, 5.1, alt + nA * 0.5));
  vec3 ground = mix(grass, rock, rockiness);
  ground = mix(ground, scrub, (1.0 - rockiness) * smoothstep(3.7, 3.0, alt) * 0.65);

  // ---- forest ----
  vec3 conifer = vec3(0.022, 0.040, 0.026);
  vec3 broad = vec3(0.045, 0.068, 0.028);
  vec3 canopy = mix(broad, conifer, smoothstep(1.3, 2.3, alt));
  float tv = tree.y;
  canopy *= 0.7 + 0.6 * tv;
  // autumn colour in a few broadleaf trees (Oct–Nov)
  float autumnTree = uSeason.y * step(0.86, tv) * (1.0 - smoothstep(1.6, 2.3, alt));
  canopy = mix(canopy, vec3(0.20, 0.10, 0.025) * (0.7 + 0.6 * fract(tv * 13.0)), autumnTree);
  // lighter crown tips, darker inner branches
  canopy *= mix(0.65, 1.15, 1.0 - tree.z);

  // ---- hill villages: terraced fields, houses, and where their lights are ----
  const float HOUSE_CELL = 0.03; // km
  float vm = villageField(q, hb) * (1.0 - smoothstep(0.32, 0.55, slope))
           * smoothstep(1.0, 1.8, t) * (1.0 - smoothstep(20.0, 26.0, t));
  float lightCov = 0.0;
  float lightId = 0.0;
  if (vm > 0.01) {
    // terraces: steps every ~7 m of height, faded out where they would be sub-pixel
    float terStep = 0.007;
    float ter = fract(alt / terStep + nC * 0.15);
    float spacingPx = terStep / max(slope * 1.3, 0.04) / max(fp, 1e-5);
    float terVis = smoothstep(3.0, 8.0, spacingPx);
    vec3 field = uSeason.x * vec3(0.065, 0.11, 0.035)
               + uSeason.y * vec3(0.19, 0.14, 0.06)
               + uSeason.z * vec3(0.12, 0.10, 0.06)
               + uSeason.w * vec3(0.10, 0.12, 0.04);
    field = mix(field, field * vec3(0.7, 1.15, 0.75), smoothstep(-0.1, 0.4, nB)); // some plots still green
    field *= 0.85 + 0.3 * (nD * 0.5 + 0.5);
    vec3 terr = mix(field, field * 0.55, smoothstep(0.8, 0.93, ter) * terVis + (1.0 - terVis) * 0.12);
    ground = mix(ground, terr, vm * (1.0 - rockiness));

    // houses: one per jittered 30 m cell where the village is dense enough
    vec2 hc = floor(p.xz / HOUSE_CELL);
    vec2 hcen = (hc + 0.25 + 0.5 * hash22(hc + 41.0)) * HOUSE_CELL;
    float present = step(hash12(hc + 3.1), vm * 0.4);
    float hs = 0.0035 + 0.002 * hash12(hc + 8.8);
    vec2 dd = abs(p.xz - hcen);
    float inHouse = present * step(max(dd.x, dd.y), hs) * smoothstep(0.5, 1.6, hs * 2.0 / fp);
    float hk = hash12(hc + 17.3);
    vec3 houseCol = hk < 0.45 ? vec3(0.55, 0.53, 0.48)   // whitewashed walls
                  : hk < 0.7  ? vec3(0.40, 0.29, 0.17)   // ochre mud
                  : hk < 0.88 ? vec3(0.20, 0.27, 0.33)   // blue tin roof
                              : vec3(0.33, 0.12, 0.08);  // red tin roof
    ground = mix(ground, houseCol, inHouse);

    // lights: project each nearby house's window to the screen; keep it if visible from here
    for (int j = -1 + uZero; j <= 1; j++)
    for (int i = -1 + uZero; i <= 1; i++) {
      vec2 c = hc + vec2(float(i), float(j));
      if (hash12(c + 3.1) > vm * 0.4 || hash12(c + 5.5) > 0.32) continue; // not every house has a lamp
      vec2 cen = (c + 0.25 + 0.5 * hash22(c + 41.0)) * HOUSE_CELL;
      vec3 Lp = vec3(cen.x, terrainBase(cen, oct) + 0.004, cen.y);
      vec3 ld = Lp - ro;
      float dl = length(ld);
      if (t < dl - 0.04) continue; // a nearer slope hides this light
      float ang = length(cross(rd, ld / dl)) / pixelAngle();
      float cov = exp(-ang * ang / 0.45);
      if (cov > lightCov) { lightCov = cov; lightId = hash12(c + 9.1); }
    }
  }

  vec3 albedo;
  float canopyW;
  float distForest = forestDensity(q, hb) * (1.0 - smoothstep(0.55, 0.85, slope));
  if (tf > 0.0) {
    vec3 floorCol = mix(ground, scrub * 0.7, dens * 0.8);
    vec3 nearAlb = mix(floorCol, canopy, crown);
    vec3 farAlb = mix(ground, canopy * 0.8, distForest);
    albedo = mix(farAlb, nearAlb, tf);
    canopyW = mix(distForest, crown, tf);
  } else {
    albedo = mix(ground, mix(conifer, broad, 0.3) * 0.82 * (0.85 + 0.3 * (nB * 0.5 + 0.5)), distForest);
    canopyW = distForest;
  }

  // ---- ambient occlusion ----
  float ao = horizonAO(p, t);
  if (tf > 0.0) {
    float under = (1.0 - crown) * dens;
    ao *= mix(1.0, 0.45, under * tf);
    ao *= mix(1.0, mix(0.6, 1.0, 1.0 - tree.z), crown);
  }
  ao *= mix(1.0, 0.8, distForest * (1.0 - tf));

  // ---- snow field (applied per frame, so snow line can follow season & snowfall) ----
  float aspect = dot(Ns.xz, uNorth);
  float snowAlt = alt + 0.32 * nA + 0.09 * nB + 0.035 * nC + 0.2 * aspect;
  // high faces hold snow and ice even when steep (fluted snow on Himalayan giants)
  float steepOk = 0.24 * smoothstep(4.8, 7.0, alt);
  float suit = smoothstep(0.66 + steepOk, 0.42 + steepOk * 0.6, slope + nC * 0.06 + nD * 0.03);
  // vertical flutes: streaks of rock and snow down steep faces
  float flute = noise2(vec2(q.x * 60.0 + q.y * 9.0, q.y * 7.0 + alt * 3.0));
  suit *= mix(1.0, 0.55 + 0.45 * smoothstep(-0.3, 0.4, flute), smoothstep(0.35, 0.6, slope));
  suit = mix(suit, suit * 0.45, canopyW);

  o0 = vec4(octEncodeY(N), t, clamp(ao, 0.0, 1.0));
  o1 = vec4(sqrt(clamp(albedo, 0.0, 1.0)), canopyW);
  o2 = vec4(octEncodeY(Ns), snowAlt, suit);
  float meadow = (1.0 - rockiness) * (1.0 - canopyW) * (1.0 - smoothstep(4.6, 5.2, alt));
  o3 = vec4(lightCov, lightId, vm, canopyW > 0.5 && tf > 0.0 ? tree.y : meadow);
}
`;
})();
