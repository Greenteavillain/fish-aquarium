// Fish: simulation (CPU, struct-of-arrays) + per-frame culling / LOD / instance upload.
//
// Layout of the population (adapted from scenes/final for a camera that MOVES):
//  - AMBIENT shoals: the composition's stream swarms (species mixes, flow directions, speeds,
//    sizes) live in boxes that wrap toroidally around the camera in x/z, so wherever you swim you
//    are inside the shoal.  Fish shrink to nothing over the last 1.5 m before a wrap edge, which sits
//    12-28 m away in the fog.  (Blender's frustum-mode swarms bake a fixed camera; the composition
//    note says a moving camera breaks them — so their PARAMETERS are reused, not their lanes.)
//  - STREAM (QA2 round 2): the composition's box streams themselves (the final's hero river of
//    slabs, ~10.3k fish) world-fixed where scenes/final has them, on analytic wrapping lanes — the
//    ambient boxes alone gave the opening view 48 % fish coverage against the final's 73 %.  See
//    addStream.  (2026-10-05 web sync: the recomposed final's slabs are snapper, seabream, fusilier,
//    snooty wrasse, stripey, parrotfish, mackerel, sardine, saury, goatfish, angelfish, knifejaw.)
//  - World-fixed: the composition's mills by the pillar, a web-only bait ball, the hammerheads /
//    eagle rays on long loops at the fog edge, the placed bed fish / rockfish / dories / filefish /
//    lionfish exactly where scenes/final put them, plus extra benthic / reef species (the 8 sea
//    species the final does not use) so every one of the 38 is somewhere in the world.
// Every fish faces its velocity and beats its tail at a tempo set by its real speed in body lengths
// per second (stride per beat ~0.6 BL for carangiform, from the final's re-timed stripey: 34 beats /
// 10 s at ~2 BL/s), so nothing 'skates'.
import * as THREE from 'three';
import { NEON_PALETTE } from './fishmat.js';

const KIND = { AMBIENT: 0, VORTEX: 1, PATH: 2, STATIC: 3, HOVER: 4, STREAM: 5 };
// body lengths travelled per tail beat; 0 = not speed-driven (hovering / resting: base tempo)
const STRIDE = { carangiform: 0.6, thunniform: 0.7, anguilliform: 0.45, rajiform_flap: 1.3,
  rajiform_undulate: 0.5, flatfish_wave: 0.5, ostraciiform: 0.35, hover_drift: 0, benthic_rest: 0, prop: 0 };
const STRIDE_OVERRIDE = { hammerhead: 0.95 };    // a 2.3 m shark beats ~0.6 Hz at 1.4 m/s (final: 6 cycles/10 s)
// Never recoloured in neon mode (tint alpha 0).  Mirrors scenes/final_color/make_color.py SKIP_SPECIES:
// the hammerheads are the scale cue ('a neon shark reads as a toy') and the jaw is bone.  The eagle ray
// is web-only (not in the final) but is the other giant cruiser, so it follows the hammerheads' rule.
// (2026-10-05 web sync) WHY a list: the web only skipped swim_style 'prop', so the neon web frame
// showed magenta hammerheads where the recoloured Blender poster keeps them grey.
const NEON_SKIP = new Set(['hammerhead', 'carcharhinus-altimus', 'eagle-ray']);

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const norm3 = (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };

export class FishSystem {
  constructor({ species, comp, keepouts, sandHeight, seed = 7, cap = 48000 }) {
    this.species = species;           // [{spec, id, k, swim, mat, geoNear, geoFar}]
    this.byId = Object.fromEntries(species.map((s) => [s.id, s]));
    this.comp = comp;
    this.keepouts = keepouts;
    // stackTop: no other cylinder sits on this one (the pillar is 4 stacked cylinders; only the top
    // one may be left over the top when a parted fish is projected out of the rock, compose())
    for (const k of keepouts) k.stackTop = !keepouts.some((o) => o !== k && Math.abs(o.y0 - (k.y0 + k.h)) < 0.1 && Math.hypot(o.x - k.x, o.z - k.z) < k.r + o.r);
    this.sand = sandHeight;
    this.rng = mulberry32(seed);
    this.N = 0;
    // ambient ~24.7k + composition streams ~10.3k + world-fixed ~1.5k (2026-10-05: 36.5k).  (mobile 10-05) phones
    // pass 32k: their population is ~24k (main.js MOBILE_PERF) and every slot costs ~180 bytes of arrays
    this.cap = cap;
    this.density = 1;           // multiplies every ambient layer's count (main.js; ?dens= for tests)
    this.layers = [];
    this.alloc(this.cap);
    this.quality = 1;           // target fraction of ambient fish drawn (adaptive)
    this.qCur = 1;              // smoothed, so fish fade in/out instead of popping on a change
    this.nearPx = 120;          // on-screen body length above which the 10k-triangle LOD is used
    // (QA2) below these on-screen lengths (drawing-buffer px) the fish switch to the simplified
    // 'tiny' (~25 % of the far LOD) and 'micro' (~8 %) meshes built in main.js.  WHY: measured with
    // benchSync at 2560x1440, the start view was VERTEX-bound — 9.6 M triangles took 14 ms, the same
    // view with the far LOD cut to 300 triangles took 7.3 ms — and 70 % of the drawn fish are under
    // 28 px, where 1500 triangles per fish are invisible detail.  The time saved buys more fish.
    // (QA2 round 2) 44 -> 72 and 12 -> 18 with the composition streams (~10k more fish in the
    // opening view, mostly 40-80 px).  Same-frame captures at 2560x1440, thresholds 44/12 vs 80/20:
    // 1.5 % of pixels differ by > 40 levels (silhouette edges a sub-pixel apart), no visible loss
    // side by side at 2x zoom (scratch lod_pair.png); triangles 9.3 M -> 7.2-7.5 M.
    this.tinyPx = 72;
    this.microPx = 18;
    this.stats = { sim: 0, drawn: 0, near: 0, far: 0, culled: 0 };
    this.camAvoid = 0.9;        // m: fish part around the swimmer
    this.camVel = null;         // the swimmer's velocity (THREE.Vector3, set by main.js) for parting
    // per-species ceiling on the near-LOD threshold, so the adaptive controller (which raises
    // nearPx under load) can never push these onto their far mesh while big on screen.
    // eagle-ray: its far LOD's thin wing plate crosses itself (asset check: bright shards on the
    // belly up close) -> 'keep the ray on near until it is under about 150 px'.
    this.nearCap = new Float32Array(species.length).fill(1e9);
    for (const [id, cap] of [['eagle-ray', 150], ['hammerhead', 180]]) if (this.byId[id]) this.nearCap[this.byId[id].k] = cap;
  }

  alloc(n) {
    const F = (k = 1) => new Float32Array(n * k);
    Object.assign(this, {
      px: F(), py: F(), pz: F(), vx: F(), vy: F(), vz: F(), hx: F(), hy: F(), hz: F(), bank: F(),
      len: F(), spd: F(), beat: F(), phase: F(), amp: F(), rank: F(), fade: F(),
      rp: F(3),          // where each drawn fish was last DRAWN (after parting); for checks only
      tint: F(4), wan: F(4), pa: F(8), quat: F(4), baseHz: F(), stride: F(),
      sp: new Uint8Array(n), kind: new Uint8Array(n), grp: new Uint16Array(n), lod: new Uint8Array(n),
      vsign: new Int8Array(n), seen: new Uint32Array(n),
      gIdx: new Int8Array(n).fill(-1), gSide: F(3),     // STREAM fish: giant being parted around + chosen side
    });
    this.frameNo = 1;
  }

