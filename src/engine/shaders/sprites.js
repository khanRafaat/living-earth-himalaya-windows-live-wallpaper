/*
 * Sprites — the living layer drawn over the composite each frame:
 *   type 0 raptor · 1 chough · 2 goose/crane  (procedural flapping silhouettes)
 *   type 3 meteor · 4 satellite · 5 chimney smoke
 * Each instance is a rotated quad. Fragments are depth-tested against the baked
 * terrain, lit with the same sky/sun as the scene, hazed by distance, and
 * tone-mapped exactly like the composite so they sit naturally in the image.
 *
 * Instance layout (4 × vec4):
 *   a0 = centre x, centre y (px), half width, half height (px)
 *   a1 = rotation (rad), type, alpha, distance (km)
 *   a2, a3 = per-type parameters (see life.js)
 */
(function () {
  'use strict';
  const S = window.LE.shaders;

  S.spriteVertex = `#version 300 es
layout(location = 0) in vec4 aA;
layout(location = 1) in vec4 aB;
layout(location = 2) in vec4 aC;
layout(location = 3) in vec4 aD;
uniform vec2 uRes;
out vec2 vLocal;
flat out vec4 vA;
flat out vec4 vB;
flat out vec4 vC;
flat out vec4 vD;
void main() {
  int id = gl_VertexID % 6;
  vec2 corner = vec2((id == 1 || id == 2 || id == 4) ? 1.0 : -1.0, (id == 2 || id == 4 || id == 5) ? 1.0 : -1.0);
  vec2 local = corner * aA.zw;
  float c = cos(aB.x), s = sin(aB.x);
  vec2 px = aA.xy + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  gl_Position = vec4(px / uRes * 2.0 - 1.0, 0.0, 1.0);
  vLocal = local;
  vA = aA; vB = aB; vC = aC; vD = aD;
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

  S.spriteFragment = () => `${S.header}
${S.camera}
${S.noise}
${S.atmosphere}
${S.atmosphereLookup}
uniform sampler2D uG0;
uniform sampler2D uVol;
uniform sampler2D uAdapt;
uniform vec2 uVolRes;
uniform vec3 uSunDir;
uniform vec3 uSunE;
uniform vec3 uMoonE;
uniform vec3 uMoonDir;
uniform float uOvercast;
uniform float uValleyHaze;
uniform float uNight;
uniform float uTime;
in vec2 vLocal;
flat in vec4 vA;
flat in vec4 vB;
flat in vec4 vC;
flat in vec4 vD;
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

float volT() {
  return texelFetch(uVol, ivec2(gl_FragCoord.xy * uVolRes / uRes), 0).a;
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
    float halfLen = vA.z - 4.0;
    float x = vLocal.x;
    float y = vLocal.y;
    float u = clamp((x + halfLen) / (2.0 * halfLen), 0.0, 1.0); // 0 = tail end, 1 = head
    float w = vC.w;
    float core = exp(-y * y / (w * w)) * step(x, halfLen + 0.5);
    float head = exp(-((x - halfLen) * (x - halfLen) + y * y) / 1.8);
    vec3 c = mix(vec3(1.0, 0.8, 0.55), vec3(0.75, 1.0, 0.85), u);      // trains glow green-white at the head
    col = c * vC.y * (core * u * u * 1.2 + head * 0.8) * volT();
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

  // ---------------- chimney smoke ----------------
  if (t > 0.0 && t < dist - 0.05) discard;   // behind a nearer slope
  // local: x across, y from the chimney (0) to the top of the plume (1)
  float yy = (vLocal.y + vA.w) / (2.0 * vA.w);
  float xx = vLocal.x / vA.z;                // -1..1
  float bend = vC.x;                         // crosswind lean (fraction of half width at the top)
  float seed = vC.y;
  float width0 = vC.z;                       // base width as fraction of half width
  float cx = bend * yy * yy + 0.12 * sin(yy * 7.0 - uTime * 0.7 + seed * 40.0) * yy;
  float wdt = width0 * (0.35 + 2.2 * yy);
  float k = (xx - cx) / max(wdt, 1e-3);
  float puff = noise2(vec2(xx * 3.0 + seed * 17.0, yy * 5.0 - uTime * 0.35)) * 0.5 + 0.5;
  float dens = exp(-k * k) * pow(1.0 - yy, 1.6) * smoothstep(0.0, 0.06, yy) * (0.45 + 0.75 * puff);
  a = clamp(dens * alpha, 0.0, 1.0);
  if (a <= 0.003) discard;
  vec3 amb = skyLUT(vec3(0.0, 1.0, 0.0)) * PI * 0.35 + skyLUT(normalize(vec3(rd.x, 0.1, rd.z))) * PI * 0.2;
  vec3 here = uCamPos + rd * dist;
  vec3 Ts = transmittance(here.y, uSunDir.y);
  float ph = phaseHG(dot(rd, uSunDir), 0.6) * 4.0 * PI;
  vec3 L = vec3(0.55, 0.57, 0.62) / PI * amb + vec3(0.6, 0.6, 0.62) * uSunE * Ts * ph * 0.05 * (1.0 - 0.85 * uOvercast);
  L += uMoonE * 0.02;
  float T = exp(-dist * (0.012 + 0.0084 * uValleyHaze * 0.3));
  vec3 skyH = skyLUT(normalize(vec3(rd.x, max(rd.y, 0.02), rd.z)));
  col = grade(L * T + skyH * (1.0 - T));
  fragColor = vec4(col * a, a);
}
`;
})();
