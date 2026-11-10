/*
 * The tree on the rock at the left of the view, and the leaves the wind carries past.
 *
 * One tree, grown once from a seed: a short gnarled trunk that forks into limbs, each forking again
 * five more times, with a rosette of leathery leaves at every tip (and last year's rosette a little
 * below it), as a tree rhododendron grows on a Himalayan ridge. Red trusses of flowers in spring.
 *
 * Frame by frame (shaders/tree.js):
 *  1. a 7-pixel probe of the light at the tree (sun and moon through air and cloud, the mountains'
 *     shadow at its foot, middle and top, the sky and ground light around it, the gust), read back
 *     into uniforms without waiting for the GPU
 *  2. when it is due: bark and leaves into a small multisampled target around the tree, moved by the
 *     real wind (TreeWind): gusts bend the tree and it swings back, roll across the crown, sway the limbs
 *     each their own way and turn the leaves' pale undersides up. Only what the fixed camera can see is
 *     drawn (shellOfTree)
 *  3. that target laid over the picture, every frame
 *  4. falling leaves: from the tree, and from upwind when the wind is up, drifting with its real speed
 *     and direction, rocking from side to side as they sink. Those beyond the tree are drawn before it.
 *
 * The tree can cost as much GPU time as the whole landscape, so it gets the same care: nothing here may
 * make the browser or the desktop wait.
 *
 * Units: metres, eye frame (x right, y up, z ahead). Tree-local positions are from the foot of the trunk.
 */
