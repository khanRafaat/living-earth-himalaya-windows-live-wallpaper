/*
 * The road on the forested hillside below the viewpoint, and where it lies. The camera never moves, so this
 * runs once before the bake:
 *   1. the renderer evaluates the terrain on a polar grid around the camera (gridPoints), on the GPU, where the terrain lives
 *   2. plan() finds the part of the hillside in view and lays the road along its contours, by a fixed route through it
 *   3. the renderer reads the exact ground height under each point of the road (finish), for the vehicles
 *   4. vectorMap() gives the bake, for any point near the road, the way to its centre line
 * Pure maths, no GL. Units: km, scene frame as in the renderer (+z = view centre, camera at the origin).
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});
  const D2R = Math.PI / 180;
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const lerp = (a, b, k) => a + (b - a) * k;

  const GRID = { na: 680, nr: 300, az: 90, r0: 1.5, r1: 4.5 }; // about 0.26° by 10 m
  const STEP = 0.008; // km between points of the road
  const MIN_RADIUS = 0.03; // km: the tightest bend

  // The way the road goes, left to right: direction (degrees from the view centre) and height on the hillside
  // (0 = where the ground enters the picture, 1 = the crest, above 1 = out of sight behind the crest).
  // It starts and ends outside the widest view. The two long descents head towards the viewer, one for each
  // direction of travel, because a contour only ever runs across the view from here.
  const ROUTE = [
    [-96, 0.6],
    [-70, 0.62],
    [-48, 0.66],
    [-34, 0.7],
    [-20, 0.62],
    [-12, 0.52], // a hairpin back to the left
    [-21, 0.42],
    [-29, 0.36], // and one back to the right
    [-20, 0.3],
    [-8, 0.27],
    [-2, 0.33],
    [0.5, 0.58],
    [3.5, 0.88],
    [7, 1.15],
    [14, 1.5],
    [21, 1.2],
    [24.5, 0.9],
    [27.5, 0.62],
    [31, 0.42],
    [38, 0.4],
    [47, 0.48],
    [58, 0.55],
    [72, 0.6],
    [96, 0.6],
  ];

  function gridPoints() {
    const { na, nr, az, r0, r1 } = GRID;
    const pts = new Float32Array(na * nr * 2);
    for (let j = 0; j < nr; j++) {
      const r = lerp(r0, r1, (j + 0.5) / nr);
      for (let i = 0; i < na; i++) {
        const a = lerp(-az, az, (i + 0.5) / na) * D2R;
        const k = (j * na + i) * 2;
        pts[k] = Math.sin(a) * r;
        pts[k + 1] = Math.cos(a) * r;
      }
    }
    return pts;
  }

  /** A moving average over +-n, in place, keeping the ends fixed in value. */
  function smoothLine(v, n, passes) {
    const len = v.length;
    const tmp = new Float32Array(len);
    for (let p = 0; p < passes; p++) {
      let sum = 0;
      for (let i = -n; i <= n; i++) sum += v[clamp(i, 0, len - 1)];
      for (let i = 0; i < len; i++) {
        tmp[i] = sum / (2 * n + 1);
        sum += v[clamp(i + n + 1, 0, len - 1)] - v[clamp(i - n, 0, len - 1)];
      }
      v.set(tmp);
    }
    return v;
  }

  /**
   * The hillside in view. For each direction: the row where the ground enters the picture and the crest that closes
   * that stretch, and their heights. heights = one float per grid cell.
   */
  function findHillside(heights, camY, bottomSlope) {
    const { na, nr, r0, r1 } = GRID;
    const rowR = (j) => lerp(r0, r1, (j + 0.5) / nr);
    const low = new Float32Array(na);
    const top = new Float32Array(na);
    for (let i = 0; i < na; i++) {
      let best = -9;
      let first = -1;
      let last = -1;
      for (let j = 0; j < nr; j++) {
        const s = (heights[j * na + i] - camY) / rowR(j);
        if (s < best) {
          if (first >= 0 && j - last > 8) break; // past the crest
          continue;
        }
        best = s;
        if (s > bottomSlope) {
          if (first < 0) first = j;
          last = j;
        }
      }
      low[i] = first < 0 ? (i ? low[i - 1] : 40) : first;
      top[i] = last < 0 ? (i ? top[i - 1] : 120) : last;
    }
    // the crest is jagged where small hills stand on it, and the route shouldn't follow them
    smoothLine(low, 12, 2);
    smoothLine(top, 18, 2);
    const hLow = new Float32Array(na);
    const hTop = new Float32Array(na);
    for (let i = 0; i < na; i++) {
      hLow[i] = heights[Math.round(low[i]) * na + i];
      hTop[i] = heights[Math.round(top[i]) * na + i];
    }
    smoothLine(hLow, 16, 2);
    smoothLine(hTop, 24, 2);
    return { low, top, hLow, hTop };
  }

  /**
   * Distance of a point of the route along its line of sight: r by its share of the hillside, and how much the contour
   * at that height lies nearer or further (0 where there is no such contour). The road follows the contour, so it winds with the ground.
   */
  function placeOnHill(heights, hill, az, up) {
    const { na, nr, az: azMax, r0, r1 } = GRID;
    const fi = clamp(((az + azMax) / (2 * azMax)) * na - 0.5, 0, na - 1);
    const i = Math.round(fi);
    const dr = (r1 - r0) / nr;
    const rowR = (j) => r0 + (j + 0.5) * dr;
    const low = hill.low[i];
    const top = hill.top[i];
    if (up > 1) return [rowR(top) + (up - 1) * 1.1, 0]; // behind the crest
    const want = lerp(hill.hLow[i], hill.hTop[i], up);
    const even = lerp(low, top, up);
    for (let j = Math.floor(low); j < Math.ceil(top); j++) {
      const a = heights[j * na + i];
      const b = heights[(j + 1) * na + i];
      if (a <= want && b > want) return [rowR(even), (j + (want - a) / Math.max(b - a, 1e-5) - even) * dr];
    }
    return [rowR(even), 0];
  }

  /** The road's centre line: a smooth curve through the route, on the ground in view, at even spacing. Returns [x, z, x, z, ...]. */
  function plan(heights, camY, bottomSlope) {
    const hill = findHillside(heights, camY, bottomSlope);
    // Catmull-Rom through the route, in (direction, height on the hill)
    const azs = [];
    const dists = [];
    const offs = [];
    const R = ROUTE;
    for (let k = 0; k < R.length - 1; k++) {
      const p0 = R[Math.max(k - 1, 0)];
      const p1 = R[k];
      const p2 = R[k + 1];
      const p3 = R[Math.min(k + 2, R.length - 1)];
      const n = Math.max(8, Math.round(Math.abs(p2[0] - p1[0]) * 6));
      for (let s = 0; s < n; s++) {
        const t = s / n;
        const t2 = t * t;
        const t3 = t2 * t;
        const f = (i) => 0.5 * (2 * p1[i] + (p2[i] - p0[i]) * t + (2 * p0[i] - 5 * p1[i] + 4 * p2[i] - p3[i]) * t2 + (3 * p1[i] - p0[i] - 3 * p2[i] + p3[i]) * t3);
        const az = f(0);
        // small bends all along, on top of what the ground gives: no mountain road runs smooth for long
        const up = f(1) + 0.05 * Math.sin(az * 0.83 + 1.1) + 0.03 * Math.sin(az * 2.1 + 2.7);
        const [r, off] = placeOnHill(heights, hill, clamp(az, -GRID.az, GRID.az), up);
        azs.push(az);
        dists.push(r);
        offs.push(off);
      }
    }
    // the contour jumps where the ground has a small hill on it, and the road doesn't
    const follow = Float32Array.from(offs);
    smoothLine(follow, 8, 3);
    const raw = [];
    for (let i = 0; i < azs.length; i++) {
      const r = dists[i] + follow[i] * 0.7;
      raw.push(Math.sin(azs[i] * D2R) * r, Math.cos(azs[i] * D2R) * r);
    }
    // even spacing, then smoothed so what the grid and the crest leave behind doesn't show as kinks
    let line = resample(raw, STEP);
    {
      const [xs, zs] = split(line);
      smoothLine(xs, 5, 3);
      smoothLine(zs, 5, 3);
      line = resample(join(xs, zs), STEP);
    }
    // A tight bend opens up slowly, and its points bunch together as it does, so they are spaced out again between rounds
    for (let round = 0; round < 30; round++) {
      const [xs, zs] = split(line);
      const tight = easeBends(xs, zs);
      line = resample(join(xs, zs), STEP);
      if (!tight) break;
    }
    return line;
  }

  function split(xz) {
    const n = xz.length / 2;
    const xs = new Float32Array(n);
    const zs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = xz[i * 2];
      zs[i] = xz[i * 2 + 1];
    }
    return [xs, zs];
  }

  function join(xs, zs) {
    const out = new Float32Array(xs.length * 2);
    for (let i = 0; i < xs.length; i++) {
      out[i * 2] = xs[i];
      out[i * 2 + 1] = zs[i];
    }
    return out;
  }

  /** No bend tighter than a bus can take. Draws the points of a tight one in towards their neighbours. True if any was found. */
  function easeBends(xs, zs) {
    const n = xs.length;
    const maxTurn = (2 * STEP) / MIN_RADIUS;
    let found = false;
    for (let pass = 0; pass < 12; pass++) {
      let tight = false;
      for (let i = 2; i < n - 2; i++) {
        const ax = xs[i] - xs[i - 2];
        const az = zs[i] - zs[i - 2];
        const bx = xs[i + 2] - xs[i];
        const bz = zs[i + 2] - zs[i];
        if (Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz)) <= maxTurn) continue;
        tight = true;
        // and a little of its neighbours, so a bend widens rather than growing a corner at each end of the part eased
        for (let k = -1; k <= 1; k++) {
          const j = i + k;
          const w = k === 0 ? 0.6 : 0.3;
          xs[j] += ((xs[j - 1] + xs[j + 1]) / 2 - xs[j]) * w;
          zs[j] += ((zs[j - 1] + zs[j + 1]) / 2 - zs[j]) * w;
        }
      }
      if (!tight) break;
      found = true;
    }
    return found;
  }

  function resample(xz, step) {
    const out = [xz[0], xz[1]];
    let px = xz[0];
    let pz = xz[1];
    let want = step;
    for (let i = 2; i < xz.length; i += 2) {
      let x = xz[i];
      let z = xz[i + 1];
      let d = Math.hypot(x - px, z - pz);
      while (d >= want && d > 0) {
        const k = want / d;
        px += (x - px) * k;
        pz += (z - pz) * k;
        out.push(px, pz);
        d -= want;
        want = step;
      }
      want -= d;
      px = x;
      pz = z;
    }
    return Float32Array.from(out);
  }

  /**
   * The finished road: its centre line with the ground height under it, and how fast a vehicle can take each point.
   * A tight bend slows it down, and it starts braking before the bend.
   */
  function finish(xz, ys) {
    const n = xz.length / 2;
    const x = new Float32Array(n);
    const z = new Float32Array(n);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = xz[i * 2];
      z[i] = xz[i * 2 + 1];
      y[i] = ys[i];
    }
    const limit = new Float32Array(n);
    const span = 3; // points either side
    const LATERAL = 1.5e-3; // km/s²: comfortable on a bend
    const BRAKE = 0.8e-3;
    for (let i = 0; i < n; i++) {
      const a = Math.max(i - span, 0);
      const b = Math.min(i + span, n - 1);
      const dx1 = x[i] - x[a];
      const dz1 = z[i] - z[a];
      const dx2 = x[b] - x[i];
      const dz2 = z[b] - z[i];
      const turn = Math.abs(Math.atan2(dx1 * dz2 - dz1 * dx2, dx1 * dx2 + dz1 * dz2));
      const arc = Math.max(STEP * (b - a) * 0.5, 1e-6);
      const radius = turn > 1e-4 ? arc / turn : 1e3;
      limit[i] = Math.sqrt(LATERAL * radius);
    }
    for (let i = n - 2; i >= 0; i--) limit[i] = Math.min(limit[i], Math.sqrt(limit[i + 1] * limit[i + 1] + 2 * BRAKE * STEP));
    for (let i = 1; i < n; i++) limit[i] = Math.min(limit[i], Math.sqrt(limit[i - 1] * limit[i - 1] + 2 * BRAKE * STEP));
    return { n, x, y, z, limit, step: STEP, length: (n - 1) * STEP };
  }

  /** Where the road is at distance s along it, moved sideways by offset (km, to its right when looking along it). */
  function at(road, s, offset, out) {
    const f = clamp(s / road.step, 0, road.n - 1.001);
    const i = Math.floor(f);
    const k = f - i;
    const dx = road.x[i + 1] - road.x[i];
    const dz = road.z[i + 1] - road.z[i];
    const l = Math.hypot(dx, dz) || 1;
    out[0] = road.x[i] + dx * k + (dz / l) * offset;
    out[1] = lerp(road.y[i], road.y[i + 1], k);
    out[2] = road.z[i] + dz * k - (dx / l) * offset;
    return out;
  }

  /**
   * For the bake: over a box around the road, the way to the nearest point of the centre line. A way, not a distance,
   * because it stays exact between texels on the line itself, where a distance would blur.
   */
  function vectorMap(road, texel = 0.005, reach = 0.1) {
    let x0 = 1e9;
    let x1 = -1e9;
    let z0 = 1e9;
    let z1 = -1e9;
    for (let i = 0; i < road.n; i++) {
      x0 = Math.min(x0, road.x[i]);
      x1 = Math.max(x1, road.x[i]);
      z0 = Math.min(z0, road.z[i]);
      z1 = Math.max(z1, road.z[i]);
    }
    x0 -= reach;
    z0 -= reach;
    const w = Math.ceil((x1 + reach - x0) / texel);
    const h = Math.ceil((z1 + reach - z0) / texel);
    const data = new Float32Array(w * h * 2).fill(1); // 1 km: far from the road
    const best = new Float32Array(w * h).fill(1e9);
    const R = Math.ceil(reach / texel);
    for (let i = 0; i < road.n - 1; i += 1) {
      const ax = road.x[i];
      const az = road.z[i];
      const bx = road.x[i + 1] - ax;
      const bz = road.z[i + 1] - az;
      const bb = bx * bx + bz * bz || 1;
      const cx = Math.round((ax - x0) / texel);
      const cz = Math.round((az - z0) / texel);
      for (let v = Math.max(cz - R, 0); v <= Math.min(cz + R, h - 1); v++) {
        for (let u = Math.max(cx - R, 0); u <= Math.min(cx + R, w - 1); u++) {
          const px = x0 + (u + 0.5) * texel;
          const pz = z0 + (v + 0.5) * texel;
          const t = clamp(((px - ax) * bx + (pz - az) * bz) / bb, 0, 1);
          const dx = ax + bx * t - px;
          const dz = az + bz * t - pz;
          const d = dx * dx + dz * dz;
          const k = v * w + u;
          if (d < best[k]) {
            best[k] = d;
            data[k * 2] = dx;
            data[k * 2 + 1] = dz;
          }
        }
      }
    }
    return { data, w, h, box: [x0, z0, 1 / (w * texel), 1 / (h * texel)] };
  }

  /**
   * How much of a headlight shows from here, for every kind of vehicle alike. facing = cosine between where the vehicle
   * points and the way to the viewer. A headlight throws its light forward, so it shows only from ahead, and it goes out
   * as the vehicle turns away on a bend.
   */
  function headlight(facing) {
    const t = clamp((facing - 0.4) / 0.35, 0, 1);
    return t * t * (3 - 2 * t);
  }

  /**
   * How much of a tail light shows from here: all of it from behind, and still most of it from the side, since rear
   * lamps wrap round the corners to be seen from there. Nothing from the front.
   */
  function taillight(facing) {
    const t = clamp((0.3 - facing) / 0.5, 0, 1);
    return t * t * (3 - 2 * t);
  }

  LE.Road = { GRID, ROUTE, gridPoints, findHillside, plan, finish, at, vectorMap, headlight, taillight };
})();