  // ---------- population ----------
  pickTint() {
    let u = this.rng(), acc = 0;
    for (const [c, w] of NEON_PALETTE) { acc += w; if (u <= acc) return c; }
    return NEON_PALETTE[0][0];
  }
  add(id, kind, L, x, y, z) {
    const s = this.byId[id];
    if (!s) return -1;
    if (this.N >= this.cap) return -1;
    const i = this.N++;
    this.sp[i] = s.k; this.kind[i] = kind; this.len[i] = L;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.hx[i] = 1; this.hy[i] = 0; this.hz[i] = 0;
    this.phase[i] = this.rng(); this.beat[i] = this.rng();
    this.amp[i] = 0.92 + 0.16 * this.rng();
    this.rank[i] = this.rng();
    this.fade[i] = 1;
    const c = this.pickTint();
    // (the rng draw stays unconditional so the population's random sequence does not depend on the list)
    const ta = 0.85 + 0.3 * this.rng();
    this.tint.set([c.r, c.g, c.b, s.spec.swim_style === 'prop' || NEON_SKIP.has(id) ? 0 : ta], i * 4);
    this.wan.set([0.15 + 0.35 * this.rng(), this.rng() * 6.283, 0.1 + 0.25 * this.rng(), this.rng() * 6.283], i * 4);
    this.quat.set([0, 0, 0, 1], i * 4);
    this.vsign[i] = 1;
    const st = s.spec.swim_style;
    this.stride[i] = STRIDE_OVERRIDE[id] ?? STRIDE[st] ?? 0;
    // resting/hovering tempo: the species' own cycles per 10 s loop (library), +-15 %
    this.baseHz[i] = (s.swim.cycles / 10) * (0.85 + 0.3 * this.rng());
    return i;
  }
  lenFor(id, range) {
    const s = this.byId[id];
    const [a, b] = range || [s.spec.typical_length_m * 0.85, s.spec.typical_length_m * 1.15];
    return a + (b - a) * this.rng();
  }
  pickWeighted(list) {
    const tot = list.reduce((a, x) => a + x[1], 0);
    let u = this.rng() * tot;
    for (const x of list) { u -= x[1]; if (u <= 0) return x; }
    return list[list.length - 1];
  }

  /** layer: {name, half, y:[y0,y1], count, flows:[[dir3, w]], species:[[id, w, [lmin,lmax]]], speed:[min,max], cam} */
  addLayer(def, cam) {
    const li = this.layers.length;
    const L = { ...def, flows: def.flows.map(([d, w]) => [norm3(d), w]) };
    this.layers.push(L);
    const count = Math.round(def.count * this.density);
    for (let n = 0; n < count; n++) {
      const [id, , range] = this.pickWeighted(def.species);
      const x = cam.x + (this.rng() * 2 - 1) * def.half;
      const z = cam.z + (this.rng() * 2 - 1) * def.half;
      // 'tri': denser mid-band (the final's schools sit 1.5-4 m up, thinning toward sand and top)
      const u = def.ydist === 'tri' ? (this.rng() + this.rng()) / 2 : this.rng();
      const y = def.y[0] + (def.y[1] - def.y[0]) * u;
      const i = this.add(id, KIND.AMBIENT, this.lenFor(id, range), x, y, z);
      if (i < 0) break;
      const [dir] = this.pickWeighted(L.flows);
      this.grp[i] = li;
      this.wan[i * 4 + 0] = 0.12 + 0.3 * this.rng();
      const sp = def.speed[0] + (def.speed[1] - def.speed[0]) * this.rng();
      this.spd[i] = sp;
      // per-fish flow direction (with ~6 deg jitter) stored in pa[0..2]
      const j = 0.1;
      const d = norm3([dir[0] + (this.rng() - 0.5) * j, dir[1] + (this.rng() - 0.5) * j * 0.5, dir[2] + (this.rng() - 0.5) * j]);
      this.pa.set(d, i * 8);
      this.vx[i] = d[0] * sp; this.vy[i] = d[1] * sp; this.vz[i] = d[2] * sp;
      this.hx[i] = d[0]; this.hy[i] = d[1]; this.hz[i] = d[2];
    }
  }

  /** vortex: {center3, diameter, height, count, species, speed, spin, inner, taper} — a mill / bait ball */
  addVortex(def) {
    for (let n = 0; n < def.count; n++) {
      const [id, , range] = this.pickWeighted(def.species);
      const L = this.lenFor(id, range);
      const R = def.diameter / 2;
      // Re-roll the height/radius until the fish's WHOLE circle (with its bob range) clears every
      // rock.  WHY: the orbit is analytic, nothing steers it; the knifejaw mill round the pillar
      // passed straight through Boulder_02 beside it (QA: 4 fish, centres up to 0.46 m inside the
      // rock) at its low end.  A fish with no clear orbit after 40 tries is left out.
      const inner = def.innerAbs ?? (def.inner ?? 0.3) * R;
      const bob = (def.bob ?? 0.15) * this.rng();
      let yc = 0, rr = 0, ok = false;
      for (let tries = 0; tries < 40 && !ok; tries++) {
        const hFrac = this.rng() * 2 - 1;                       // -1 bottom .. 1 top
        const taper = 1 - (def.taper ?? 0.3) * hFrac * hFrac;   // rounder ball: narrower top & bottom
        const r = (inner + (R - inner) * Math.sqrt(this.rng())) * taper;
        rr = Math.max(r, def.innerAbs ?? 0);
        yc = def.center[1] + hFrac * def.height / 2;
        ok = this.orbitClear(def.center[0], def.center[2], rr, rr, yc - bob, yc + bob, 0.45 * L);
      }
      if (!ok) continue;
      const sp = def.speed[0] + (def.speed[1] - def.speed[0]) * this.rng();
      const i = this.add(id, KIND.VORTEX, L, def.center[0], def.center[1], def.center[2]);
      if (i < 0) break;
      this.spd[i] = sp;
      this.pa.set([def.center[0], yc, def.center[2], rr,
        this.rng() * 6.2832, (def.spin ?? 1) * sp / rr, bob, this.rng() * 6.2832], i * 8);
    }
  }

  /** true if the horizontal ellipse (cx, cz, rx, rz) at every height in [y0, y1] keeps `pad` clear
   *  of every KEEPOUT cylinder (sampled every ~0.1 m of arc). */
  orbitClear(cx, cz, rx, rz, y0, y1, pad) {
    const n = Math.max(48, Math.ceil(6.2832 * Math.max(rx, rz) / 0.1));
    for (const k of this.keepouts) {
      if (y1 < k.y0 - pad || y0 > k.y0 + k.h + pad) continue;
      const R = k.r + pad;
      for (let j = 0; j < n; j++) {
        const a = (j / n) * 6.2832;
        if (Math.hypot(cx + rx * Math.cos(a) - k.x, cz + rz * Math.sin(a) - k.z) < R) return false;
      }
    }
    return true;
  }

