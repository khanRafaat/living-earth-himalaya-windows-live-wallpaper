/*
 * Sprites — the living layer drawn over the composite each frame:
 *   type 0 raptor · 1 chough · 2 goose/crane  (procedural flapping silhouettes)
 *   type 3 meteor · 4 satellite · 5 the glow of a fire on the hills by night · 6 road vehicle · 7 the light a vehicle throws ahead
 * Each instance is a rotated quad. Fragments are depth-tested against the baked
 * terrain, lit with the same sky/sun as the scene, hazed by distance, and
 * tone-mapped exactly like the composite so they sit naturally in the image.
 *
 * Instance layout (5 × vec4):
 *   a0 = centre x, centre y (px), half width, half height (px)
 *   a1 = rotation (rad), type, alpha, distance (km)
 *   a2, a3, a4 = per-type parameters (see life.js)
 */
(function () {
  'use strict';
  const S = window.LE.shaders;

  S.spriteVertex = `#version 300 es
layout(location = 0) in vec4 aA;
layout(location = 1) in vec4 aB;
layout(location = 2) in vec4 aC;
layout(location = 3) in vec4 aD;
layout(location = 4) in vec4 aE;
uniform vec2 uRes;
out vec2 vLocal;
flat out vec4 vA;
flat out vec4 vB;
flat out vec4 vC;
flat out vec4 vD;
flat out vec4 vE;
void main() {
  int id = gl_VertexID % 6;
  vec2 corner = vec2((id == 1 || id == 2 || id == 4) ? 1.0 : -1.0, (id == 2 || id == 4 || id == 5) ? 1.0 : -1.0);
  vec2 local = corner * aA.zw;
  float c = cos(aB.x), s = sin(aB.x);
  vec2 px = aA.xy + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  gl_Position = vec4(px / uRes * 2.0 - 1.0, 0.0, 1.0);
  vLocal = local;
  vA = aA; vB = aB; vC = aC; vD = aD; vE = aE;
}`;

  // Between two slow-mode pictures: far cheaper than drawing the scene, and clouds drift a few pixels
  // at most between them, so a dissolve reads as smooth movement.
  S.fade = () => `${S.header}
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uMix;
out vec4 fragColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  fragColor = vec4(mix(texelFetch(uFrom, c, 0).rgb, texelFetch(uTo, c, 0).rgb, uMix), 1.0);
}`;

  // The same fade in rain or snow. The pictures are kept without the falling drops and flakes, and they are put
  // in front here, every frame, as the scene would: on the light before grading (gradeColor run backwards), so
  // they look the same as in a scene frame and line up with the tree's own (S.post in tree.js).
  S.fadeRain = () => `${S.header}
${S.noise}
uniform vec2 uRes;
uniform float uTime;
uniform float uFlash;
uniform float uOvercast;
uniform vec3 uSunDir;
uniform sampler2D uSkyLUT;
${S.post}
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uMix;
out vec4 fragColor;

// gradeColor's tone curve, one channel: ACES by day, 1 - exp(-1.4 x) by night, blended by n
float toneCurve(float x, float n) {
  float day = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  return mix(day, 1.0 - exp(-1.4 * x), n);
}
float toneSlope(float x, float n) {
  float num = x * (2.51 * x + 0.03);
  float den = x * (2.43 * x + 0.59) + 0.14;
  float day = ((5.02 * x + 0.03) * den - num * (4.86 * x + 0.59)) / (den * den);
  return mix(day, 1.4 * exp(-1.4 * x), n);
}
float toneInverse(float v, float n) {
  float a = 2.51 - 2.43 * v;
  float b = 0.03 - 0.59 * v;
  float day = (-b + sqrt(b * b + 0.56 * v * a)) / (2.0 * a);
  float night = -log(1.0 - v) / 1.4;
  float x = mix(day, night, n);
  if (n > 0.001 && n < 0.999) {
    // between day and night the blend has no closed form: two Newton steps from there
    for (int i = 0; i < 2; i++) x = max(x - (toneCurve(x, n) - v) / max(toneSlope(x, n), 1e-4), 0.0);
  }
  return x;
}

// the light a picture's colour was graded from (gradeColor backwards; its dither stays in, a fraction of a step)
vec3 ungrade(vec3 c) {
  c /= max(uFade, 1e-3);
  float l2 = dot(c, vec3(0.299, 0.587, 0.114));
  c = l2 + (c - l2) / 1.05;
  c = pow(clamp(c, 0.0, 0.996), vec3(2.2));
  vec3 y = vec3(toneInverse(c.r, uNight), toneInverse(c.g, uNight), toneInverse(c.b, uNight));
  // and the night's bluer vision: y = mix(z, lum(z) * k, a)
  float a = uNight * 0.5;
  vec3 k = vec3(0.6, 0.74, 1.0) * 1.15;
  vec3 L = vec3(0.2126, 0.7152, 0.0722);
  float lumZ = dot(y, L) / (1.0 - a + a * dot(k, L));
  return (y - a * lumZ * k) / (1.0 - a);
}

void main() {
  ivec2 ic = ivec2(gl_FragCoord.xy);
  vec3 c = mix(texelFetch(uFrom, ic, 0).rgb, texelFetch(uTo, ic, 0).rgb, uMix);
  vec2 m = precipMask(gl_FragCoord.xy);
  // most pixels have no drop or flake on them: the picture as it is
  if (m.x + m.y < 4e-4) {
    fragColor = vec4(c, 1.0);
    return;
  }
  fragColor = gradeColor(precipApply(ungrade(c), m), gl_FragCoord.xy);
}`;

  S.spriteFragment = () => `${S.header}
${S.camera}
${S.noise}
${S.atmosphere}
${S.atmosphereLookup}
${S.octahedral}
uniform sampler2D uG0;
uniform sampler2D uG1;
uniform sampler2D uVol;
uniform sampler2D uAdapt;
uniform sampler2D uShadow;
uniform vec2 uVolRes;
uniform vec3 uSunDir;
uniform vec3 uSunE;
uniform vec3 uMoonE;
uniform vec3 uMoonDir;
uniform float uOvercast;
uniform float uValleyHaze;
uniform float uNight;
uniform float uTime;
uniform float uHeadE; // a vehicle's headlights, in the scene's light units at this exposure
in vec2 vLocal;
flat in vec4 vA;
flat in vec4 vB;
flat in vec4 vC;
flat in vec4 vD;
flat in vec4 vE;
out vec4 fragColor;

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Bird silhouette in half-wingspan units. c = (flap phase, flap amount, span factor, dihedral)
float birdSDF(vec2 q, int type, vec4 c, vec2 body, float pxu) {
  float s1 = sin(c.x);
  float s2 = sin(c.x - 0.85);
  float amp = c.y, spanF = c.z, dih = c.w;
  vec2 p = vec2(abs(q.x), q.y);
  float thIn, thOut, elbow, bodyLen, bodyTh;
  if (type == 0) { thIn = 0.14; thOut = 0.09; elbow = 0.45; bodyLen = 0.34; bodyTh = 0.075; }      // vulture/eagle: broad wings
  else if (type == 1) { thIn = 0.11; thOut = 0.06; elbow = 0.5; bodyLen = 0.44; bodyTh = 0.07; }   // chough
  else { thIn = 0.085; thOut = 0.05; elbow = 0.47; bodyLen = 0.8; bodyTh = 0.05; }                 // goose/crane: long neck
  thIn = max(thIn, 0.62 * pxu);
  thOut = max(thOut, 0.45 * pxu);
  bodyTh = max(bodyTh, 0.6 * pxu);
  vec2 sh = vec2(0.05 * spanF, 0.0);
  vec2 el = vec2(elbow * spanF, 0.32 * amp * s1 + dih * 0.4);
  vec2 tp = vec2(spanF, 0.6 * amp * s2 + dih);
  float d = sdSegment(p, sh, el) - thIn;
  vec2 pa = p - el, ba = tp - el;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  d = min(d, length(pa - ba * h) - mix(thIn * 0.85, thOut * 0.55, h));
  if (type == 0) {
    // splayed primary "fingers" of a soaring raptor
    vec2 f = p - tp;
    d = min(d, sdSegment(f, vec2(0.0), vec2(0.07 * spanF, 0.03 + 0.05 * dih)) - thOut * 0.35);
  }
  d = min(d, sdSegment(q, -body * bodyLen * 0.45, body * bodyLen * 0.55) - bodyTh);
  return d;
}

vec3 grade(vec3 col) {
  col *= texelFetch(uAdapt, ivec2(0), 0).r;
  col *= 1.0 + uNight * (0.3 + 1.1 * uOvercast); // same night lift and tone curve as the scene (composite.js)
  float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(col, lum * vec3(0.6, 0.74, 1.0) * 1.15, uNight * 0.5);
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  vec3 tone = clamp((col * (a * col + b)) / (col * (c * col + d) + e), 0.0, 1.0);
  col = mix(tone, 1.0 - exp(-col * 1.4), uNight);
  return pow(col, vec3(1.0 / 2.2));
}

// The same, for lamplight: the eye keeps the colour of a lamp at night, which grade() would turn grey-blue
vec3 gradeLamp(vec3 col) {
  col *= texelFetch(uAdapt, ivec2(0), 0).r;
  col *= 1.0 + uNight * (0.3 + 1.1 * uOvercast);
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  vec3 tone = clamp((col * (a * col + b)) / (col * (c * col + d) + e), 0.0, 1.0);
  col = mix(tone, 1.0 - exp(-col * 1.4), uNight);
  return pow(col, vec3(1.0 / 2.2));
}

// Is a lamp at this point of the picture in sight? Judged where the lamp is, against the ground the bake stored there.
bool lampSeen(vec2 px, float dist) {
  float lt = texelFetch(uG0, ivec2(px), 0).z;
  return lt <= 0.0 || lt >= dist - 0.012;
}

// A small round lamp: a bright core and a soft halo, in pixels squared
float lampGlow(vec2 d, float core, float halo, float haloAmt) {
  float r = dot(d, d);
  return exp(-r / core) + haloAmt * exp(-r / halo);
}

// A box seen from above is three segments added together, the sum of its length, width and height on the picture.
// The distance to the outside of such a shape is the largest over those three directions.
float boxEdge(vec2 q, vec2 e, vec2 A, vec2 B, vec2 U) {
  float l = length(e);
  if (l < 1e-3) return -1e3;
  vec2 n = vec2(-e.y, e.x) / l;
  return abs(dot(q, n)) - abs(dot(A, n)) - abs(dot(B, n)) - abs(dot(U, n));
}

float volT() {
  return texelFetch(uVol, ivec2(gl_FragCoord.xy * uVolRes / uRes), 0).a;
}

// The cloud and mist in front of what lies at this pixel, tFull away: the volume pass's light and how much it lets
// through, from its low-resolution picture the way the scene takes them (composite.js sampleVolume), weighted towards
// the texels that ended at about that distance. So a vehicle on the road gets the mist over the road, not what lay over
// the trees in front of it.
vec4 volAt(float tFull) {
  vec2 scale = uVolRes / uRes;
  vec2 vp = gl_FragCoord.xy * scale - 0.5;
  vec2 base = floor(vp);
  vec2 f = vp - base;
  float zf = log(max(tFull, 0.01));
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int j = 0; j < 2; j++)
  for (int i = 0; i < 2; i++) {
    ivec2 vc = clamp(ivec2(base) + ivec2(i, j), ivec2(0), ivec2(uVolRes) - 1);
    float tv = texelFetch(uG0, ivec2((vec2(vc) + 0.5) / scale), 0).z;
    float zv = log(tv < 0.0 ? 250.0 : max(tv, 0.01));
    float wb = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
    float w = (wb + 1e-3) * exp(-abs(zv - zf) * 5.0);
    acc += texelFetch(uVol, vc, 0) * w;
    wsum += w;
  }
  return wsum > 1e-6 ? acc / wsum : vec4(0.0, 0.0, 0.0, 1.0);
}

// A road vehicle at one point q of its picture (px from its middle): the colour of the face there, and how much sun
// that face takes. Roof, sides, windows and wheels. (A, B, U: half its length, width and height on the picture.)
vec4 vehicleFace(vec2 q, vec2 A, vec2 B, vec2 U, int kind, vec3 paint, float sideSun) {
  // which face this point is on. The corner nearest the viewer is the lowest on the picture.
  float sa = A.y <= 0.0 ? 1.0 : -1.0;
  float sb = B.y <= 0.0 ? 1.0 : -1.0;
  vec2 corner = A * sa + B * sb - U;
  vec2 top = q - U;
  float det = A.x * B.y - A.y * B.x;
  float tu = abs(det) > 1e-3 ? (top.x * B.y - top.y * B.x) / det : 9.0;
  float tv = abs(det) > 1e-3 ? (A.x * top.y - A.y * top.x) / det : 9.0;
  if (max(abs(tu), abs(tv)) <= 1.0 && kind != 2)
    return vec4(kind == 0 ? mix(paint, vec3(0.6), 0.5) : paint * 0.9, max(uSunDir.y, 0.0)); // a bus's pale roof
  // up its side, 0 at the road, 1 at the roof
  vec2 run = (q.x - corner.x) * A.x * sa <= 0.0 && abs(A.x) > 1e-3 ? -2.0 * sa * A : -2.0 * sb * B;
  float along = abs(run.x) > 1e-3 ? clamp((q.x - corner.x) / run.x, 0.0, 1.0) : 0.0;
  float up = clamp((q.y - corner.y - along * run.y) / max(2.0 * U.y, 1e-3), 0.0, 1.0);
  vec3 alb;
  if (kind == 2) alb = up > 0.48 ? paint : vec3(0.03);                         // the rider above the machine
  else {
    alb = paint;
    if (up > 0.5 && up < 0.86) alb = vec3(0.035, 0.05, 0.06);                  // windows
    if (up < 0.2) alb = vec3(0.02);                                             // wheels, and the dark under it
  }
  return vec4(alb, sideSun);
}

void main() {
  int type = int(vB.y + 0.5);
  float alpha = vB.z;
  float dist = vB.w;
  ivec2 ic = ivec2(gl_FragCoord.xy);
  float t = texelFetch(uG0, ic, 0).z;
  vec3 rd = cameraRay(gl_FragCoord.xy);
  vec3 col = vec3(0.0);
  float a = 0.0;

  if (type <= 2) {
    // ---------------- birds ----------------
    if (t > 0.0 && t < dist) discard;
    float halfSpan = vA.z / 1.3;
    float pxu = 1.0 / halfSpan;
    float d = birdSDF(vLocal / halfSpan, type, vC, vD.xy, pxu);
    a = clamp(0.5 - d / pxu, 0.0, 1.0) * alpha;
    if (a <= 0.002) discard;
    vec3 alb = type == 0 ? vec3(0.075, 0.06, 0.05) : type == 1 ? vec3(0.022, 0.022, 0.025) : vec3(0.30, 0.29, 0.27);
    vec3 here = uCamPos + rd * dist;
    vec3 Ts = transmittance(here.y, uSunDir.y);
    vec3 amb = skyLUT(vec3(0.0, 1.0, 0.0)) * PI * 0.5 + skyLUT(normalize(vec3(rd.x, 0.1, rd.z))) * PI * 0.25;
    float front = max(0.0, -dot(rd, uSunDir));           // sun behind the viewer lights the side we see
    float topSeen = vD.z;                                  // looking down on the bird shows its sunlit back
    vec3 L = alb / PI * (amb + uSunE * Ts * (0.3 * front + 0.6 * topSeen * max(uSunDir.y, 0.0)) * (1.0 - 0.85 * uOvercast));
    // feathers glow at the edges when backlit
    float back = pow(max(dot(rd, uSunDir), 0.0), 6.0);
    L += uSunE * Ts * back * 0.02 * smoothstep(-2.5 * pxu, 0.0, d) * (1.0 - uOvercast);
    float T = exp(-dist * (0.012 + 0.0084 * uValleyHaze * 0.25 + 0.003 * uMieScale));
    vec3 skyH = skyLUT(normalize(vec3(rd.x, max(rd.y, 0.02), rd.z)));
    col = grade(L * T + skyH * (1.0 - T));
    fragColor = vec4(col * a, a);
    return;
  }

  if (type == 3) {
    // ---------------- meteor ----------------
    if (t > 0.0) discard;
    float halfLen = vA.z - 3.0;
    float x = vLocal.x;
    float y = vLocal.y;
    float u = clamp((x + halfLen) / (2.0 * halfLen), 0.0, 1.0); // 0 = tail end, 1 = head
    float w = vC.w;
    // a hair-thin line, its ends soft
    float core = exp(-y * y / (w * w)) * smoothstep(-halfLen - 1.0, -halfLen + 1.0, x) * (1.0 - smoothstep(halfLen, halfLen + 1.0, x));
    float trail = exp(-(1.0 - u) * 2.5);                         // brightest just behind the head, dimmer back along it
    float head = exp(-((x - halfLen) * (x - halfLen) + y * y) / 0.7) * vC.x; // only while it still burns
    vec3 c = mix(vec3(1.0, 0.78, 0.55), vec3(0.85, 1.0, 0.9), u * u); // the train warm, the head green-white
    col = c * vC.y * (core * trail * 1.1 + head * 0.8) * volT();
    fragColor = vec4(grade(col) * alpha, 0.0);
    return;
  }

  if (type == 4) {
    // ---------------- satellite ----------------
    if (t > 0.0) discard;
    float r2 = dot(vLocal, vLocal);
    col = vec3(1.0, 0.98, 0.94) * vC.x * exp(-r2 / 0.8) * volT();
    fragColor = vec4(grade(col) * alpha, 0.0);
    return;
  }

  if (type == 6) {
    // ---------------- road vehicle ----------------
    vec2 q = vLocal;
    vec2 A = vC.xy;                              // half its length, pointing to the front
    vec2 B = vC.zw;                              // half its width
    vec2 U = vec2(0.0, vD.x);                    // half its height
    int kind = int(vD.w + 0.5);                  // 0 bus, 1 jeep, 2 motorcycle
    float d = max(boxEdge(q, A, A, B, U), max(boxEdge(q, B, A, B, U), boxEdge(q, U, A, B, U)));
    a = clamp(0.5 - d, 0.0, 1.0) * alpha;
    if (t > 0.0 && t < dist - 0.012) a = 0.0;    // behind a nearer slope, a tree or the rock

    // its paint, as 5 bits each of red, green, blue
    float pk = vD.y;
    vec3 paint = vec3(mod(pk, 32.0), mod(floor(pk / 32.0), 32.0), floor(pk / 1024.0)) / 31.0;
    paint *= paint;
    vec3 toEye = normalize(vec3(-rd.x, 0.0, -rd.z));
    float sideSun = max(dot(toEye, uSunDir), 0.0) * 0.8 + 0.1;
    // Its roof, windows and wheels are a pixel or two across: taken at four points in this pixel and averaged, so they
    // stay still as it moves instead of flickering from pixel to pixel. Points outside it hardly count.
    vec4 face = vec4(0.0);
    float wsum = 0.0;
    for (int k = 0; k < 4; k++) {
      vec2 o = k == 0 ? vec2(0.125, 0.375) : k == 1 ? vec2(-0.375, 0.125) : k == 2 ? vec2(-0.125, -0.375) : vec2(0.375, -0.125);
      vec2 qs = q + o;
      float ws = max(boxEdge(qs, A, A, B, U), max(boxEdge(qs, B, A, B, U), boxEdge(qs, U, A, B, U))) <= 0.0 ? 1.0 : 0.02;
      face += vehicleFace(qs, A, B, U, kind, paint, sideSun) * ws;
      wsum += ws;
    }
    face /= wsum;
    vec3 alb = face.rgb;
    float lit = face.a;
    vec3 here = uCamPos + rd * dist;
    vec3 Ts = transmittance(here.y, uSunDir.y);
    vec3 amb = skyLUT(vec3(0.0, 1.0, 0.0)) * PI * 0.5 + skyLUT(normalize(vec3(rd.x, 0.1, rd.z))) * PI * 0.25;
    // The shadow on the road under it, one for the whole of it, read along its length. Not at its own pixels: there
    // the map holds whatever lies behind it on the picture, often dappled forest beyond the road, and that pattern
    // would slide across its roof as it moves.
    ivec2 lim = ivec2(uRes) - 1;
    vec2 foot = vA.xy - U;
    float sh = (texelFetch(uShadow, clamp(ivec2(foot), ivec2(0), lim), 0).r
              + texelFetch(uShadow, clamp(ivec2(foot + A * 0.6), ivec2(0), lim), 0).r
              + texelFetch(uShadow, clamp(ivec2(foot - A * 0.6), ivec2(0), lim), 0).r) / 3.0;
    vec3 L = alb / PI * (amb + uSunE * Ts * lit * sh * (1.0 - 0.85 * uOvercast) + uMoonE * 0.3);
    float T = exp(-dist * (0.012 + 0.0084 * uValleyHaze * 0.3));
    vec3 skyH = skyLUT(normalize(vec3(rd.x, max(rd.y, 0.02), rd.z)));
    // Cloud or mist between it and the eye, as the scene has it: it shows through as much as they let through, and
    // their own light is laid over it (only fading it out, without that light, left it a sharp dark shape in a cloud)
    vec4 veil = volAt(dist);
    col = grade((L * T + skyH * (1.0 - T)) * veil.a + veil.rgb);
    float fog = veil.a;

    // Its lamps: one of each on a motorcycle, a pair otherwise. Added to the picture as it is shown, so they read the
    // same through the night's exposure. Whether a lamp is in sight is judged where the lamp is: its glow spreads over
    // ground nearer than the vehicle, which must not cut it off, and a lamp behind a tree or the crest gives no glow.
    vec3 glow = vec3(0.0);
    float lamp = vD.z;                           // headlights, by the way it faces
    float tail = vE.x;                           // tail lights, brighter when braking
    float beam = vE.y;                           // 1 main beam, 0 dipped
    int blink = int(vE.z + 0.5);                 // indicators lit at this moment: 1 left, 2 right, 3 both
    vec2 spread = kind == 2 ? vec2(0.0) : B * 0.8;
    float seeThrough = 0.25 + 0.75 * fog;
    // in daylight a lamp is a small point of colour: the glow round it belongs to the dark
    float dark = uNight;
    float haloBy = 0.08 + 0.92 * dark;
    vec2 front = A - U * 0.4;
    if (lamp > 0.003 && lampSeen(vA.xy + front, dist)) {
      // main beam dazzles: a wider, brighter halo
      float halo = mix(20.0, 44.0, beam);
      float amt = mix(0.2, 0.45, beam);
      float g = lampGlow(q - front - spread, 0.8, halo, amt);
      if (kind != 2) g = 0.5 * (g + lampGlow(q - front + spread, 0.8, halo, amt)) + 0.5 * max(exp(-dot(q - front - spread, q - front - spread) / 0.8), exp(-dot(q - front + spread, q - front + spread) / 0.8));
      glow += vec3(1.0, 0.93, 0.78) * g * lamp * (0.95 + 0.35 * beam) * seeThrough;
    }
    vec2 back = -A - U * 0.45;
    if (tail > 0.003 && lampSeen(vA.xy + back, dist)) {
      // red, always on with the headlights; braking makes them brighter and their glow wider
      float braking = vE.w;
      float halo = mix(8.0, 16.0, braking * dark);
      float amt = mix(0.22, 0.42, braking) * haloBy;
      float g = lampGlow(q - back - spread * 0.95, 0.7, halo, amt);
      if (kind != 2) g = max(g, lampGlow(q - back + spread * 0.95, 0.7, halo, amt));
      glow += vec3(1.0, 0.06, 0.02) * g * tail * mix(0.55, 1.4, dark) * seeThrough;
    }
    if (blink > 0) {
      // amber at the front and back corners of that side: B points to its right
      float night = mix(0.35, 1.0, dark);
      for (int side = 1; side <= 2; side++) {
        if ((blink & side) == 0) continue;
        vec2 sideV = (side == 2 ? B : -B) * (kind == 2 ? 1.6 : 0.95) - U * 0.4;
        vec2 f1 = A * 0.95 + sideV;
        vec2 b1 = -A * 0.95 + sideV;
        float g = 0.0;
        if (lampSeen(vA.xy + f1, dist)) g += lampGlow(q - f1, 0.45, 5.0, 0.12 * haloBy);
        if (lampSeen(vA.xy + b1, dist)) g += lampGlow(q - b1, 0.45, 5.0, 0.12 * haloBy);
        glow += vec3(1.0, 0.5, 0.06) * g * 0.75 * night * seeThrough;
      }
    }
    // every glow fades out before the edge of the patch it is drawn on, so it never ends in a straight line
    glow *= 1.0 - smoothstep(0.7, 1.0, max(abs(q.x) / vA.z, abs(q.y) / vA.w));
    if (a <= 0.002 && dot(glow, glow) < 1e-5) discard;
    fragColor = vec4(col * a + glow, a);
    return;
  }

  if (type == 7) {
    // ---------------- the light a vehicle throws ahead of it ----------------
    // Lights whatever the bake stored at this pixel, road or treetops or slope, by its own colour and the way it faces:
    // brightest along the beam, falling off with distance, and none behind the lamp.
    vec3 lampP = vC.xyz;
    float range = vC.w;
    vec3 fwd = vD.xyz;
    float cone = vD.w;
    float strength = alpha;
    vec3 add = vec3(0.0);
    if (t > 0.0) {
      vec3 P = uCamPos + rd * t;
      vec3 d = P - lampP;
      float r = length(d);
      vec3 l = d / max(r, 1e-6);
      float ax = dot(l, fwd);
      // brightest along its axis and softening all the way out to the edge of the cone, with no rim anywhere: the
      // same outer angle as life.js uses for the patch it is drawn on
      float outer = max(cone - 0.22, 0.35);
      float across = smoothstep(outer, 1.0 - (1.0 - cone) * 0.3, ax);
      float inBeam = across * across * (0.55 + 0.45 * across);
      float rr = r / (range * 0.3);
      float fall = (1.0 - smoothstep(range * 0.3, range, r)) / (1.0 + rr * rr);
      vec4 g0 = texelFetch(uG0, ic, 0);
      vec3 N = octDecodeY(g0.xy);
      float nl = dot(N, -l);
      float ndl = clamp(nl, 0.0, 1.0) * 0.75 + 0.25 * smoothstep(-0.6, 0.0, nl); // leaves catch it from any side
      vec3 g1 = texelFetch(uG1, ic, 0).rgb;
      vec3 alb = g1 * g1;
      vec3 E = vec3(1.0, 0.88, 0.72) * strength * uHeadE * inBeam * fall * ndl;
      add = gradeLamp(alb / PI * E);
    }
    // In rain, snow or mist the beam itself shows in the air, where the view passes closest to its axis
    float haze = vE.x;
    if (haze > 0.01) {
      vec3 w0 = uCamPos - lampP;
      float b = dot(rd, fwd);
      float den = max(1.0 - b * b, 1e-5);
      float u = clamp((dot(fwd, w0) - b * dot(rd, w0)) / den, 0.0, range * 0.7);
      vec3 Q = lampP + fwd * u;
      float along = dot(Q - uCamPos, rd);
      float perp = length(uCamPos + rd * along - Q);
      float radius = 0.0006 + u * sqrt(1.0 - cone * cone) / cone;
      float air = exp(-(perp * perp) / (radius * radius)) * (1.0 - u / (range * 0.7));
      if (t > 0.0 && along > t + 0.002) air = 0.0; // behind the ground seen here
      add += vec3(1.0, 0.9, 0.76) * air * air * haze * strength * 0.16 * (0.2 + 0.8 * uNight);
    }
    add *= volT();
    add *= 1.0 - smoothstep(0.75, 1.0, max(abs(vLocal.x) / vA.z, abs(vLocal.y) / vA.w)); // never a straight edge
    if (dot(add, add) < 1e-7) discard;
    fragColor = vec4(add, 0.0);
    return;
  }

  // ---------------- a fire on the hills, by night ----------------
  // The smoke itself, and the mist, are drawn in 3D by the volume pass (volume.js). This is the small orange glow where
  // a burning field or a cooking fire burns, if that spot is in sight. kind 0: a house's fire · 2: a burning field.
  int kind = int(vC.w + 0.5);
  float fire = vD.x;
  vec2 foot = vec2(0.0, -vA.w);
  if (fire < 0.01 || uNight < 0.05 || !lampSeen(vA.xy + foot, dist)) discard;
  vec2 q = vLocal - foot;
  float r2 = dot(q, q);
  vec3 glow = vec3(1.0, 0.42, 0.1) * (exp(-r2 / 3.0) + 0.22 * exp(-r2 / 40.0)) * fire * uNight * (kind == 2 ? 1.2 : 0.4);
  glow *= alpha * volT() * (1.0 - smoothstep(0.7, 1.0, max(abs(vLocal.x) / vA.z, abs(vLocal.y) / vA.w)));
  if (dot(glow, glow) < 1e-6) discard;
  fragColor = vec4(glow, 0.0);
}
`;
})();