(function () {
  'use strict';
  const LE = (window.LE = window.LE || {});
  const { createTarget, deleteTarget } = LE.GL;

  const BARK_FLOATS = 14; // P3 N3 wind4 bark4
  const LEAF_FLOATS = 21; // stem3 dir3 side3 wind4 leaf4 clump4
  const DRIFT_FLOATS = 13; // centre3 axisA3 axisB3 info4
  const MAX_DRIFT = 90;
  const SWAY_ROOM = 1.2; // m the wind can move the tips, for the target's size
  const LEAN_MAX = 0.6; // m at the top of the tree, however hard it blows
  const LIMB_MAX = 0.12; // m per unit of a limb's flex (at most about 2.7)
  // the limbs' swings: natural frequencies (rad/s, about 0.5 to 1.3 Hz) and damping
  const LIMB_W = [3.2, 4.5, 6.1, 8.3];
  const LIMB_Z = [0.2, 0.2, 0.22, 0.25];
  const SHELL_CELL = 0.0026; // rad, for working out what is hidden: about 4 screen pixels at any window size
  const SHELL_LAYERS = 6; // leaves in front of something before it counts as hidden: gaps open in the wind (compared by eye and per pixel)
  const LEAF_BATCHES = 4; // separate draws, so other GPU work can get a turn between them

  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  // ---------------------------------------------------------------- small vector kit
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const madd = (a, b, s) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => mul(a, 1 / (len(a) || 1));
  const perp = (d) => norm(cross(Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0], d));
  // v turned by angle t about the unit axis k
  function rot(v, k, t) {
    const c = Math.cos(t);
    const s = Math.sin(t);
    const kv = cross(k, v);
    const kd = dot(k, v) * (1 - c);
    return [v[0] * c + kv[0] * s + k[0] * kd, v[1] * c + kv[1] * s + k[1] * kd, v[2] * c + kv[2] * s + k[2] * kd];
  }

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- growing the tree
  /**
   * Wind weights (shaders/tree.js windOffset): limb flex grows with the distance along the wood from the
   * fork, twig flex with the distance from where the twig grew; every limb and twig keeps one rhythm. So
   * a joint moves exactly as the wood it grows from.
   */
  const LIMB_K = 0.25;
  const TWIG_K = 0.3;
  const TWIG_LEVEL = 3;

  function growTree(seed, awayDir) {
    const R = rng(seed);
    const rr = (a, b) => a + (b - a) * R();
    const up = [0, 1, 0];
    // it reaches out toward the open view, the way a tree on an edge reaches for the light
    const lean = norm([0.8, 0, 0.3]);
    const branches = []; // { nodes: [{ p, r, w }], level, sides }
    const tips = []; // { p, d, s, twigBase, limbPh, twigPh }
    const forks = []; // the same, where a young shoot forked

    const windAt = (s, twigBase, limbPh, twigPh) => [
      Math.pow(Math.max(s, 0), 1.3) * LIMB_K,
      limbPh,
      twigBase >= 0 ? Math.pow(Math.max(s - twigBase, 0), 1.3) * TWIG_K : 0,
      twigPh,
    ];

    // one stout trunk that twists as it rises, with a flared, rooted foot
    const trunk = [];
    const TRUNK = 2.5;
    const NT = 9;
    for (let i = 0; i <= NT; i++) {
      const f = i / NT;
      const neck = Math.max(0, (f - 0.8) / 0.2);
      const r = (0.25 - 0.06 * f + 0.24 * Math.exp(-f * 9)) * (1 - 0.2 * neck * neck * (3 - 2 * neck));
      trunk.push({ p: [0.3 * Math.sin(f * 3.6) + rr(-0.012, 0.012), -0.25 + TRUNK * f, 0.16 * Math.sin(f * 5.1) + rr(-0.012, 0.012)], r, w: [0, 0, 0, 0] });
    }
    branches.push({ nodes: trunk, level: 0, sides: 12 });
    // roots gripping the ground
    const nRoots = 5 + Math.floor(R() * 2);
    for (let i = 0; i < nRoots; i++) {
      const az = (i / nRoots) * Math.PI * 2 + rr(-0.4, 0.4);
      let rd = norm([Math.cos(az), -0.25, Math.sin(az)]);
      let rp = [Math.cos(az) * 0.2, 0.08, Math.sin(az) * 0.2];
      const nodes = [];
      const L = rr(0.8, 1.3);
      for (let k = 0; k <= 4; k++) {
        nodes.push({ p: rp, r: 0.12 * (1 - 0.8 * (k / 4)) + 0.01, w: [0, 0, 0, 0] });
        rd = norm(add(rd, [rr(-0.25, 0.25), -0.12, rr(-0.25, 0.25)]));
        rp = madd(rp, rd, L / 4);
      }
      branches.push({ nodes, level: 0, sides: 7 });
    }

    let clumps = 0;
    function grow(start, dir, length, r0, level, s0, twigBase, limbPh, twigPh, dead, clump) {
      const n = Math.max(2, Math.round(length / 0.22));
      const nodes = [];
      let q = start;
      let dd = dir;
      let s = s0;
      if (level === TWIG_LEVEL) {
        twigBase = s0;
        twigPh = R() * Math.PI * 2;
      }
      // each shoot system from here on carries one mass of foliage, lit as a whole
      if (level === 4 || clump === undefined) clump = clumps++;
      const crook = level <= 2 ? 0.26 : 0.18;
      for (let i = 0; i <= n; i++) {
        const f = i / n;
        nodes.push({ p: q, r: Math.max(r0 * (1 - (level === 1 ? 0.6 : 0.22) * f), 0.0065), w: windAt(s, twigBase, limbPh, twigPh) });
        if (i === n) break;
        // reach for the light, wander and kink; long thin wood sags under its leaves
        const sag = level >= 3 ? 0.05 * (level - 2) * f : 0;
        dd = norm(add(dd, [rr(-crook, crook), 0.035 - sag + rr(-0.08, 0.08), rr(-crook, crook)]));
        q = madd(q, dd, length / n);
        s += length / n;
      }
      branches.push({ nodes, level, sides: level <= 1 ? 9 : level === 2 ? 7 : level === 3 ? 5 : 4 });
      const end = nodes[n];
      if (dead) return { p: end.p, s };
      // past the edge of the crown a shoot ends in leaves, so the crown keeps its round form with no long bare limbs
      const mid = [trunkTop[0] + 0.1, trunkTop[1] + 1.75, trunkTop[2] + 0.1];
      const past = ((end.p[0] - mid[0]) / 3.6) ** 2 + ((end.p[1] - mid[1]) / 2.3) ** 2 + ((end.p[2] - mid[2]) / 3.3) ** 2 > 1;
      if (level >= 7 || length < 0.11 || (level >= 2 && past)) {
        tips.push({ p: end.p, d: dd, s, twigBase, limbPh, twigPh, clump });
        return;
      }
      // leaves of earlier years stay on where the shoot forked
      if (level >= 4) forks.push({ p: end.p, d: dd, s, twigBase, limbPh, twigPh, clump });
      const kids = 2 + (R() < 0.6 ? 1 : 0);
      const ax = perp(dd);
      const az0 = R() * Math.PI * 2;
      for (let k = 0; k < kids; k++) {
        // some shoots die back in the shade inside the crown and stay bare
        if (level >= 3 && R() < 0.08) {
          const bare = norm(rot(rot(dd, ax, rr(0.5, 0.9)), dd, az0 + k * 2.1));
          grow(end.p, bare, length * rr(0.3, 0.5), end.r * 0.55, Math.max(level + 1, 5), s, twigBase, limbPh, twigPh, true, clump);
          continue;
        }
        const spread = rr(0.38, 0.65) - (level >= 4 ? 0.08 : 0);
        let cd = rot(rot(dd, ax, spread), dd, az0 + (k / kids) * Math.PI * 2 + rr(-0.5, 0.5));
        // the crown is a broad dome: shoots turn outward from its middle and up toward the light
        const out = [end.p[0] - trunkTop[0], 0, end.p[2] - trunkTop[2]];
        cd = norm(add(add(cd, mul(norm(out), 0.15)), mul(up, 0.18)));
        // and grow longer on the open side, where the light is
        const cl = length * rr(0.68, 0.78) * (1 + 0.12 * dot(norm([cd[0], 0, cd[2]]), lean));
        const cr = end.r * Math.sqrt(1 / kids) * 1.08;
        grow(madd(end.p, cd, -end.r * 0.5), cd, cl, cr, level + 1, s, twigBase, limbPh, twigPh, false, clump);
      }
    }

    // limbs from the top of the trunk
    const trunkTop = trunk[NT].p;
    // The trunk parts into three leaders. Each carries the limbs that lie its way, and the limbs are spread evenly over
    // a dome, so the crown has no gaps or lobes.
    const azL = R() * Math.PI * 2;
    const leaders = [0, 1, 2].map((i) => {
      const az = azL + (i / 3) * Math.PI * 2 + rr(-0.25, 0.25);
      const dir = norm([0.62 * Math.cos(az), 0.8, 0.62 * Math.sin(az)]);
      const phase = R() * Math.PI * 2;
      const end = grow(madd(trunkTop, up, -0.2), dir, rr(1.05, 1.25), 0.135, 1, 0, -1, phase, 0, true);
      return { dir, phase, end };
    });
    const LIMBS = 16;
    for (let i = 0; i < LIMBS; i++) {
      const y = 0.2 + (0.76 * (i + 0.5)) / LIMBS;
      const rho = Math.sqrt(1 - y * y);
      const az = azL + i * 2.39996 + rr(-0.15, 0.15);
      const dir = norm([rho * Math.cos(az), y, rho * Math.sin(az)]);
      const from = leaders.reduce((a, b) => (dot(b.dir, dir) > dot(a.dir, dir) ? b : a));
      grow(from.end.p, dir, rr(0.8, 1.0) * (0.72 + 0.4 * y), 0.05, 2, from.end.s, -1, from.phase, 0);
    }

    // ---- leaves and flowers
    const leaves = [];
    const flowers = [];
    const pushLeaf = (stem, dir, side, w, phase, kind, vr, ao, clump) => {
      leaves.push([stem[0], stem[1], stem[2], dir[0], dir[1], dir[2], side[0], side[1], side[2], w[0], w[1], w[2], w[3], phase, kind, vr, ao, clump]);
    };
    function rosette(at, axis, w, n, tiltA, tiltB, droop, ao, clump) {
      const ax = perp(axis);
      const az0r = R() * Math.PI * 2;
      for (let j = 0; j < n; j++) {
        const inner = j % 3 === 0;
        const tilt = inner ? rr(tiltA * 0.55, tiltA * 0.8) : rr(tiltA, tiltB);
        let ld = rot(rot(axis, ax, tilt), axis, az0r + (j / n) * Math.PI * 2 + rr(-0.25, 0.25));
        ld = norm(add(ld, [0, -droop * rr(0.6, 1.4), 0]));
        const L = rr(0.14, 0.23) * (inner ? 0.8 : 1);
        let side = cross([0, 1, 0], ld);
        side = len(side) < 1e-3 ? perp(ld) : norm(side);
        side = rot(side, ld, rr(-0.7, 0.7));
        const hw = L * rr(0.2, 0.26);
        const vr = R();
        pushLeaf(madd(at, ld, 0.01), mul(ld, L), mul(side, hw), w, R(), 1, vr, ao, clump);
      }
    }
    for (const f of forks) {
      rosette(f.p, f.d, windAt(f.s, f.twigBase, f.limbPh, f.twigPh), 6 + Math.floor(R() * 4), 1.3, 1.85, 0.5, 0.7, f.clump);
    }
    for (const t of tips) {
      const tw = windAt(t.s, t.twigBase, t.limbPh, t.twigPh);
      rosette(t.p, t.d, tw, 9 + Math.floor(R() * 6), 0.95, 1.4, 0.25, 1.0, t.clump);
      // last year's leaves, a little further back along the shoot
      const back = rr(0.12, 0.22);
      const tw2 = windAt(t.s - back, t.twigBase, t.limbPh, t.twigPh);
      rosette(madd(t.p, t.d, -back), t.d, tw2, 7 + Math.floor(R() * 5), 1.25, 1.75, 0.45, 0.8, t.clump);
      // a truss of bells
      if (R() < 0.3) {
        const c = madd(t.p, t.d, 0.09);
        const nb = 12 + Math.floor(R() * 7);
        for (let b = 0; b < nb; b++) {
          let o = norm([rr(-1, 1), rr(-1, 1), rr(-1, 1)]);
          if (dot(o, t.d) < -0.2) o = madd(o, t.d, 0.8);
          o = norm(o);
          const rad = rr(0.034, 0.046);
          const bc = madd(c, o, 0.085);
          const a1 = rot(perp(o), o, R() * Math.PI * 2);
          const a2 = cross(o, a1);
          flowers.push([...madd(bc, a1, -rad), ...mul(a1, rad * 2), ...mul(a2, rad), ...tw, R(), 2, R(), 1.0, t.clump]);
        }
      }
    }
    for (const f of flowers) leaves.push(f);
    // each mass of foliage as a ball: its middle and its reach
    const cSum = new Map();
    for (const l of leaves) {
      const c = cSum.get(l[17]) || [0, 0, 0, 0];
      c[0] += l[0] + l[3] * 0.5;
      c[1] += l[1] + l[4] * 0.5;
      c[2] += l[2] + l[5] * 0.5;
      c[3]++;
      cSum.set(l[17], c);
    }
    const cBall = new Map();
    for (const [id, c] of cSum) cBall.set(id, [c[0] / c[3], c[1] / c[3], c[2] / c[3], 0]);
    for (const l of leaves) {
      const b = cBall.get(l[17]);
      b[3] = Math.max(b[3], Math.hypot(l[0] + l[3] - b[0], l[1] + l[4] - b[1], l[2] + l[5] - b[2]));
    }
    for (const l of leaves) {
      const b = cBall.get(l[17]);
      l.splice(17, 1, b[0], b[1], b[2], Math.max(b[3], 0.2));
    }

    // ---- crown, as an ellipsoid, and the whole extent
    let lo = [1e9, 1e9, 1e9];
    let hi = [-1e9, -1e9, -1e9];
    for (const l of leaves) {
      for (let k = 0; k < 3; k++) {
        lo[k] = Math.min(lo[k], l[k]);
        hi[k] = Math.max(hi[k], l[k]);
      }
    }
    const crownC = mul(add(lo, hi), 0.5);
    const crownR = mul(sub(hi, lo), 0.5);
    // Shade never changes with the wind or the hour: how deep each leaf sits in its clump and in the crown,
    // worked out once here instead of for every vertex in every frame
    for (const l of leaves) {
      const rel = [l[0] + l[3] * 0.5 - l[17], l[1] + l[4] * 0.5 - l[18], l[2] + l[5] * 0.5 - l[19]];
      const q = [(l[0] - crownC[0]) / crownR[0], (l[1] - crownC[1]) / crownR[1], (l[2] - crownC[2]) / crownR[2]];
      const crownAO = clamp(0.45 + 0.55 * smooth(0.25, 1, len(q)) + 0.15 * q[1], 0.4, 1);
      l[16] *= crownAO * (0.6 + 0.4 * smooth(0.15, 0.95, len(rel) / l[20]));
    }
    const boundLo = [lo[0] - 0.3, -0.4, lo[2] - 0.3];
    const boundHi = [hi[0] + 0.3, hi[1] + 0.3, hi[2] + 0.3];
    for (const b of branches) {
      for (const nd of b.nodes) {
        for (let k = 0; k < 3; k++) {
          boundLo[k] = Math.min(boundLo[k], nd.p[k] - nd.r);
          boundHi[k] = Math.max(boundHi[k], nd.p[k] + nd.r);
        }
      }
    }

    const { bark, index } = barkTubes(branches, awayDir);
    const leafData = new Float32Array(leaves.length * LEAF_FLOATS);
    leaves.forEach((l, i) => leafData.set(l, i * LEAF_FLOATS));

    return {
      branches,
      bark,
      index,
      leaves: leafData,
      leafCount: leaves.length,
      flowerCount: flowers.length, // they come last in the leaf list
      crownC,
      crownR,
      trunkTop,
      clumps: cBall.size,
      height: hi[1],
      boundLo,
      boundHi,
      tips: tips.length,
    };
  }

  // smooth noise over time, -1 to 1, that never repeats
  const hash1 = (n) => {
    const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const noise1 = (t, seed) => {
    const i = Math.floor(t);
    const f = t - i;
    const u = f * f * (3 - 2 * f);
    return 2 * (hash1(i + seed * 57.3) * (1 - u) + hash1(i + 1 + seed * 57.3) * u) - 1;
  };

  /**
   * The state of the wind in the tree. Gusts come irregularly and never repeat, and the wood answers them as a
   * real tree does: the trunk and each swing of limbs is a spring with its own natural frequency, so a gust bends
   * them, they swing back when it passes, and the swinging dies away. A gust also reaches the upwind side of the
   * crown first and rolls across it at the speed of the air. The strength still comes from the real wind, so still
   * air leaves the tree still. All of it is a few numbers a frame, passed to the shaders as uniforms.
   */
  class TreeWind {
    constructor() {
      this.t = 0;
      this.lean = [0, 0]; // the top of the tree: downwind, across (m)
      this.leanV = [0, 0];
      this.limbs = new Float32Array(LIMB_W.length * 2); // each swing: downwind, across
      this.limbV = new Float32Array(LIMB_W.length * 2);
      this.front = new Float32Array(4); // the gust at four places across the crown, upwind to downwind
      this.flutter = 0; // the twigs' and leaves' clock
    }

    /** The gust at time t, -1 to 1. field: the gust passing here in the bands crossing the forest (the probe). */
    gustAt(t, field) {
      // some spells are lively, others nearly calm
      const lively = 0.3 + 0.7 * (0.5 + 0.5 * noise1(t * 0.035, 7));
      const g = (0.6 * noise1(t * 0.23, 1) + 0.4 * noise1(t * 0.61, 2) + 0.25 * noise1(t * 1.7, 3)) * lively + 0.4 * field;
      return clamp(g * 1.3, -1, 1);
    }

    /** dt s, str the wind's strength (0 to 2.4), kmh its speed, field as above, width m across the crown. */
    step(dt, str, kmh, field, width) {
      if (!(dt > 0)) return;
      // the air crosses the crown at the speed of the gusts: seconds in light air, a moment in a storm
      const cross = Math.min(width / Math.max((kmh * 1.4) / 3.6, 2), 3);
      // after a long pause, settle at rest instead of working through the time
      const settle = dt > 2;
      const n = settle ? 0 : Math.min(Math.ceil(dt / 0.03), 67);
      const h = settle ? 0 : dt / n;
      for (let k = 0; k < n; k++) this._advance(h, str, cross, field);
      this.t += settle ? dt : 0;
      if (settle) {
        this.lean[0] = 0.2 * str;
        this.lean[1] = 0;
        this.leanV[0] = this.leanV[1] = 0;
        this.limbs.fill(0);
        this.limbV.fill(0);
      }
      for (let i = 0; i < 4; i++) this.front[i] = this.gustAt(this.t - (i / 3) * cross, field);
    }

    _advance(h, str, cross, field) {
      this.t += h;
      const t = this.t;
      const g = this.gustAt(t, field);
      // Natural wind pushes one way, harder and softer. It also veers a little, more so when it is light
      const veer = 0.5 + 0.5 / (1 + str * 2);
      // a soft limit: a storm bends the wood as far as it goes and it still moves there, instead of stopping dead
      const soft = (v, m) => m * Math.tanh(v / m);
      const toX = soft(0.2 * str * (1 + 0.8 * g), LEAN_MAX * 0.85);
      const toY = 0.1 * str * veer * noise1(t * 0.4, 4);
      const W = 2.6; // about 0.4 Hz: the trunk of a tree this size
      const Z = 0.14;
      this.leanV[0] += (W * W * (toX - this.lean[0]) - 2 * Z * W * this.leanV[0]) * h;
      this.leanV[1] += (W * W * (toY - this.lean[1]) - 2 * Z * W * this.leanV[1]) * h;
      this.lean[0] = clamp(this.lean[0] + this.leanV[0] * h, -LEAN_MAX, LEAN_MAX);
      this.lean[1] = clamp(this.lean[1] + this.leanV[1] * h, -LEAN_MAX, LEAN_MAX);
      for (let i = 0; i < LIMB_W.length; i++) {
        // each swing feels the gust at its own place in the crown, and its own eddies
        const gi = this.gustAt(t - (i / 3) * cross, field);
        const x = soft(0.03 * str + 0.04 * str * (0.7 * gi + 0.9 * noise1(t * (0.7 + 0.2 * i), 10 + i)), LIMB_MAX * 0.7);
        const y = soft(0.04 * str * veer * noise1(t * (0.9 + 0.25 * i), 20 + i), LIMB_MAX * 0.7);
        const w = LIMB_W[i];
        const z = LIMB_Z[i];
        const a = i * 2;
        this.limbV[a] += (w * w * (x - this.limbs[a]) - 2 * z * w * this.limbV[a]) * h;
        this.limbV[a + 1] += (w * w * (y - this.limbs[a + 1]) - 2 * z * w * this.limbV[a + 1]) * h;
        this.limbs[a] = clamp(this.limbs[a] + this.limbV[a] * h, -LIMB_MAX, LIMB_MAX);
        this.limbs[a + 1] = clamp(this.limbs[a + 1] + this.limbV[a + 1] * h, -LIMB_MAX, LIMB_MAX);
      }
      // twigs and leaves hurry in a gust and slow in a lull
      this.flutter = (this.flutter + h * (0.5 + 0.6 * (g + 1)) * (0.6 + 0.4 * Math.min(str, 1))) % 2400;
    }
  }

  // Bark tubes, straight into typed arrays (tens of thousands of vertices)
  function barkTubes(branches, awayDir) {
    let nv = 0;
    let ni = 0;
    for (const b of branches) {
      const rings = b.nodes.length + 1;
      nv += rings * (b.sides + 1);
      ni += (rings - 1) * b.sides * 6;
    }
    const bark = new Float32Array(nv * BARK_FLOATS);
    const index = new Uint32Array(ni);
    const at = { v: 0, i: 0 };
    for (const b of branches) tube(b, bark, index, at, awayDir);
    return { bark, index };
  }

  /**
   * Only the part of the crown the camera can see. The camera never moves, and a dense crown stacks up to 38
   * leaves on one pixel, so most of the inside can never show. Going from the nearest leaf to the farthest,
   * this counts how many solid blades already cover each small patch of the view. A leaf with SHELL_LAYERS or
   * more in front of it everywhere is left out, and so is a thin shoot hidden the same way. Trunk and main limbs
   * always stay. The kept leaves go nearest first, so the GPU rejects whatever is behind them before shading it.
   */
  function shellOfTree(T, site, awayDir, depth = SHELL_LAYERS) {
    const L = T.leaves;
    const nLeaf = T.leafCount - T.flowerCount;
    const cellOf = (x, y, z) => [Math.atan2(x + site[0], z + site[2]) / SHELL_CELL, (y + site[1]) / Math.hypot(x + site[0], z + site[2]) / SHELL_CELL];

    let cx0 = 1e9;
    let cy0 = 1e9;
    let cx1 = -1e9;
    let cy1 = -1e9;
    const grow = (c) => {
      cx0 = Math.min(cx0, c[0]);
      cy0 = Math.min(cy0, c[1]);
      cx1 = Math.max(cx1, c[0]);
      cy1 = Math.max(cy1, c[1]);
    };
    for (let i = 0; i < T.leafCount; i++) {
      const o = i * LEAF_FLOATS;
      grow(cellOf(L[o], L[o + 1], L[o + 2]));
      grow(cellOf(L[o] + L[o + 3], L[o + 1] + L[o + 4], L[o + 2] + L[o + 5]));
    }
    const PAD = 4;
    const ox = Math.floor(cx0) - PAD;
    const oy = Math.floor(cy0) - PAD;
    const cw = Math.ceil(cx1) - ox + PAD;
    const ch = Math.ceil(cy1) - oy + PAD;
    const layers = new Uint8Array(cw * ch);
    const stamp = new Int32Array(cw * ch).fill(-1);
    const cellIndex = (c) => {
      const x = Math.floor(c[0]) - ox;
      const y = Math.floor(c[1]) - oy;
      return x >= 0 && y >= 0 && x < cw && y < ch ? y * cw + x : -1;
    };

    const midDist = (i) => {
      const o = i * LEAF_FLOATS;
      return Math.hypot(L[o] + L[o + 3] * 0.5 + site[0], L[o + 1] + L[o + 4] * 0.5 + site[1], L[o + 2] + L[o + 5] * 0.5 + site[2]);
    };
    const nearFirst = (a, b) => a[1] - b[1];
    const order = [];
    for (let i = 0; i < nLeaf; i++) order.push([i, midDist(i)]);
    order.sort(nearFirst);

    const kept = [];
    const cells = [];
    for (const [i] of order) {
      const o = i * LEAF_FLOATS;
      // The blade as it is drawn: (a along it, x across it), as the shape in the leaf's fragment shader. A leaf
      // spans a few cells, so its projection is flat enough to step through it without any more trigonometry.
      const base = cellOf(L[o], L[o + 1], L[o + 2]);
      const tip = cellOf(L[o] + L[o + 3], L[o + 1] + L[o + 4], L[o + 2] + L[o + 5]);
      const edge = cellOf(L[o] + L[o + 6], L[o + 1] + L[o + 7], L[o + 2] + L[o + 8]);
      const ax = tip[0] - base[0];
      const ay = tip[1] - base[1];
      const sx = edge[0] - base[0];
      const sy = edge[1] - base[1];
      const na = Math.max(2, Math.ceil(Math.hypot(ax, ay) * 2));
      const nx = Math.max(2, Math.ceil(Math.hypot(sx, sy) * 4));
      cells.length = 0;
      let hidden = true;
      for (let ia = 0; ia <= na; ia++) {
        const a = ia / na;
        const wp = Math.min(1.9 * Math.sqrt(a * (1 - a)) * (1.25 - 0.45 * a), 1) * smooth(0, 0.12, a);
        for (let ix = 0; ix <= nx; ix++) {
          const x = (ix / nx) * 2 - 1;
          if (Math.abs(x) > wp) continue;
          const cx = Math.floor(base[0] + ax * a + sx * x) - ox;
          const cy = Math.floor(base[1] + ay * a + sy * x) - oy;
          if (cx < 0 || cy < 0 || cx >= cw || cy >= ch) continue;
          const c = cy * cw + cx;
          if (stamp[c] === i) continue;
          stamp[c] = i;
          cells.push(c);
          if (layers[c] < depth) hidden = false;
        }
      }
      if (hidden && cells.length) continue;
      kept.push(i);
      for (const c of cells) if (layers[c] < 255) layers[c]++;
    }

    // flowers sit at the tips, in front: all of them stay
    const flowers = [];
    for (let i = nLeaf; i < T.leafCount; i++) flowers.push([i, midDist(i)]);
    flowers.sort(nearFirst);
    const data = new Float32Array((kept.length + flowers.length) * LEAF_FLOATS);
    kept.forEach((i, k) => data.set(L.subarray(i * LEAF_FLOATS, (i + 1) * LEAF_FLOATS), k * LEAF_FLOATS));
    flowers.forEach(([i], k) => data.set(L.subarray(i * LEAF_FLOATS, (i + 1) * LEAF_FLOATS), (kept.length + k) * LEAF_FLOATS));

    const visible = (b) => {
      if (b.level < 3) return true;
      for (let n = 0; n < b.nodes.length; n++) {
        const p = b.nodes[n].p;
        const q = b.nodes[Math.min(n + 1, b.nodes.length - 1)].p;
        const steps = Math.max(1, Math.ceil(len(sub(q, p)) / (midDistOf(p) * SHELL_CELL)));
        for (let s = 0; s <= steps; s++) {
          const m = madd(p, sub(q, p), s / steps);
          const c = cellIndex(cellOf(m[0], m[1], m[2]));
          if (c < 0 || layers[c] < depth) return true;
        }
      }
      return false;
    };
    const midDistOf = (p) => Math.hypot(p[0] + site[0], p[1] + site[1], p[2] + site[2]);
    const { bark, index } = barkTubes(T.branches.filter(visible), awayDir);

    return { ...T, bark, index, leaves: data, leafCount: data.length / LEAF_FLOATS };
  }

  // A tube along a branch, its seam turned away from the eye, closed at the end with a short cone.
  function tube(b, out, idx, at, awayDir) {
    const nodes = b.nodes.slice();
    const last = nodes[nodes.length - 1];
    const prev = nodes[nodes.length - 2];
    const td = norm(sub(last.p, prev.p));
    nodes.push({ p: madd(last.p, td, last.r * 0.9), r: last.r * 0.25, w: last.w });
    const sides = b.sides;
    const base = at.v;
    let t0 = norm(sub(nodes[1].p, nodes[0].p));
    let n0 = sub(awayDir, mul(t0, dot(awayDir, t0)));
    n0 = len(n0) < 1e-3 ? perp(t0) : norm(n0);
    let along = 0;
    for (let i = 0; i < nodes.length; i++) {
      const nd = nodes[i];
      const t = i === 0 ? t0 : i === nodes.length - 1 ? norm(sub(nd.p, nodes[i - 1].p)) : norm(sub(nodes[i + 1].p, nodes[i - 1].p));
      if (i > 0) along += len(sub(nd.p, nodes[i - 1].p));
      n0 = norm(sub(n0, mul(t, dot(n0, t)))); // carried along the bends without twisting
      const b0 = cross(t, n0);
      // dark low down, where it stands in its own shade and the grass
      const ao = 0.55 + 0.45 * smooth(-0.15, 1.3, nd.p[1]);
      for (let k = 0; k <= sides; k++) {
        const a = (k / sides) * Math.PI * 2;
        const nr = add(mul(n0, Math.cos(a)), mul(b0, Math.sin(a)));
        // the trunk is fluted and lumpy, not a pipe
        const lump = b.level === 0 ? 1 + 0.12 * Math.sin(a * 3 + along * 2.1) + 0.06 * Math.sin(a * 5 - along * 4.3) : 1;
        const P = madd(nd.p, nr, nd.r * lump);
        const o = at.v++ * BARK_FLOATS;
        out[o] = P[0];
        out[o + 1] = P[1];
        out[o + 2] = P[2];
        out[o + 3] = nr[0];
        out[o + 4] = nr[1];
        out[o + 5] = nr[2];
        out[o + 6] = nd.w[0];
        out[o + 7] = nd.w[1];
        out[o + 8] = nd.w[2];
        out[o + 9] = nd.w[3];
        out[o + 10] = (k / sides) * Math.PI * 2 * nd.r;
        out[o + 11] = along;
        out[o + 12] = ao;
        out[o + 13] = nd.r;
      }
    }
    const ring = sides + 1;
    for (let i = 0; i < nodes.length - 1; i++) {
      for (let k = 0; k < sides; k++) {
        const a = base + i * ring + k;
        const c = a + ring;
        idx[at.i++] = a;
        idx[at.i++] = c;
        idx[at.i++] = a + 1;
        idx[at.i++] = a + 1;
        idx[at.i++] = c;
        idx[at.i++] = c + 1;
      }
    }
  }

  // ---------------------------------------------------------------- the tree and the falling leaves
  class Foreground {
    /** Read each frame, so the tree can be turned on and off while the wallpaper runs. */
    get enabled() {
      return this.r.cfg.render.tree !== false;
    }

    constructor(renderer) {
      const gl = renderer.gl;
      this.r = renderer;
      this.gl = gl;
      this.site = [0, 0, 11];
      this.box = null;
      this.ms = null;
      this.drift = [];
      this.driftData = new Float32Array(MAX_DRIFT * DRIFT_FLOATS);
      this.nFar = 0;
      this.nNear = 0;
      this._spawn = 0;
      this._lastT = null;
      this._seed = 0;
      this.moving = false;
      this.R = rng(0x51ed);
      this.lightTarget = createTarget(gl, 7, 1, [{ fmt: 'rgba16f', filter: gl.NEAREST }]);
      this.light = new Float32Array(28); // the probe's seven pixels
      this.gust = 0; // the gust at the tree, smoothed between probes
      this.treeWind = new TreeWind();
      this._windT = null;
      this._lightBuf = gl.createBuffer();
      this._lightFence = null;
      this._lightRead = false;
      this._treeT = null; // when the tree was last drawn into its target
      this.barkVAO = gl.createVertexArray();
      this.leafVAO = gl.createVertexArray();
      this.driftVAO = gl.createVertexArray();
      this.barkBuf = gl.createBuffer();
      this.barkIdx = gl.createBuffer();
      this.leafBuf = gl.createBuffer();
      this.driftBuf = gl.createBuffer();
      gl.bindVertexArray(this.driftVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.driftBuf);
      gl.bufferData(gl.ARRAY_BUFFER, this.driftData.byteLength, gl.DYNAMIC_DRAW);
      this._driftPointers(0);
      gl.bindVertexArray(renderer.vao);
    }

    _driftPointers(first) {
      const gl = this.gl;
      const st = DRIFT_FLOATS * 4;
      const o = first * st;
      const sizes = [3, 3, 3, 4];
      let off = 0;
      for (let i = 0; i < 4; i++) {
        gl.enableVertexAttribArray(i);
        gl.vertexAttribPointer(i, sizes[i], gl.FLOAT, false, st, o + off * 4);
        gl.vertexAttribDivisor(i, 1);
        off += sizes[i];
      }
    }

    _leafPointers(first) {
      const gl = this.gl;
      const st = LEAF_FLOATS * 4;
      let off = first * st;
      [3, 3, 3, 4, 4, 4].forEach((n, i) => {
        gl.enableVertexAttribArray(i);
        gl.vertexAttribPointer(i, n, gl.FLOAT, false, st, off);
        gl.vertexAttribDivisor(i, 1);
        off += n * 4;
      });
    }

    /** New size or a new view: the tree's place, its geometry (seams face away from the eye) and its target. */
    resize(w, h) {
      const gl = this.gl;
      const site = this.r.treeSite();
      this.site = [site[0], site[1], site[2]];
      const away = norm([site[0], 0, site[2]]);
      const seed = (this.r.cfg.render.seed | 0) * 7919 + 17;
      if (!this.tree || this._seed !== seed || this._away === undefined || Math.abs(this._away - away[0]) > 1e-4) {
        this.tree = shellOfTree(growTree(seed, away), this.site, away);
        this._seed = seed;
        this._away = away[0];
        const T = this.tree;
        gl.bindVertexArray(this.barkVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.barkBuf);
        gl.bufferData(gl.ARRAY_BUFFER, T.bark, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.barkIdx);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, T.index, gl.STATIC_DRAW);
        const sb = BARK_FLOATS * 4;
        [3, 3, 4, 4].reduce((off, n, i) => {
          gl.enableVertexAttribArray(i);
          gl.vertexAttribPointer(i, n, gl.FLOAT, false, sb, off * 4);
          return off + n;
        }, 0);
        gl.bindVertexArray(this.leafVAO);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.leafBuf);
        gl.bufferData(gl.ARRAY_BUFFER, T.leaves, gl.STATIC_DRAW);
        this._leafPointers(0);
        gl.bindVertexArray(this.r.vao);
      }
      // the screen rectangle the tree can reach, swaying included
      const T = this.tree;
      const v = this.r.viewInfo();
      let x0 = 1e9;
      let y0 = 1e9;
      let x1 = -1e9;
      let y1 = -1e9;
      for (let i = 0; i <= 4; i++)
        for (let j = 0; j <= 4; j++)
          for (let k = 0; k <= 4; k++) {
            const lp = [
              T.boundLo[0] - SWAY_ROOM + ((T.boundHi[0] - T.boundLo[0] + 2 * SWAY_ROOM) * i) / 4,
              T.boundLo[1] + ((T.boundHi[1] - T.boundLo[1] + SWAY_ROOM) * j) / 4,
              T.boundLo[2] - SWAY_ROOM + ((T.boundHi[2] - T.boundLo[2] + 2 * SWAY_ROOM) * k) / 4,
            ];
            const px = this.project(add(lp, this.site), v);
            if (!px) continue;
            x0 = Math.min(x0, px[0]);
            y0 = Math.min(y0, px[1]);
            x1 = Math.max(x1, px[0]);
            y1 = Math.max(y1, px[1]);
          }
      x0 = clamp(Math.floor(x0) - 4, 0, w);
      y0 = clamp(Math.floor(y0) - 4, 0, h);
      x1 = clamp(Math.ceil(x1) + 4, 0, w);
      y1 = clamp(Math.ceil(y1) + 4, 0, h);
      this._freeTarget();
      if (x1 - x0 < 2 || y1 - y0 < 2) {
        this.box = null;
        return;
      }
      this.box = [x0, y0, x1 - x0, y1 - y0];
      this._allocTarget(this.box[2], this.box[3]);
    }

    /** Eye-frame metres to screen pixels (the scene's cylindrical panorama), or null behind the eye. */
    project(pe, v) {
      const a = Math.atan2(pe[0], pe[2]);
      if (Math.abs(a) > v.hfov * 0.5 + 0.2) return null;
      const r = Math.hypot(pe[0], pe[2]);
      return [v.w * 0.5 + a / v.pxAng, v.horizonY * v.h + pe[1] / Math.max(r, 1e-3) / v.pxAng];
    }

    _allocTarget(w, h) {
      const gl = this.gl;
      // the sample count every attachment supports
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
        this.box = null;
        console.warn('Tree target incomplete: 0x' + status.toString(16));
        return;
      }
      this.resolved = createTarget(gl, w, h, [
        { fmt: 'rgba8', filter: gl.NEAREST },
        { fmt: 'r8', filter: gl.NEAREST },
      ]);
    }

    _freeTarget() {
      const gl = this.gl;
      this._treeT = null; // whatever comes next starts empty
      if (this.ms) {
        gl.deleteFramebuffer(this.ms.fbo);
        this.ms.rb.forEach((rb) => gl.deleteRenderbuffer(rb));
        this.ms = null;
      }
      deleteTarget(gl, this.resolved);
      this.resolved = null;
    }

    // ---------------------------------------------------------------- per frame
    _wind(state) {
      const kmh = state.treeKmh || 0;
      const g = state.treeDir || state.gustDir;
      // a light breeze already shows on a tree: this rises faster at first than the speed does
      return { kmh, str: Math.min(Math.pow(kmh / 30, 0.8), 2.4), dir: [g[0], 0, g[1]] };
    }

    /** Moves the wind in the tree on to now. */
    _stepWind(state) {
      const t = state.time;
      const dt = this._windT === null ? 0 : t - this._windT;
      this._windT = t;
      const w = this._wind(state);
      const T = this.tree;
      this.treeWind.step(dt, w.str, w.kmh, this.gust, 2 * Math.hypot(T.crownR[0], T.crownR[2]));
    }

    /**
     * Is it time to draw the tree anew? Between times the last picture of it stays in its target and is laid
     * over each frame. Its leaves move at 1 to 2 cycles a second, so about 15 pictures a second show that
     * fully; in still air nothing moves but the slowly changing light.
     */
    _treeDue(state) {
      if (this._treeT === null) return true;
      const since = state.time - this._treeT;
      if (since < 0) return true;
      const R = this.r;
      const w = state.weather;
      // Rain and snow are drawn over the tree and a flash lights it, so those keep up with every frame. In rest
      // mode the scene behind changes only every 2 s anyway, and there lightness matters most.
      if (!R._rest && (w.rain > 0.003 || w.snow > 0.003 || w.flash > 0.01 || R._fade < 1)) return true;
      const hz = R._rest ? 10 : this._wind(state).kmh > 2.5 ? R.quality.treeHz : 8;
      // 0.7, not 1: at 20 frames a second a 15 Hz tree is drawn in each one, at 30 in every second one
      return since >= 0.7 / hz;
    }

    /** How far (m) the crown has swayed downwind now, for the dappled shadow it casts on the rock. */
    swayOffset() {
      return this.treeWind.lean[0];
    }

    _bloom(state) {
      const doy = (state.astro && state.astro.dayOfYear) || 0;
      return smooth(32, 55, doy) * (1 - smooth(100, 125, doy));
    }

    /** Moves the falling leaves on, and starts new ones. */
    update(state) {
      if (!this.enabled || !this.tree) return;
      const t = state.time;
      let dt = this._lastT === null ? 0 : t - this._lastT;
      this._lastT = t;
      if (!(dt > 0)) dt = 0;
      // The page's clock (LE.SceneClock) moves on by little across a pause or a late frame, so a long step only comes
      // from a chip that is slow all the time, and the leaves go on. Clearing them at 2 s made every leaf vanish at
      // once and new ones appear elsewhere. Only something far longer, which should never happen, starts them over.
      if (dt > 30) {
        dt = 0;
        this.drift.length = 0;
      }
      // The flying leaves can be turned off on their own: the tree stays. Spring blossom goes with them.
      this.leaves = this.r.cfg.leaves !== false;
      if (!this.leaves) {
        this.drift.length = 0;
        this._spawn = 0;
      }
      const wind = this._wind(state);
      this.moving = wind.kmh > 2.5 || this.drift.length > 0;
      // several small steps keep the rocking fall smooth at a low frame rate
      const n = Math.max(1, Math.ceil(dt / 0.05));
      for (let i = 0; i < n; i++) this._step(dt / n, t - dt + ((i + 1) * dt) / n, state, wind);
      this._upload();
    }

    _step(dt, t, state, wind) {
      if (dt <= 0) return;
      const U = wind.kmh / 3.6; // m/s
      const W = wind.dir;
      const season = state.season || [0, 0, 1, 0];
      const bloom = this._bloom(state);
      // old leaves let go all year, most in autumn and in a storm; strong wind also brings them from upwind
      const shed = 0.6 + 1.2 * season[1] + 0.3 * season[0];
      const rate = (wind.kmh < 3 ? 0.04 : 0.06 + 2.4 * Math.pow(smooth(3, 45, wind.kmh), 1.4)) * shed + bloom * 0.35 * smooth(2, 25, wind.kmh);
      if (this.leaves !== false) this._spawn += rate * dt;
      while (this._spawn >= 1) {
        this._spawn -= 1;
        if (this.drift.length < MAX_DRIFT) this.drift.push(this._newLeaf(U, W, bloom, wind.kmh));
      }
      const keep = [];
      for (const L of this.drift) {
        // the air: the mean wind, with gusts running downwind and eddies
        const along = L.p[0] * W[0] + L.p[2] * W[2];
        const g = 1 + 0.4 * Math.sin(t * 0.83 - along * 0.07 + L.seed) + 0.22 * Math.sin(t * 2.1 + along * 0.19 + L.seed * 2.3);
        const eddy = 0.18 + 0.12 * U;
        const ax = W[0] * U * g + eddy * Math.sin(t * 1.3 + L.seed * 5.1);
        const az = W[2] * U * g + eddy * Math.sin(t * 1.1 + L.seed * 3.7);
        // air rising over the edge of the rock, more in a strong wind
        const ay = eddy * 0.6 * Math.sin(t * 0.9 + L.seed * 7.3) + 0.06 * U;
        // the leaf sinks, rocking from side to side
        L.ph += dt * L.rock;
        const fall = -L.vt * (0.8 + 0.4 * Math.sin(L.ph * 2));
        const swing = 0.6 * L.vt * Math.cos(L.ph);
        const tx = ax + swing * L.sw[0];
        const ty = ay + fall;
        const tz = az + swing * L.sw[2];
        const k = 1 - Math.exp(-dt / 0.35);
        L.v[0] += (tx - L.v[0]) * k;
        L.v[1] += (ty - L.v[1]) * k;
        L.v[2] += (tz - L.v[2]) * k;
        L.p = madd(L.p, L.v, dt);
        // tumbling, faster in the wind
        const spin = L.spin * (0.5 + Math.min(U / 6, 2));
        L.A = rot(L.A, L.k, spin * dt);
        L.B = rot(L.B, L.k, spin * dt);
        L.k = norm(rot(L.k, L.k2, dt * 0.7));
        // keep the axes square
        L.B = norm(sub(L.B, mul(L.A, dot(L.A, L.B) / dot(L.A, L.A))));
        L.B = mul(L.B, L.hw);
        L.A = mul(norm(L.A), L.hl);
        L.age += dt;
        const dist = len(L.p);
        if (L.age < L.life && dist < 70 && L.p[1] > -60 && dist > 1.2) keep.push(L);
      }
      this.drift = keep;
    }

    _newLeaf(U, W, bloom, kmh) {
      const R = this.R;
      const rr = (a, b) => a + (b - a) * R();
      const T = this.tree;
      const v = this.r.viewInfo();
      const fromTree = kmh < 6 || R() < 0.45;
      const petal = bloom > 0.3 && R() < 0.55 * bloom;
      const vt = petal ? rr(0.55, 0.85) : rr(0.85, 1.35);
      let p;
      if (fromTree) {
        // somewhere in the crown
        let q;
        do q = [rr(-1, 1), rr(-1, 1), rr(-1, 1)];
        while (dot(q, q) > 1);
        p = add(this.site, [T.crownC[0] + q[0] * T.crownR[0] * 0.85, T.crownC[1] + q[1] * T.crownR[1] * 0.85, T.crownC[2] + q[2] * T.crownR[2] * 0.85]);
      } else {
        // aim at a point in view a few seconds ahead, mostly near the tree, and start upwind of it
        const u = R() < 0.65 ? rr(-1, -0.35) : rr(-1, 1);
        const a = u * v.hfov * 0.5;
        const dist = rr(10, 32);
        const slope = rr(-0.15, 0.42);
        const target = [Math.sin(a) * dist, slope * dist, Math.cos(a) * dist];
        const lead = rr(1.5, 4);
        p = sub(target, [W[0] * U * lead, -0.8 * vt * lead, W[2] * U * lead]);
      }
      const k = norm([rr(-1, 1), rr(-1, 1), rr(-1, 1)]);
      const A0 = perp(k);
      const hl = petal ? rr(0.02, 0.028) : rr(0.04, 0.065);
      const hw = petal ? hl * rr(0.8, 1) : hl * rr(0.3, 0.42);
      const swAz = R() * Math.PI * 2;
      return {
        p,
        v: [W[0] * U, -vt, W[2] * U],
        k,
        k2: norm([rr(-1, 1), rr(-1, 1), rr(-1, 1)]),
        A: mul(A0, hl),
        B: mul(cross(k, A0), hw),
        hl,
        hw,
        spin: rr(1.5, 4.5) * (R() < 0.5 ? -1 : 1),
        sw: [Math.cos(swAz), 0, Math.sin(swAz)],
        ph: R() * 6.28,
        rock: rr(2.2, 3.6),
        vt,
        kind: petal ? 4 : 3,
        vr: R(),
        seed: R() * 100,
        age: 0,
        life: rr(7, 15),
      };
    }

    _upload() {
      const v = this.r.viewInfo();
      const treeDist = len(this.site);
      const far = [];
      const near = [];
      for (const L of this.drift) {
        const px = this.project(L.p, v);
        if (!px || px[0] < -80 || px[0] > v.w + 80 || px[1] < -80 || px[1] > v.h + 80) continue;
        const d = len(L.p);
        // fade in and out, and out of the way close to the eye, where a leaf would fill the screen
        const op = Math.min(1, L.age / 0.6) * Math.min(1, (L.life - L.age) / 1.2) * smooth(1.5, 3.5, d);
        if (op <= 0.01) continue;
        (d > treeDist ? far : near).push([L, op]);
      }
      const D = this.driftData;
      let i = 0;
      for (const [L, op] of far.concat(near)) {
        D.set([L.p[0], L.p[1], L.p[2], L.A[0], L.A[1], L.A[2], L.B[0], L.B[1], L.B[2], L.kind, L.vr, op, 1], i * DRIFT_FLOATS);
        i++;
      }
      this.nFar = far.length;
      this.nNear = near.length;
      if (i) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.driftBuf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, D, 0, i * DRIFT_FLOATS);
      }
    }

    /** Uniforms shared by the tree's programs. */
    _common(p, state, box) {
      const R = this.r;
      const v = R.viewInfo();
      const w = state.weather;
      const T = this.tree;
      const wind = this._wind(state);
      const t = state.time % 2400;
      p.set('uRes', [R.w, R.h]);
      p.set('uHFov', v.hfov);
      p.set('uHorizonY', v.horizonY);
      p.set('uBox', box);
      p.set('uSite', this.site);
      p.set('uWindDir', wind.dir);
      p.set('uWindStr', wind.str);
      p.set('uTime', t);
      p.set('uTreeH', T.height);
      p.set('uCrownC', T.crownC);
      p.set('uCrownR', T.crownR);
      p.set('uKeyDir', state.keyDir);
      p.set('uKeyIsSun', state.keyIsSun);
      p.set('uTreeL', this.light);
      p.set('uLean', this.treeWind.lean);
      p.set('uLimb', this.treeWind.limbs);
      p.set('uFront', this.treeWind.front);
      p.set('uFlutter', this.treeWind.flutter);
      p.set('uSunDir', state.sunDir);
      p.set('uMoonDir', state.moonDir);
      p.set('uOvercast', w.overcast);
      p.set('uFlash', w.flash);
      p.set('uWet', w.wet);
      p.set('uSeason', state.season);
      p.set('uMieScale', w.haze);
      const snowAt = smooth(state.snowLine - 0.18, state.snowLine + 0.28, R.cfg.render.cameraAltitude);
      p.set('uSnowTree', snowAt * 0.92);
      const tc = norm([-this.site[0], 0, -this.site[2]]);
      p.set('uToCam', [tc[0], tc[2]]);
      p.set('uNight', state.night);
      p.set('uRain', w.rain);
      p.set('uSnow', w.snow);
      p.set('uRainSlant', w.rainSlant);
      p.set('uRainLayers', R.quality.rainLayers);
      p.set('uFade', R._fade);
      p.set('uBloom', this._bloom(state));
      R._bind(p, {
        uG0: R.gbuf.tex[0],
        uTransLUT: R.transLUT.tex[0],
        uSkyLUT: R.skyLUT.tex[0],
        uAdapt: R.adaptA.tex[0],
      });
    }

    /** Takes in the probe's result once the GPU has it. False while it is still on its way. */
    _collectLight() {
      const f = this._lightFence;
      if (f === null) return true;
      const gl = this.gl;
      if (!gl.isContextLost() && gl.getSyncParameter(f, gl.SYNC_STATUS) !== gl.SIGNALED) return false;
      gl.deleteSync(f);
      this._lightFence = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._lightBuf);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.light);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      return true;
    }

    /** The probe's pixels, into this.light. Waits for the GPU only once, for the very first picture of the tree. */
    _readLight() {
      const gl = this.gl;
      if (!this._lightRead) {
        this._lightRead = true;
        gl.readPixels(0, 0, 7, 1, gl.RGBA, gl.FLOAT, this.light);
        this.gust = this.light[27];
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._lightBuf);
        gl.bufferData(gl.PIXEL_PACK_BUFFER, this.light.byteLength, gl.STREAM_READ);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
        return;
      }
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._lightBuf);
      gl.readPixels(0, 0, 7, 1, gl.RGBA, gl.FLOAT, 0);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this._lightFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    }

    _probe(state) {
      const R = this.r;
      const gl = this.gl;
      const p = R.prog.treeLight;
      const T = this.tree;
      const cam = R.cfg.render.cameraAltitude;
      const km = (lp) => [(this.site[0] + lp[0]) * 0.001, cam + (this.site[1] + lp[1]) * 0.001, (this.site[2] + lp[2]) * 0.001];
      R._target(this.lightTarget, 7, 1);
      gl.useProgram(p.p);
      R._camera(p, R.w, R.h);
      R._weatherUniforms(p, state);
      p.set('uKeyDir', state.keyDir);
      p.set('uTreeSite', R.treeSite());
      p.set('uTreeFoot', km([0, 0, 0]));
      p.set('uTreeMid', km(T.crownC));
      p.set('uTreeTop', km([T.crownC[0], T.height, T.crownC[2]]));
      const tc = norm([-this.site[0], 0, -this.site[2]]);
      p.set('uToCam', [tc[0], tc[2]]);
      p.set('uGustDir', state.gustDir);
      p.set('uGustTravel', state.gustTravel);
      R._bind(p, { uTransLUT: R.transLUT.tex[0], uSkyLUT: R.skyLUT.tex[0], uNoise2D: R.noise2D, uNoise3D: R.noise3D });
      R._draw();
      this._readLight();
    }

    _drawDrift(state, first, count) {
      if (!count) return;
      const gl = this.gl;
      const R = this.r;
      const p = R.prog.treeDrift;
      R._target(null, R.w, R.h);
      gl.useProgram(p.p);
      this._common(p, state, [0, 0, R.w, R.h]);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.driftVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.driftBuf);
      this._driftPointers(first);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, count);
      gl.bindVertexArray(R.vao);
      gl.disable(gl.BLEND);
    }

    /** Leaves into the bound target, nearest first and in separate draws, so other GPU work gets a turn between them. */
    _drawLeaves(count) {
      const gl = this.gl;
      gl.bindVertexArray(this.leafVAO);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.leafBuf);
      const per = Math.ceil(count / LEAF_BATCHES);
      for (let first = 0; first < count; first += per) {
        this._leafPointers(first);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, Math.min(per, count - first));
        gl.flush();
      }
      this._leafPointers(0);
    }

    /** Bark and leaves into the multisampled target, then resolved: colour (already weighted by coverage) and coverage. */
    _drawTree(state) {
      const R = this.r;
      const gl = this.gl;
      const box = this.box;
      const [bw, bh] = [box[2], box[3]];
      const T = this.tree;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.ms.fbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.viewport(0, 0, bw, bh);
      gl.clearColor(0, 0, 0, 0);
      gl.clearDepth(1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LESS);
      gl.depthMask(true);
      // Leaves first: bark is the costlier per pixel, and most of it is behind them. Out of season no flower
      // is drawn at all (they would be size zero anyway), which is about a fifth of the corners to work out.
      let p = R.prog.treeLeaf;
      gl.useProgram(p.p);
      this._common(p, state, box);
      if (this.ms.samples) gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      this._drawLeaves(this._bloom(state) > 0 ? T.leafCount : T.leafCount - T.flowerCount);
      gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);
      p = R.prog.treeBark;
      gl.useProgram(p.p);
      this._common(p, state, box);
      gl.bindVertexArray(this.barkVAO);
      gl.drawElements(gl.TRIANGLES, T.index.length, gl.UNSIGNED_INT, 0);
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
      gl.flush();
      this._treeT = state.time;
    }

    /** Draws the leaves beyond the tree, the tree, then the leaves in front of it, over the picture. */
    draw(state) {
      if (!this.enabled || !this.tree) return;
      const R = this.r;
      const gl = this.gl;
      this.update(state);
      if (this._collectLight()) this._probe(state); // one at a time: it never waits for the GPU
      this.gust += (this.light[27] - this.gust) * 0.3;
      this._stepWind(state);
      this._drawDrift(state, 0, this.nFar);
      if (this.box && this.ms) {
        const box = this.box;
        if (this._treeDue(state)) this._drawTree(state);
        // over the picture
        {
          R._target(null, R.w, R.h);
          const p = R.prog.treeComp;
          gl.useProgram(p.p);
          p.set('uRes', [R.w, R.h]);
          p.set('uBox', box);
          R._bind(p, { uTreeColor: this.resolved.tex[0], uTreeCover: this.resolved.tex[1] });
          gl.enable(gl.BLEND);
          gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
          gl.drawArrays(gl.TRIANGLES, 0, 6);
          gl.disable(gl.BLEND);
        }
      }
      this._drawDrift(state, this.nFar, this.nNear);
    }

    dispose() {
      const gl = this.gl;
      this._freeTarget();
      deleteTarget(gl, this.lightTarget);
      if (this._lightFence !== null) gl.deleteSync(this._lightFence);
      this._lightFence = null;
      [this.barkBuf, this.barkIdx, this.leafBuf, this.driftBuf, this._lightBuf].forEach((b) => gl.deleteBuffer(b));
      [this.barkVAO, this.leafVAO, this.driftVAO].forEach((v) => gl.deleteVertexArray(v));
    }
  }

  LE.Foreground = Foreground;
  LE.growTree = growTree; // for tests
  LE.shellOfTree = shellOfTree;
  LE.TreeWind = TreeWind;
})();
