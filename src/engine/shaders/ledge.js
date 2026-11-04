/*
 * The rock we stand on, and the mountainside it belongs to, on the left of the view.
 *
 * A height field in metres around the eye (x right, y up, z ahead), shaped by direction: u is the
 * azimuth as a share of half the view, so -1 is the left edge of the screen at any width. Right of
 * u ≈ -0.45 it is only the platform under our feet, out of sight below the bottom of the screen;
 * the middle and the right of the view stay open.
 *
 * Toward the left: our platform reaches further out, then a gully, then the mountainside rising
 * across it, which joins our rock near the left edge. Everything ends in steep walls, so past the
 * lip the view drops away to the valley more than half a kilometre below.
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

float ledgeU(vec2 m) { return atan(m.x, m.y) / (0.5 * uHFov); }
vec2 diffOffsetL(int k, float eps) {
  return k == 0 ? vec2(-eps, 0.0) : (k == 1 ? vec2(eps, 0.0) : (k == 2 ? vec2(0.0, -eps) : vec2(0.0, eps)));
}
// past an edge: a rounded lip, then a wall about 76° steep that keeps getting steeper
float ledgeDrop(float d) { return d <= 0.0 ? 0.0 : d * d * 6.0 / (0.6 + d * 1.5) + d * d * 0.15; }

// slabs, knobs and cracks (m). lod = pixel footprint in metres: fine detail fades out where sub-pixel
float ledgeRelief(vec2 m, float lod) {
  float h = noise2(m * 0.09) * 0.9 + noise2(m * 0.27 + 3.1) * 0.45 + noise2(m * 0.8 + 9.4) * 0.16;
  float f1 = 1.0 - smoothstep(0.25, 0.9, lod);
  float f2 = 1.0 - smoothstep(0.08, 0.3, lod);
  h += f1 * (noise2(m * 2.3 + 7.7) * 0.06 + abs(noise2(m * 1.1 + 2.2)) * -0.12);
  h += f2 * noise2(m * 7.0 + 1.3) * 0.018;
  return h;
}

// Rock walls break into steps: bands of harder rock make small ledges every few metres. The ledges slope
// outward a little: dead flat, each one is a sliver under a pixel high seen from across the gully, and
// breaks up into a dotted line of light.
float ledgeStair(float q) { float f = fract(q); return floor(q) + mix(f, smoothstep(0.12, 0.88, f), 0.6); }
float ledgeSteps(float d, float u) {
  if (d <= 0.0) return 0.0;
  const float s = 4.2;
  float q0 = noise2(vec2(u * 7.0, 0.5)) * 0.35 + 0.5; // where along a step the edge falls
  return (ledgeStair(d / s + q0) - ledgeStair(q0)) * s;   // zero at the edge, so the lip has no fence
}

float ledgeHeight(vec2 m, float lod) {
  float r = length(m);
  float u = ledgeU(m);
  float rel = ledgeRelief(m, lod);
  // the platform under our feet, reaching further out toward the left; a broken, uneven lip
  float k = smoothstep(-0.42, -1.0, u);
  float r1 = 6.4 + 15.0 * k * k + (1.8 * noise2(vec2(u * 21.0, 0.3)) + 0.6 * noise2(vec2(u * 64.0, 2.1))) * (0.25 + k);
  float top = -1.75 - 0.03 * r + rel * (0.22 + 0.3 * k);
  // a tor of piled blocks on our side, at the very left
  float kt = smoothstep(-0.92, -1.15, u) * smoothstep(12.0, 19.0, r) * (1.0 - smoothstep(28.0, 38.0, r));
  // (its piled blocks rise in rounded steps, not sheer jumps: a jump shows as a dark seam)
  float tb = noise2(m * 0.6 + 3.0) * 2.0 + 1.0;
  top += kt * (3.5 + 2.5 * noise2(m * 0.11 + 1.7) + 2.0 * abs(noise2(m * 0.35)) + 0.8 * (floor(tb) + smoothstep(0.55, 1.0, fract(tb))));
  float h = top - ledgeSteps(ledgeDrop(r - r1), u);
  // across a gully: a buttress of the mountainside, its face turned toward us, joining our rock at the left
  float kb = smoothstep(-0.5, -0.95, u);
  if (kb > 0.0) {
    float r2 = mix(60.0, 43.0, kb) + 2.5 * noise2(vec2(u * 9.0, 5.0)) + 0.35 * noise2(vec2(u * 31.0, 7.0));
    float r3 = r2 + 45.0 + 15.0 * kb;
    float crag = max(noise2(m * 0.05 + 4.0), 0.0);
    float b = -7.0 + 11.0 * kb + 0.035 * max(r - r2, 0.0) + rel * 1.8 + crag * crag * 4.0 * kb;
    float wall = ledgeSteps(ledgeDrop((r2 - r) * 0.62), u + 0.37) + ledgeDrop(r - r3);
    float hw = b - wall - 30.0 * (1.0 - smoothstep(0.0, 0.12, kb));
    // the face: jointed blocks that stand out or sit back. Offsets go up and down, not in and out: the
    // height must keep rising toward the face, or the field would fold back over itself. Blocks are
    // flat-topped (whole-block jumps), the smooth part changes slower with height than the wall rises.
    float onFace = smoothstep(0.3, 2.0, wall) * (1.0 - smoothstep(-1.0, 0.0, r - r2)) * (1.0 - smoothstep(0.0, 1.0, r - r3));
    if (onFace > 0.0) {
      float lat = u * 0.5 * uHFov * r2; // metres along the face
      vec2 bc = vec2(lat / 3.4, hw / 2.9 + noise2(vec2(lat * 0.2, 1.0)) * 0.6);
      // Blocks with rounded edges on all four sides, so nothing jumps: an edge that jumped faced away from
      // us for a pixel's width and showed as a dotted dark line across the face. The rounding is gentle
      // enough (offset slope under 1 against the wall's height) that the face never folds over itself.
      vec2 bf = fract(bc);
      float bevel = smoothstep(0.0, 0.18, bf.x) * smoothstep(1.0, 0.82, bf.x) * smoothstep(0.0, 0.32, bf.y) * smoothstep(1.0, 0.68, bf.y);
      float blocks = (hash12(floor(bc)) - 0.5) * 0.9 * bevel + noise2(vec2(lat, hw) * 0.22) * 1.0 + noise2(vec2(lat, hw) * 0.9) * 0.18;
      hw += blocks * onFace;
    }
    h = max(h, hw);
  }
  // level ground where the tree's roots hold the soil
  vec2 dt = m - uTreeSite.xz;
  float w = 1.0 - smoothstep(uTreeSite.w * 0.45, uTreeSite.w, length(dt));
  h = mix(h, uTreeSite.y + rel * 0.08, w);
  return h;
}

// First hit with the rock along rd, as a distance in km, or -1. Horizontal metres r: the ray is at
// height slope * r there. Steps are sized from the clearance over the rock, small enough for walls.
float ledgeMarch(vec3 rd) {
  float hz = length(rd.xz);
  float u = atan(rd.x, rd.z) / (0.5 * uHFov);
  float slope = rd.y / max(hz, 1e-4);
  if (u > -0.40 || slope > 0.8) return -1.0;
  vec2 dir = rd.xz / hz;
  float pa = pixelAngle();
  float r = 0.6;
  float rPrev = r;
  for (int i = uZero; i < 420; i++) {
    float lod = r * pa / hz;
    float dh = slope * r - ledgeHeight(dir * r, lod);
    if (dh < 0.0) {
      float a = rPrev, b = r;
      for (int k = uZero; k < 10; k++) {
        float mid = 0.5 * (a + b);
        if (slope * mid - ledgeHeight(dir * mid, mid * pa / hz) < 0.0) b = mid; else a = mid;
      }
      return b / hz * 0.001;
    }
    rPrev = r;
    r += clamp(dh * 0.2, 0.015 + r * 0.0025, 2.5);
    if (r > 300.0) break;
  }
  return -1.0;
}

// The height in km at a world position, for shadow rays (-1e3 where there is no rock)
float ledgeHeightKm(vec3 pKm) {
  vec2 m = (pKm.xz - uCamPos.xz) * 1000.0;
  if (dot(m, m) > 300.0 * 300.0) return -1e3;
  return uCamPos.y + ledgeHeight(m, 0.5) * 0.001;
}
`;
})();
