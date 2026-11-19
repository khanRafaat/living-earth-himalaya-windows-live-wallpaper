/*
 * The goats on the rock by the tree, drawn as lit 3D animals. life.js decides where they are and what they do; this
 * gives each one a body every frame and draws it.
 *
 * The first goats were flat shapes seen from the side, and the user said they looked like cardboard (2026-11-18: "goat is
 * in 2nd mode itr should be 3d"). Close to the eye and next to the tree, an animal has to be round and lit across its
 * body. So each goat is built anew from its pose, as the tree's branches are: lofts of rings along its bones. A deep
 * barrel, a neck that lifts the head or lowers it to the grass, a head with ears, horns and a beard, four legs that bend
 * at the knee and the hock in a four-beat walk, hooves and a tail. It is lit by the tree's own light probe (the same sun,
 * sky and ground light), shadowed by the hill, the tree's crown and its own body, and it throws its shadow on the rock.
 * Drawn into a small multisampled target round the herd and laid over the picture as the tree is.
 *
 * No model from the internet: the realistic rigged ones are sold under licences that forbid passing the file on, and
 * this repository and the exe would pass it on; the free ones are cartoons.
 *
 * Body frame: metres of a grown goat, x forward, y up from the ground under its middle, z to its left.
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});
  const { createTarget, deleteTarget } = LE.GL;

  const FLOATS = 14; // P3 N3 A4 (kind, darkening of its part, height above its ground, its capsule) B4 (pattern u, v, region, around)
  const MAX = 6; // goats drawn at once (life.js makes at most four)
  const CAPS = 11; // capsules that stand in for the body in shadows: shaders/goat.js
  const TAU = Math.PI * 2;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const mix = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  const fract = (x) => x - Math.floor(x);
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const madd = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  const lerp3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => mul(a, 1 / (len(a) || 1));
  // (x, y) turned by t in the plane of the body's side (x forward, y up)
  const rot2 = (v, t) => [v[0] * Math.cos(t) - v[1] * Math.sin(t), v[0] * Math.sin(t) + v[1] * Math.cos(t)];

  // ---------------------------------------------------------------- the body at rest
  // The barrel from the tail to the chest: x, top of the back, underline, half its width. Deep and narrow, as a goat is;
  // the belly hangs lowest just behind the middle.
  const BODY = [
    [-0.43, 0.612, 0.572, 0.012],
    [-0.415, 0.642, 0.49, 0.062],
    [-0.38, 0.664, 0.43, 0.1],
    [-0.31, 0.676, 0.392, 0.122],
    [-0.21, 0.667, 0.364, 0.138],
    [-0.09, 0.656, 0.344, 0.152],
    [0.03, 0.66, 0.34, 0.157],
    [0.13, 0.675, 0.35, 0.148],
    [0.21, 0.69, 0.368, 0.128],
    [0.28, 0.682, 0.392, 0.104],
    [0.335, 0.645, 0.425, 0.08],
    [0.368, 0.595, 0.465, 0.05],
    [0.384, 0.548, 0.505, 0.012],
  ];

  // The legs, from the joint in the body down to the fetlock: shoulder, elbow, knee, fetlock (fore); hip, stifle, hock,
  // fetlock (hind). Then the pastern and hoof, from the fetlock to the middle of the sole.
  const FORE = { p: [0.255, 0.5], t: [0.215, 0.36], m: [0.228, 0.19], f: [0.236, 0.058], sole: [0.014, -0.058], bend: 1, lift: 0.075, fold: 1.2 };
  const HIND = { p: [-0.27, 0.54], t: [-0.19, 0.405], m: [-0.31, 0.262], f: [-0.292, 0.058], sole: [0.017, -0.058], bend: -1, lift: 0.062, fold: 0.9 };
  for (const L of [FORE, HIND]) {
    L.a = Math.hypot(L.m[0] - L.t[0], L.m[1] - L.t[1]);
    L.b = Math.hypot(L.f[0] - L.m[0], L.f[1] - L.m[1]);
    L.rest = Math.atan2(L.f[1] - L.p[1], L.f[0] - L.p[0]);
  }
  // left hind, left fore, right hind, right fore: a four-beat walk, each foot a quarter of a step after the one before
  const LEGS = [
    { leg: HIND, z: 0.07, off: 0 },
    { leg: FORE, z: 0.066, off: 0.25 },
    { leg: HIND, z: -0.07, off: 0.5 },
    { leg: FORE, z: -0.066, off: 0.75 },
  ];
  const HEAD_L = 0.2; // m from the poll to the nose
  const STEP = 0.6; // m a goat moves in one whole step, all four feet (life.js)
  const STANCE = 0.64; // of each step a foot is on the ground

  /** The knee between t and f, a and b from them, bent to the front (bend 1) or the back (-1). 2D, body side plane. */
  function knee(t, f, a, b, bend) {
    let dx = f[0] - t[0];
    let dy = f[1] - t[1];
    const d = clamp(Math.hypot(dx, dy), Math.abs(a - b) + 1e-4, (a + b) * 0.9995);
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
    const ca = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
    const sa = Math.sqrt(1 - ca * ca);
    // the normal to the line from t to f, to the front of it when the line runs down
    const nx = -dy;
    const ny = dx;
    return [t[0] + a * (dx * ca + bend * nx * sa), t[1] + a * (dy * ca + bend * ny * sa)];
  }

  /**
   * Where everything of one goat is now, in its body frame (m of a grown goat, before its size): its bones from its state
   * in life.js. ground(x, z) is the height of the rock under that point of the body frame (0 where it is level).
   */
  function goatPose(g, ground) {
    const sd = g.seed;
    const kid = sd < 0.12;
    const st = clamp(g.stride || 0, 0, 1);
    const hd = clamp(g.head, 0, 1);
    const tm = g.clock || 0;
    const cyc = (g.phase || 0) / TAU;
    // the back rises and falls a little with each foot it puts down
    const bob = 0.009 * st * Math.cos(cyc * 2 * TAU);
    const legs = LEGS.map(({ leg: L, z, off }) => {
      const p = fract(cyc + off);
      let dx;
      let lift = 0;
      let fold = 0;
      if (p < STANCE) dx = 0.5 - p / STANCE;
      else {
        const q = (p - STANCE) / (1 - STANCE);
        dx = -0.5 + q * q * (3 - 2 * q);
        lift = Math.sin(Math.PI * q);
        fold = Math.sin(Math.PI * Math.min(q * 1.25, 1));
      }
      dx *= STEP * STANCE * st;
      lift *= L.lift * st;
      fold *= L.fold * st;
      const soleX = L.f[0] + L.sole[0] + dx;
      const gy = clamp(ground(soleX, z), -0.16, 0.16);
      const sole = [soleX, gy + lift];
      // the pastern and hoof fold back as the foot swings forward
      const ps = rot2(L.sole, -fold);
      const f = [sole[0] - ps[0], sole[1] - ps[1]];
      const P = [L.p[0], L.p[1] + bob];
      // the whole leg swings about the shoulder or hip towards its foot, the joints below take the rest
      const turn = (Math.atan2(f[1] - P[1], f[0] - P[0]) - L.rest) * 0.7;
      const tr = rot2([L.t[0] - L.p[0], L.t[1] - L.p[1]], turn);
      const T = [P[0] + tr[0], P[1] + tr[1]];
      const M = knee(T, f, L.a, L.b, L.bend);
      const C = [f[0] + ps[0] * 0.5, f[1] + ps[1] * 0.5];
      const to3 = (q) => [q[0], q[1], z];
      return { fore: L === FORE, z, P: to3(P), T: to3(T), M: to3(M), F: to3(f), C: to3(C), G: to3(sole), lift };
    });

    // The head: up and looking about, or down at the grass, pulling at it now and then. The neck turns it a little to
    // either side; walking, it looks ahead.
    const nod = 0.05 * st * Math.sin(cyc * 2 * TAU);
    const pulling = hd > 0.6 ? Math.max(0, Math.sin(tm * 0.9 + sd * 20)) : 0;
    const bite = 0.07 * smooth(0.6, 1, hd) * Math.sin(tm * 4.3) * pulling;
    const yaw = ((1 - hd) * 0.55 * Math.sin(tm * 0.21 + sd * 17) + hd * 0.18 * Math.sin(tm * 0.13 + sd * 7)) * (1 - 0.7 * st);
    const dirAt = (pitch, y) => [Math.cos(pitch) * Math.cos(y), Math.sin(pitch), Math.cos(pitch) * Math.sin(y)];
    const neckB = [0.275, 0.575 - 0.045 * hd + bob, 0];
    const theta = mix(1.0, -1.1, hd) + nod + bite;
    const neckE = madd(neckB, dirAt(theta, yaw), 0.29);
    const neckC = madd(neckB, dirAt(theta + mix(0.12, 0.42, hd), yaw * 0.6), 0.145);
    const phi = mix(-0.82, -1.62, hd) + bite * 0.6 + nod * 0.5;
    const hy = yaw * 1.3;
    const hdir = dirAt(phi, hy);
    const hup = [-Math.sin(phi) * Math.cos(hy), Math.cos(phi), -Math.sin(phi) * Math.sin(hy)];
    const hs = kid ? 1.15 : 1;
    const back = madd(neckE, hup, 0.012);
    const muzzle = madd(back, hdir, HEAD_L * hs);
    // ears hang from the sides of its head, some long and low, some held out; one flicks now and then
    const flick = 0.35 * smooth(0.93, 1, Math.sin(tm * 0.8 + sd * 31));
    const droop = 0.3 + 0.75 * fract(sd * 3.1);
    // horns on all but the kids: back from the top of the head, a buck's longer and sweeping out
    const buck = sd > 0.7;
    const hornL = kid ? 0 : buck ? 0.2 + 0.1 * fract(sd * 9.7) : 0.11 + 0.05 * fract(sd * 9.7);
    // the tail stands up and flicks from side to side every few seconds
    const since = (tm + sd * 10) % 6.5;
    const wag = since < 0.8 ? Math.sin(since * 30) * (1 - since / 0.8) : 0;
    return {
      kid, buck, sd, hd, st, bob, legs, neckB, neckC, neckE, back, muzzle, hdir, hup, hs, flick, droop, hornL, wag,
      beard: !kid && sd > 0.55,
      earL: (0.12 + 0.05 * fract(sd * 5.7)) * hs,
    };
  }

  // ---------------------------------------------------------------- the mesh
  /**
   * Writes a goat's vertices into out from vertex v0: every part a loft of rings, each ring an ellipse (half widths hw
   * to the side, hu up or forward, hd down or back) round its centre, the normals worked out from the rings' shapes so no
   * seam shows. Every goat has the same rings in the same order (a kid's horns are rings of size nil), so one index list
   * serves them all. X takes the body frame to the eye's (see below); returns the next free vertex.
   */
  function goatMesh(pose, out, v0, X, lofts) {
    let v = v0;
    const record = lofts && !lofts.length;
    // the body frame to the eye's: X.m columns (forward, up, left as the eye sees them), X.o where it stands, X.s its size.
    // Plain numbers in here: it runs for every point of every goat in every frame.
    const m = X.m;
    const ox = X.o[0];
    const oy = X.o[1];
    const oz = X.o[2];
    const sz = X.s;
    const loft = (rings, sides, opt) => {
      const n = rings.length;
      if (record) lofts.push([n, sides]);
      const along = new Float64Array(n);
      for (let i = 1; i < n; i++) along[i] = along[i - 1] + len(sub(rings[i].c, rings[i - 1].c));
      const kindDef = opt.kind;
      const capDef = opt.cap;
      const regionDef = opt.region ?? 0;
      for (let i = 0; i < n; i++) {
        const r = rings[i];
        const ip = Math.max(i - 1, 0);
        const inx = Math.min(i + 1, n - 1);
        const rp = rings[ip];
        const rn = rings[inx];
        // the ring's frame: along the loft, its up (from the hint) and its side
        let tx = rn.c[0] - rp.c[0];
        let ty = rn.c[1] - rp.c[1];
        let tz = rn.c[2] - rp.c[2];
        let l = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
        tx /= l;
        ty /= l;
        tz /= l;
        const ud = r.u[0] * tx + r.u[1] * ty + r.u[2] * tz;
        let ux = r.u[0] - tx * ud;
        let uy = r.u[1] - ty * ud;
        let uz = r.u[2] - tz * ud;
        l = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
        ux /= l;
        uy /= l;
        uz /= l;
        const sx = ty * uz - tz * uy;
        const sy = tz * ux - tx * uz;
        const szz = tx * uy - ty * ux;
        const ds = Math.max(along[inx] - along[ip], 1e-5);
        const mean = (r.hw + 0.5 * (r.hu + r.hd)) * 0.5;
        const kind = r.kind >= 0 ? r.kind : kindDef;
        const cap = r.cap >= 0 ? r.cap : capDef;
        const region = r.region >= 0 ? r.region : regionDef;
        const ti = i / (n - 1);
        const cx = r.c[0];
        const cy = r.c[1];
        const cz = r.c[2];
        const hw = r.hw;
        const hu = r.hu;
        const hd = r.hd;
        const pear = r.pear;
        const nhw = rn.hw;
        const nhu = rn.hu;
        const nhd = rn.hd;
        const phw = rp.hw;
        const phu = rp.hu;
        const phd = rp.hd;
        const ao = opt.ao;
        const u = opt.u0 + along[i];
        for (let k = 0; k <= sides; k++) {
          // from underneath round: the seam of the hair's pattern runs under the belly, the backs of the legs, the jaw
          const a = (k / sides) * TAU - Math.PI / 2;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const up = sa >= 0;
          const h = up ? hu : hd;
          const sw = pear && up ? hw * (1 - pear * sa * sa) : hw;
          const px = cx + sx * sw * ca + ux * h * sa;
          const py = cy + sy * sw * ca + uy * h * sa;
          const pz = cz + szz * sw * ca + uz * h * sa;
          // the ellipse's normal in the ring, leaned along the loft where the rings grow or shrink
          const ka = ca / Math.max(sw, 1e-4);
          const kb = sa / Math.max(h, 1e-4);
          let nx = sx * ka + ux * kb;
          let ny = sy * ka + uy * kb;
          let nz = szz * ka + uz * kb;
          l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          const hn = (up ? nhu : nhd) * sa;
          const hp = (up ? phu : phd) * sa;
          const slope = (Math.sqrt(nhw * ca * nhw * ca + hn * hn) - Math.sqrt(phw * ca * phw * ca + hp * hp)) / ds;
          nx = nx / l - tx * slope;
          ny = ny / l - ty * slope;
          nz = nz / l - tz * slope;
          l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
          nx /= l;
          ny /= l;
          nz /= l;
          const o = v * FLOATS;
          out[o] = ox + sz * (m[0] * px + m[3] * py + m[6] * pz);
          out[o + 1] = oy + sz * (m[1] * px + m[4] * py + m[7] * pz);
          out[o + 2] = oz + sz * (m[2] * px + m[5] * py + m[8] * pz);
          out[o + 3] = m[0] * nx + m[3] * ny + m[6] * nz;
          out[o + 4] = m[1] * nx + m[4] * ny + m[7] * nz;
          out[o + 5] = m[2] * nx + m[5] * ny + m[8] * nz;
          out[o + 6] = kind;
          out[o + 7] = ao ? ao(sa, ca, ti) : 1;
          out[o + 8] = py * sz;
          out[o + 9] = cap;
          out[o + 10] = u;
          out[o + 11] = (a + Math.PI / 2) * mean;
          out[o + 12] = region;
          out[o + 13] = sa;
          v++;
        }
      }
    };
    // every ring the same shape (unset: -1), so reading them stays fast
    const ring = (c, u, hw, hu, hd, extra) => {
      const r = { c, u, hw, hu, hd, pear: 0, kind: -1, cap: -1, region: -1 };
      if (extra) {
        if (extra.pear !== undefined) r.pear = extra.pear;
        if (extra.kind !== undefined) r.kind = extra.kind;
        if (extra.cap !== undefined) r.cap = extra.cap;
        if (extra.region !== undefined) r.region = extra.region;
      }
      return r;
    };
    const UP = [0, 1, 0];
    const FWD = [1, 0, 0];
    const p = pose;

    // the barrel: a little rounder in the belly on some
    const belly = 1 + 0.07 * fract(p.sd * 11.3);
    loft(
      BODY.map(([x, top, under, hw], i) => {
        const low = i > 1 && i < BODY.length - 2 ? under - (belly - 1) * 0.5 * (top - under) : under;
        const cy = (top + low) / 2 + p.bob;
        return ring([x, cy, 0], UP, hw * (i > 2 && i < 10 ? mix(1, belly, 0.5) : 1), top - (top + low) / 2, (top + low) / 2 - low, { pear: 0.16 });
      }),
      18,
      { kind: 0, cap: 0, u0: 0, region: 0, ao: (sa) => mix(0.72, 1, smooth(-0.95, 0.15, sa)) },
    );

    // the neck, from inside the chest, arched over to the head
    const bez = (t) => {
      const a = lerp3(p.neckB, p.neckC, t);
      const b = lerp3(p.neckC, p.neckE, t);
      return lerp3(a, b, t);
    };
    const NECK = [
      [0, 0.085, 0.1, 0.12],
      [0.18, 0.068, 0.078, 0.092],
      [0.4, 0.056, 0.062, 0.072],
      [0.62, 0.05, 0.055, 0.064],
      [0.8, 0.048, 0.052, 0.062],
      [0.92, 0.047, 0.052, 0.06],
      [1.02, 0.044, 0.05, 0.056],
    ];
    const neckSide = [-Math.sin(Math.atan2(p.neckE[2] - p.neckB[2], p.neckE[0] - p.neckB[0])), 0, Math.cos(Math.atan2(p.neckE[2] - p.neckB[2], p.neckE[0] - p.neckB[0]))];
    loft(
      NECK.map(([t, hw, hu, hd]) => {
        const c = bez(Math.min(t, 1));
        const c2 = t > 1 ? madd(c, norm(sub(p.neckE, bez(0.95))), (t - 1) * 0.3) : c;
        const tan = norm(sub(bez(Math.min(t + 0.05, 1)), bez(Math.max(t - 0.05, 0))));
        return ring(c2, cross(neckSide, tan), hw, hu, hd);
      }),
      12,
      { kind: 0, cap: 1, u0: 3, region: 0.5, ao: (sa) => mix(0.8, 1, smooth(-0.9, 0.3, sa)) },
    );

    // the head, from the poll to the nose: a deep jaw behind, narrowing to the muzzle
    const hs = p.hs;
    const HEAD = [
      [-0.03, 0.012, 0.012, 0.012],
      [0.0, 0.038, 0.036, 0.044],
      [0.12, 0.052, 0.046, 0.068],
      [0.3, 0.055, 0.042, 0.062],
      [0.5, 0.044, 0.035, 0.05],
      [0.7, 0.036, 0.03, 0.043],
      [0.86, 0.032, 0.028, 0.038],
      [0.96, 0.027, 0.022, 0.03],
      [1.0, 0.01, 0.008, 0.012],
    ];
    loft(
      HEAD.map(([t, hw, hu, hd]) => ring(madd(p.back, p.hdir, t * HEAD_L * hs), p.hup, hw * hs, hu * hs, hd * hs, { region: 2 + clamp(t, 0, 1) })),
      12,
      { kind: 0, cap: 2, u0: 6, ao: (sa) => mix(0.85, 1, smooth(-0.9, 0.2, sa)) },
    );

    // ears and horns, either side; in the head's frame
    const hside = cross(p.hdir, p.hup);
    for (const sgn of [1, -1]) {
      const base = add(add(madd(p.back, p.hdir, 0.05 * hs), mul(hside, sgn * 0.042 * hs)), mul(p.hup, 0.022 * hs));
      const dr = p.droop - (sgn > 0 ? p.flick : 0);
      const dir = norm(add(add(mul(hside, sgn * Math.cos(dr)), mul(p.hup, -Math.sin(dr))), mul(p.hdir, -0.35)));
      const EAR = [
        [-0.15, 0.006, 0.012],
        [0.2, 0.007, 0.022],
        [0.55, 0.007, 0.03],
        [0.85, 0.006, 0.022],
        [1.0, 0.002, 0.004],
      ];
      loft(
        EAR.map(([t, th, br]) => ring(madd(base, dir, t * p.earL), p.hdir, th * hs, br * hs, br * hs)),
        6,
        { kind: 0, cap: 2, u0: 8 + sgn, region: 0.5, ao: () => 0.85 },
      );
      // horns: up and back from the top of the head, curving further back, a buck's sweeping out too
      const hb = add(add(madd(p.back, p.hdir, 0.03 * hs), mul(hside, sgn * 0.022)), mul(p.hup, 0.04 * hs));
      const L = p.hornL;
      const r0 = p.buck ? 0.021 : 0.015;
      const HORN = 7;
      let at = hb;
      let d = norm(add(add(mul(p.hup, 0.85), mul(p.hdir, -0.5)), mul(hside, sgn * 0.12)));
      const horn = [];
      for (let i = 0; i < HORN; i++) {
        const t = i / (HORN - 1);
        horn.push(ring(at, p.hdir, r0 * (1 - 0.8 * t) * (L > 0 ? 1 : 0), r0 * (1 - 0.8 * t) * (L > 0 ? 1 : 0) * 1.15, r0 * (1 - 0.8 * t) * (L > 0 ? 1 : 0) * 1.15));
        at = madd(at, d, L / (HORN - 1));
        d = norm(add(add(d, mul(p.hdir, -0.42)), add(mul(hside, sgn * (p.buck ? 0.3 : 0.08)), mul(p.hup, -0.12))));
      }
      if (L > 0) horn[HORN - 1].hw = horn[HORN - 1].hu = horn[HORN - 1].hd = 0.002;
      loft(horn, 6, { kind: 1, cap: 2, u0: 10 + sgn, region: 0 });
    }

    // a beard under the chin on some
    {
      const chin = add(madd(p.back, p.hdir, 0.55 * HEAD_L * hs), mul(p.hup, -0.042 * hs));
      const d = norm(add(mul(p.hdir, -0.15), [0, -1, 0]));
      const bl = p.beard ? 0.07 + 0.035 * fract(p.sd * 4.3) : 0;
      const on = p.beard ? 1 : 0;
      loft(
        [-0.1, 0.35, 0.75, 1].map((t) => ring(madd(chin, d, t * bl), FWD, (0.009 - 0.0075 * Math.max(t, 0)) * on, (0.011 - 0.009 * Math.max(t, 0)) * on, (0.011 - 0.009 * Math.max(t, 0)) * on)),
        5,
        { kind: 0, cap: 2, u0: 13, region: 4, ao: () => 0.8 },
      );
    }

    // the tail, short and up
    {
      const base = [-0.405, 0.615 + p.bob, 0];
      const d = norm([-0.45, 0.89, p.wag * 0.45]);
      loft(
        [-0.2, 0.25, 0.55, 0.85, 1].map((t, i) => ring(madd(base, d, t * 0.11), FWD, [0.03, 0.028, 0.022, 0.015, 0.004][i], [0.03, 0.028, 0.022, 0.015, 0.004][i], [0.03, 0.028, 0.022, 0.015, 0.004][i])),
        6,
        { kind: 0, cap: 0, u0: 14, region: 0.5 },
      );
    }

    // the legs, and a hoof on each
    p.legs.forEach((L, k) => {
      const { P, T, M, F, C, G } = L;
      const inner = (ca) => smooth(0.1, 0.8, -Math.sign(L.z) * ca);
      const rings = L.fore
        ? [
            [P, 0.042, 0.06, 0.06, 3],
            [T, 0.04, 0.046, 0.05, 3],
            [lerp3(T, M, 0.3), 0.037, 0.041, 0.037, 3],
            [lerp3(T, M, 0.72), 0.025, 0.026, 0.023, 3],
            [M, 0.021, 0.022, 0.021, 7],
            [lerp3(M, F, 0.5), 0.0145, 0.0155, 0.0145, 7],
            [F, 0.0175, 0.0185, 0.0175, 7],
            [C, 0.0155, 0.0155, 0.0155, 7],
          ]
        : [
            [P, 0.05, 0.06, 0.065, 3],
            [lerp3(P, T, 0.5), 0.05, 0.058, 0.07, 3],
            [T, 0.045, 0.048, 0.062, 3],
            [lerp3(T, M, 0.4), 0.036, 0.035, 0.05, 3],
            [lerp3(T, M, 0.8), 0.026, 0.024, 0.034, 3],
            [M, 0.021, 0.02, 0.03, 7],
            [lerp3(M, F, 0.5), 0.0155, 0.016, 0.016, 7],
            [F, 0.019, 0.02, 0.019, 7],
          ];
      if (L.fore) rings.splice(1, 0, [lerp3(P, T, 0.5), 0.043, 0.056, 0.058, 3]);
      else rings.push([C, 0.016, 0.017, 0.016, 7]);
      loft(
        rings.map(([c, hw, hu, hd, cap], i) => ring(c, FWD, hw, hu, hd, { cap: cap + k, region: i >= rings.length - 4 ? 1 : 0 })),
        9,
        { kind: 0, u0: 16 + k * 2, ao: (sa, ca, t) => mix(1, 0.72, inner(ca) * (1 - t)) * mix(0.82, 1, smooth(0, 0.5, t)) },
      );
      // the hoof: from inside the pastern down to the sole, its toe forward
      const down = norm(sub(G, C));
      const toe = norm(sub(FWD, mul(down, dot(FWD, down))));
      const tip = madd(G, toe, 0.004);
      loft(
        [
          ring(lerp3(C, G, -0.15), FWD, 0.017, 0.018, 0.017),
          ring(lerp3(C, G, 0.25), FWD, 0.0195, 0.022, 0.019),
          ring(lerp3(C, tip, 0.8), FWD, 0.021, 0.027, 0.019),
          ring(madd(tip, down, 0.004), FWD, 0.012, 0.016, 0.011),
        ],
        8,
        { kind: 2, cap: 7 + k, u0: 24 + k, region: 1, ao: () => 0.85 },
      );
    });
    return v;
  }

  /** The capsules that stand in for the goat in shadows (eye frame, its size): a.xyz, r, b.xyz, 0 each. */
  function goatCapsules(p, xf, size, out) {
    const caps = [
      [[-0.32, 0.53 + p.bob, 0], [0.25, 0.535 + p.bob, 0], 0.148],
      [p.neckB, p.neckE, 0.058],
      [p.back, lerp3(p.back, p.muzzle, 0.85), 0.042 * p.hs],
    ];
    for (const L of p.legs) caps.push([L.T, L.M, L.fore ? 0.032 : 0.042]);
    for (const L of p.legs) caps.push([L.M, L.G, 0.018]);
    caps.forEach(([a, b, r], i) => {
      const A = xf(a);
      const B = xf(b);
      out.set([A[0], A[1], A[2], r * size, B[0], B[1], B[2], 0], i * 8);
    });
    return out;
  }

  // ---------------------------------------------------------------- drawing
  class Goats {
    constructor(renderer) {
      const gl = renderer.gl;
      this.r = renderer;
      this.gl = gl;
      this.lofts = [];
      this.nv = 0; // vertices per goat
      this.ni = 0; // indices per goat
      this.data = null;
      this.vao = gl.createVertexArray();
      this.buf = gl.createBuffer();
      this.ibuf = gl.createBuffer();
      this.ms = null;
      this.resolved = null;
      this.frame = null;
      this.caps = new Float32Array(CAPS * 8);
    }

    /** The eye frame of a goat: where it stands, which way it heads, how it leans with the rock; and the rock's heights. */
    _place(g, L) {
      const s = L.site;
      const Xr = [L.az, 0, -L.ax];
      const Dr = [L.ax, 0, L.az];
      const F = add(mul(Xr, Math.cos(g.h)), mul(Dr, Math.sin(g.h)));
      const Z = [-F[2], 0, F[0]];
      const size = g.size;
      const life = this.r.life;
      const at = (x, z) => {
        const X = g.X + (F[0] * Xr[0] + F[2] * Xr[2]) * x * size + (Z[0] * Xr[0] + Z[2] * Xr[2]) * z * size;
        const D = g.D + (F[0] * Dr[0] + F[2] * Dr[2]) * x * size + (Z[0] * Dr[0] + Z[2] * Dr[2]) * z * size;
        const y = life._ledgeY(X, D);
        return y === y ? y - g.Y : 0;
      };
      // it leans with the rock from its hind feet to its fore feet
      const front = (at(0.25, 0.07) + at(0.25, -0.07)) / 2;
      const hind = (at(-0.28, 0.07) + at(-0.28, -0.07)) / 2;
      const pitch = clamp(Math.atan2(front - hind, 0.53 * size), -0.3, 0.3);
      const cp = Math.cos(pitch);
      const sp = Math.sin(pitch);
      const cx = add(mul(F, cp), [0, sp, 0]);
      const cy = add(mul(F, -sp), [0, cp, 0]);
      const E0 = [s[0] + g.X * L.az + g.D * L.ax, s[1] + g.Y + (front + hind) / 2, s[2] - g.X * L.ax + g.D * L.az];
      const xn = (n) => [cx[0] * n[0] + cy[0] * n[1] + Z[0] * n[2], cx[1] * n[0] + cy[1] * n[1], cx[2] * n[0] + cy[2] * n[1] + Z[2] * n[2]];
      const xf = (b) => add(E0, mul(xn(b), size));
      const X = { m: [cx[0], cx[1], cx[2], cy[0], cy[1], cy[2], Z[0], Z[1], Z[2]], o: E0, s: size };
      // the rock under a point of the body frame, in the leaning body frame (m of a grown goat)
      const ground = (x, z) => ((at(x, z) - (front + hind) / 2) / size - x * sp) / cp;
      return { E0, xf, xn, X, ground, size };
    }

    /** Builds every goat for this frame: meshes, capsules, boxes on the screen. Nothing when there are none. */
    _build(L, v) {
      const goats = L.goats.slice(0, MAX);
      if (!this.data) {
        // the layout comes from the first goat built (every goat has the same rings), then the shared index list
        const tmp = new Float32Array(4096 * FLOATS);
        const g0 = { X: 0, D: 0, Y: 0, h: 0, head: 0, stride: 0, phase: 0, clock: 0, seed: 0.5, size: 1 };
        this.nv = goatMesh(goatPose(g0, () => 0), tmp, 0, IDENTITY, this.lofts);
        const idx = [];
        let base = 0;
        for (const [n, sides] of this.lofts) {
          const ring = sides + 1;
          for (let i = 0; i < n - 1; i++) {
            for (let k = 0; k < sides; k++) {
              const a = base + i * ring + k;
              const c = a + ring;
              idx.push(a, c, a + 1, a + 1, c, c + 1);
            }
          }
          base += n * ring;
        }
        this.ni = idx.length;
        const all = new Uint16Array(this.ni * MAX);
        for (let g = 0; g < MAX; g++) for (let i = 0; i < this.ni; i++) all[g * this.ni + i] = idx[i] + g * this.nv;
        const gl = this.gl;
        this.data = new Float32Array(this.nv * MAX * FLOATS);
        gl.bindVertexArray(this.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
        gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibuf);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, all, gl.STATIC_DRAW);
        [3, 3, 4, 4].reduce((off, n, i) => {
          gl.enableVertexAttribArray(i);
          gl.vertexAttribPointer(i, n, gl.FLOAT, false, FLOATS * 4, off * 4);
          gl.vertexAttribDivisor(i, 0);
          return off + n;
        }, 0);
        gl.bindVertexArray(this.r.vao);
      }
      const site = L.ledge.site;
      const treeD = Math.hypot(site[0], site[1], site[2]);
      const out = [];
      goats.forEach((g, k) => {
        const pl = this._place(g, L.ledge);
        const pose = goatPose(g, pl.ground);
        const end = goatMesh(pose, this.data, k * this.nv, pl.X, null);
        if (end - k * this.nv !== this.nv) throw new Error('goat mesh changed its layout');
        // its box on the screen
        let x0 = 1e9;
        let y0 = 1e9;
        let x1 = -1e9;
        let y1 = -1e9;
        const D = this.data;
        for (let i = k * this.nv; i < end; i += 2) {
          const o = i * FLOATS;
          const px = LE.Foreground.prototype.project([D[o], D[o + 1], D[o + 2]], v);
          if (!px) continue;
          x0 = Math.min(x0, px[0]);
          y0 = Math.min(y0, px[1]);
          x1 = Math.max(x1, px[0]);
          y1 = Math.max(y1, px[1]);
        }
        if (!(x1 > 0 && x0 < v.w && y1 > 0 && y0 < v.h)) return;
        const caps = goatCapsules(pose, pl.xf, pl.size, new Float32Array(CAPS * 8));
        const dist = len(pl.xf([0, 0.5, 0]));
        out.push({ g, k, box: [x0 - 2, y0 - 2, x1 + 2, y1 + 2], caps, E0: pl.E0, size: pl.size, near: dist < treeD - 0.5, dist, foot: LE.Foreground.prototype.project(pl.E0, v) });
      });
      return out;
    }

    _ensureTarget(w, h) {
      if (this.ms && this.ms.w >= w && this.ms.h >= h) return true;
      this._freeTarget();
      const gl = this.gl;
      const R = this.r;
      w = Math.min(Math.ceil((w * 1.25) / 32) * 32, R.w);
      h = Math.min(Math.ceil((h * 1.25) / 32) * 32, R.h);
      const counts = (fmt) => Array.from(gl.getInternalformatParameter(gl.RENDERBUFFER, fmt, gl.SAMPLES) || []);
      const ok = (n) => [gl.RGBA8, gl.R8, gl.DEPTH_COMPONENT24].every((f) => counts(f).includes(n));
      const samples = [4, 2].find(ok) || 0;
      const make = (fmt) => {
        const rb = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
        if (samples) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt, w, h);
        else gl.renderbufferStorage(gl.RENDERBUFFER, fmt, w, h);
        return rb;
      };
      const ms = { fbo: gl.createFramebuffer(), rb: [make(gl.RGBA8), make(gl.R8), make(gl.DEPTH_COMPONENT24)], samples, w, h };
      gl.bindFramebuffer(gl.FRAMEBUFFER, ms.fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, ms.rb[0]);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.RENDERBUFFER, ms.rb[1]);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, ms.rb[2]);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindRenderbuffer(gl.RENDERBUFFER, null);
      this.ms = ms;
      if (status !== gl.FRAMEBUFFER_COMPLETE && !gl.isContextLost()) {
        this._freeTarget();
        console.warn('Goat target incomplete: 0x' + status.toString(16));
        return false;
      }
      this.resolved = createTarget(gl, w, h, [
        { fmt: 'rgba8', filter: gl.NEAREST },
        { fmt: 'r8', filter: gl.NEAREST },
      ]);
      return true;
    }

    _freeTarget() {
      const gl = this.gl;
      if (this.ms) {
        gl.deleteFramebuffer(this.ms.fbo);
        this.ms.rb.forEach((rb) => gl.deleteRenderbuffer(rb));
        this.ms = null;
      }
      deleteTarget(gl, this.resolved);
      this.resolved = null;
    }

    /** Uniforms both goat programs read: the view, the light at the tree, the weather, the picture's grading. */
    _common(p, state, box, extra) {
      const R = this.r;
      const fg = R.fg;
      const v = R.viewInfo();
      const w = state.weather;
      p.set('uRes', [R.w, R.h]);
      p.set('uHFov', v.hfov);
      p.set('uHorizonY', v.horizonY);
      p.set('uBox', box);
      p.set('uSite', fg.site);
      p.set('uKeyDir', state.keyDir);
      p.set('uKeyIsSun', state.keyIsSun);
      p.set('uSunDir', state.sunDir);
      p.set('uMoonDir', state.moonDir);
      p.set('uTreeL', fg.light);
      const T = fg.tree;
      p.set('uCrown', fg.enabled && T ? 1 : 0);
      if (T) {
        p.set('uCrownC', T.crownC);
        p.set('uCrownR', T.crownR);
      }
      const tc = norm([-fg.site[0], 0, -fg.site[2]]);
      p.set('uToCam', [tc[0], tc[2]]);
      p.set('uOvercast', w.overcast);
      p.set('uFlash', w.flash);
      p.set('uWet', w.wet);
      p.set('uTime', state.time % 2400);
      p.set('uNight', state.night);
      p.set('uRain', w.rain);
      p.set('uSnow', w.snow);
      p.set('uRainSlant', w.rainSlant);
      p.set('uRainLayers', R.quality.rainLayers);
      p.set('uFade', R._fade);
      R._bind(p, {
        uG0: R.gbuf.tex[0],
        uShadow: R.shadowA.tex[0],
        uTransLUT: R.transLUT.tex[0],
        uSkyLUT: R.skyLUT.tex[0],
        uAdapt: R.adaptA.tex[0],
        ...extra,
      });
    }

    /**
     * The goats beyond the tree (near false: before the tree, with every goat's shadow on the rock) or nearer than it
     * (after the tree), over the picture.
     */
    draw(state, near) {
      const R = this.r;
      const L = R.life;
      if (!near) this.frame = null;
      if (!L || !L.ledge || !L.goats || !L.goats.length || R.cfg.life === false) return;
      const gl = this.gl;
      if (!near) {
        // the light at the tree is the light here; without the tree its probe still runs for them
        if (!R.fg.enabled) R.fg.probeLight(state);
        this.frame = this._build(L, R.viewInfo());
        if (this.frame.length) {
          // straight from the build array, only the goats in use (nothing new to collect every frame)
          gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, this.nv * goatsUsed(this.frame) * FLOATS);
          this._shadows(state);
        }
      }
      const list = (this.frame || []).filter((f) => f.near === near);
      if (!list.length) return;
      let x0 = 1e9;
      let y0 = 1e9;
      let x1 = -1e9;
      let y1 = -1e9;
      for (const f of list) {
        x0 = Math.min(x0, f.box[0]);
        y0 = Math.min(y0, f.box[1]);
        x1 = Math.max(x1, f.box[2]);
        y1 = Math.max(y1, f.box[3]);
      }
      x0 = clamp(Math.floor(x0), 0, R.w);
      y0 = clamp(Math.floor(y0), 0, R.h);
      x1 = clamp(Math.ceil(x1), 0, R.w);
      y1 = clamp(Math.ceil(y1), 0, R.h);
      const bw = x1 - x0;
      const bh = y1 - y0;
      if (bw < 1 || bh < 1 || R.clipped(x0, bw) || !this._ensureTarget(bw, bh)) return;
      const box = [x0, y0, bw, bh];
      // into the multisampled target, far goats first
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.ms.fbo);
      R._offScreen();
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.viewport(0, 0, bw, bh);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      const p = R.prog.goat;
      gl.useProgram(p.p);
      this._common(p, state, box, {});
      gl.bindVertexArray(this.vao);
      for (const f of list) {
        this._goatUniforms(p, f);
        gl.drawElements(gl.TRIANGLES, this.ni, gl.UNSIGNED_SHORT, f.k * this.ni * 2);
      }
      gl.disable(gl.DEPTH_TEST);
      gl.bindVertexArray(R.vao);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.ms.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.resolved.fbo);
      for (let a = 0; a < 2; a++) {
        gl.readBuffer(gl.COLOR_ATTACHMENT0 + a);
        gl.drawBuffers(a === 0 ? [gl.COLOR_ATTACHMENT0, gl.NONE] : [gl.NONE, gl.COLOR_ATTACHMENT1]);
        gl.blitFramebuffer(0, 0, bw, bh, 0, 0, bw, bh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
      gl.readBuffer(gl.COLOR_ATTACHMENT0);
      gl.drawBuffers(this.resolved.bufs);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
      // over the picture, as the tree is
      R._target(null, R.w, R.h);
      const c = R.prog.treeComp;
      gl.useProgram(c.p);
      c.set('uRes', [R.w, R.h]);
      c.set('uBox', box);
      R._bind(c, { uTreeColor: this.resolved.tex[0], uTreeCover: this.resolved.tex[1] });
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.disable(gl.BLEND);
    }

    _goatUniforms(p, f) {
      const g = f.g;
      p.set('uCap', f.caps);
      p.set('uCoat', g.coat || 0);
      p.set('uSeed', g.seed || 0);
      p.set('uFoot', f.foot ? [f.foot[0], f.foot[1]] : [-1, -1]);
      p.set('uSize', f.size);
    }

    /** Each goat's shadow on the rock, and the dark under it: before the tree and before any goat. */
    _shadows(state) {
      const R = this.r;
      const gl = this.gl;
      const v = R.viewInfo();
      const key = state.keyDir;
      const p = R.prog.goatShadow;
      R._target(null, R.w, R.h);
      gl.useProgram(p.p);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      let first = true;
      for (const f of this.frame) {
        // round its feet, and as far as its shadow reaches on level rock (no further than 7 of its lengths... 5 m)
        let x0 = f.box[0];
        let y0 = f.box[1];
        let x1 = f.box[2];
        let y1 = f.box[3];
        const reach = key[1] > 0.03 ? Math.min(f.size * 0.75 / key[1], 5) : 0;
        const pts = [];
        for (let i = 0; i < CAPS; i++) {
          for (const e of [0, 4]) {
            const P = [f.caps[i * 8 + e], f.caps[i * 8 + e + 1], f.caps[i * 8 + e + 2]];
            const y = P[1] - f.E0[1];
            const t = key[1] > 0.03 ? Math.min(y / key[1], reach) : 0;
            const r = f.caps[i * 8 + 3] * 2.5 + 0.05 + 0.03 * t;
            for (const Q of [madd(P, key, -t), [P[0], f.E0[1], P[2]]]) {
              pts.push(madd(Q, [1, 0, 0], r + 0.3), madd(Q, [1, 0, 0], -r - 0.3), madd(Q, [0, 0, 1], r + 0.3), madd(Q, [0, 0, 1], -r - 0.3));
            }
          }
        }
        for (const q of pts) {
          const px = LE.Foreground.prototype.project(q, v);
          if (!px) continue;
          x0 = Math.min(x0, px[0]);
          y0 = Math.min(y0, px[1]);
          x1 = Math.max(x1, px[0]);
          y1 = Math.max(y1, px[1]);
        }
        x0 = clamp(Math.floor(x0) - 2, 0, R.w);
        y0 = clamp(Math.floor(y0) - 2, 0, R.h);
        x1 = clamp(Math.ceil(x1) + 2, 0, R.w);
        y1 = clamp(Math.ceil(y1) + 2, 0, R.h);
        if (x1 - x0 < 1 || y1 - y0 < 1 || R.clipped(x0, x1 - x0)) continue;
        if (first) {
          this._common(p, state, [0, 0, R.w, R.h], {});
          first = false;
        }
        p.set('uBox', [x0, y0, x1 - x0, y1 - y0]);
        p.set('uCap', f.caps);
        p.set('uGoatC', add(f.E0, [0, 0.4 * f.size, 0]));
        p.set('uSize', f.size);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
      }
      gl.disable(gl.BLEND);
    }

    dispose() {
      const gl = this.gl;
      this._freeTarget();
      gl.deleteBuffer(this.buf);
      gl.deleteBuffer(this.ibuf);
      gl.deleteVertexArray(this.vao);
    }
  }

  const IDENTITY = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], o: [0, 0, 0], s: 1 };
  // how many goats' vertices the buffer holds this frame (the first k + 1 of them)
  const goatsUsed = (frame) => frame.reduce((m, f) => Math.max(m, f.k + 1), 0);

  LE.Goats = Goats;
  LE.goatPose = goatPose; // for tests
  LE.goatMesh = goatMesh;
  LE.goatCapsules = goatCapsules;
  LE.goatMesh.IDENTITY = IDENTITY;
  LE.Goats.FLOATS = FLOATS;
  LE.Goats.CAPS = CAPS;
})();