  /**
   * A world-fixed composition stream (scenes/final swarm.py 'stream' BOX mode): fish on straight
   * lanes along e1 = dir inside an e1-aligned box (length along e1, side width, height), each lane
   * wrapping over the box length, with a small sinusoidal wander.  def: {name, center3, size3, dir3,
   * count, species, speed:[min,max], wanderDeg}.
   *
   * WHY (QA2 round 2): the web replaced these slabs by ambient boxes around the camera (needed for
   * free roaming), at ~5 fish/m^3 everywhere; the final packs its hero river into these slabs at
   * 20-40 fish/m^3 right in front of CAM_Main.  Measured as the share of the poster frame covered
   * by fish (pixels differing from the fish-free plate): final 73 % (mid band 92 %), web 48 % (60 %).
   * Putting the slabs back, world-fixed where the final has them, gives the opening view the
   * final's wall, and a real dense school you can swim into; the ambient boxes keep every other
   * direction full.  Analytic motion: ~10k fish for a fraction of the steering cost.
   *
   * Free-camera adaptations: (1) the box ends were placed off the 2:3 poster frame but a 16:9 view
   * sees them, so each fish disappears at its own random distance within the last ~30 % (max
   * 2.5 m) of its lane — the school thins out toward its ends like a real school's edge instead of
   * all fish shrinking at one plane; (2) lanes that would pass through a rock (+ body + wander) or
   * dip into the sand are re-rolled at spawn (Blender bends them with a lateral push instead; a
   * re-roll is exact and costs nothing per frame); (3) they part around the camera and the giants
   * (compose()).
   */
  addStream(def) {
    const e1 = norm3(def.dir);
    const e2 = norm3([e1[2], 0, -e1[0]]);                 // horizontal side: up x e1
    const e3 = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const si = (this.streams ||= []).push({ name: def.name, e1, e2, e3 }) - 1;
    const sE = new Float32Array((si + 1) * 9);
    if (this.sE) sE.set(this.sE.subarray(0, si * 9));
    sE.set([...e1, ...e2, ...e3], si * 9);
    this.sE = sE;
    const [Ls, W, H] = def.size;
    const c = def.center;
    const taper = Math.min(0.3 * Ls, 2.5);
    const tw = Math.tan(THREE.MathUtils.degToRad(def.wanderDeg ?? 12));
    let made = 0;
    for (let n = 0; n < def.count; n++) {
      const [id, , range] = this.pickWeighted(def.species);
      const L = this.lenFor(id, range);
      const v = def.speed[0] + (def.speed[1] - def.speed[0]) * this.rng();
      const w = 0.5 + 1.3 * this.rng();
      const Aw = Math.min(0.38, tw * v / w), Av = 0.45 * Aw;
      let bx = 0, by = 0, bz = 0, ok = false;
      for (let tries = 0; tries < 25 && !ok; tries++) {
        const lat = (this.rng() - 0.5) * W, ht = (this.rng() - 0.5) * H;
        bx = c[0] + e2[0] * lat + e3[0] * ht; by = c[1] + e2[1] * lat + e3[1] * ht; bz = c[2] + e2[2] * lat + e3[2] * ht;
        ok = true;
        const pad = 0.5 * L + Aw + 0.05;
        for (let u = -Ls / 2; u <= Ls / 2 && ok; u += 0.2) {
          const x = bx + e1[0] * u, y = by + e1[1] * u, z = bz + e1[2] * u;
          if (y - Av < this.sand.at(x, z) + 0.12 + 0.3 * L || this.insideKeepout(x, y, z, pad)) ok = false;
        }
      }
      if (!ok) continue;
      const i = this.add(id, KIND.STREAM, L, bx, by, bz);
      if (i < 0) break;
      made++;
      this.grp[i] = si;
      this.spd[i] = v;
      this.pa.set([bx, by, bz, (this.rng() - 0.5) * Ls, Ls, v, taper * this.rng(), Av], i * 8);
      this.wan.set([Aw, w, this.rng() * 6.2832, this.rng() * 6.2832], i * 4);
      this.vx[i] = e1[0] * v; this.vy[i] = e1[1] * v; this.vz[i] = e1[2] * v;
      this.hx[i] = e1[0]; this.hy[i] = e1[1]; this.hz[i] = e1[2];
    }
    return made;
  }

  /** an elliptical loop: {center3, rx, rz, yAmp, speed, theta0, dir(+-1), onSand} */
  addPath(id, L, def) {
    const i = this.add(id, KIND.PATH, L, def.center[0], def.center[1], def.center[2]);
    if (i < 0) return i;
    const Ravg = (def.rx + def.rz) / 2;
    this.spd[i] = def.speed;
    this.pa.set([def.center[0], def.center[1], def.center[2], def.rx, def.rz, def.theta0 ?? 0,
      (def.dir ?? 1) * def.speed / Ravg, def.yAmp ?? 0], i * 8);
    this.vsign[i] = def.onSand ? -1 : 1;
    // big cruisers become obstacles the ambient schools part around (update()): a capsule along the
    // body (half length 0.42 L) with a radius from the body's real cross-section in species.json
    // (hammerhead ~0.1 L thick, eagle ray ~1.1 L wide); 0.1 m of margin.
    if (L > 1.0 && !def.onSand) {
      const bb = this.byId[id].spec.bbox_three;
      const half = bb ? Math.max(bb.max[1] - bb.min[1], bb.max[2] - bb.min[2]) / 2 : 0.15;
      (this.giants ||= []).push(i);
      (this.giantR ||= []).push(half * L + 0.1);
      (this.giantHL ||= []).push(0.42 * L);
    }
    return i;
  }

  /** slow wandering loop around an anchor: {anchor3, amp3, w, swim?}.  See update() for the motion.
   *  swim: optional composition fishswim record (see swimAs), e.g. the final's hovering John Dory. */
  addHover(id, L, def) {
    const i = this.add(id, KIND.HOVER, L, ...def.anchor);
    if (i < 0) return i;
    this.pa.set([...def.anchor, ...def.amp, def.w, this.rng() * 100], i * 8);
    this.spd[i] = def.w * Math.hypot(def.amp[0], def.amp[2]) * 0.7;
    this.vsign[i] = this.rng() < 0.5 ? 1 : -1;      // which way round the loop (unused otherwise)
    if (def.swim) this.swimAs(i, def.swim);
    return i;
  }

  addStatic(id, L, pos, quat, swim = null) {
    const i = this.add(id, KIND.STATIC, L, ...pos);
    if (i < 0) return i;
    this.quat.set(quat, i * 4);
    if (swim) this.swimAs(i, swim);
    return i;
  }

  /**
   * Give fish i the FishSwim amplitude and tempo of a role in scenes/final (a composition `fishswim`
   * record: Amplitude, Cycles per 240-frame / 10 s loop) instead of its species' cruising swim.
   *
   * (2026-10-05 web sync) WHY: the swim STYLE is a compile-time define of the species material, but the
   * recomposed final gives placed fish of swimming species a resting / hovering swim: the yellowbarred
   * rockfish lie on rocks as benthic_rest (amplitude 0.008), the John Dory and the filefish hover as
   * hover_drift (0.012).  As plain statics they kept the species' carangiform 0.06-0.08 tail sweep and a
   * speed-driven tempo, i.e. a fish lying on a rock wagging its whole tail.  At these amplitudes the
   * three style shapes differ by under 1 % of a body length, so scaling the per-instance amplitude to
   * the role's and taking its tempo is what is visible.  A second material per role would be exact but
   * would add a draw call and a shader variant per species for a sub-millimetre difference.
   */
  swimAs(i, fs) {
    const s = this.species[this.sp[i]];
    if (!fs || !(s.swim.amp > 0)) return;
    this.amp[i] = (fs.Amplitude / s.swim.amp) * (0.92 + 0.16 * this.rng());
    this.stride[i] = 0;                               // tempo = the role's own, not speed-driven
    this.baseHz[i] = (Math.max(1, fs.Cycles) / 10) * (0.85 + 0.3 * this.rng());
  }

  insideKeepout(x, y, z, pad) {
    for (const k of this.keepouts) {
      if (y < k.y0 - pad || y > k.y0 + k.h + pad) continue;
      if (Math.hypot(x - k.x, z - k.z) < k.r + pad) return true;
    }
    return false;
  }

