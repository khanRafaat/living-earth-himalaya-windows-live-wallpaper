/*
 * The goats on the rock by the tree (goats.js).
 *
 *  goat        a goat's body, lit as the tree is: the tree's light probe (sun and moon through air and cloud, the sky and
 *              ground light round it), the hill's shadow where it stands, the tree's crown, its own body in the way of
 *              the sun, and the sky its body hides from its belly and the insides of its legs. Into a multisampled
 *              target, laid over the picture by treeComp.
 *  goatShadow  its shadow on the rock and the dark under it, over the picture before the goats and the tree
 *
 * Its own body stands in for it in the light as eleven capsules (goats.js goatCapsules): barrel, neck, head, and two for
 * each leg. Positions are metres from the eye.
 */
(function () {
  'use strict';
  const S = window.LE.shaders;

  const caps = `
uniform highp vec4 uCap[22]; // capsule i: uCap[2i] = one end, radius; uCap[2i + 1] = the other end

// the distance from p to capsule i's axis
float capAxis(vec3 p, int i) {
  vec3 a = uCap[2 * i].xyz;
  vec3 ba = uCap[2 * i + 1].xyz - a;
  float s = clamp(dot(p - a, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
  return length(p - a - ba * s);
}

// How much of the light coming from L reaches p past the goat (1: nothing in the way), softer the further the shadow
// falls. The capsule p belongs to (own), and any p is inside of, don't count.
float capsLight(vec3 p, vec3 L, float own) {
  float vis = 1.0;
  for (int i = 0; i < 11; i++) {
    float r = uCap[2 * i].w;
    if (r <= 0.0 || abs(float(i) - own) < 0.5 || capAxis(p, i) < r * 1.1) continue;
    vec3 a = uCap[2 * i].xyz;
    vec3 ba = uCap[2 * i + 1].xyz - a;
    vec3 w0 = p - a;
    float B = dot(L, ba);
    float C = max(dot(ba, ba), 1e-8);
    float D = dot(L, w0);
    float E = dot(ba, w0);
    float s = clamp((E - B * D) / max(C - B * B, 1e-8), 0.0, 1.0);
    float t = dot(a + ba * s - p, L);
    if (t <= 0.0) continue;
    s = clamp(dot(p + L * t - a, ba) / C, 0.0, 1.0);
    float d = length(p + L * t - a - ba * s);
    float pen = 0.006 + 0.03 * t;
    vis *= smoothstep(r - pen, r + pen, d);
  }
  return vis;
}

// how much of the sky the goat hides from a surface at p facing n
float capsSky(vec3 p, vec3 n, float own) {
  float occ = 0.0;
  for (int i = 0; i < 11; i++) {
    float r = uCap[2 * i].w;
    if (r <= 0.0 || abs(float(i) - own) < 0.5) continue;
    vec3 a = uCap[2 * i].xyz;
    vec3 ba = uCap[2 * i + 1].xyz - a;
    float s = clamp(dot(p - a, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
    vec3 d = a + ba * s - p;
    float l = length(d);
    if (l < r * 1.15) continue;
    occ += r / l * max(dot(n, d / l), 0.0) * min(1.0, (length(ba) + 2.0 * r) / (2.0 * l));
  }
  return clamp(occ * 0.6, 0.0, 0.7);
}
`;

  S.goatVertex = () => `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) in vec3 aP;
layout(location = 1) in vec3 aN;
layout(location = 2) in vec4 aA; // kind (0 coat, 1 horn, 2 hoof), darkening of its part, height above its ground (m), its capsule
layout(location = 3) in vec4 aB; // pattern (m along its part, m round it), region (0 body, 0.5 neck, ears, tail, 1 lower legs, 2-3 head from the poll to the nose, 4 beard), sine round its ring (1 on top)
uniform vec2 uRes;
uniform float uHFov;
uniform float uHorizonY;
uniform vec4 uBox;
${caps}
out vec3 vPos;
out vec3 vN;
out vec4 vA;
out vec4 vB;
void main() {
  vPos = aP;
  vN = aN;
  vB = aB;
  // its own body hides some of the sky from its belly, the insides of its legs and under its neck
  vA = vec4(aA.x, aA.y * (1.0 - capsSky(aP, aN, aA.w)), aA.z, aA.w);
  float pa = uHFov / uRes.x;
  float a = atan(aP.x, aP.z);
  float r = length(aP.xz);
  vec2 px = vec2(uRes.x * 0.5 + a / pa, uHorizonY * uRes.y + aP.y / max(r, 1e-3) / pa);
  gl_Position = vec4((px - uBox.xy) / uBox.zw * 2.0 - 1.0, length(aP) / 80.0 * 2.0 - 1.0, 1.0);
}`;

  S.goatFragment = () => `${S.header}
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
uniform vec2 uToCam;
uniform vec3 uSite;
uniform vec4 uTreeL[7]; // the tree's light probe (tree.js treeLight)
uniform float uCrown;   // 1 with the tree there, whose crown shades what is under it
uniform vec3 uCrownC;
uniform vec3 uCrownR;
uniform sampler2D uG0;
uniform sampler2D uShadow;
uniform float uCoat;    // 0 black, 1 white, 2 brown, 3 fawn, 4 black and white, 5 grey (life.js GOAT_COATS)
uniform float uSeed;
uniform float uSize;
uniform vec2 uFoot;     // where it stands on the picture (px)
${caps}
${S.post}
in vec3 vPos;
in vec3 vN;
in vec4 vA;
in vec4 vB;
layout(location = 0) out vec4 fragColor;
layout(location = 1) out vec4 fragCover;

// sky and ground light for a surface facing n (as the tree's)
vec3 ambient(vec3 n) {
  vec3 up = uTreeL[2].rgb, toCam = uTreeL[3].rgb, away = uTreeL[4].rgb, down = uTreeL[5].rgb;
  float c = dot(n.xz, uToCam);
  vec3 side = mix(away, toCam, c * 0.5 + 0.5);
  return n.y >= 0.0 ? mix(side, up, n.y) : mix(side, down, -n.y);
}

float ggx(vec3 n, vec3 v, vec3 l, float rough) {
  vec3 h = normalize(l + v);
  float nh = max(dot(n, h), 0.0);
  float a2 = pow(rough, 4.0);
  float dd = nh * nh * (a2 - 1.0) + 1.0;
  float F = 0.04 + 0.96 * pow(1.0 - max(dot(v, h), 0.0), 5.0);
  return a2 / (PI * dd * dd) * F * 0.25;
}

// how much of the key light gets through the tree's crown to P (tree-local), as tree.js
float crownLight(vec3 P) {
  vec3 o = (P - uCrownC) / uCrownR;
  vec3 dd = uKeyDir / uCrownR;
  float a = dot(dd, dd);
  float b = dot(o, dd);
  float c = dot(o, o) - 1.0;
  float disc = b * b - a * c;
  if (disc <= 0.0) return 1.0;
  float sq = sqrt(disc);
  return exp(-(max((-b + sq) / a, 0.0) - max((-b - sq) / a, 0.0)) * 0.45);
}

// the coat: k as uCoat; uv the pattern; region and around as vB
vec3 coat(int k, vec2 uv, float region, float around) {
  vec3 black = vec3(0.026, 0.022, 0.02);
  vec3 white = vec3(0.55, 0.52, 0.46);
  vec3 c = k == 1 ? white : k == 2 ? vec3(0.15, 0.08, 0.04) : k == 3 ? vec3(0.32, 0.215, 0.115) : k == 5 ? vec3(0.19, 0.18, 0.17) : black;
  bool head = region > 1.5 && region < 3.5;
  float t = region - 2.0;
  // pied: a few big white patches with ragged edges. Large enough that a thin leg is all one colour, not ringed
  if (k == 4) c = mix(black, white, smoothstep(0.5, 0.6, noise2(uv * vec2(2.4, 3.0) + uSeed * 37.0) * 0.82 + noise2(uv * vec2(11.0, 14.0) + 3.0) * 0.18));
  if (k == 2 || k == 3) {
    // the pattern of many hill goats: a dark stripe along the back, dark legs and a dark band down the face
    c = mix(c, black * 1.6, smoothstep(0.9, 0.985, around) * step(region, 0.25));
    c = mix(c, black * 1.6, step(0.75, region) * step(region, 1.25) * 0.85);
    if (head) c = mix(c, black * 1.6, smoothstep(0.15, 0.4, t) * smoothstep(0.1, 0.6, around) * 0.75);
  }
  if (k == 1 || k == 5) c *= mix(vec3(1.0), vec3(0.92, 0.84, 0.7), step(0.75, region) * step(region, 1.25)); // stained legs
  // the hair: fine streaks along it, and a broad unevenness; the beard darker
  c *= (0.9 + 0.2 * noise2(uv * vec2(28.0, 90.0) + uSeed * 13.0)) * (0.92 + 0.16 * noise2(uv * vec2(2.2, 3.0) + uSeed * 5.0));
  if (region > 3.5) c *= k == 1 ? 0.8 : 0.6;
  if (head) {
    c = mix(c, vec3(0.05, 0.042, 0.04), smoothstep(0.86, 0.97, t) * 0.75);                                          // the bare nose
    c = mix(c, vec3(0.012), (1.0 - smoothstep(0.0, 0.05, abs(t - 0.33))) * (1.0 - smoothstep(0.0, 0.16, abs(around - 0.42)))); // the eyes
  }
  return c;
}

void main() {
  vec2 fc = gl_FragCoord.xy + uBox.xy; // screen pixel
  float dist = length(vPos);
  // Hidden by rock nearer than it. Its hooves may sink a little into the top, which life.js knows to half a metre.
  float tl = texelFetch(uG0, ivec2(fc), 0).z;
  if (tl > 0.0 && tl * 1000.0 < dist - 0.1 - 0.5 * (1.0 - smoothstep(0.04, 0.3, vA.z))) discard;

  int kind = int(vA.x + 0.5);
  float ao = vA.y;
  vec3 v = -vPos / dist;
  vec3 n = normalize(vN);
  vec3 alb;
  float rough = 0.42;
  if (kind == 1) {
    // horn: grey-brown with rings across it, darker to the tip
    float along = fract(vB.x); // m from its base (goats.js: each horn's pattern starts at a whole number)
    alb = vec3(0.085, 0.075, 0.062) * (0.9 + 0.1 * sin(along * 260.0)) * mix(1.0, 0.55, smoothstep(0.04, 0.24, along));
    rough = 0.55;
  } else if (kind == 2) {
    alb = vec3(0.034, 0.03, 0.028);
    rough = 0.5;
  } else {
    alb = coat(int(uCoat + 0.5), vB.xy, vB.z, vB.w);
  }
  alb *= 1.0 - 0.35 * uWet; // wet hair is darker

  // the hill's or the rock's shadow where it stands, the tree's crown, and its own body
  ivec2 lim = ivec2(uRes) - 1;
  float sh = 1.0;
  if (uFoot.x >= 0.0) {
    sh = (texelFetch(uShadow, clamp(ivec2(uFoot), ivec2(0), lim), 0).r
        + texelFetch(uShadow, clamp(ivec2(uFoot + vec2(4.0, 0.0)), ivec2(0), lim), 0).r
        + texelFetch(uShadow, clamp(ivec2(uFoot - vec2(4.0, 0.0)), ivec2(0), lim), 0).r) / 3.0;
  }
  float keyVis = sh * capsLight(vPos + n * 0.012 * uSize, uKeyDir, vA.w);
  if (uCrown > 0.5) keyVis *= crownLight(vPos - uSite);
  vec3 sunL = uTreeL[0].rgb;
  vec3 moonL = uTreeL[1].rgb;
  float shS = uKeyIsSun > 0.5 ? keyVis : 1.0;
  float shM = uKeyIsSun > 0.5 ? 1.0 : keyVis;
  // hair lets the light round a little into its own shade
  float wrap = kind == 0 ? 0.3 : 0.05;
  float dS = max((dot(n, uSunDir) + wrap) / (1.0 + wrap), 0.0);
  float dM = max((dot(n, uMoonDir) + wrap) / (1.0 + wrap), 0.0);
  vec3 col = alb / PI * (sunL * shS * dS + moonL * shM * dM + ambient(n) * ao);
  float rim = pow(1.0 - max(dot(n, v), 0.0), 3.0);
  if (kind == 0) {
    // its hair catches the light along the edges seen against it, most with the sun behind it
    float back = pow(max(dot(-v, uSunDir), 0.0), 2.0);
    col += (alb * 0.7 + 0.015) * sunL * shS * rim * (0.1 * max(dot(n, uSunDir) + 0.3, 0.0) + 0.6 * back);
    col += alb / PI * ambient(n) * rim * 0.3 * ao;
  } else {
    col += sunL * shS * max(dot(n, uSunDir), 0.0) * ggx(n, v, uSunDir, rough) * 0.35 * (1.0 - 0.85 * uOvercast);
  }
  // lightning lights it for an instant
  col += alb * uFlash * vec3(0.72, 0.78, 1.0) * 1.6 * (0.45 + 0.55 * max(n.y, 0.0)) * ao;

  col = exposeColor(col, dist * 0.001);
  vec4 outC = finishColor(col, fc);
  fragColor = vec4(outC.rgb, 1.0);
  fragCover = vec4(1.0);
}
`;

  S.goatShadow = () => `${S.header}
${S.camera}
${S.octahedral}
uniform sampler2D uG0;
uniform sampler2D uShadow;
uniform vec3 uKeyDir;
uniform float uKeyIsSun;
uniform vec4 uTreeL[7];
uniform vec3 uGoatC; // the middle of the goat (m from the eye)
uniform float uSize;
${caps}
out vec4 fragColor;
void main() {
  ivec2 ic = ivec2(gl_FragCoord.xy);
  vec4 g0 = texelFetch(uG0, ic, 0);
  if (g0.z <= 0.0) discard;
  vec3 P = cameraRay(gl_FragCoord.xy) * g0.z * 1000.0;
  if (length(P - uGoatC) > 5.0 + 1.5 * uSize) discard; // rock beyond it or in front of it, or the land far off
  vec3 N = octDecodeY(g0.xy);
  // How much of the light there is the key light's, which the goat can take away; the sky's it only dims under it
  float lit = texelFetch(uShadow, ic, 0).r;
  vec3 keyL = uKeyIsSun > 0.5 ? uTreeL[0].rgb : uTreeL[1].rgb;
  float direct = dot(keyL, vec3(0.2126, 0.7152, 0.0722)) * max(dot(N, uKeyDir), 0.0) * lit;
  float sky = dot(mix(uTreeL[3].rgb, uTreeL[2].rgb, max(N.y, 0.0)), vec3(0.2126, 0.7152, 0.0722));
  float f = direct / max(direct + sky, 1e-6);
  vec3 q = P + N * 0.02;
  float m = 1.0 - f * (1.0 - capsLight(q, uKeyDir, -1.0)) - (1.0 - f) * capsSky(q, N, -1.0);
  // the picture is already graded: darken it as much as that light would have, in its gamma
  fragColor = vec4(0.0, 0.0, 0.0, 1.0 - pow(clamp(m, 0.0, 1.0), 1.0 / 2.2));
}
`;
})();
