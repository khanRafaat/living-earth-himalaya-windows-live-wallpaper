/*
 * The tree on the rock at the left, and the leaves the wind carries past (see foreground.js).
 *
 *  treeLight  a 7-pixel probe, read back into plain uniforms without waiting (foreground.js): the sun and moon
 *             light at the tree (atmosphere, clouds, and the mountains or our own rock in the way, at the
 *             foot, middle and top of the tree), the sky and ground light around it, and the gust there
 *  treeBark   trunk and branches, drawn as tubes
 *  treeLeaf   leaves and flowers, one card each (instanced), alpha-to-coverage on a multisampled target
 *  treeDrift  falling leaves, drawn straight onto the picture
 *  treeComp   lays the resolved tree over the picture
 *
 * Positions are metres from the eye (x right, y up, z ahead), tree-local ones from the foot of the trunk.
 * Projected with the same cylindrical panorama as the scene, so the tree sits exactly on its rock. Lit by
 * the same light and graded by the same code (S.post), so it belongs to the picture.
 */
(function () {
  'use strict';
  const S = window.LE.shaders;

  // ------------------------------------------------------------------ light probe
  S.treeLight = () => `${S.header}
${S.camera}
${S.noise}
${S.terrain}
${S.ledge}
${S.atmosphere}
${S.atmosphereLookup}
${S.volumeCommon}
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uKeyDir;
uniform vec3 uSunE;
uniform vec3 uMoonE;
uniform vec3 uTreeFoot; // km, world
uniform vec3 uTreeMid;
uniform vec3 uTreeTop;
uniform vec2 uToCam;    // horizontal unit vector (x, z) from the tree toward the eye
uniform vec2 uGustDir;
uniform vec2 uGustTravel;
out vec4 o;

// The gust bands that cross the forest and the grass (composite.js), sampled where the tree stands, plus
// smaller gusts a few tens of metres across that come and go every few seconds
float localGust() {
  vec2 pk = uTreeMid.xz;
  vec2 across = vec2(-uGustDir.y, uGustDir.x);
  vec2 wc = vec2(dot(pk, uGustDir), dot(pk, across));
  vec2 a = wc - vec2(uGustTravel.x, 0.0);
  vec2 b = wc - vec2(uGustTravel.y, 0.0);
  float big = textureLod(uNoise2D, a * vec2(1.6, 0.4), 2.0).r * 0.65 + textureLod(uNoise2D, b * vec2(1.0, 0.3) + 0.37, 2.0).g * 0.35;
  float small = textureLod(uNoise2D, a * vec2(16.0, 4.0) + 0.21, 0.0).r;
  return clamp((big - 0.5) * 2.0 * 0.55 + (small - 0.5) * 2.0 * 0.75, -1.0, 1.0);
}

// as the shadow pass (lighting.js), with our own rock in the way too
float keyShadow(vec3 p) {
  vec3 L = uKeyDir;
  if (L.y < -0.08) return 0.0;
  float res = 1.0;
  float s = 0.003;
  for (int i = uZero; i < 170; i++) {
    vec3 q = p + L * s;
    if (q.y > 9.6) break;
    int oct = int(clamp(floor(log2(4.8 / ((s * 0.0025 + 2e-5) * 1.6))), 3.0, 10.0));
    float h = max(terrainBase(q.xz, oct), ledgeHeightKm(q));
    float d = q.y - h;
    res = min(res, 12.0 * d / s);
    if (res < 0.0) break;
    s += clamp(d * 0.55, max(0.0012, s * 0.01), 2.0);
    if (s > 80.0) break;
  }
  res = clamp(res, 0.0, 1.0);
  return res * res * (3.0 - 2.0 * res);
}

// as cloudShadow() in the composite
float cloudShadowAt(vec3 pos) {
  if (uCoverage < 0.015) return 1.0;
  float hMid = mix(uCloudBase, uCloudTop, 0.35);
  if (pos.y > hMid) return 1.0;
  float reach = smoothstep(hMid, hMid - 1.2, pos.y);
  vec3 L = uKeyDir;
  float ly = max(L.y, 0.06);
  vec3 p = pos + L / ly * (hMid - pos.y);
  vec3 q = p + uWind;
  float d = cloudBody(q, 0.35, cloudCoverageAt(p.xz) * cloudRegion(p.xz));
  float sh = exp(-clamp(d, 0.0, 1.0) * uCloudDensity * 3.2);
  return mix(1.0, mix(max(sh, 0.12), 0.07, uOvercast), reach);
}

// as skyIrradiance() plus the overcast light in the composite
vec3 skyAmb(vec3 n) {
  vec3 zen = skyLUT(vec3(0.0, 1.0, 0.0));
  vec2 hd = n.xz;
  float l = length(hd);
  hd = l > 1e-4 ? hd / l : vec2(0.0, 1.0);
  vec3 hor = skyLUT(normalize(vec3(hd.x, 0.18, hd.y)));
  vec3 horB = skyLUT(normalize(vec3(-hd.x, 0.18, -hd.y)));
  float up = n.y * 0.5 + 0.5;
  vec3 amb = PI * (zen * (0.5 * up + 0.08) + hor * (0.3 + 0.2 * l) + horB * 0.1 * (1.0 - 0.5 * l));
  vec3 cloudAmb = (uSunE * transmittance(uCloudBase, uSunDir.y) * clamp(uSunDir.y * 1.1 + 0.06, 0.0, 1.0) * 0.13
                 + uMoonE * transmittance(uCloudBase, uMoonDir.y) * clamp(uMoonDir.y + 0.05, 0.0, 1.0) * 0.13
                 + zen * 0.6) * PI * (0.55 + 0.45 * up);
  return mix(amb, cloudAmb * vec3(0.95, 0.97, 1.0), uOvercast);
}

void main() {
  int i = int(gl_FragCoord.x);
  vec3 p = uTreeMid;
  float cs = cloudShadowAt(p);
  if (i == 0) o = vec4(uSunE * transmittance(p.y, uSunDir.y) * cs, 1.0);
  else if (i == 1) o = vec4(uMoonE * transmittance(p.y, uMoonDir.y) * cs, 1.0);
  else if (i == 2) o = vec4(skyAmb(vec3(0.0, 1.0, 0.0)), 1.0);
  else if (i == 3) o = vec4(skyAmb(vec3(uToCam.x, 0.0, uToCam.y)), 1.0);
  else if (i == 4) o = vec4(skyAmb(vec3(-uToCam.x, 0.0, -uToCam.y)), 1.0);
  else if (i == 5) {
    // light thrown back up by the rock and grass under the tree
    vec3 sunG = uSunE * transmittance(uTreeFoot.y, uSunDir.y) * max(uSunDir.y, 0.0) + uMoonE * transmittance(uTreeFoot.y, uMoonDir.y) * max(uMoonDir.y, 0.0);
    o = vec4(vec3(0.11, 0.105, 0.09) * (sunG * cs * keyShadow(uTreeFoot + vec3(0.0, 0.0012, 0.0)) * 0.6 + skyAmb(vec3(0.0, 1.0, 0.0)) * 0.7), 1.0);
  } else {
    o = vec4(keyShadow(uTreeFoot + vec3(0.0, 0.0006, 0.0)), keyShadow(p), keyShadow(uTreeTop), localGust());
  }
}
`;

  // ------------------------------------------------------------------ shared vertex code
  // (precision as in the fragment shaders: uniforms both stages use must match)
  // Every vertex of 20 000 leaves runs this, every time the tree is drawn, so anything the same for the whole
  // tree comes in as a uniform: the light and the state of the wind (TreeWind in foreground.js).
  const treeVS = `
precision highp int;
uniform vec2 uRes;
uniform float uHFov;
uniform float uHorizonY;
uniform vec4 uBox;       // the target's rectangle on the screen (px)
uniform vec3 uSite;      // foot of the trunk, metres from the eye
uniform vec3 uWindDir;   // where the air goes: horizontal unit vector, eye frame
uniform float uWindStr;  // 0 still, 1 a strong breeze, 2.4 a storm
uniform vec2 uLean;      // how far the top of the tree has moved now: downwind, across (m)
uniform vec2 uLimb[4];   // four swings that the limbs share out between them: downwind, across (m per unit of flex)
uniform vec4 uFront;     // the gust at four places across the crown, upwind to downwind, -1 to 1
uniform float uFlutter;  // the clock for twigs and leaves: it runs faster in a gust
uniform float uTreeH;
uniform vec3 uCrownC;    // crown as an ellipsoid, tree-local metres
uniform vec3 uCrownR;
uniform vec3 uKeyDir;
uniform float uKeyIsSun;
uniform vec4 uTreeL[7]; // the probe's seven pixels (tree.js treeLight)

// The flutter clock wraps every 2400 s (it keeps its precision that way). Frequencies are rounded to whole
// cycles per 2400 s, so the wrap never makes the tree jump.
float osc(float w, float ph) {
  float n = floor(w * 2400.0 / 6.2831853 + 0.5);
  return sin(n * (6.2831853 / 2400.0) * uFlutter + ph);
}

// The gust where P is: a gust reaches the upwind side of the crown first and rolls across it
float gustAt(vec3 P) {
  float q = clamp(1.5 + 1.5 * dot(P - uCrownC, uWindDir) / length(uCrownR.xz), 0.0, 2.999);
  int i = int(q);
  return mix(uFront[i], uFront[i + 1], q - float(i));
}

// How far the wind moves a point of the tree. A = (limb flex, limb phase, twig flex, twig phase): the
// flex grows with the distance along the wood from the fork, so every joint stays joined.
vec3 windOffset(vec3 P, vec4 A, float gust) {
  float s = uWindStr;
  vec3 W = uWindDir;
  vec3 side = vec3(-W.z, 0.0, W.x);
  // the whole tree bends: more toward the top
  float h = clamp(P.y / uTreeH, 0.0, 1.2);
  vec3 d = (W * uLean.x + side * uLean.y) * h * h;
  // Each limb takes its own mix of two of the shared swings, and some go the other way across the wind, so
  // neighbouring limbs don't move together
  float m = A.y * 0.6366198;
  int i = int(m) & 3;
  vec2 l = mix(uLimb[i], uLimb[(i + 1) & 3], fract(m));
  l.y *= fract(A.y * 5.1) > 0.5 ? 1.0 : -1.0;
  d += (W * l.x + side * l.y + vec3(0.0, 0.6 * l.y, 0.0)) * A.x;
  // Twigs flick quickly, each at its own rate, and come and go instead of all flicking all the time
  float g = max(1.0 + 0.8 * gust, 0.2);
  float rate = 3.2 + 2.6 * fract(A.w * 3.7);
  float burst = smoothstep(-0.3, 0.7, osc(0.7 + 0.8 * fract(A.w * 9.1), A.w * 5.0));
  float f2 = (osc(rate, A.w) * 0.6 + osc(rate * 1.6, A.w * 2.3) * 0.4) * (0.35 + 0.65 * burst);
  d += (W * 0.22 * s * g + (side * 0.6 + vec3(0.0, 0.5, 0.0)) * f2 * s * (0.5 + 0.5 * g) * 0.6) * A.z * 0.25;
  return d;
}

// eye-frame metres to the target's clip space
vec4 projectEye(vec3 pe) {
  float pa = uHFov / uRes.x;
  float a = atan(pe.x, pe.z);
  float r = length(pe.xz);
  vec2 px = vec2(uRes.x * 0.5 + a / pa, uHorizonY * uRes.y + pe.y / max(r, 1e-3) / pa);
  return vec4((px - uBox.xy) / uBox.zw * 2.0 - 1.0, length(pe) / 80.0 * 2.0 - 1.0, 1.0);
}

// how much of the key light gets through the crown to P (tree-local)
float crownLight(vec3 P) {
  vec3 o = (P - uCrownC) / uCrownR;
  vec3 dd = uKeyDir / uCrownR;
  float a = dot(dd, dd);
  float b = dot(o, dd);
  float c = dot(o, o) - 1.0;
  float disc = b * b - a * c;
  if (disc <= 0.0) return 1.0;
  float sq = sqrt(disc);
  float len = max((-b + sq) / a, 0.0) - max((-b - sq) / a, 0.0);
  return exp(-len * 0.45);
}

// the mountains' (or our rock's) shadow, from the probe at the foot, middle and top of the tree
float terrainLight(float y) {
  vec4 s = uTreeL[6];
  float h = clamp(y / uTreeH, 0.0, 1.0);
  return h < 0.5 ? mix(s.r, s.g, h * 2.0) : mix(s.g, s.b, h * 2.0 - 1.0);
}

// ambient occlusion inside the crown: dark deep inside, open at the rim and the top
float crownAO(vec3 P) {
  vec3 q = (P - uCrownC) / uCrownR;
  return clamp(0.45 + 0.55 * smoothstep(0.25, 1.0, length(q)) + 0.15 * q.y, 0.4, 1.0);
}
`;

  S.treeBarkVertex = () => `#version 300 es
precision highp float;
layout(location = 0) in vec3 aP;
layout(location = 1) in vec3 aN;
layout(location = 2) in vec4 aWind;
layout(location = 3) in vec4 aBark; // around, along (m), ao, radius
${treeVS}
out vec3 vPos;
out vec3 vN;
out vec4 vInfo;  // kind 0, variation, ao, key light let through
out vec2 vUV;
out vec2 vBark;
out vec3 vClumpN;
out vec3 vSide;
void main() {
  vClumpN = vec3(0.0);
  vSide = vec3(0.0);
  vec3 P = aP + windOffset(aP, aWind, gustAt(aP));
  vPos = uSite + P;
  vN = aN;
  float key = crownLight(aP) * terrainLight(aP.y);
  vInfo = vec4(0.0, fract(aWind.y * 7.13), aBark.z * crownAO(aP), key);
  vUV = vec2(0.0);
  vBark = aBark.xy;
  gl_Position = projectEye(vPos);
}`;

  S.treeLeafVertex = () => `#version 300 es
precision highp float;
layout(location = 0) in vec3 aStem;
layout(location = 1) in vec3 aDir;   // along the blade, its length
layout(location = 2) in vec3 aSide;  // across, half its width
layout(location = 3) in vec4 aWind;
layout(location = 4) in vec4 aLeaf;  // flutter phase, kind (1 leaf, 2 flower), variation, ao (crown and clump included)
layout(location = 5) in vec4 aClump; // the mass of foliage this leaf belongs to: centre, radius
uniform float uBloom;
${treeVS}
out vec3 vPos;
out vec3 vN;
out vec4 vInfo;
out vec2 vUV;
out vec2 vBark;
out vec3 vClumpN;
out vec3 vSide;
void main() {
  // a strip of four corners: base left, base right, tip left, tip right
  vec2 c = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1) * 2.0 - 1.0);
  vBark = vec2(0.0);
  float gust = gustAt(aStem);
  vec3 stem = aStem + windOffset(aStem, aWind, gust);
  float s = uWindStr;
  float g = max(1.0 + 0.8 * gust, 0.2);
  vec3 nrm = normalize(cross(aDir, aSide));
  float L = length(aDir);
  float Wd = length(aSide);
  // Blades stream downwind, nod and twist: as a gust rolls through they turn their pale undersides up.
  // Each one rests and shivers in its own time.
  float rest = 0.45 + 0.55 * osc(0.6 + 1.1 * fract(aLeaf.x * 3.1), aLeaf.x * 17.0);
  float fl = (osc(5.0 + 6.0 * fract(aLeaf.x * 13.1), aLeaf.x * 50.0) * 0.6 + osc(11.0, aLeaf.x * 23.0) * 0.4) * rest;
  float tw = osc(7.0 + 4.0 * fract(aLeaf.x * 5.3), aLeaf.x * 31.0) * rest;
  float amp = (0.06 + 0.5 * s) * (0.55 + 0.45 * g);
  vec3 dir = normalize(aDir / L + uWindDir * 0.35 * s * g + nrm * fl * amp * 0.5) * L;
  vec3 side = normalize(aSide / Wd + nrm * tw * amp * 1.2) * Wd;
  float size = aLeaf.y > 1.5 ? uBloom : 1.0; // flowers only in their season
  vec3 P = stem + (dir * c.x + side * c.y) * size;
  vPos = uSite + P;
  vN = normalize(cross(dir, side));
  // Foliage is lit as masses: each clump has a lit side and a side in its own shade, and is dark inside.
  // The light crosses the leaves of the clump between this one and the sun or moon.
  vec3 rel = (aStem + aDir * 0.5) - aClump.xyz;
  vClumpN = rel / max(length(rel), 1e-3);
  vSide = side / Wd;
  float b = dot(rel, uKeyDir);
  float exitT = -b + sqrt(max(b * b - dot(rel, rel) + aClump.w * aClump.w, 0.0));
  float clumpLight = mix(exp(-exitT * 2.6), 1.0, 0.12);
  float key = crownLight(aStem) * terrainLight(aStem.y) * clumpLight;
  vInfo = vec4(aLeaf.y, aLeaf.z, aLeaf.w, key);
  vUV = c;
  gl_Position = projectEye(vPos);
}`;

  // falling leaves: an instance per leaf, its centre and two half-axes in eye-frame metres
  S.treeDriftVertex = () => `#version 300 es
precision highp float;
layout(location = 0) in vec3 aC;
layout(location = 1) in vec3 aA;
layout(location = 2) in vec3 aB;
layout(location = 3) in vec4 aInfo;  // kind (3 leaf, 4 petal), variation, opacity, key light let through
${treeVS}
out vec3 vPos;
out vec3 vN;
out vec4 vInfo;
out vec2 vUV;
out vec2 vBark;
out vec3 vClumpN;
out vec3 vSide;
flat out float vAlpha;
void main() {
  vClumpN = vec3(0.0);
  vSide = vec3(0.0);
  int id = gl_VertexID % 6;
  vec2 c = vec2((id == 1 || id == 2 || id == 4) ? 1.0 : -1.0, (id == 2 || id == 4 || id == 5) ? 1.0 : -1.0);
  vPos = aC + aA * c.x + aB * c.y;
  vN = normalize(cross(aA, aB));
  // in the crown's shade, or the mountains'
  vInfo = vec4(aInfo.x, aInfo.y, 1.0, aInfo.w * crownLight(aC - uSite) * terrainLight(aC.y - uSite.y));
  vBark = vec2(0.0);
  vUV = vec2(c.x * 0.5 + 0.5, c.y);
  vAlpha = aInfo.z;
  gl_Position = projectEye(vPos);
}`;

  // ------------------------------------------------------------------ shading
  const treeFS = (drift) => `${S.header}
${S.noise}
${S.atmosphere}
${S.atmosphereLookup}
uniform vec2 uRes;
uniform vec4 uBox;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uKeyDir;
uniform float uKeyIsSun;
uniform float uOvercast;
uniform float uFlash;
uniform float uTime;
uniform float uWet;
uniform vec4 uSeason; // summer, autumn, winter, spring
uniform float uSnowTree;
uniform vec2 uToCam;
uniform vec3 uSite;
uniform vec4 uTreeL[7]; // the probe's seven pixels (treeLight above)
uniform sampler2D uG0;
${S.post}
in vec3 vPos;
in vec3 vN;
in vec4 vInfo;
in vec2 vUV;
in vec2 vBark;
in vec3 vClumpN;
in vec3 vSide;
${drift ? 'flat in float vAlpha;\nout vec4 fragColor;' : 'layout(location = 0) out vec4 fragColor;\nlayout(location = 1) out vec4 fragCover;'}

// sky and ground light for a surface facing n
vec3 ambient(vec3 n) {
  vec3 up = uTreeL[2].rgb, toCam = uTreeL[3].rgb, away = uTreeL[4].rgb, down = uTreeL[5].rgb;
  float y = n.y;
  float c = dot(n.xz, uToCam);
  vec3 side = mix(away, toCam, c * 0.5 + 0.5);
  return y >= 0.0 ? mix(side, up, y) : mix(side, down, -y);
}

float ggx(vec3 n, vec3 v, vec3 l, float rough) {
  vec3 h = normalize(l + v);
  float nh = max(dot(n, h), 0.0);
  float a2 = pow(rough, 4.0);
  float dd = nh * nh * (a2 - 1.0) + 1.0;
  float F = 0.04 + 0.96 * pow(1.0 - max(dot(v, h), 0.0), 5.0);
  return a2 / (PI * dd * dd) * F * 0.25;
}

void main() {
  vec2 fc = gl_FragCoord.xy + uBox.xy; // screen pixel
  // hidden behind nearer rock
  float tl = texelFetch(uG0, ivec2(fc), 0).z;
  float dist = length(vPos);
  if (tl > 0.0 && tl * 1000.0 < dist - 0.08) discard;

  int kind = int(vInfo.x + 0.5);
  float vr = vInfo.y;
  float ao = vInfo.z;
  float keyVis = vInfo.w;
  vec3 v = -vPos / dist;
  vec3 n = normalize(vN);
  float alpha = 1.0;
  vec3 alb;
  float rough = 0.6;
  float trans = 0.0;
  float specK = 0.0;
  vec3 transC = vec3(0.0);

  if (kind == 0) {
    // bark: reddish brown, rough, cracked along its length and peeling in flakes; grey lichen, moss on top
    float around = vBark.x;
    float along = vBark.y;
    float nb = noise2(vec2(around * 9.0, along * 2.2)) * 0.6 + noise2(vec2(around * 23.0, along * 7.0)) * 0.4;
    float flake = smoothstep(0.35, 0.75, noise2(vec2(around * 14.0, along * 4.0) + 3.0));
    float fiss = smoothstep(0.72, 0.97, 1.0 - abs(noise2(vec2(around * 7.0, along * 1.1) + 1.7)));
    alb = mix(vec3(0.055, 0.037, 0.03), vec3(0.15, 0.095, 0.068), nb * 0.5 + 0.5);
    alb = mix(alb, vec3(0.2, 0.15, 0.115), flake * 0.4);
    alb *= 1.0 - 0.6 * fiss;
    // at the foot: stained by soil and rain splash, with moss creeping up from the ground
    float yl = vPos.y - uSite.y;
    float foot = 1.0 - smoothstep(0.1, 1.05, yl + nb * 0.15);
    float lichen = smoothstep(0.3, 0.65, noise2(vec2(around * 6.3, along * 3.7) + 7.0) * 0.7 + noise2(vec2(around * 17.0, along * 9.0) + 2.0) * 0.3) * (1.0 - fiss) * (1.0 - foot);
    alb = mix(alb, vec3(0.21, 0.22, 0.17), lichen * 0.4);
    alb = mix(alb, vec3(0.04, 0.06, 0.022), smoothstep(0.25, 0.8, n.y) * smoothstep(-0.2, 0.5, nb) * 0.6 * (1.0 - smoothstep(0.6, 2.2, yl)));
    alb = mix(alb, mix(vec3(0.04, 0.032, 0.025), vec3(0.032, 0.046, 0.018), smoothstep(-0.2, 0.4, nb)), foot * 0.8);
    ao *= 1.0 - 0.4 * fiss;
    if (dot(n, v) < 0.0) n = -n;
  } else {
    // leaf, flower or petal card
    float a = vUV.x;
    float x = vUV.y;
    float shape;
    if (kind == 2 || kind == 4) {
      // a bell of the flower truss: round, with a darker throat
      float d = length(vec2(a * 2.0 - 1.0, x));
      shape = 1.0 - d;
      alb = mix(vec3(0.42, 0.018, 0.03), vec3(0.62, 0.05, 0.06), vr) * (0.7 + 0.3 * smoothstep(0.0, 0.6, d));
      trans = 0.6;
      transC = vec3(0.5, 0.04, 0.04);
      rough = 0.5;
      if (dot(n, v) < 0.0) n = -n;
    } else {
      // oblong pointed blade with a short stalk and a pale midrib
      float wp = min(1.9 * sqrt(max(a * (1.0 - a), 0.0)) * (1.25 - 0.45 * a), 1.0) * smoothstep(0.0, 0.12, a);
      wp = max(wp, 0.08 * step(a, 0.12) * step(0.0, a)); // stalk
      shape = wp - abs(x);
      bool top = dot(n, v) >= 0.0;
      if (kind == 3) {
        // fallen: old leaves gone yellow, brown and russet
        alb = mix(mix(vec3(0.30, 0.20, 0.035), vec3(0.17, 0.075, 0.03), smoothstep(0.2, 0.6, vr)), vec3(0.08, 0.05, 0.03), smoothstep(0.7, 1.0, vr));
        alb = top ? alb : alb * vec3(1.15, 1.1, 1.0);
        trans = 0.5;
        transC = vec3(0.16, 0.1, 0.02);
      } else {
        // evergreen, deep green and glossy above; pale silvery green felt below, which shows from beneath and
        // flashes when the wind turns them; here and there a leaf turning before it falls
        vec3 upper = mix(vec3(0.03, 0.058, 0.02), vec3(0.058, 0.094, 0.03), vr);
        if (vr > 0.985) upper = vec3(0.12, 0.1, 0.035);
        // the seasons: fresh light green in spring, reds and golds in autumn with some leaves still green, dull in winter
        vec3 spring = mix(vec3(0.05, 0.1, 0.022), vec3(0.095, 0.155, 0.035), vr);
        float turned = step(0.5, fract(vr * 17.0));
        vec3 autumn = mix(upper, mix(vec3(0.2, 0.045, 0.018), vec3(0.34, 0.17, 0.03), fract(vr * 7.0)), turned);
        vec3 winter = mix(vec3(0.033, 0.046, 0.024), vec3(0.058, 0.066, 0.034), vr);
        upper = upper * uSeason.x + autumn * uSeason.y + winter * uSeason.z + spring * uSeason.w;
        vec3 lower = mix(vec3(0.095, 0.115, 0.072), vec3(0.125, 0.13, 0.085), vr);
        if (vr > 0.82) lower = mix(lower, vec3(0.14, 0.11, 0.07), 0.45);
        alb = top ? upper : lower;
        alb = mix(alb, alb * 1.6 + vec3(0.015, 0.025, 0.0), smoothstep(0.07, 0.0, abs(x)) * smoothstep(0.05, 0.2, a) * 0.5);
        specK = top ? 1.0 : 0.15;
        rough = top ? mix(0.36, 0.22, uWet) : 0.8;
        trans = top ? 1.0 : 0.8;
        transC = mix(vec3(0.09, 0.15, 0.025), vec3(0.24, 0.11, 0.02), uSeason.y); // sunlight through a leaf takes its colour
      }
      // folded a little along the midrib, so each half catches the light differently
      if (dot(vSide, vSide) > 0.25) n = normalize(n - vSide * x * 0.4);
      if (!top) n = -n;
    }
    float fw = max(fwidth(shape), 1e-4);
    alpha = clamp(shape / fw + 0.5, 0.0, 1.0);
    if (alpha < 0.01) discard;
  }

  // snow on the upper sides, and the dark sheen of wet leaves and bark
  alb = mix(alb, vec3(0.82, 0.85, 0.9), uSnowTree * smoothstep(0.35, 0.85, n.y));
  alb *= 1.0 - 0.3 * uWet;

  vec3 sunL = uTreeL[0].rgb;
  vec3 moonL = uTreeL[1].rgb;
  float shS = uKeyIsSun > 0.5 ? keyVis : 1.0;
  float shM = uKeyIsSun > 0.5 ? 1.0 : keyVis;
  float ndlS = dot(n, uSunDir);
  float ndlM = dot(n, uMoonDir);
  // leaves are lit partly as the mass they belong to, so a clump reads as a whole, with a lit side and a shaded one
  vec3 nd = n;
  float wrap = 0.0;
  if (kind != 0 && dot(vClumpN, vClumpN) > 0.25) {
    nd = normalize(mix(n, vClumpN, 0.6));
    wrap = 0.3;
  }
  float dS = max((dot(nd, uSunDir) + wrap) / (1.0 + wrap), 0.0);
  float dM = max((dot(nd, uMoonDir) + wrap) / (1.0 + wrap), 0.0);
  vec3 col = alb / PI * (sunL * shS * dS + moonL * shM * dM + ambient(nd) * ao);
  // light through the blade when it is lit from behind, strongest looking toward the sun
  float back = max(-ndlS, 0.0) * (0.4 + 0.6 * pow(max(dot(-v, uSunDir), 0.0), 3.0));
  col += transC * sunL * shS * back * trans * 0.45;
  col += transC * moonL * shM * max(-ndlM, 0.0) * trans * 0.3;
  // the waxy shine of the leaves
  col += sunL * shS * max(ndlS, 0.0) * ggx(n, v, uSunDir, rough) * (0.6 + 1.4 * uWet) * specK * (1.0 - 0.85 * uOvercast);
  col += moonL * shM * max(ndlM, 0.0) * ggx(n, v, uMoonDir, rough) * 0.6 * specK;
  // lightning lights the tree for an instant
  col += alb * uFlash * vec3(0.72, 0.78, 1.0) * 1.6 * (0.45 + 0.55 * max(n.y, 0.0)) * ao;

  col = exposeColor(col, dist * 0.001);
  vec4 outC = finishColor(col, fc);
${drift ? '  float aa = alpha * vAlpha;\n  fragColor = vec4(outC.rgb * aa, aa);' : '  fragColor = vec4(outC.rgb, alpha);\n  fragCover = vec4(1.0);'}
}
`;
  S.treeFragment = () => treeFS(false);
  S.treeDriftFragment = () => treeFS(true);

  // ------------------------------------------------------------------ the resolved tree over the picture
  S.treeCompVertex = `#version 300 es
uniform vec2 uRes;
uniform vec4 uBox;
void main() {
  int id = gl_VertexID % 6;
  vec2 c = vec2((id == 1 || id == 2 || id == 4) ? 1.0 : 0.0, (id == 2 || id == 4 || id == 5) ? 1.0 : 0.0);
  gl_Position = vec4((uBox.xy + c * uBox.zw) / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;
  S.treeComp = () => `${S.header}
uniform vec4 uBox;
uniform sampler2D uTreeColor;
uniform sampler2D uTreeCover;
out vec4 fragColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy - uBox.xy);
  float cover = texelFetch(uTreeCover, c, 0).r;
  if (cover <= 0.0) discard;
  // the resolve averaged colour over the samples, empty ones counting as black: already premultiplied
  fragColor = vec4(texelFetch(uTreeColor, c, 0).rgb, cover);
}`;
})();