  // ---------- render buckets ----------
  buildMeshes(scene) {
    const counts = new Array(this.species.length).fill(0);
    for (let i = 0; i < this.N; i++) counts[this.sp[i]]++;
    this.meshes = [];
    for (const s of this.species) {
      const n = counts[s.k];
      const pair = [];       // per LOD: 0 near, 1 far, 2 tiny, 3 micro (null when absent)
      for (const [lod, geo] of [[0, s.geoNear], [1, s.geoFar], [2, s.geoTiny], [3, s.geoMicro]]) {
        if (!n || !geo) { pair.push(null); continue; }
        const capN = lod === 0 ? Math.min(n, 1500) : n;     // near is only ever a few hundred
        const g = geo;
        g.setAttribute('aSwim', new THREE.InstancedBufferAttribute(new Float32Array(capN * 4), 4).setUsage(THREE.DynamicDrawUsage));
        g.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(capN * 4), 4).setUsage(THREE.DynamicDrawUsage));
        const m = new THREE.InstancedMesh(g, s.mat, capN);
        m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        m.frustumCulled = false;       // culled per instance on the CPU below
        m.count = 0;
        m.name = `FISH_${s.id}_${['near', 'far', 'tiny', 'micro'][lod]}`;
        // draw order for early-z: near fish, far fish, rocks, sand, then the background (main.js)
        m.renderOrder = lod ? 2 : 1;
        // te/sw/tn cached: writeInstance runs for every drawn fish (16k+ per frame with the streams)
        // and the property chains m.instanceMatrix.array / m.geometry.attributes.X.array cost
        // measurable CPU there (QA2 round 2)
        m.userData = { cap: capN, cursor: 0, te: m.instanceMatrix.array, sw: g.attributes.aSwim.array, tn: g.attributes.aTint.array };
        scene.add(m);
        pair.push(m);
      }
      this.meshes.push(pair);
    }
  }

  // ---------- per frame ----------
  update(t, dt, camera, viewportH) {
    dt = Math.max(0, Math.min(dt, 1 / 20));
    const cam = camera.position;
    const cx = cam.x, cy = cam.y, cz = cam.z;
    this.qCur += (this.quality - this.qCur) * Math.min(1, dt * 1.5);
    const N = this.N;
    const { px, py, pz, vx, vy, vz, len, spd, kind, pa, wan, grp } = this;
    const kos = this.keepouts;
    const nko = kos.length;
    const camR = this.camAvoid;
    const sand = this.sand;
    const steer = 1 - Math.exp(-dt * 2.2);
    // giants as obstacles for the ambient schools: per giant 12 floats = centre(3), heading(3),
    // capsule radius, half length, speed, reject distance^2 (incl. the largest fish's half length)
    const giants = this.giants || (this.giants = []), nGi = Math.min(giants.length, 30);
    const G = (this._G ||= new Float32Array(30 * 12));
    for (let gI = 0; gI < nGi; gI++) {
      const a = giants[gI], o = gI * 12;
      const gs = Math.hypot(vx[a], vy[a], vz[a]) || 1;
      G[o] = px[a]; G[o + 1] = py[a]; G[o + 2] = pz[a];
      G[o + 3] = vx[a] / gs; G[o + 4] = vy[a] / gs; G[o + 5] = vz[a] / gs;
      G[o + 6] = this.giantR[gI]; G[o + 7] = this.giantHL[gI]; G[o + 8] = gs;
      const reach = this.giantHL[gI] + this.giantR[gI] + 0.4 + 1.0;
      G[o + 9] = reach * reach;
    }

    const sE = this.sE || (this.sE = new Float32Array(9)), qCur = this.qCur, rank = this.rank, fadeA = this.fade;
    for (let i = 0; i < N; i++) {
      const k = kind[i];
      if (k === KIND.AMBIENT) {
        const lay = this.layers[grp[i]];
        const qf = Math.min(1, Math.max(0, (this.qCur - this.rank[i]) / 0.03));
        if (qf <= 0) {
          // (QA2) thinned out by the adaptive quality: not drawn, so only drift and wrap — no rock
          // steering, no parting.  WHY: this way lowering quality also lowers the CPU cost (it used
          // to save GPU only; 20k+ fish were fully steered every frame whatever was shown).  When the
          // fish comes back it grows in from size 0 over 0.03 of rank, and the full path below
          // (including the 'never inside a rock' projection) runs before its first visible frame.
          px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
          const h = lay.half;
          const rx = px[i] - cx, rz = pz[i] - cz;
          if (rx > h) px[i] -= 2 * h; else if (rx < -h) px[i] += 2 * h;
          if (rz > h) pz[i] -= 2 * h; else if (rz < -h) pz[i] += 2 * h;
          // stay inside the height band (nothing springs it back while thinned: minutes at low
          // quality would otherwise let it sink into the sand and reappear there)
          const yl = Math.max(lay.y[0], sand.at(px[i], pz[i]) + 0.15 + 0.3 * len[i]);
          if (py[i] < yl) py[i] = yl; else if (py[i] > lay.y[1]) py[i] = lay.y[1];
          this.fade[i] = 0;
          continue;
        }
        const s = spd[i], L = len[i], i8 = i * 8, i4 = i * 4;
        const fx = pa[i8], fy = pa[i8 + 1] * this.vsign[i], fz = pa[i8 + 2];
        // wander: sideways (horizontal, perpendicular to the flow) and vertical, as velocity
        const ws = Math.sin(t * wan[i4] + wan[i4 + 1]) * 0.28;
        const wv = Math.sin(t * wan[i4 + 2] + wan[i4 + 3]) * 0.12;
        const sl = Math.hypot(fx, fz) || 1;
        let dx = (fx - (fz / sl) * ws) * s;
        let dy = (fy + wv) * s;
        let dz = (fz + (fx / sl) * ws) * s;
        // stay in the layer's height band: flip this fish's vertical drift at the band edges and
        // spring back softly (no wrap in y = no pop near the sand or the surface layers)
        const y = py[i];
        const y0 = Math.max(lay.y[0], sand.at(px[i], pz[i]) + 0.15 + 0.3 * L);
        if (y < y0) { dy += (y0 - y) * 1.5; if (this.vsign[i] * pa[i8 + 1] < 0) this.vsign[i] = -this.vsign[i]; }
        else if (y > lay.y[1]) { dy -= (y - lay.y[1]) * 1.5; if (this.vsign[i] * pa[i8 + 1] > 0) this.vsign[i] = -this.vsign[i]; }
        // KEEPOUT cylinders: cancel the inward part of the wish and slide round on the side the fish
        // is already heading for (no left/right dithering -> no snapping heading)
        for (let c = 0; c < nko; c++) {
          const ko = kos[c];
          if (y < ko.y0 - L || y > ko.y0 + ko.h + L) continue;
          const ox = px[i] - ko.x, oz = pz[i] - ko.z;
          const R = ko.r + 0.55 * L;
          const Rinf = R + 0.8 + 1.2 * s;
          const r2 = ox * ox + oz * oz;
          if (r2 > Rinf * Rinf) continue;
          const r = Math.sqrt(r2) || 1e-4, nx = ox / r, nz = oz / r;
          let w = Math.min(1, Math.max(0, (Rinf - r) / (Rinf - R)));
          w = w * w * (3 - 2 * w);
          // over the top of a rock: lift instead of swerving (a fish crossing above the pillar must
          // not dip its belly into the stone)
          const top = ko.y0 + ko.h;
          if (r < R && y > top - 0.35) { dy += (top + 0.6 * L - y) * 3.0 * w; continue; }
          const vn = dx * nx + dz * nz;
          if (vn < 0) { dx -= nx * vn * w; dz -= nz * vn * w; }
          let tx = -nz, tz = nx;
          if (tx * vx[i] + tz * vz[i] < 0) { tx = -tx; tz = -tz; }
          dx += (tx * 0.7 + nx * 0.5) * s * w;
          dz += (tz * 0.7 + nz * 0.5) * s * w;
        }
        // part around the camera
        const ax = px[i] - cx, ay = py[i] - cy, az = pz[i] - cz;
        const ad2 = ax * ax + ay * ay + az * az, AR = camR + L;
        if (ad2 < AR * AR) {
          const ad = Math.sqrt(ad2) || 1e-4, push = (AR - ad) / AR * 2.4;
          dx += (ax / ad) * push; dy += (ay / ad) * push * 0.6; dz += (az / ad) * push;
        }
        // (QA2) part around the giants (hammerheads, eagle rays): a capsule along each giant's body,
        // using its previous-frame position/velocity (G, filled before this loop; the giants
        // themselves are updated later in it).  WHY: the giants' loops run through the schools and
        // nothing kept fish out of them — up close a shark swam through saury and stripey that showed
        // inside its body.  Schools parting around a passing predator is also what makes a close
        // pass read as alive.  (Per-frame typed data + one distance reject per giant: the first,
        // property-reading version cost 1.3 ms of CPU per frame for 28k fish x 5 giants.)
        let gNear = 0;
        for (let gI = 0, o = 0; gI < nGi; gI++, o += 12) {
          const rx0 = px[i] - G[o], ry0 = py[i] - G[o + 1], rz0 = pz[i] - G[o + 2];
          if (rx0 * rx0 + ry0 * ry0 + rz0 * rz0 > G[o + 9]) continue;
          gNear |= 1 << gI;
          const ux = G[o + 3], uy = G[o + 4], uz = G[o + 5], gl = G[o + 7], gR = G[o + 6] + 0.5 * L;
          const tt = Math.max(-gl, Math.min(gl, rx0 * ux + ry0 * uy + rz0 * uz));
          const qx = rx0 - ux * tt, qy = ry0 - uy * tt, qz = rz0 - uz * tt;
          const qd = Math.sqrt(qx * qx + qy * qy + qz * qz) || 1e-4;
          const Rin = gR + 1.0;
          if (qd >= Rin) continue;
          let w = Math.min(1, (Rin - qd) / (Rin - gR)); w = w * w * (3 - 2 * w);
          const push = w * (G[o + 8] + s) * 1.6;
          dx += (qx / qd) * push; dy += (qy / qd) * push * 0.7; dz += (qz / qd) * push;
        }
        vx[i] += (dx - vx[i]) * steer; vy[i] += (dy - vy[i]) * steer; vz[i] += (dz - vz[i]) * steer;
        px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;
        // ...and never inside one: project out of the capsule (steering normally keeps them clear;
        // this catches a fish the giant overtakes head-on)
        if (gNear) {
          for (let gI = 0, o = 0; gI < nGi; gI++, o += 12) {
            if (!(gNear & (1 << gI))) continue;
            const ux = G[o + 3], uy = G[o + 4], uz = G[o + 5], gl = G[o + 7], gR = G[o + 6] + 0.4 * L;
            const rx0 = px[i] - G[o], ry0 = py[i] - G[o + 1], rz0 = pz[i] - G[o + 2];
            const tt = Math.max(-gl, Math.min(gl, rx0 * ux + ry0 * uy + rz0 * uz));
            const qx = rx0 - ux * tt, qy = ry0 - uy * tt, qz = rz0 - uz * tt;
            const qd = Math.sqrt(qx * qx + qy * qy + qz * qz) || 1e-4;
            if (qd < gR) { const f = gR / qd; px[i] = G[o] + ux * tt + qx * f; py[i] = G[o + 1] + uy * tt + qy * f; pz[i] = G[o + 2] + uz * tt + qz * f; }
          }
        }
        // toroidal wrap around the camera + size fade over the last 1.5 m before the edge
        const h = lay.half;
        let rx = px[i] - cx, rz = pz[i] - cz;
        if (rx > h) { px[i] -= 2 * h; rx -= 2 * h; } else if (rx < -h) { px[i] += 2 * h; rx += 2 * h; }
        if (rz > h) { pz[i] -= 2 * h; rz -= 2 * h; } else if (rz < -h) { pz[i] += 2 * h; rz += 2 * h; }
        // hard guarantee: never inside a rock (radial projection; normally the steering already
        // keeps fish outside, this catches fast fish after a long frame and fish that just WRAPPED
        // into a boulder, which is why it runs after the wrap: web_sim_test.json found 3 such
        // samples up to 1.7 m deep when it ran before)
        for (let c = 0; c < nko; c++) {
          const ko = kos[c];
          const top = ko.y0 + ko.h;
          if (py[i] < ko.y0 || py[i] > top + 0.25 * L) continue;
          const ox = px[i] - ko.x, oz = pz[i] - ko.z, R = ko.r + 0.4 * L;
          const r2 = ox * ox + oz * oz;
          if (r2 >= R * R) continue;
          const r = Math.sqrt(r2) || 1e-4;
          // leave by the shorter way: up over the top, or radially out
          if (top + 0.25 * L - py[i] < R - r) { py[i] = top + 0.25 * L; if (vy[i] < 0) vy[i] = 0; }
          else { px[i] = ko.x + ox / r * R; pz[i] = ko.z + oz / r * R; }
        }
        const ex = Math.min(1, (h - Math.abs(rx)) / 1.5), ez = Math.min(1, (h - Math.abs(rz)) / 1.5);
        this.fade[i] = Math.max(0, ex) * Math.max(0, ez) * qf;
      } else if (k === KIND.STREAM) {
        // lane position wrapped into [-Ls/2, Ls/2) + wander across (e2) and up (e3); see addStream
        const i8 = i * 8, i4 = i * 4, e = grp[i] * 9;     // sE: e1, e2, e3 of each stream (typed)
        const Ls = pa[i8 + 4], v = pa[i8 + 5];
        let u = pa[i8 + 3] + v * t;
        u -= Ls * Math.floor(u / Ls + 0.5);
        const Aw = wan[i4], w = wan[i4 + 1], Av = pa[i8 + 7];
        const a1 = w * t + wan[i4 + 2], a2 = 0.73 * w * t + wan[i4 + 3];
        const s1 = Aw * Math.sin(a1), c1 = Aw * w * Math.cos(a1), s2 = Av * Math.sin(a2), c2 = Av * 0.73 * w * Math.cos(a2);
        px[i] = pa[i8] + sE[e] * u + sE[e + 3] * s1 + sE[e + 6] * s2;
        py[i] = pa[i8 + 1] + sE[e + 1] * u + sE[e + 4] * s1 + sE[e + 7] * s2;
        pz[i] = pa[i8 + 2] + sE[e + 2] * u + sE[e + 5] * s1 + sE[e + 8] * s2;
        vx[i] = sE[e] * v + sE[e + 3] * c1 + sE[e + 6] * c2;
        vy[i] = sE[e + 1] * v + sE[e + 4] * c1 + sE[e + 7] * c2;
        vz[i] = sE[e + 2] * v + sE[e + 5] * c1 + sE[e + 8] * c2;
        // thin out toward the ends (each fish at its own distance, pa[6]) + adaptive quality
        const fe = Math.min(1, Math.max(0, (Ls / 2 - Math.abs(u) - pa[i8 + 6]) / 0.6));
        const qf = Math.min(1, Math.max(0, (qCur - rank[i]) / 0.03));
        fadeA[i] = fe * fe * (3 - 2 * fe) * qf;
      } else if (k === KIND.VORTEX) {
        const i8 = i * 8;
        const th = pa[i8 + 4] + pa[i8 + 5] * t, r = pa[i8 + 3];
        const bob = pa[i8 + 6] * Math.sin(t * 0.21 + pa[i8 + 7]);
        const c = Math.cos(th), sn = Math.sin(th);
        px[i] = pa[i8] + r * c; pz[i] = pa[i8 + 2] + r * sn; py[i] = pa[i8 + 1] + bob;
        const w = pa[i8 + 5];
        vx[i] = -r * sn * w; vz[i] = r * c * w; vy[i] = pa[i8 + 6] * 0.21 * Math.cos(t * 0.21 + pa[i8 + 7]);
        this.fade[i] = Math.min(1, Math.max(0, (this.qCur - this.rank[i] * 0.7) / 0.03));
      } else if (k === KIND.PATH) {
        const i8 = i * 8;
        const th = pa[i8 + 5] + pa[i8 + 6] * t;
        const c = Math.cos(th), sn = Math.sin(th), w = pa[i8 + 6];
        px[i] = pa[i8] + pa[i8 + 3] * c; pz[i] = pa[i8 + 2] + pa[i8 + 4] * sn;
        vx[i] = -pa[i8 + 3] * sn * w; vz[i] = pa[i8 + 4] * c * w;
        if (this.vsign[i] < 0) {          // on the sand: follow the dunes
          const S = this.byId[this.species[this.sp[i]].id];
          const yNew = sand.at(px[i], pz[i]) - S.spec.bbox_three.min[1] * len[i] * 0.85;
          vy[i] = dt > 0 ? (yNew - py[i]) / dt * 0.0 : 0;
          py[i] = yNew;
        } else {
          py[i] = pa[i8 + 1] + pa[i8 + 7] * Math.sin(2 * th + 1.3);
          vy[i] = pa[i8 + 7] * 2 * w * Math.cos(2 * th + 1.3);
        }
        this.fade[i] = 1;
      } else if (k === KIND.HOVER) {
        // A slow, wobbly loop round the anchor, always the same way round (vsign), with a gentle
        // bob.  WHY not the former Lissajous wander: its velocity REVERSES at every loop end, and a
        // heading smoothed enough not to spin in a frame lags the reversal, so the fish swam
        // backwards / sideways for seconds (QA: pinecone fish and pipefish up to 150 deg between
        // heading and travel).  On a loop the velocity never passes through zero, so the fish can
        // face exactly where it goes.  The radius stays <= amp, inside the circle of amp*1.45 + L/2
        // that populate() checked clear of every rock.
        const i8 = i * 8, w = pa[i8 + 6], ph = pa[i8 + 7], sg = this.vsign[i];
        const th = ph + sg * w * t;
        const wr = w * 0.37, rm = 0.8 + 0.2 * Math.sin(wr * t + ph * 1.7), drm = 0.2 * wr * Math.cos(wr * t + ph * 1.7);
        const c = Math.cos(th), sn = Math.sin(th);
        const a2 = t * w * 0.71 + ph * 1.3;
        px[i] = pa[i8] + pa[i8 + 3] * rm * c;
        pz[i] = pa[i8 + 2] + pa[i8 + 5] * rm * sn;
        py[i] = pa[i8 + 1] + pa[i8 + 4] * Math.sin(a2);
        vx[i] = pa[i8 + 3] * (drm * c - rm * sn * sg * w);
        vz[i] = pa[i8 + 5] * (drm * sn + rm * c * sg * w);
        vy[i] = pa[i8 + 4] * w * 0.71 * Math.cos(a2);
        // face the velocity, with the bob only a third as steep: hoverers barely pitch
        const hl = Math.hypot(vx[i], vy[i] * 0.33, vz[i]) || 1;
        this.hx[i] = vx[i] / hl; this.hy[i] = vy[i] * 0.33 / hl; this.hz[i] = vz[i] / hl;
        this.fade[i] = 1;
      } else {
        this.fade[i] = 1;
      }
    }
    this.compose(t, dt, camera, viewportH);
  }

  compose(t, dt, camera, viewportH) {
    this.frameNo++;
    const cam = camera.position, cx = cam.x, cy = cam.y, cz = cam.z;
    camera.updateMatrixWorld();
    const pm = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const fr = (this._fr ||= new THREE.Frustum()).setFromProjectionMatrix(pm);
    const P = (this._planes ||= new Float32Array(24));
    fr.planes.forEach((p, j) => { P[j * 4] = p.normal.x; P[j * 4 + 1] = p.normal.y; P[j * 4 + 2] = p.normal.z; P[j * 4 + 3] = p.constant; });
    const focal = (viewportH / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const nearPx = this.nearPx, tinyPx = this.tinyPx, microPx = this.microPx;
    for (const pair of this.meshes) for (const m of pair) if (m) m.userData.cursor = 0;
    const { px, py, pz, vx, vy, vz, len, kind, sp, beat, fade, lod } = this;
    let near = 0, far = 0, tiny = 0, micro = 0, culled = 0;
    const camR = this.camAvoid;
    const cv = this.camVel, cvx = cv ? cv.x : 0, cvy = cv ? cv.y : 0, cvz = cv ? cv.z : 0;   // swimmer velocity (main.js)
    const kos = this.keepouts, nko = kos.length;
    // giants at their CURRENT positions (update() steers ambient fish with last frame's, G), same
    // 12-float layout; for the stream-fish parting below
    const giants = this.giants || [], nGi = Math.min(giants.length, 30);
    const G2 = (this._G2 ||= new Float32Array(30 * 12)), gSide = this.gSide;
    for (let gI = 0; gI < nGi; gI++) {
      const a = giants[gI], o = gI * 12;
      const gs = Math.hypot(vx[a], vy[a], vz[a]) || 1;
      G2[o] = px[a]; G2[o + 1] = py[a]; G2[o + 2] = pz[a];
      G2[o + 3] = vx[a] / gs; G2[o + 4] = vy[a] / gs; G2[o + 5] = vz[a] / gs;
      G2[o + 6] = this.giantR[gI]; G2[o + 7] = this.giantHL[gI];
    }
    // Visible fish are written front-to-back (counting sort into distance buckets).  WHY: the fish
    // are fill-bound, not vertex-bound (GPU timer: 720p costs ~1/4 of 1440p), and dense schools
    // overlap many times; near-first lets early-z reject the hidden fragments behind them.
    const NB = 24;
    const vis = (this._vis ||= new Int32Array(this.cap)), vb = (this._vb ||= new Uint8Array(this.cap));
    const vxp = (this._vxp ||= new Float32Array(this.cap * 3));
    const bc = (this._bc ||= new Int32Array(NB + 1));
    bc.fill(0);
    let nv = 0;
    for (let i = 0, N = this.N; i < N; i++) {
      const k = kind[i];
      const L = len[i];
      // tail-beat clock (always advanced, visible or not, so it never jumps)
      const vmag = Math.hypot(vx[i], vy[i], vz[i]);
      const st = this.stride[i];
      let hz0 = st > 0 ? vmag / (L * st) : this.baseHz[i];
      if (st > 0) hz0 = Math.min(Math.max(hz0, this.baseHz[i] * 0.35), 9);
      let b = beat[i] + hz0 * dt; b -= Math.floor(b); beat[i] = b;
      const f = fade[i];
      // (a hidden stream fish forgets the giant it was parting around: when it comes back it may be
      // somewhere else in that giant's reach, and the old side would snap it across)
      if (f <= 0.002) { if (k === KIND.STREAM) this.gIdx[i] = -1; culled++; continue; }
      let x = px[i], y = py[i], z = pz[i];
      // Stream fish part around the giants (hammerheads, eagle rays): the near hammerhead's loop
      // runs straight through the stripey river.  Ambient fish steer around giants (update());
      // stream fish are analytic, so the DRAWN position is displaced instead, Blender-style
      // (swarm.py KEEPOUT push): the offset eta along a side direction becomes sqrt(eta^2 + R^2 W),
      // W = 1 along the body, fading to 0 beyond its ends and toward the outer radius Ro.
      // WHY a side chosen once on entry and kept (per-fish state gIdx/gSide): any memoryless
      // direction (radial from the axis, or one with a fixed per-fish bias) has a singular point
      // where it flips, i.e. a fish whose lane the shark's axis sweeps across would jump ~2R
      // (~1 m) in one frame.  Entering at Ro the direction is well defined and the push is 0, and
      // with the side fixed, sqrt() is continuous even if the lane point crosses the axis.
      if (k === KIND.STREAM && nGi) {
        const gi0 = this.gIdx[i], i3 = i * 3;
        let dx = 0, dy = 0, dz = 0;
        for (let gI = 0, o = 0; gI < nGi; gI++, o += 12) {
          if (gi0 >= 0 && gi0 !== gI) continue;          // parting around one giant at a time
          const R = G2[o + 6] + 0.5 * L + 0.15, Ro = 2.2 * R, gl = G2[o + 7];
          const rx0 = x - G2[o], ry0 = y - G2[o + 1], rz0 = z - G2[o + 2];
          const ux = G2[o + 3], uy = G2[o + 4], uz = G2[o + 5];
          const ta = rx0 * ux + ry0 * uy + rz0 * uz;
          const qx = rx0 - ux * ta, qy = ry0 - uy * ta, qz = rz0 - uz * ta;
          const qd = Math.sqrt(qx * qx + qy * qy + qz * qz);
          if (Math.abs(ta) > gl + Ro || qd > Ro) { if (gi0 === gI) this.gIdx[i] = -1; continue; }
          // the side is stored as an ANGLE in the giant's own cross-section frame (n1 = world up
          // made perpendicular to the body axis, n2 = axis x n1), so it turns with the giant.
          // (A stored world vector re-orthogonalised each frame went degenerate as the shark yawed
          // through its loop's turns: a horizontal side ends up along the axis and flips.)
          let n1x = -uy * ux, n1y = 1 - uy * uy, n1z = -uy * uz;
          const nl = Math.sqrt(n1x * n1x + n1y * n1y + n1z * n1z) || 1e-4;
          n1x /= nl; n1y /= nl; n1z /= nl;
          const n2x = uy * n1z - uz * n1y, n2y = uz * n1x - ux * n1z, n2z = ux * n1y - uy * n1x;
          if (gi0 !== gI) {
            this.gIdx[i] = gI;
            gSide[i3] = Math.atan2(qx * n2x + qy * n2y + qz * n2z, qx * n1x + qy * n1y + qz * n1z);
          }
          const ph = gSide[i3], cph = Math.cos(ph), sph = Math.sin(ph);
          const sx = cph * n1x + sph * n2x, sy = cph * n1y + sph * n2y, sz = cph * n1z + sph * n2z;
          const eta = qx * sx + qy * sy + qz * sz;
          let a = (Math.abs(ta) - gl) / R; a = a <= 0 ? 0 : a >= 1 ? 1 : a * a * (3 - 2 * a);
          let b = (qd - 1.2 * R) / (Ro - 1.2 * R); b = b <= 0 ? 0 : b >= 1 ? 1 : b * b * (3 - 2 * b);
          // On the chosen side sqrt(eta^2 + R^2 W).  On the other side (the lane point has crossed
          // the axis while parted) 2 eta (1 - W) + sqrt(eta^2 + R^2 W): equal to the first at
          // eta = 0 (no step when the lane point crosses the axis), sqrt(eta^2 + R^2) at W = 1, and
          // back to eta (not |eta|) as W -> 0.  WHY: with sqrt() alone a fish that had crossed over
          // was still drawn on the chosen side when W reached 0 at release, and jumped 2|eta| (up to
          // 2.2 m) to its real side in one frame.  This is Blender's swarm.py form with W in place
          // of sqrt(W) (whose infinite slope at W = 0 is fine for a static lane shape, a snap in
          // time here); a first try, eta + W (sqrt(...) - eta), stepped by up to 0.16 m when eta
          // changed sign at intermediate W.
          const Wt = (1 - a) * (1 - b), sq = Math.sqrt(eta * eta + R * R * Wt);
          const de = (eta >= 0 ? sq : 2 * eta * (1 - Wt) + sq) - eta;
          dx = sx * de; dy = sy * de; dz = sz * de;
          break;
        }
        if (dx || dy || dz) {
          x += dx; y += dy; z += dz;
          // rock beats giant (as for the camera).  Out by the SHORTER way, over the top of a stack
          // or sideways.  WHY: the near hammerhead passes 0.7 m over the pillar top and pushes the
          // fish below it DOWN into the stone; projecting them sideways (radially) moved them up to
          // 0.57 m in one frame round the pillar (QA2 round 2, 48 pops > 0.1 m/frame in 17 s).
          for (let c = 0; c < nko; c++) {
            const ko = kos[c], top = ko.y0 + ko.h;
            if (y < ko.y0 || y > top + 0.3 * L) continue;
            const ox = x - ko.x, oz = z - ko.z, R = ko.r + 0.3 * L, r2 = ox * ox + oz * oz;
            if (r2 < R * R) {
              const r = Math.sqrt(r2) || 1e-4;
              if (ko.stackTop && top + 0.3 * L - y < R - r) y = top + 0.3 * L;
              else { x = ko.x + ox / r * R; z = ko.z + oz / r * R; }
            }
          }
        }
      }
      // displace analytic movers (vortex / loops / streams) around the swimmer; ambient fish steer instead
      if (k === KIND.VORTEX || k === KIND.PATH || k === KIND.HOVER || k === KIND.STREAM) {
        const ax = x - cx, ay = y - cy, az = z - cz, AR = camR + L;
        const d2 = ax * ax + ay * ay + az * az;
        if (d2 < AR * AR) {
          // Part SIDEWAYS to the fish's motion relative to the swimmer, sliding over the sphere of
          // radius AR.  WHY not the plain radial push (first version): its direction flips when the
          // fish passes through the camera's centre, so swimming through the bait ball made fish
          // 1.2 m away (~280 px tall) jump up to 0.88 m in one frame, orbiting round the camera
          // (QA: 25 jumps in 200 frames).  Sideways to the relative motion the side a fish passes
          // on does not change while it passes, and the push fades to zero at the sphere's front
          // and back, so the path is continuous.  Nearly at rest relative to the camera there is
          // no 'passing', so it blends back to radial (and nothing moves fast enough to flip).
          const rvx = vx[i] - cvx, rvy = vy[i] - cvy, rvz = vz[i] - cvz;
          const rv = Math.hypot(rvx, rvy, rvz);
          const d = Math.sqrt(d2) || 1e-4;
          let rx = cx + ax * AR / d, ry = cy + ay * AR / d, rz = cz + az * AR / d;   // radial result
          const wp = Math.min(1, Math.max(0, (rv - 0.03) / 0.12));
          if (wp > 0) {
            const ux = rvx / rv, uy = rvy / rv, uz = rvz / rv;
            const along = ax * ux + ay * uy + az * uz;
            let qx = ax - along * ux, qy = ay - along * uy, qz = az - along * uz;     // perpendicular part
            // a fixed per-fish side for the (measure-zero) head-on case, blended in continuously
            const g = this.phase[i] * 6.2832;
            let gx = Math.cos(g), gy = 0.35, gz = Math.sin(g);
            const gu = gx * ux + gy * uy + gz * uz; gx -= gu * ux; gy -= gu * uy; gz -= gu * uz;
            const bw = 0.05 * (1 - d / AR);            // 0 at the sphere: no step where parting starts
            qx += bw * gx; qy += bw * gy; qz += bw * gz;
            const ql = Math.hypot(qx, qy, qz) || 1e-4;
            const pd = Math.sqrt(Math.max(0, AR * AR - along * along));
            const sx = cx + along * ux + qx / ql * pd, sy = cy + along * uy + qy / ql * pd, sz = cz + along * uz + qz / ql * pd;
            rx += (sx - rx) * wp; ry += (sy - ry) * wp; rz += (sz - rz) * wp;
          }
          x = rx; y = ry; z = rz;
          // ...but never parted INTO a rock: next to the pillar the push pointed mill fish into the
          // stone (QA: drawn knifejaw centres 4.5 cm inside Pillar_02).  Rock beats camera.
          // (QA2 round 2) shorter way out, as for the giants above: a camera hovering over the
          // pillar pushes mill / stream fish down onto its top, and the radial-only projection
          // swung them round the pillar in one frame
          for (let c = 0; c < nko; c++) {
            const ko = kos[c], top = ko.y0 + ko.h;
            if (y < ko.y0 || y > top + 0.3 * L) continue;
            const ox = x - ko.x, oz = z - ko.z, R = ko.r + 0.3 * L, r2 = ox * ox + oz * oz;
            if (r2 < R * R) {
              const r = Math.sqrt(r2) || 1e-4;
              if (ko.stackTop && top + 0.3 * L - y < R - r) y = top + 0.3 * L;
              else { x = ko.x + ox / r * R; z = ko.z + oz / r * R; }
            }
          }
        }
      }
      const r = 0.62 * L * f;
      let out = false;
      for (let j = 0; j < 24; j += 4) if (P[j] * x + P[j + 1] * y + P[j + 2] * z + P[j + 3] < -r) { out = true; break; }
      if (out) { culled++; continue; }
      const dx = x - cx, dy = y - cy, dz = z - cz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-4;
      const pxl = (L * f * focal) / dist;
      if (pxl < 0.7) { culled++; continue; }
      const np = Math.min(nearPx, this.nearCap[sp[i]]);
      // finest level whose threshold the fish exceeds; a fish only coarsens once it is 15 % below
      // its current level's threshold (no flicker between meshes for a fish hovering at a boundary)
      let l = pxl > np ? 0 : pxl > tinyPx ? 1 : pxl > microPx ? 2 : 3;
      const cur = lod[i];
      if (cur < l && pxl > 0.85 * (cur === 0 ? np : cur === 1 ? tinyPx : microPx)) l = cur;
      lod[i] = l;
      const bkt = Math.min(NB - 1, Math.floor(Math.sqrt(dist) * 4.4));    // ~0..30 m, finer up close
      vis[nv] = i; vb[nv] = bkt; vxp[nv * 3] = x; vxp[nv * 3 + 1] = y; vxp[nv * 3 + 2] = z; nv++;
      this.rp[i * 3] = x; this.rp[i * 3 + 1] = y; this.rp[i * 3 + 2] = z;
      bc[bkt + 1]++;
    }
    for (let k = 0; k < NB; k++) bc[k + 1] += bc[k];
    const order = (this._order ||= new Int32Array(this.cap));
    for (let n = 0; n < nv; n++) order[bc[vb[n]]++] = n;
    for (let o2 = 0; o2 < nv; o2++) {
      const n = order[o2], i = vis[n];
      const x = vxp[n * 3], y = vxp[n * 3 + 1], z = vxp[n * 3 + 2];
      this.writeInstance(i, x, y, z, dt);
      if (lod[i] === 0) near++; else if (lod[i] === 1) far++; else if (lod[i] === 2) tiny++; else micro++;
    }
    for (const pair of this.meshes) for (const m of pair) {
      if (!m) continue;
      const n = m.userData.cursor;
      m.count = n;
      m.visible = n > 0;
      if (!n) continue;
      const im = m.instanceMatrix;
      im.clearUpdateRanges(); im.addUpdateRange(0, n * 16); im.needsUpdate = true;
      for (const a of [m.geometry.attributes.aSwim, m.geometry.attributes.aTint]) {
        a.clearUpdateRanges(); a.addUpdateRange(0, n * 4); a.needsUpdate = true;
      }
    }
    Object.assign(this.stats, { sim: this.N, drawn: near + far + tiny + micro, near, far, tiny, micro, culled });
  }

  writeInstance(i, x, y, z, dt) {
    const { vx, vy, vz, hx, hy, hz, len, kind, sp, quat, tint, beat, phase, amp, spd, fade, lod, bank } = this;
    const pair = this.meshes[sp[i]];
    // a level without a mesh (simplifier unavailable) falls back to the far LOD
    let m = pair[lod[i]] || pair[1];
    if (m === pair[1] && lod[i] > 1) lod[i] = 1;
    if (m.userData.cursor >= m.userData.cap) { m = pair[1]; lod[i] = 1; }
    const c = m.userData.cursor++;
    const L = len[i], f = fade[i], k = kind[i], b = beat[i];
    const vmag = Math.hypot(vx[i], vy[i], vz[i]);
    {
      // ---- orientation ----
      const ud = m.userData, te = ud.te, o = c * 16;
      const S = L * f;
      if (k === KIND.STATIC) {
        const q0 = quat[i * 4], q1 = quat[i * 4 + 1], q2 = quat[i * 4 + 2], q3 = quat[i * 4 + 3];
        const x2 = q0 + q0, y2 = q1 + q1, z2 = q2 + q2;
        const xx = q0 * x2, xy = q0 * y2, xz = q0 * z2, yy = q1 * y2, yz = q1 * z2, zz = q2 * z2;
        const wx = q3 * x2, wy = q3 * y2, wz = q3 * z2;
        te[o] = (1 - (yy + zz)) * S; te[o + 1] = (xy + wz) * S; te[o + 2] = (xz - wy) * S; te[o + 3] = 0;
        te[o + 4] = (xy - wz) * S; te[o + 5] = (1 - (xx + zz)) * S; te[o + 6] = (yz + wx) * S; te[o + 7] = 0;
        te[o + 8] = (xz + wy) * S; te[o + 9] = (yz - wx) * S; te[o + 10] = (1 - (xx + yy)) * S; te[o + 11] = 0;
      } else {
        // head (+X) along the velocity, pitch limited; dorsal (+Y) toward world up, banked into turns
        let X0 = vx[i], X1 = vy[i], X2 = vz[i];
        if (k === KIND.HOVER) { X0 = hx[i]; X1 = hy[i]; X2 = hz[i]; }     // smoothed in update()
        let l = Math.hypot(X0, X1, X2);
        if (l < 1e-5) { X0 = hx[i]; X1 = hy[i]; X2 = hz[i]; l = Math.hypot(X0, X1, X2) || 1; }
        X0 /= l; X1 /= l; X2 /= l;
        if (X1 > 0.6 || X1 < -0.6) {          // fish don't swim vertically: clamp pitch to ~37 deg
          const hl = Math.hypot(X0, X2) || 1e-4, sy = Math.sign(X1) * 0.6, hs = 0.8 / hl;
          X0 *= hs; X2 *= hs; X1 = sy;
        }
        // yaw rate -> bank (roll into the turn, like the Blender swarm's bank, max ~25 deg).  The
        // previous heading is only fresh if the fish was drawn last frame (culled fish skip this).
        const fresh = this.seen[i] === this.frameNo - 1;
        this.seen[i] = this.frameNo;
        const yawRate = dt > 0 && fresh ? (hz[i] * X0 - hx[i] * X2) / dt : 0;     // +: turning left (about +Y)
        bank[i] += (Math.max(-0.43, Math.min(0.43, yawRate * 0.35)) - bank[i]) * Math.min(1, dt * 4);
        hx[i] = X0; hy[i] = X1; hz[i] = X2;
        let Y0 = -X0 * X1, Y1 = 1 - X1 * X1, Y2 = -X2 * X1;
        const yl = Math.hypot(Y0, Y1, Y2) || 1; Y0 /= yl; Y1 /= yl; Y2 /= yl;
        let Z0 = X1 * Y2 - X2 * Y1, Z1 = X2 * Y0 - X0 * Y2, Z2 = X0 * Y1 - X1 * Y0;
        const cb = Math.cos(bank[i]), sb = Math.sin(bank[i]);
        const nY0 = Y0 * cb - Z0 * sb, nY1 = Y1 * cb - Z1 * sb, nY2 = Y2 * cb - Z2 * sb;
        Z0 = Z0 * cb + Y0 * sb; Z1 = Z1 * cb + Y1 * sb; Z2 = Z2 * cb + Y2 * sb;
        te[o] = X0 * S; te[o + 1] = X1 * S; te[o + 2] = X2 * S; te[o + 3] = 0;
        te[o + 4] = nY0 * S; te[o + 5] = nY1 * S; te[o + 6] = nY2 * S; te[o + 7] = 0;
        te[o + 8] = Z0 * S; te[o + 9] = Z1 * S; te[o + 10] = Z2 * S; te[o + 11] = 0;
      }
      te[o + 12] = x; te[o + 13] = y; te[o + 14] = z; te[o + 15] = 1;
      // swim + tint attributes
      const sw = ud.sw, tn = ud.tn, a4 = c * 4;
      sw[a4] = b; sw[a4 + 1] = phase[i];
      const sref = spd[i] > 0 ? spd[i] : 1;
      sw[a4 + 2] = amp[i] * (this.stride[i] > 0 ? Math.min(1.35, Math.max(0.85, 0.85 + 0.15 * vmag / sref)) : 1);
      sw[a4 + 3] = 0;
      tn[a4] = tint[i * 4]; tn[a4 + 1] = tint[i * 4 + 1]; tn[a4 + 2] = tint[i * 4 + 2]; tn[a4 + 3] = tint[i * 4 + 3];
    }
  }
}

export { KIND };
