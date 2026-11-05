/*
 * The point of rock at the left of the view, with the tree standing near its tip.
 *
 * A solid, not a height field, because its face is cut back under the top: a ray can pass beneath the rock. It is
 * written in the frame of the tree: X across the view, Y up from the foot of the trunk, D away from the eye. The eye is
 * out in the air, higher than the rock, so it looks down a little onto the top.
 *
 * It is built the way a real cliff is. The rock lies in tilted beds, thick and thin. Each bed is broken by joints into
 * blocks that stand out or sit back, so there are sharp ledges with shadow under them, and the point ends in steps.
 * Flat broken faces on the blocks keep them from looking cut.
 *
 * Baked once into the G-buffer like the rest of the land, so the composite lights it with the same
 * sun, moon, sky, shadows, snow, rain and lightning. Its distance t < LEDGE_T_KM tells it apart:
 * the real terrain never comes closer than about 550 m.
 */
(function () {
  'use strict';
  const S = window.LE.shaders;

  S.ledge = `
uniform vec4 uTreeSite; // where the tree stands: x, y, z in metres from the eye; w = radius of its level patch
const float LEDGE_T_KM = 0.4;
const float HILL_TIP = 2.6; // how far past the tree the point of rock reaches (m)

// The rock's own frame: X across the view, Y up from the foot of the trunk, D away from the eye
vec3 hillFrame(vec3 p) {
  vec2 a = normalize(uTreeSite.xz);
  vec2 q = p.xz - uTreeSite.xz;
  return vec3(q.x * a.y - q.y * a.x, p.y - uTreeSite.y, dot(q, a));
}

// Flat broken faces, with cells of size 1: the height here (about -0.4 to 1). The surface is the highest of a few
// three-sided pyramids, so it is all flat faces and hard edges.
float rockShards(vec2 q) {
  vec2 c = floor(q);
  float best = -9.0;
  for (int y = uZero - 1; y <= uZero + 1; y++) {
    for (int x = uZero - 1; x <= uZero + 1; x++) {
      vec2 cell = c + vec2(float(x), float(y));
      vec2 h = hash22(cell);
      float h3 = hash12(cell + 19.0);
      vec2 d = q - (cell + 0.2 + 0.6 * h);
      float ang = h3 * 2.094;
      vec2 a1 = vec2(cos(ang), sin(ang));
      vec2 a2 = vec2(-0.5 * a1.x - 0.866 * a1.y, 0.866 * a1.x - 0.5 * a1.y);
      vec2 a3 = -a1 - a2;
      best = max(best, 0.4 + 0.6 * fract(h3 * 7.3) - 1.05 * max(max(dot(d, a1), dot(d, a2)), dot(d, a3)));
    }
  }
  return best;
}

float rockJoint; // set by rockBeds: how far it is across the rock to the nearest joint (m)

// The beds of the rock, at w across the view and y up. x = how far this block stands out (about 0 to 1.25),
// y = how far up its bed (0 to 1), z = a number for this block, w = a number for this bed.
vec4 rockBeds(float w, float y) {
  // beds dip across the view and wander a little
  float v = y + w * 0.2 + 0.2 * noise2(vec2(w * 0.4, y * 0.25 + 3.0)) + 0.06 * noise2(vec2(w * 1.6, y * 0.7 + 8.0)) + 0.018 * noise2(vec2(w * 6.0, y * 6.0 + 2.0));
  float c = v * 1.55 + 0.4 * sin(v * 1.7) + 0.2 * sin(v * 4.3 + 1.0); // thick beds and thin ones
  float bed = floor(c);
  float up = c - bed;
  float hb = hash12(vec2(bed, 3.7));
  float len = 0.8 + 1.7 * fract(hb * 5.3); // each bed breaks up at its own spacing, along joints that lean a little
  float cut = w / len + hb * 17.0 + (up - 0.5) * (fract(hb * 11.0) - 0.5) * 0.7
            + 0.05 * noise2(vec2(w * 1.7, y * 2.1 + 4.0)) + 0.02 * noise2(vec2(w * 9.0, y * 11.0 + 1.0));
  float block = floor(cut);
  rockJoint = min(cut - block, block + 1.0 - cut) * len;
  float hk = hash12(vec2(block, bed + 11.0));
  // most blocks are near flush with their bed, a few stand well out; each bed's face slopes its own way
  float stand = 0.55 * hb + 0.42 * hk * hk + (fract(hb * 3.1) - 0.5) * 0.35 * (up - 0.5);
  return vec4(stand, up, hk, hb);
}

// How much bare rock the top shows: all of it along the rim, and in patches further in. m = (X, D).
float hillRocky(vec2 m) {
  float left = HILL_TIP - m.x;
  float inFromRim = min(min(m.y + 1.0 + left * 0.75, 1.6 + left * 0.6 - m.y), left);
  float rim = 1.0 - smoothstep(0.1, 1.2, inFromRim + 0.5 * noise2(m * 0.8 + 2.0));
  float patches = smoothstep(0.1, 0.45, noise2(m * 0.25 + 7.0) * 0.7 + noise2(m * 0.9 + 1.0) * 0.3);
  return max(rim, patches * 0.85);
}

// The height of the top: nearly flat, as a bedding plane is, with rock breaking through. Level at the tree's roots.
float hillTop(vec2 m) {
  float rel = noise2(m * 0.3) * 0.1 + noise2(m * 0.85 + 3.1) * 0.05 + noise2(m * 2.7 + 1.3) * 0.015;
  float rocky = hillRocky(m);
  float top = rel - 0.015 * max(-m.x, 0.0) + (rockShards(m * 0.75 + 13.0) - 0.35) * 0.45 * rocky
            + (1.0 - rocky) * (0.045 * noise2(m * vec2(9.0, 5.0)) + 0.025 * noise2(m * vec2(21.0, 13.0) + 4.0));
  float w = 1.0 - smoothstep(uTreeSite.w * 0.45, uTreeSite.w, length(m));
  return mix(top, rel * 0.1, w);
}

// The broad form, for shadows from far off and for the trunk. Negative inside, otherwise about the distance (m).
float hillBroad(vec3 p) {
  vec3 L = hillFrame(p);
  float below = max(-L.y, 0.0);
  float left = HILL_TIP - L.x;
  return max(max(-1.6 - left * 0.75 + below * 0.32 - L.z, L.z - 1.6 - left * 0.6), max(L.x - HILL_TIP + below * 0.75, L.y - 0.1));
}

// The rock in full. Negative inside, otherwise about the distance to it (m). p = metres from the eye.
float hillSolid(vec3 p) {
  vec3 L = hillFrame(p);
  float below = max(-L.y, 0.0);
  float left = HILL_TIP - L.x;
  float nearD = -1.0 - left * 0.75 + below * 0.32; // the face, cut back as it goes down
  float farD = 1.6 + left * 0.6;
  float tipX = HILL_TIP - below * 0.75 + 0.6 * noise2(vec2(L.y * 0.55, 1.7)); // the point, cut back faster
  // The planes the detail can't reach past: while they are far off, there's no need to work out the detail
  float rough = max(max(nearD - 1.3 - L.z, L.z - farD), max(L.x - tipX - 1.0, L.y - 0.6));
  if (rough > 0.5) return rough;
  vec4 bed = rockBeds(L.x, L.y);
  float front = nearD - 0.7 * bed.x - 0.055 * rockShards(L.xy * vec2(3.1, 3.9) + bed.w * 31.0)
              - 0.1 * noise2(L.xy * vec2(1.1, 1.7) + bed.w * 17.0) - L.z;
  float tip = L.x - tipX - (bed.w - 0.5) * 1.1 - 0.3 * (rockShards(L.zy * 1.4 + 7.0) - 0.4); // each bed ends at its own place
  return max(max(front, L.z - farD), max(tip, L.y - hillTop(L.xz)));
}

// A field of blades, in picture pixels: columns w wide, broken into strokes about h tall. Each stroke has its own brightness
// and is lightest at its tip, so the edges stay sharp where soft noise would look out of focus. lean moves the tips that
// many pixels to the right, and the roots stay where they are.
float grassStroke(vec2 g, float w, float h, float seed, float lean) {
  float x = (g.x - lean * fract(g.y / h + seed * 1.3)) / w + seed * 3.7;
  float c = floor(x);
  float r = hash12(vec2(c, seed + 3.1));
  float y = g.y / (h * (0.7 + 0.6 * r)) + r * 31.0;
  float k = floor(y);
  float across = 1.0 - abs(x - c - 0.5) * 2.0;
  return hash12(vec2(c, k + seed)) * (y - k) * smoothstep(0.0, 0.5, across);
}

// All the blades, combed the same way within a clump. gx, gy: where this is in the picture, in pixels.
float grassBlades(float gx, float gy, float lean) {
  float comb = 0.35 * noise2(vec2(gx / 60.0, gy / 30.0));
  return max(max(grassStroke(vec2(gx + gy * comb, gy), 1.5, 4.0, 0.0, lean),
                 grassStroke(vec2(gx + gy * (comb + 0.15), gy), 2.6, 6.0, 7.0, lean) * 0.85),
             grassStroke(vec2(gx + gy * (comb - 0.1), gy), 4.0, 9.0, 13.0, lean) * 0.7);
}

// How much light a pixel of grass gives back, for what blade is on it
float grassTone(float blade) {
  return mix(0.3, 1.25, clamp(0.16 + 0.75 * blade, 0.0, 1.0));
}

// First hit with the rock along rd, as a distance in km, or -1
float ledgeMarch(vec3 rd) {
  float hz = length(rd.xz);
  if (rd.y / max(hz, 1e-4) > -0.045) return -1.0; // the rock never comes this high in the view
  vec2 a = normalize(uTreeSite.xz);
  float along = dot(rd.xz, a);
  if (along <= 0.0) return -1.0;
  float r0 = length(uTreeSite.xz);
  if ((rd.x * a.y - rd.z * a.x) / along > (HILL_TIP + 1.6) / (r0 - 6.0)) return -1.0; // right of the point
  float pa = pixelAngle();
  float t = r0 * 0.35;
  float f = 1.0;
  for (int i = uZero; i < 140; i++) {
    f = hillSolid(rd * t);
    float hit = t * pa * 0.35;
    if (f < hit) return t * 0.001;
    t += max(f * 0.62, hit);
    if (t > r0 * 2.2) return -1.0;
  }
  return f < 0.15 ? t * 0.001 : -1.0;
}

// For shadow rays: a height that leaves a point at km position pKm as far above it as it is from the rock
float ledgeHeightKm(vec3 pKm) {
  vec3 p = (pKm - uCamPos) * 1000.0;
  if (dot(p.xz, p.xz) > 60.0 * 60.0) return -1e3;
  return pKm.y - hillBroad(p) * 0.001;
}
`;
})();
