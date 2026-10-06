// 바닷속 물고기 — interactive web version of scenes/final.
//
// URL params:  ?debug=1  arrow keys look without pointer lock + window.__fish for inspection
//              ?q=0.6    fixed fish quality (0.2..1, disables the adaptive controller)
//              ?poster=1 CAM_Main framing exactly (2:3 letterbox, vertical FOV 65.47) for comparing
//                        with the Blender renders
//              ?neon=1   start in neon colours      ?res=0.7  render-scale override
//              ?streams=0..2  composition river density (0 = off, for comparison; default 1)
//              ?seed=7   fish population seed (checks average several)
//              ?mobile=1 / ?mobile=0  force the phone controls on / off (default: detected, see MOBILE)
//              (debug: __fish.shares() = species share of the fish-covered screen, like checks/shares.py)
import * as THREE from 'three';
import { loadAll } from './loader.js';
import { buildWaterLUT, makeBackground, waterUniforms, setTopLift } from './water.js';
import { buildEnv, buildLights, keepoutsFrom, envUniforms } from './env.js';
import { makeFishMaterial, fishUniforms, setupFishLights } from './fishmat.js';
import { FishSystem } from './fish.js';
import { makeShaft, makeSnow, makeBubbles, bubbleAttrs } from './fx.js';
import { SwimControls } from './controls.js';
import { GyroLook } from './gyro.js';
import { setupTouch } from './touch.js';
import { installGrade, makeForward, neutral } from './grade.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
const POSTER = params.has('poster');
const $ = (id) => document.getElementById(id);

// (mobile 10-05) user: "핸드폰 이동하면 시점 이동되게?" — friends open the link on phones.  A touch-first device
// gets the phone mode: tilt-to-look (gyro.js), an on-screen joystick + 위로/아래로 (touch.js), a 'tap to start'
// card, and a lighter start (fewer fish, capped pixel ratio; see MOBILE_PERF).
// Detection: a coarse PRIMARY pointer (phones, tablets) or no hover + touch points, or a mobile UA.  WHY not
// just maxTouchPoints: touch-screen laptops have touch points but a mouse/trackpad as the primary pointer,
// and they must keep the desktop mouse + WASD controls.  ?mobile=1 / 0 forces it (checks, odd devices).
const MOBILE = params.has('mobile') ? params.get('mobile') !== '0'
  : (matchMedia('(pointer: coarse)').matches || (navigator.maxTouchPoints > 0 && matchMedia('(hover: none)').matches) ||
     /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent));
// Phones: weaker GPU and CPU, and they heat up and throttle after a few minutes at full tilt.
//  density 0.6: ambient shoals at 60 % (the per-frame CPU cost scales with simulated fish; a phone core is
//    ~1.5-3x slower than the M4 the desktop numbers were measured on: 9.2 ms there for 38.5k fish);
//  streams 0.8: the hero river a little thinner;  quality 0.7: start below the top, the adaptive controller
//    earns it back if the phone is fast (it never goes above the density's population);
//  dpr <= 1.5 and <= 2.0 MP: a 3x phone screen is 2.6-3.5 MP of fish fragments at native resolution, and on a
//    6-inch screen 1.5x is already sharper than the fish textures;  cap 32k: smaller per-fish arrays.
const MOBILE_PERF = { density: 0.6, streams: 0.8, quality: 0.7, dprMax: 1.5, pixelBudget: 2.0e6, cap: 32000 };
if (MOBILE) {
  document.body.classList.add('mobile');
  // iOS Safari ignores user-scalable=no; its pinch arrives as gesturestart (the start card / buttons)
  document.addEventListener('gesturestart', (e) => e.preventDefault());
}

let failed = false;
function fail(msg) {
  failed = true;
  $('loading').classList.add('error');
  $('loadMsg').textContent = msg;
  document.querySelector('#loading h1').textContent = '열 수 없어요';
  document.querySelector('#loading p').textContent = '';
}

// ---------- WebGL2 check before anything heavy ----------
const canvas = $('view');
const probe = document.createElement('canvas').getContext('webgl2');
if (!probe) {
  fail('이 브라우저에서는 WebGL2를 쓸 수 없어요. 최신 크롬·사파리·엣지에서 열어 주세요 (하드웨어 가속 켜기).');
  throw new Error('WebGL2 unavailable');
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
} catch (e) {      // WebGL2 exists but a context could not be created (GPU blocklisted, out of contexts)
  fail('그래픽 장치를 시작하지 못했어요. 다른 탭을 닫거나 브라우저를 다시 열어 주세요.');
  throw e;
}
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  const t = $('toast'); t.textContent = '그래픽이 초기화됐어요 — 새로고침해 주세요'; t.classList.add('on');
});
// (frutiger 10-05) the grade is installed AFTER composition.json has loaded (see below): it is parametrised by
// the scene's look (composition.look).  Nothing compiles a shader before that (the loader only decodes).
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.05, 400);

let assets;
try {
  assets = await loadAll('assets/', (f, label) => {
    if (failed) return;              // other loads still report after one failed: keep the error shown
    $('loadBar').style.width = (f * 100).toFixed(1) + '%';
    $('loadMsg').textContent = `${label} 불러오는 중… ${(f * 100).toFixed(0)}%`;
  });
} catch (e) {
  console.error(e);
  fail('불러오지 못했어요: ' + (e.message || e) + ' — 새로고침해 보세요.');
  throw e;
}
const { speciesJson, comp } = assets;
$('loadMsg').textContent = '장면 만드는 중…';

// composition.color: Khronos PBR Neutral at the scene's exposure (frutiger: +0.82 EV = x1.765; the aquarium
// look was +0.7 EV) — preceded by the scene's colour grade (grade.js, values from composition.look; ?grade=0
// shows the ungraded look for comparison).  Must run before any material compiles.
const gradeP = params.get('grade') === '0' ? null : installGrade(renderer, comp.look);
if (!gradeP) renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = comp.color?.three?.toneMappingExposure ?? 1.6245;
// (frutiger 10-05) the look's top multiply ('brighter toward the surface', compose setup_grade top 1.08), done
// by view ELEVATION in world space (water.js setTopLift).  Only a LIFT is applied: the aquarium look's top
// 0.84 darkening was deliberately left out of the web before (it would darken whatever you look up at), so an
// older export keeps rendering as it did.
setTopLift(comp, gradeP && gradeP.top > 1 ? gradeP.top : 1);
// (frutiger 10-05) the water LUT inverts the WHOLE display pipeline (grade + exposure + Neutral + sRGB), so
// the open water shows exactly the Blender plate's measured colours (water.js buildWaterLUT)
{
  const ex = renderer.toneMappingExposure;
  const l2s = (v) => (v < 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
  const forward = gradeP ? makeForward(gradeP, ex) : (c) => neutral(c.map((v) => Math.max(0, v) * ex)).map((v) => l2s(Math.min(1, Math.max(0, v))));
  const lutReport = buildWaterLUT(comp, ex, forward);
  if (DEBUG) window.__waterLUT = lutReport;
}
scene.add(makeBackground());
const env = buildEnv(scene, assets, comp);
const lights = buildLights(scene, comp, { sunGain: 0.55, ambient: 2.0 });
// (frutiger 10-05) returns the species of the school the look's SUN_SchoolFill is light-linked to (parrot_low)
// (frutiger 10-05) fish-only light gain 0.65 -> 0.845 (x1.3) in the frutiger look.  WHY: with the env fitted to the
// plate and the water reflection on (fishmat uFishEnv), the web poster frame was still darker than the Blender poster
// exactly where the fish are (fifths 2-4: 0.648 / 0.565 / 0.500 vs 0.701 / 0.599 / 0.524, meanL 0.628 vs 0.654):
// EEVEE's fish also receive the volume's in-scattered light, which three has no term for.  Frozen-frame A/B
// (checks/web/tmp/frutiger/lt_*.png): x1.15 -> meanL 0.641, x1.3 -> 0.650, 0 warm-fish pixels with R >= 254 in
// all (the poster: 0.08 %).  Only the fish-only lights: the scene's hemisphere light would also move the sand /
// rocks off their fit.
const FISH_LIGHT_GAIN = comp.look?.preset === 'frutiger' ? 0.845 : 0.65;
const schoolFillIds = setupFishLights(comp, FISH_LIGHT_GAIN);
const keepouts = keepoutsFrom(comp);

// ---------- camera: CAM_Main ----------
const cm = comp.camera.three;
const START = { pos: new THREE.Vector3().fromArray(cm.position), look: new THREE.Vector3().fromArray(cm.look_at), up: new THREE.Vector3().fromArray(cm.up) };
function resetView() {
  camera.position.copy(START.pos);
  camera.up.set(0, 1, 0);
  camera.lookAt(START.look);            // yaw 0, pitch +17 deg (CAM_Main has no roll)
  controls.setFromCamera();
  controls.vel.set(0, 0, 0);
}

// ---------- fish ----------
// (QA2) Two extra, coarser LODs for small fish, simplified at load from the far LOD with
// meshoptimizer (same CDN as three; ~2 ms per species).  WHY at load and not baked into assets/:
// the asset stage owns the GLBs; the simplified meshes share the far LOD's vertex buffers (only a
// new index list), so they cost no download and no extra GPU memory for vertices.  meshoptimizer
// keeps UV seams welded (no cracks).  If the module cannot load, the page runs with near/far only.
let simplifier = null;
try {
  const mo = await import('https://cdn.jsdelivr.net/npm/meshoptimizer@0.22.0/meshopt_simplifier.module.js');
  await mo.MeshoptSimplifier.ready;
  simplifier = mo.MeshoptSimplifier;
} catch (e) { console.warn('meshoptimizer unavailable: small-fish LODs off', e); }
function simplifyGeo(src, ratio, err) {
  const P = src.attributes.position;
  if (!simplifier || !src.index || P.isInterleavedBufferAttribute || !(P.array instanceof Float32Array)) return null;
  const idx = src.index.array instanceof Uint32Array ? src.index.array : new Uint32Array(src.index.array);
  const target = Math.max(60, Math.floor(idx.length * ratio / 3) * 3);
  const [dst] = simplifier.simplify(idx, P.array, 3, target, err, []);
  if (dst.length < 36) return null;
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal', 'uv']) if (src.attributes[k]) g.setAttribute(k, src.attributes[k]);
  g.setIndex(new THREE.BufferAttribute(dst, 1));
  return g;
}
for (const spec of speciesJson.species) {
  const f = assets.fish[spec.id];
  // tiny: drawn 12-36 px long; micro: under 12 px.  Error bounds are relative to the 1 m body, so
  // 1.5 % at 36 px is about half a pixel, 7 % at 12 px under one pixel.  (Micro at 4 % stopped at
  // the tiny mesh's size for most species: the error bound, not the ratio, was binding.)
  f.geoTiny = simplifyGeo(f.geoFar, 0.25, 0.015);
  f.geoMicro = simplifyGeo(f.geoFar, 0.07, 0.07);
}
const speciesList = speciesJson.species.map((spec, k) => {
  const f = assets.fish[spec.id];
  f.map.anisotropy = 4;
  // swim params: the library's per-species params, with scenes/final's re-timed amplitude where it
  // has one (it raised Cycles and scaled Amplitude x0.82-0.85 to stop 'sliding').  Cycles is not
  // used for swimmers here: tempo comes from speed.
  const fp = { ...speciesJson.fishswim.defaults[spec.swim_style], ...spec.fishswim_params };
  const fv = spec.final_scene_variants;
  const amp = fv ? fv.reduce((a, v) => a + v.Amplitude, 0) / fv.length : fp.amplitude;
  const swim = { amp, wavelength: fp.wavelength, detail: fp.detail ?? 1, bias: fp.bias ?? 0, rigid_front: fp.rigid_front ?? 0, cycles: fp.cycles };
  // (frutiger 10-05) schoolFill: the look's fill that lifts the dark-teal parrotfish band over the bright sand
  // (fishmat.js SCHOOL_FILL: only those species, only at the band's height)
  const mat = makeFishMaterial(spec, f.map, swim, { schoolFill: schoolFillIds.includes(spec.id) });
  return { id: spec.id, k, spec, swim, mat, geoNear: f.geoNear, geoFar: f.geoFar, geoTiny: f.geoTiny, geoMicro: f.geoMicro };
});
// ?seed=N: another random population (default 7).  (2026-10-05) For checks: species shares measured on
// one population swing +-2 % with where a few near fish happen to be, so tuning averages several seeds.
const fish = new FishSystem({ species: speciesList, comp, keepouts, sandHeight: env.sandHeight,
  seed: params.has('seed') ? (+params.get('seed') | 0) : 7, ...(MOBILE ? { cap: MOBILE_PERF.cap } : {}) });
if (params.has('dens')) fish.density = Math.max(0.2, Math.min(3, +params.get('dens')));
else if (MOBILE) fish.density = MOBILE_PERF.density;
populate(fish, comp, START.pos);
fish.buildMeshes(scene);

// ---------- light shafts + snow ----------
// (QA2) The final's two soft streaks (compose.py SHAFTS), placed exactly as it places them: a point
// at a screen position of the POSTER camera (CAM_Main, 2:3, 65.47 deg) at a given depth, the axis
// through it parallel to SUN_Main's rays, cut where the beam leaves the screen-y span (top, bottom).
// So the opening view shows the poster's beams at the same place, slant and length; they are world
// objects, so you can swim up to and through them.
const sunDir = new THREE.Vector3().fromArray(comp.lights.find((l) => l.name === 'SUN_Main').direction.three).normalize();
const shafts = [];
// (frutiger 10-05) web gain per unit of Blender shaft strength (emit x k).  The QA2 calibration put the
// aquarium look's main streak (strength 2.1) at gain 0.17 -> 0.081 per unit; the frutiger beams keep that
// ratio first, then SHAFT_TUNE (measured against the Blender plate, see SYSTEMS.md frutiger web section).
const SHAFT_PER_STRENGTH = 0.17 / 2.1;
// SHAFT_TUNE: measured on the fish-free poster frame (checks/web/tmp/frutiger/beam_*.png, beamsum.py: mean excess of
// the 3 strongest beam peaks over a 161-px running median, per row) with the screen blend below: x1.0 -> rows
// 0.15 / 0.25 of the frame 25.5 / 29.3 levels (Blender plate 28.7 / 27.8), cores max 253; x1.6 already clips the
// cores to 255,255,255.  The web beams fade a little sooner at both ends (row 0.06: 9.9 vs 16.1, row 0.35: 13.8
// vs 18.7); raising the gain to fix the ends would clip the middle, so 1.0.
const SHAFT_TUNE = 1.0;
// (frutiger 10-05) the frutiger look's beams sit on near-white water: screen blend (fx.js makeShaft)
const SHAFT_BLEND = comp.look?.preset === 'frutiger' ? 'screen' : 'add';
const shaftCol = comp.shafts?.color || [1.0, 0.96, 0.86];
// strength of the scene's main beam relative to the aquarium main streak: the free-camera beams follow it
const shaftScale = (comp.shafts?.beams?.find((b) => b.name === 'main')?.strength ?? 2.1) / 2.1;
if (comp.shafts?.beams?.length) {
  // (frutiger 10-05) the scene's own beams, exactly as built (compose make_shafts: main + faint + four parallel
  // aero rays along SUN_Main), from their exported axis ends.  WHY not re-derived here any more: the frutiger
  // look has six beams with their own depths / radii / strengths; the export reads them off the objects.
  for (const b of comp.shafts.beams) {
    shafts.push(makeShaft({ top: b.top.three, bottom: b.bottom.three, rc: b.rc, gain: SHAFT_PER_STRENGTH * SHAFT_TUNE * b.strength,
      color: shaftCol, seed: shafts.length, blend: SHAFT_BLEND }));
  }
}
{
  const pc = new THREE.PerspectiveCamera(comp.camera.fov_vertical_deg, 2 / 3, 0.05, 400);
  pc.position.fromArray(comp.camera.three.position);
  pc.up.set(0, 1, 0);
  pc.lookAt(new THREE.Vector3().fromArray(comp.camera.three.look_at));
  pc.updateMatrixWorld(); pc.updateProjectionMatrix();
  const ndcAt = (x, y, depth) => {              // world point at screen ndc (x, y), 'depth' m along the view axis
    const p = new THREE.Vector3(x, y, 0.5).unproject(pc).sub(pc.position);
    const fwd = pc.getWorldDirection(new THREE.Vector3());
    return pc.position.clone().addScaledVector(p, depth / p.dot(fwd));
  };
  const ndcY = (p) => p.clone().project(pc).y;
  // name, ndc of the beam's middle, depth (m), screen-y span (top, bottom), core radius (m), strength
  // (an older export without composition.shafts: the aquarium look's two streaks, as compose SHAFTS)
  for (const [ndc, dep, [yt, yb], rc, k] of (comp.shafts?.beams?.length ? [] : [[[-0.70, 0.30], 2.4, [0.95, -0.30], 0.070, 1.0], [[-0.45, 0.45], 3.0, [0.98, 0.05], 0.045, 0.5]])) {
    const mid = ndcAt(ndc[0], ndc[1], dep);
    // walk along the ray line until the projected y reaches the target (bisection, as compose.py)
    const solve = (target) => {
      let lo = -6, hi = 3;
      for (let i = 0; i < 60; i++) { const m = 0.5 * (lo + hi); if (ndcY(mid.clone().addScaledVector(sunDir, m)) > target) lo = m; else hi = m; }
      return mid.clone().addScaledVector(sunDir, 0.5 * (lo + hi));
    };
    shafts.push(makeShaft({ top: solve(yt).toArray(), bottom: solve(yb).toArray(), rc, gain: 0.17 * k, seed: shafts.length }));
  }
  // More beams around the open water, so a free camera finds sunlit water in every direction (the
  // poster sees only its two).  Same field, longer: from 11-13 m up to ~1.5-3 m above the sand, so
  // they dissolve in the haze above and well above the floor.  Placed 7-26 m out at azimuths that
  // avoid the start view's centre (the poster frame keeps exactly its two streaks).
  const extra = [[-60, 7, 0.10, 0.9], [75, 9, 0.12, 0.8], [130, 11, 0.14, 0.9], [-130, 13, 0.16, 0.85],
    [180, 8, 0.11, 0.7], [-95, 18, 0.2, 0.9], [40, 22, 0.22, 0.8], [100, 26, 0.24, 0.8], [-35, 24, 0.22, 0.7]];
  for (const [azDeg, dist, rc, k] of extra) {
    const az = THREE.MathUtils.degToRad(azDeg);
    // azimuth 0 = CAM_Main's view (-Z), positive to the right
    const x = Math.sin(az) * dist, z = -Math.cos(az) * dist;
    const yTop = 11 + 2 * ((shafts.length * 0.37) % 1), yBot = 1.5 + 1.5 * ((shafts.length * 0.61) % 1);
    // the axis passes over (x, z) at mid height
    const yMid = (yTop + yBot) / 2;
    const P = new THREE.Vector3(x, yMid, z);
    const top = P.clone().addScaledVector(sunDir, (yTop - yMid) / sunDir.y);
    const bot = P.clone().addScaledVector(sunDir, (yBot - yMid) / sunDir.y);
    shafts.push(makeShaft({ top: top.toArray(), bottom: bot.toArray(), rc, gain: 0.17 * k * shaftScale * SHAFT_TUNE, color: shaftCol, seed: shafts.length, blend: SHAFT_BLEND }));
  }
}
shafts.forEach((s) => scene.add(s));
const snow = makeSnow(4500);     // (QA2) 3500 -> 4500 with the bokeh specks (GPU points: no measurable cost)
scene.add(snow);
// (QA2) a small dense box right around the lens: the big 20 m box puts only ~1-2 specks within 1.5 m,
// where the depth of field turns them into the soft bokeh discs that the final's plate shows
// (~20 per frame).  Same shader; its 4 x 3 x 4 m box wraps with the camera like the big one.
const snowNear = makeSnow(350, [4, 3, 4], 7654321);
scene.add(snowNear);

// ---------- bubbles (frutiger 10-05) ----------
// The scene's bubbles (compose make_bubbles: vents at Boulder_02, the pillar top, two sand spots, the column
// rising through the main beam, 6 near orbs) exactly where and how they move in Blender (fx.js makeBubbles),
// plus two web-only sets so a free camera meets the Aero bubbles wherever it swims:
//  * vents on the sand around the arena (same per-bubble distributions as the scene's sand vents), placed
//    clear of every rock, 6-22 m from the start, none inside the start view's sand window (they would cross
//    the scene's placed fish there, compose's rule for its own vents);
//  * a sparse field of single bubbles in a 6 x 5 x 6 m box that wraps with the camera (like the snow): the
//    ones that pass within ~1 m of the lens are the soft bokeh orbs of the look.
// Only when the look has bubbles (composition.bubbles is exported only then).
const bubbleMeshes = [];
if (comp.bubbles?.points_three?.length) {
  const B = comp.bubbles;
  bubbleMeshes.push(makeBubbles({ points: B.points_three.flat(), attrs: B.attributes, rim: B.rim_emission ?? 0.9,
    rimColor: B.rim_color ?? [0.85, 0.97, 1.0], loopSeconds: (B.loop_frames ?? 240) / 24, name: 'FX_Bubbles_scene' }));
  const vents = [];
  for (let k = 0, tries = 0; vents.length < 9 && tries < 400; tries++) {
    const a = ((k * 0.381966 + tries * 0.137) % 1) * 6.2832, r = 6 + 16 * ((tries * 0.618034) % 1);
    const x = Math.sin(a) * r, z = -Math.cos(a) * r - 4;
    if (keepouts.some((q) => Math.hypot(x - q.x, z - q.z) < q.r + 0.6)) continue;
    if (Math.abs(x) < 3 && z < -1 && z > -9) continue;              // the start view's sand window
    vents.push({ base: [x, env.sandHeight.at(x, z) + 0.01, z], spread: 0.03, n: 26 + (k % 3) * 8, rise: 2.4 + 0.4 * (k % 3),
      size: [0.003, 0.009], cycs: [2, 3] });
    k++;
  }
  const v = bubbleAttrs(vents, 4242);
  bubbleMeshes.push(makeBubbles({ points: v.points, attrs: v.attrs, rim: B.rim_emission ?? 0.9, rimColor: B.rim_color ?? [0.85, 0.97, 1.0],
    loopSeconds: 10, name: 'FX_Bubbles_vents' }));
  const amb = bubbleAttrs([{ n: 36, at: (rnd) => [(rnd() - 0.5) * 6, (rnd() - 0.5) * 5, (rnd() - 0.5) * 6], rise: 2.0,
    size: [0.004, 0.012], cycs: [1], amp: [0.02, 0.05] }], 777);
  bubbleMeshes.push(makeBubbles({ points: amb.points, attrs: amb.attrs, rim: B.rim_emission ?? 0.9, rimColor: B.rim_color ?? [0.85, 0.97, 1.0],
    loopSeconds: 10, wrap: [6, 5, 6], name: 'FX_Bubbles_ambient' }));
  bubbleMeshes.forEach((m) => scene.add(m));
}

// ---------- controls / UI ----------
const controls = new SwimControls(camera, canvas, { sand: env.sandHeight, keepouts, debug: DEBUG });
fish.camVel = controls.vel;           // fish part sideways to their motion relative to you
resetView();
const START_YAW = controls.yaw, START_PITCH = controls.pitch;     // '정면' on the phone faces this way again
let neonTarget = params.has('neon') ? 1 : 0;
fishUniforms.uNeon.value = neonTarget;
waterUniforms.uNeonWater.value = neonTarget;
const toast = (msg, ms = 1400) => { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toast._h); toast._h = setTimeout(() => t.classList.remove('on'), ms); };
let hudOn = DEBUG;
const helpEl = $('help');
let helpTimer = 0;
function showHelp(sec = 7) { helpEl.classList.remove('faded'); clearTimeout(helpTimer); if (sec) helpTimer = setTimeout(() => helpEl.classList.add('faded'), sec * 1000); }
controls.onToggle = {
  KeyC: () => { neonTarget = neonTarget ? 0 : 1; toast(neonTarget ? '네온 색' : '자연 색'); },
  KeyH: () => { if (helpEl.classList.contains('faded')) showHelp(0); else helpEl.classList.add('faded'); },
  KeyP: () => { hudOn = !hudOn; $('hud').classList.toggle('on', hudOn); },
  KeyR: () => { resetView(); toast('처음 자리로'); },
  KeyV: () => { controls.flyAlongView = !controls.flyAlongView; toast(controls.flyAlongView ? '시선 방향으로 헤엄' : '수평으로 헤엄'); },
  KeyU: () => toggleUI(),
};

// ---------- UI 숨기기 (ui-toggle 10-06) ----------
// 유저 요청: 화면을 더블클릭(폰은 두 번 톡)하면 UI가 가려지고, 다시 하면 나온다 — 장면만 깨끗하게 보려고.
// 숨는 것 = 도움말·HUD·조이스틱/버튼·출처 링크·조준점 (index.html 의 body.ui-hidden 규칙).  카메라 조작
// (자이로·키보드·마우스 잠금·화면 끌기)은 그대로라 숨긴 채로도 둘러볼 수 있다.  U 키는 같은 동작의 키보드판.
let uiHidden = false;
function setUIHidden(h) { uiHidden = h; document.body.classList.toggle('ui-hidden', h); }
function toggleUI() {
  setUIHidden(!uiHidden);
  if (uiHidden) toast(MOBILE ? '두 번 톡 하면 다시 보여요' : '더블클릭(U)하면 다시 보여요', 1800);
}
// 데스크톱: 캔버스 더블클릭.  포인터 잠금 중에도 잠긴 요소(캔버스)로 dblclick 이 온다.  시작 전(카드 위)은 제외.
canvas.addEventListener('dblclick', (e) => { if (!MOBILE && started) { e.preventDefault(); toggleUI(); } });
// 폰: 캔버스 위 '톡' 두 번.  WHY 직접 판정(dblclick 아님): 모바일 브라우저는 touch-action:none 캔버스에서
// dblclick 을 안정적으로 보내지 않고, 화면 끌기(둘러보기)와 섞이면 안 되므로 '짧고(<300ms) 거의 안 움직인
// (<12px) 한 손가락 톡' 두 번이 400ms·40px 안에 올 때만 센다.  조이스틱·버튼은 캔버스가 아니라 해당 안 됨
// (조이스틱 두 번 톡=빠르게 헤엄과 안 겹침).
if (MOBILE) {
  const downs = new Map(); let lastTap = null;
  canvas.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') downs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp }); });
  const up = (e) => {
    const d = downs.get(e.pointerId); downs.delete(e.pointerId);
    if (!d || !started || downs.size) { lastTap = null; return; }            // 두 손가락이면 톡 아님
    const isTap = e.timeStamp - d.t < 300 && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 12;
    if (!isTap) { lastTap = null; return; }
    if (lastTap && e.timeStamp - lastTap.t < 400 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      lastTap = null; toggleUI();
    } else lastTap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
  };
  canvas.addEventListener('pointerup', up);
  canvas.addEventListener('pointercancel', (e) => { downs.delete(e.pointerId); lastTap = null; });
}
$('hud').classList.toggle('on', hudOn);

// ---------- phone mode (mobile 10-05) ----------
// gyro look (gyro.js) on top of SwimControls, the joystick / buttons (touch.js), and a finger drag on the
// view.  Desktop: none of this is created.
let gyro = null, touchUI = null, wakeLock = null;
if (MOBILE) {
  // swim where the phone looks (incl. up/down): in a magic window you aim by pointing the phone, so the
  // desktop's level swim (V) would ignore half of the aiming.  The 위로/아래로 buttons still rise / sink.
  controls.flyAlongView = true;
  gyro = new GyroLook();
  controls.look = gyro;
  // finger drag: 'grab the water' (the scene follows the finger, as in 360-degree photos on phones); with
  // the gyro on it adds a turn on top of the sensor (turn round without spinning on the spot), without it
  // it is the whole look.  WHY not the desktop drag direction (mouse right = turn right): that is mouse-look,
  // and on a touch screen it reads as the world sliding the wrong way under the finger.
  controls.onDragLook = (dx, dy) => {
    if (gyro.active) { gyro.drag(dx, dy); return; }
    controls.yaw += dx * gyro.dragK;
    controls.pitch = Math.max(-1.45, Math.min(1.45, controls.pitch + dy * gyro.dragK));
  };
  let lastGyro = 'off', gyroFromButton = false;
  gyro.onState = (st) => {
    touchUI?.setGyro(st);
    if (st === 'unavailable') toast('기울기 센서를 못 찾았어요 · 화면을 끌어 둘러보세요', 3200);
    else if (st === 'denied') toast('기울기 권한이 없어요 · 화면을 끌어 둘러보세요', 3200);
    else if (st === 'on' && (lastGyro === 'unavailable' || lastGyro === 'denied' || gyroFromButton)) toast('자이로 켬');
    if (st !== 'waiting') gyroFromButton = false;
    lastGyro = st;
  };
  touchUI = setupTouch({
    controls,
    onNeon: () => controls.onToggle.KeyC(),
    onGyro: () => {
      if (gyro.wanted && (gyro.state === 'on' || gyro.state === 'waiting')) { gyro.disable(); toast('자이로 끔 · 화면을 끌어 둘러보기', 2200); }
      else { gyroFromButton = true; gyro.enable(); }          // inside the tap: iOS may ask again
    },
    onFront: () => {
      if (gyro.active) gyro.recenter(START_YAW); else controls.turnTo(START_YAW, START_PITCH);
      toast('정면');
    },
    onHome: () => controls.onToggle.KeyR(),
  });
  // R (a phone / tablet with a keyboard) and the 처음 button: back to the start AND facing the scene; with
  // the gyro on, resetView's lookAt alone would be overwritten by the sensor on the next frame
  controls.onToggle.KeyR = () => { resetView(); if (gyro.active) gyro.recenter(START_YAW); toast('처음 자리로'); };
  // the '허용' hint only on iPhone / iPad Safari, which shows a motion-access prompt.  WHY not 'requestPermission
  // exists': current Chrome (Android too) has the function as well and grants without asking, so the hint
  // promised a prompt that never came.  (iPadOS reports a Mac UA: touch points tell it apart.)
  const iOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  if (iOS && typeof window.DeviceOrientationEvent?.requestPermission === 'function') $('iosHint').hidden = false;
  // Tilting the phone is not a touch: without a wake lock the screen dims after ~30 s of just looking
  // around and then locks.  Released by the browser when the tab hides; taken again when it is back.
  document.addEventListener('visibilitychange', () => { if (started && document.visibilityState === 'visible') keepAwake(); });
  // iOS reports the new innerWidth/innerHeight a moment after the rotation's resize event
  const later = () => setTimeout(resize, 250);
  screen.orientation?.addEventListener?.('change', later);
  addEventListener('orientationchange', later);
}
async function keepAwake() {
  try { if (navigator.wakeLock && !document.hidden) wakeLock = await navigator.wakeLock.request('screen'); } catch (e) { /* not allowed: fine */ }
}
// The start tap on a phone.  gyro.enable() FIRST and synchronously: iOS shows its motion-permission prompt
// only for a requestPermission() made inside the tap itself.
function startMobile() {
  gyro.enable();
  begin();
  touchUI.show();
  keepAwake();
}

const startEl = $('start');
let started = false, everLocked = false;
startEl.addEventListener('click', async () => {
  if (MOBILE) { startMobile(); return; }        // no pointer lock on a phone
  if (await controls.lock()) return;          // onLockChange(true) already hid the card
  // Refused.  If the lock has worked before, this is almost always Chrome's cooldown: right after
  // Esc it refuses a new lock for about a second.  WHY keep the card then: hiding it dropped you
  // into drag mode where moving the mouse did nothing, with no hint why.  If the lock never worked
  // here (iframe, automation, phones, a browser without it) drag-to-look is the way: start anyway.
  if (everLocked) { toast('잠시 후 다시 클릭해 주세요'); return; }
  begin();
});
canvas.addEventListener('click', () => { if (!MOBILE && !controls.locked && started) controls.lock(); });
function begin() {
  if (!started) { started = true; showHelp(8); }
  startEl.classList.add('gone');
}
controls.onLockChange = (locked) => {
  document.body.classList.toggle('locked', locked);
  if (locked) { everLocked = true; begin(); }
  else if (started && !DEBUG) { startEl.classList.remove('gone'); startEl.querySelector('.go').textContent = '클릭해서 계속'; }
};
if (DEBUG) { begin(); if (MOBILE) startMobile(); }

// ---------- sizing / adaptive quality ----------
// Pixel budget: cap the drawing buffer near 2560x1600 (4.1 MP); a Retina dpr 2 on a 1440p window
// would otherwise be 14.7 MP of fish fragments.  The adaptive controller then trades fish count
// first, render scale second.
let resScale = params.has('res') ? +params.get('res') : 1;
const fixedQ = params.has('q') ? Math.max(0.2, Math.min(1, +params.get('q'))) : null;
if (fixedQ) fish.quality = fish.qCur = fixedQ;
else if (MOBILE) fish.quality = fish.qCur = MOBILE_PERF.quality;
function resize() {
  const w = innerWidth, h = innerHeight;
  let cw = w, ch = h;
  if (POSTER) { ch = h; cw = Math.round(h * 2 / 3); if (cw > w) { cw = w; ch = Math.round(w * 1.5); } }
  canvas.style.width = cw + 'px'; canvas.style.height = ch + 'px';
  canvas.style.left = ((w - cw) / 2) + 'px'; canvas.style.top = ((h - ch) / 2) + 'px';
  const budget = MOBILE ? MOBILE_PERF.pixelBudget : 4.1e6;
  const dpr = Math.min(devicePixelRatio || 1, MOBILE ? MOBILE_PERF.dprMax : Infinity, Math.sqrt(budget / (cw * ch))) * resScale;
  renderer.setPixelRatio(dpr);
  renderer.setSize(cw, ch, false);
  camera.aspect = cw / ch;
  // landscape browsers: 62 deg vertical (~95 deg horizontal at 16:9); the poster's 65.47 deg is for
  // a 2:3 portrait frame and would be ~100 deg wide here.
  let fov = POSTER ? comp.camera.fov_vertical_deg : (params.has('fov') ? +params.get('fov') : 62);
  if (!POSTER && !params.has('fov')) {
    // Portrait / narrow windows (phones, a browser snapped to half a screen): a fixed 62 deg
    // VERTICAL view is only 31 deg wide on a phone, a tunnel.  Keep at least the poster's horizontal
    // view (CAM_Main: 65.47 deg vertical at 2:3 = 46.4 deg wide), capped at 90 deg vertical.
    const hMin = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(comp.camera.fov_vertical_deg) / 2) * 2 / 3);
    const vNeed = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(hMin / 2) / camera.aspect));
    fov = Math.min(90, Math.max(fov, vNeed));
  }
  camera.fov = fov;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

const RES_MAX = Math.min(1, resScale);          // a ?res= override is also the recovery ceiling
const NEAR_PX0 = fish.nearPx;
const perf = { fps: 0, ms: 0, win: [], acc: 0, stale: true, fastT: 0, capT: 0,
  lastAdj: 0, lastRecover: -1e9, probeAt: 0, probeBackoff: 15000, cpuMs: 0 };

const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
function shedStep(avg) {
  // step size grows with how slow it is (36 fps -> 0.2, 20 fps -> 0.3) so a weak GPU is smooth
  // within a few seconds instead of ten
  const step = Math.min(0.3, Math.max(0.1, (avg - 16.7) / 16.7 * 0.3));
  if (fish.quality > 0.45) fish.quality = Math.max(0.4, fish.quality - step);
  else if (resScale > 0.6 + 1e-6) { resScale = Math.max(0.6, resScale - 0.1); resize(); }   // (1e-6: 1-4*0.1 is 0.6000000000000001)
  else fish.nearPx = Math.min(260, fish.nearPx * 1.25);
}
function recoverStep() {
  // exact reverse of shedStep's order (the first version never lowered nearPx again: once raised,
  // fish stayed on the coarse LOD until reload)
  if (fish.nearPx > NEAR_PX0) fish.nearPx = Math.max(NEAR_PX0, fish.nearPx / 1.25);
  else if (resScale < RES_MAX - 1e-6) { resScale = Math.min(RES_MAX, resScale + 0.1); resize(); }
  else if (fish.quality < 1) fish.quality = Math.min(1, fish.quality + 0.08);
  else return false;
  return true;
}

function adapt(now, frameMs) {
  // Gaps that say nothing about render cost reset the window instead of shedding quality:
  //  - ~1 s: an occluded page in the built-in browser pane gets rAF throttled to exactly 1 Hz;
  //  - > 2.5 s: tab switch / sleep / debugger.
  // WHY not 'anything over 120 ms' (the first version): a device that really renders at under
  // 8 fps (software GL, a weak GPU at 4K) then NEVER adapted and the HUD showed a frozen 'FPS 60'
  // -- the controller stood still exactly where it is needed most.
  if (document.visibilityState !== 'visible' || frameMs > 2500 || (frameMs > 850 && frameMs < 1200)) {
    perf.win.length = 0; perf.acc = 0; perf.stale = true; return;
  }
  perf.win.push(frameMs); perf.acc += frameMs;
  if (perf.acc < 1000 || perf.win.length < 3) return;
  // decide on the MEDIAN frame: one GC pause or shader hitch in a second of frames is not load
  const avg = median(perf.win);
  perf.ms = avg; perf.fps = 1000 * perf.win.length / perf.acc; perf.stale = false;
  perf.win.length = 0; perf.acc = 0;
  if (fixedQ || document.hidden || !started) return;
  if (now - perf.lastAdj < 1500) return;
  if (avg > 18.5) {                                   // under ~54 fps: shed load
    shedStep(avg);
    // a shed right after a blind probe (below) means the probe overshot: wait longer next time
    if (now - perf.lastRecover < 5000) { perf.probeBackoff = Math.min(120000, perf.probeBackoff * 2); perf.probeAt = now + perf.probeBackoff; }
    perf.lastAdj = now; perf.fastT = perf.capT = 0;
  } else if (avg < 14.5) {                            // comfortably above 60: earn it back slowly
    perf.capT = 0;
    if (++perf.fastT >= 3) { if (recoverStep()) perf.lastAdj = perf.lastRecover = now; perf.fastT = 0; }
  } else {
    // Holding the display refresh (60 Hz): rAF intervals cannot go below 16.7 ms there, so a frame
    // costing 6 ms and one costing 16 ms look the same and headroom is invisible.  WHY this probe:
    // the first version only earned quality back under 14.5 ms, i.e. on 90 Hz+ screens -- on a
    // 60 Hz screen one heavy moment shed fish FOREVER.  After 5 s of steady frames, try one
    // recovery step; if that drops the frame rate the shed above takes it back and the wait doubles
    // (15 s .. 2 min), so it settles instead of see-sawing.
    // (WHY not the GPU timer query: on ANGLE Metal it read 0.4-2 ms for 597x472 frames that took
    // ~5 ms each when a batch was synced with readPixels at 640x360, and 100+ ms while Blender was
    // rendering on the same GPU -- too erratic to steer by; see benchSync below.)
    perf.fastT = 0;
    if (++perf.capT >= 5 && now >= perf.probeAt) { if (recoverStep()) perf.lastAdj = perf.lastRecover = now; perf.capT = 0; }
  }
}

// focal length in drawing-buffer pixels for the screen-size-aware effects (snow / bubble DOF, shaft min width).
// (frutiger 10-05) a function so __fish.snap() can set it for its own render size: while the pane is hidden the
// canvas is 0 px tall, focal 0 made the bubbles 0 px and the shafts infinitely wide (= invisible) in snaps.
// A 0-px canvas (hidden pane, minimised window) keeps the last focal: focal ~0.8 px made every bubble quad cover
// the whole screen (the quad size is px x distance / focal) — 216 full-screen discarding quads = 80 ms per frame
// in __fish.benchSync after a load in a hidden pane (measured, checks/web/tmp/frutiger/progress.txt).
function setFocal(vh) {
  if (!(vh > 0)) return;
  const f = vh / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  snow.material.uniforms.uFocal.value = f;
  snowNear.material.uniforms.uFocal.value = f;
  for (const sh of shafts) sh.material.uniforms.uPixAng.value = 1 / f;
  for (const bm of bubbleMeshes) bm.material.uniforms.uFocal.value = f;
}

// ---------- loop ----------
const clock = { last: performance.now(), t0: performance.now() };
function frame(now, manual = false) {
  // (mobile 10-05) 120 / 144 Hz phones: draw every other refresh (60 / 72 fps).  Twice the frames would
  // only heat the phone into throttling.  WHY a 9.5 ms gate and not 'one frame per 16.7 ms': on a 90 Hz
  // screen that alternates 11 / 22 ms frames, and the adaptive controller (median frame) misreads it.
  if (MOBILE && !manual && now - clock.last < 9.5) { requestAnimationFrame(frame); return; }
  // never negative: rAF timestamps are monotonic, but the debug step() advances the clock ahead of
  // real time, and a following rAF frame then ran the swim backwards (seen as a 36 m jump)
  const dtMs = Math.max(0, now - clock.last);
  clock.last = Math.max(clock.last, now);
  const dt = Math.min(dtMs / 1000, 0.05);
  const t = (now - clock.t0) / 1000;
  const c0 = performance.now();
  controls.update(dt);
  waterUniforms.uTime.value = t;
  fishUniforms.uNeon.value += (neonTarget - fishUniforms.uNeon.value) * Math.min(1, dt * 5);
  if (Math.abs(fishUniforms.uNeon.value - neonTarget) < 0.002) fishUniforms.uNeon.value = neonTarget;
  waterUniforms.uNeonWater.value = fishUniforms.uNeon.value;     // the tank look crossfades with the fish
  const vh = renderer.domElement.height;
  setFocal(vh);
  fish.update(t, dt, camera, vh);
  perf.cpuMs = perf.cpuMs * 0.9 + (performance.now() - c0) * 0.1;
  renderer.render(scene, camera);
  adapt(now, dtMs);
  if (hudOn) hud();
  if (!manual) requestAnimationFrame(frame);
}

function hud() {
  if ((hud.n = (hud.n || 0) + 1) % 10) return;
  const s = fish.stats, info = renderer.info.render;
  $('hud').textContent =
    (perf.stale ? `FPS —  (측정 중, CPU ${perf.cpuMs.toFixed(1)} ms)\n`
      : `FPS ${perf.fps.toFixed(0)}  (${perf.ms.toFixed(1)} ms, CPU ${perf.cpuMs.toFixed(1)} ms)\n`) +
    `물고기 ${s.drawn.toLocaleString()}마리 그림 (전체 ${s.sim.toLocaleString()})\n` +
    `  모델 근 ${s.near} / 중 ${s.far} / 원 ${s.tiny ?? 0} / 점 ${s.micro ?? 0}\n` +
    `삼각형 ${(info.triangles / 1e6).toFixed(2)}M  호출 ${info.calls}\n` +
    `품질 ${(fish.quality * 100).toFixed(0)}%  해상도 ${(resScale * 100).toFixed(0)}%  ${renderer.domElement.width}×${renderer.domElement.height}\n` +
    `위치 ${camera.position.x.toFixed(1)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(1)}`;
}

// ---------- debug handle ----------
window.__fish = {
  THREE, scene, camera, renderer, fish, controls, perf, comp, env, lights, shafts, snow, snowNear, bubbleMeshes, gradeP, envUniforms, waterUniforms, fishUniforms,
  MOBILE, gyro, touchUI,
  get state() {
    return { fps: +perf.fps.toFixed(1), ms: +perf.ms.toFixed(2), cpuMs: +perf.cpuMs.toFixed(2), nearPx: fish.nearPx, ...fish.stats,
      quality: fish.quality, resScale, neon: fishUniforms.uNeon.value, buffer: [renderer.domElement.width, renderer.domElement.height],
      tris: renderer.info.render.triangles, calls: renderer.info.render.calls,
      cam: camera.position.toArray().map((v) => +v.toFixed(2)), yaw: controls.yaw, pitch: controls.pitch, locked: controls.locked };
  },
  setView(pos, yawDeg, pitchDeg) { camera.position.fromArray(pos); controls.yaw = THREE.MathUtils.degToRad(yawDeg); controls.pitch = THREE.MathUtils.degToRad(pitchDeg); controls.vel.set(0, 0, 0); },
  key(code, ms = 300) { controls.keys.add(code); setTimeout(() => controls.keys.delete(code), ms); },
  press(code) { controls.onToggle[code]?.(); },
  resetView,
  speciesCounts() { const c = {}; for (let i = 0; i < fish.N; i++) { const id = speciesList[fish.sp[i]].id; c[id] = (c[id] || 0) + 1; } return c; },
  /**
   * (2026-10-05 web sync) Occlusion-aware species share of the fish-covered screen: the web twin of
   * scenes/final/checks/shares.py, so the web's diversity can be compared with the final's numbers.
   * One extra render at w x h into an un-antialiased target: every fish mesh draws a flat colour whose
   * red byte is its species index + 1, rocks and sand draw black (they still hide the fish behind them),
   * background / light shafts / snow are hidden.  share = that species' pixels / all fish pixels; also
   * returns the inverse Simpson index (1 / sum share^2: 'how many equally common species it looks
   * like').  The swim deformation is not applied in this pass (a few % of a body length at the tail).
   * The current camera framing is used; with ?poster=1 that is CAM_Main's 2:3 frame.
   */
  shares({ w = null, h = null } = {}) {
    const sz = renderer.getSize(new THREE.Vector2());
    if (!w || !h) { h = 900; w = Math.round(h * sz.x / sz.y); }
    const rt = new THREE.WebGLRenderTarget(w, h, { samples: 0, depthBuffer: true });
    const black = new THREE.MeshBasicMaterial({ color: 0x000000, toneMapped: false });
    const idMat = speciesList.map((s) => new THREE.MeshBasicMaterial({ color: new THREE.Color((s.k + 1) / 255, 0, 0), toneMapped: false, side: THREE.DoubleSide }));
    const fishMesh = new Map();
    fish.meshes.forEach((pair, k) => pair.forEach((m) => m && fishMesh.set(m, k)));
    const saved = [];
    scene.traverse((o) => {
      if (fishMesh.has(o)) { saved.push([o, o.material, o.visible]); o.material = idMat[fishMesh.get(o)]; }
      // (frutiger 10-05) + the bubbles (FX_*): see-through, they must not count as occluders in the ID pass
      else if (o.isPoints || o.material?.blending === THREE.AdditiveBlending || o.renderOrder === 100 || o.name?.startsWith('FX_')) { saved.push([o, o.material, o.visible]); o.visible = false; }
      else if (o.isMesh) { saved.push([o, o.material, o.visible]); o.material = black; }
    });
    const oldAspect = camera.aspect, oldClear = renderer.getClearColor(new THREE.Color()), oldAlpha = renderer.getClearAlpha();
    camera.aspect = w / h; camera.updateProjectionMatrix();
    // instances as of now (fish.update ran this frame for the real viewport; LOD choice does not matter)
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 1); renderer.clear(); renderer.render(scene, camera);
    const px = new Uint8Array(w * h * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    renderer.setRenderTarget(null); renderer.setClearColor(oldClear, oldAlpha);
    camera.aspect = oldAspect; camera.updateProjectionMatrix();
    for (const [o, m, v] of saved) { o.material = m; o.visible = v; }
    rt.dispose(); black.dispose(); idMat.forEach((m) => m.dispose());
    const cnt = new Float64Array(speciesList.length + 1);
    for (let i = 0; i < px.length; i += 4) if (px[i] > 0 && px[i] <= speciesList.length) cnt[px[i]]++;
    const fishPx = cnt.reduce((a, b) => a + b, 0);
    const share = {};
    let simpson = 0;
    speciesList.forEach((s) => { const v = cnt[s.k + 1] / (fishPx || 1); if (v > 0) share[s.id] = +v.toFixed(4); simpson += v * v; });
    const sorted = Object.fromEntries(Object.entries(share).sort((a, b) => b[1] - a[1]));
    return { w, h, coverage: +(fishPx / (w * h)).toFixed(4), invSimpson: +(1 / (simpson || 1)).toFixed(2), share: sorted };
  },
  /** (2026-10-05) instances per species currently DRAWN (after culling / quality), for the HUD-less checks */
  speciesDrawn() { const c = {}; fish.meshes.forEach((pair, k) => { const n = pair.reduce((a, m) => a + (m ? m.count : 0), 0); if (n) c[speciesList[k].id] = n; }); return c; },
  setQuality(q) { fish.quality = q; },
  /** render once and return the median display-sRGB colour of each region {name:[x0,y0,x1,y1]}
   *  (normalised, y down) — for numeric comparison against Blender renders of the same framing */
  sample(regs) {
    renderer.render(scene, camera);
    const gl = renderer.getContext(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const px = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const out = {};
    for (const [k, [x0, y0, x1, y1]] of Object.entries(regs)) {
      const ch = [[], [], []];
      for (let y = Math.floor(y0 * H); y < Math.floor(y1 * H); y += 2) for (let x = Math.floor(x0 * W); x < Math.floor(x1 * W); x += 2) {
        const o = ((H - 1 - y) * W + x) * 4;
        ch[0].push(px[o]); ch[1].push(px[o + 1]); ch[2].push(px[o + 2]);
      }
      out[k] = ch.map((a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; });
    }
    return out;
  },
  /** dev: render at w x h and save the exact frame to checks/web/<name> via tools/web_serve.py */
  async snap(name, { w = null, h = null } = {}) {
    const old = { pr: renderer.getPixelRatio(), size: renderer.getSize(new THREE.Vector2()), aspect: camera.aspect };
    if (w && h) { renderer.setPixelRatio(1); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
    fish.update((performance.now() - clock.t0) / 1000, 0, camera, renderer.domElement.height);
    setFocal(renderer.domElement.height);
    renderer.render(scene, camera);
    const blob = await new Promise((r) => renderer.domElement.toBlob(r, 'image/png'));
    if (w && h) { renderer.setPixelRatio(old.pr); renderer.setSize(old.size.x, old.size.y, false); camera.aspect = old.aspect; camera.updateProjectionMatrix(); }
    const res = await fetch('/__snap?name=' + encodeURIComponent(name), { method: 'POST', body: blob });
    return res.ok ? name : 'failed';
  },
  /** advance n frames of 1/60 s and render, without rAF (the built-in browser pane throttles or
   *  pauses rAF while hidden, which is when automated checks run) */
  step(n = 1, frameMs = 1000 / 60) { for (let i = 0; i < n; i++) frame(clock.last + frameMs, true); return this.state; },
  /**
   * Wall-clock benchmark: `frames` full frames (simulation + render) back to back at w x h, then
   * one readPixels to wait until the GPU has really finished them.  ms per frame = what a frame
   * costs when the GPU is the limit (CPU and GPU overlap within the batch).  WHY next to bench():
   * the timer-query numbers of bench() were erratic on ANGLE Metal (see adapt()).
   */
  async benchSync({ w = 2560, h = 1440, frames = 30, q = null } = {}) {
    const gl = renderer.getContext(), px = new Uint8Array(4);
    const old = { pr: renderer.getPixelRatio(), size: renderer.getSize(new THREE.Vector2()), aspect: camera.aspect, q: fish.quality, qc: fish.qCur };
    renderer.setPixelRatio(1); renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    setFocal(h);
    if (q != null) { fish.quality = fish.qCur = q; }
    let t = (performance.now() - clock.t0) / 1000;
    renderer.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);   // drain
    const t0 = performance.now();
    for (let i = 0; i < frames; i++) {
      t += 1 / 60;
      fish.update(t, 1 / 60, camera, h);
      waterUniforms.uTime.value = t;
      renderer.render(scene, camera);
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const ms = (performance.now() - t0) / frames;
    const drawn = fish.stats.drawn, tris = renderer.info.render.triangles;
    renderer.setPixelRatio(old.pr); renderer.setSize(old.size.x, old.size.y, false);
    camera.aspect = old.aspect; camera.updateProjectionMatrix();
    if (q != null) { fish.quality = old.q; fish.qCur = old.qc; }
    return { w, h, frames, msPerFrame: +ms.toFixed(2), fpsCeiling: +(1000 / ms).toFixed(0), drawn, trisM: +(tris / 1e6).toFixed(2) };
  },
  /**
   * GPU benchmark that does not depend on rAF (which a hidden pane throttles): renders `frames`
   * frames back to back at w x h (drawing-buffer pixels) and times each with
   * EXT_disjoint_timer_query_webgl2.  Simulation runs with dt = 1/60 so fish keep moving.
   */
  async bench({ w = 2560, h = 1440, frames = 40, q = null } = {}) {
    const gl = renderer.getContext();
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    const old = { pr: renderer.getPixelRatio(), size: renderer.getSize(new THREE.Vector2()), aspect: camera.aspect, q: fish.quality, qc: fish.qCur };
    renderer.setPixelRatio(1); renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
    setFocal(h);
    if (q != null) { fish.quality = fish.qCur = q; }
    const qs = [], cpu = [], drawn = [], tris = [];
    let t = (performance.now() - clock.t0) / 1000;
    for (let i = 0; i < frames; i++) {
      t += 1 / 60;
      const c0 = performance.now();
      fish.update(t, 1 / 60, camera, h);
      waterUniforms.uTime.value = t;
      cpu.push(performance.now() - c0);
      const qq = ext ? gl.createQuery() : null;
      if (qq) gl.beginQuery(ext.TIME_ELAPSED_EXT, qq);
      renderer.render(scene, camera);
      if (qq) { gl.endQuery(ext.TIME_ELAPSED_EXT); qs.push(qq); }
      drawn.push(fish.stats.drawn); tris.push(renderer.info.render.triangles);
    }
    const gpu = [];
    for (const qq of qs) {
      for (let k = 0; k < 400 && !gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE); k++) await new Promise((r) => setTimeout(r, 5));
      if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) gpu.push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(qq);
    }
    renderer.setPixelRatio(old.pr); renderer.setSize(old.size.x, old.size.y, false);
    camera.aspect = old.aspect; camera.updateProjectionMatrix();
    if (q != null) { fish.quality = old.q; fish.qCur = old.qc; }
    const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? +b[Math.floor(b.length / 2)].toFixed(2) : null; };
    const p90 = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? +b[Math.floor(b.length * 0.9)].toFixed(2) : null; };
    return { w, h, frames, gpuMedMs: med(gpu.slice(3)), gpuP90Ms: p90(gpu.slice(3)), cpuMedMs: med(cpu), drawn: med(drawn), trisM: +(med(tris) / 1e6).toFixed(2), samples: gpu.length };
  },
};

// Compile every shader variant now, behind the loading screen (KHR_parallel_shader_compile where
// available): otherwise the first frames hitch for ~25 programs while the user is already looking.
$('loadMsg').textContent = '셰이더 준비 중…';
// (all fish meshes visible for the compile: compileAsync only walks visible objects, and a species
// that is off-screen at the start, e.g. the eagle rays, would otherwise compile mid-swim)
for (const pair of fish.meshes) for (const m of pair) if (m) m.visible = true;
try { await renderer.compileAsync(scene, camera); } catch (e) { console.warn('compileAsync', e); }
$('loading').classList.add('gone');
if (!DEBUG) startEl.classList.remove('gone');
requestAnimationFrame((t) => { clock.last = t; clock.t0 = t; requestAnimationFrame(frame); });

// ======================================================================================
// Population — the composition's swarms, adapted to a free camera (see fish.js header)
// ======================================================================================
//
// (2026-10-05 web sync) Rewritten for the recomposed final (user: "too many knifejaw / stripey, make it
// more diverse"; 15 new species).  The final renamed or replaced most swarms (stripey -> snapper /
// seabream / fusilier / snooty wrasse slabs, knife_mill -> wrasse_mill, stripey_mill -> fusilier_mill,
// silver -> mackerel, baitball dropped), so nothing here may assume a swarm exists: every lookup goes
// through have(), and a name the composition lacks is reported on the console and skipped (the old code
// read sw['stripey'].direction and the page died at '장면 만드는 중…' with an exception nobody saw).
//
// What was STRIPEY-DOMINANT before and why it is not now:
//   the web's own ambient boxes (the fish around you wherever you swim) were 9,000 stripey + 1,500
//   knifejaw + 900 parrotfish in the near band — they filled the opening view more than the final's
//   slabs did.  They are now one layer per final school, each with that school's species, flow and
//   speed, sized so the opening view's species shares follow the final's (checks/shares.py: snapper,
//   stripey, fusilier, seabream, snooty wrasse, parrotfish ~10-12 % each; knifejaw ~2 %).  Measured
//   with __fish.shares() (main.js debug handle), numbers in SYSTEMS.md.
function populate(fs, comp, cam0) {
  const sw = Object.fromEntries(comp.swarms.map((s) => [s.name, s]));
  const missing = [];
  const have = (n) => {
    if (sw[n]) return sw[n];
    if (!missing.includes(n)) missing.push(n);
    return null;
  };
  const sps = (n) => sw[n].species.map((s) => [s.id, s.weight, s.length_m]);
  const spd = (n) => [sw[n].inputs['Speed Min'], sw[n].inputs['Speed Max']];
  // the final's swim for a species' placed role (rockfish resting, John Dory / filefish hovering);
  // the extra fish of the same species scattered below swim the same way (fish.js swimAs)
  const roleSwim = {};
  for (const p of comp.placed) if (p.kind !== 'fg' && p.fishswim && !roleSwim[p.id]) roleSwim[p.id] = p.fishswim;

  // ---- Ambient shoals (toroidal around the camera) ----
  // Counts are the q = 1 budget; the adaptive controller thins them by a per-fish random rank, so
  // lowering quality thins evenly everywhere.  Near layers are where the fill cost is (big on screen,
  // overlapping), so they sit in a 20 m box and are dense in the 0.4-6 m band; the far layers are many
  // tiny fish (cheap: a few pixels each) that make the hazy wall behind, as in the Blender final.
  //
  // One layer per final school (def.from = composition swarms): species = those swarms' mixes weighted
  // by their instance counts, flows = their directions weighted the same way, speeds = their range.
  // WHY per school and not one mixed reef layer: a layer gives every fish one of its flows at random,
  // so a mixed layer would send every species every way; per school, the seabream keep the final's
  // counter-current, the fusiliers swim away, the snapper with the main current — the opening view
  // reads as several schools crossing, as in the final, instead of confetti.
  // FLAT_Y: ambient layers bounce between their height band's edges (fish.js update), so the steep
  // lanes (knife_rise +0.57, silver_dive -0.60 vertical) would see-saw the whole layer; those climbs
  // and dives stay in the world-fixed streams below, the ambient copies swim nearly level.
  const FLAT_Y = 0.15;
  const ambient = (def) => {
    const from = def.from.filter(have);
    const flowsFrom = (def.flowsFrom || def.from).filter(have);
    if (!from.length || !flowsFrom.length) return;
    const acc = new Map();
    for (const n of from) {
      const s = sw[n], tot = s.species.reduce((a, x) => a + x.weight, 0) || 1;
      for (const x of s.species) {
        const e = acc.get(x.id) || [x.id, 0, [x.length_m[0], x.length_m[1]]];
        e[1] += s.count * x.weight / tot;
        e[2][0] = Math.min(e[2][0], x.length_m[0]); e[2][1] = Math.max(e[2][1], x.length_m[1]);
        acc.set(x.id, e);
      }
    }
    const flows = flowsFrom.map((n) => {
      const d = sw[n].direction.three;
      return [[d[0], Math.max(-FLAT_Y, Math.min(FLAT_Y, d[1])), d[2]], sw[n].count];
    });
    const speed = [Math.min(...from.map((n) => spd(n)[0])), Math.max(...from.map((n) => spd(n)[1]))];
    fs.addLayer({ name: def.name, half: def.half ?? 10, y: def.y, ydist: def.ydist, count: def.count,
      speed, species: [...acc.values()], flows }, cam0);
  };
  // Counts (q = 1): tuned in 3 rounds with __fish.shares() in the poster framing (?poster=1, seeds
  // 7/11/23 x 6 times) against the final's checks/shares.py numbers.  Final result (these counts):
  // stripey 12.7 / snapper 12.1 / parrot 10.8 / snooty 9.9 / fusilier 9.7 / seabream 9.4 / knifejaw 2.9 %
  // (final 11.2 / 12.0 / 10.0 / 10.1 / 10.9 / 10.7 / 2.1), inverse Simpson 11.83 (final 11.9; the web
  // before this sync: stripey 62.2, knifejaw 18.4, 2.32) — checks/web/div_shares_poster*.json.  The first guess
  // (seabream 1300, snooty 900, parrot 900, angel 350, knife 300) gave seabream 7.7 / angelfish 5.3 /
  // knifejaw 3.8 %.  Then every near-band layer x1.22 (same mix): at 9.3k the near band had less fill
  // than the old 11.4k (9,000 stripey + 1,500 knifejaw + 900 parrot; fish-covered share of the poster
  // frame's 2nd/3rd fifths 0.85/0.83 vs the old web's 0.93/0.92); at 11.3k it is 0.87/0.85 with the old
  // web's instance count (38.5k simulated vs 39.0k) and CPU (9.2 vs 9.1 ms).  More near fish would not
  // close the rest: it is the recomposed final's own slabs (its coverage fell 0.752 -> 0.709 too).
  // Silver band 4.9k (was 5,000 saury/flyingfish/needlefish), far layers unchanged.  The knifejaw keep a
  // tiny layer: most of their ~3 % comes from the knife_rise stream; red-naped wrasse ride with the
  // pillar mill's mix (reef_mix).
  for (const def of [
    { name: 'snapper', from: ['snapper', 'snapper_far'], count: 2200, y: [0.8, 5.5], ydist: 'tri' },
    { name: 'stripey', from: ['stripey_low', 'stripey_core', 'stripey_lowfar'], count: 1220, y: [0.4, 4.0], ydist: 'tri' },
    { name: 'seabream', from: ['seabream_counter', 'seabream_toward'], count: 2440, y: [1.0, 6.0], ydist: 'tri' },
    { name: 'snooty', from: ['snooty_near'], count: 1590, y: [0.6, 3.2] },
    { name: 'fusilier', from: ['fusilier_away', 'fusilier_mid'], count: 2070, half: 12, y: [1.5, 8.0], ydist: 'tri' },
    { name: 'parrot', from: ['parrot', 'parrot_low', 'parrot_mid'], count: 610, y: [0.45, 3.6] },
    { name: 'goat', from: ['goat_near'], count: 460, y: [0.3, 1.6] },
    { name: 'angel', from: ['angel_drift'], count: 245, y: [0.8, 3.5] },
    { name: 'knife', from: ['knife_rise'], count: 100, y: [0.6, 3.6] },
    // the pillar mill's mix (red-naped wrasse / stripey / parrotfish) cruising with the low stripey
    // band: a vortex has no flow direction of its own
    { name: 'reef_mix', from: ['wrasse_mill'], flowsFrom: ['stripey_low'], count: 365, y: [0.4, 2.6] },
    { name: 'mackerel', from: ['mackerel'], count: 2200, half: 12, y: [2.8, 10.5], ydist: 'tri' },
    { name: 'sardine', from: ['sardine_near'], count: 1800, half: 12, y: [2.0, 8.0], ydist: 'tri' },
    { name: 'saury', from: ['silver_dive'], flowsFrom: ['far_silver'], count: 900, half: 12, y: [2.5, 9.0] },
    { name: 'far_reef', from: ['far_reef'], count: 8000, half: 26, y: [0.35, 8], ydist: 'tri' },
    // (the old web added little tuna here so the species appeared somewhere; the final's mackerel
    // school now carries them, and the web-only bait ball below)
    { name: 'far_silver', from: ['far_silver'], count: 2600, half: 28, y: [5, 15] },
  ]) ambient(def);

  // ---- World-fixed vortices: the composition's mills ----
  // Every vortex swarm, whatever its name.  The one centred on the pillar circles the rock itself:
  // inner radius = pillar keepout + a body length, so its fish orbit the stone instead of the mill's
  // nominal annulus (which, analytic and unsteered, would cut through it).
  const pillars = keepouts.filter((k) => k.name.startsWith('KEEPOUT_Pillar'));
  const pillarFoot = pillars.reduce((a, k) => (!a || k.y0 < a.y0 ? k : a), null);
  const pillarR = Math.max(...pillars.filter((k) => k.y0 < 1.5).map((k) => k.r));
  for (const s of comp.swarms) {
    if (s.mode !== 'vortex' || !s.domain_center) continue;
    const c = s.domain_center.three;
    const atPillar = pillarFoot && Math.hypot(c[0] - pillarFoot.x, c[2] - pillarFoot.z) < pillarFoot.r;
    fs.addVortex({ center: c, diameter: s.domain_size[0], height: s.domain_size[2], count: s.count,
      species: sps(s.name), speed: spd(s.name), spin: s.args.vortex_spin, inner: s.args.vortex_inner,
      taper: s.args.vortex_taper, bob: s.inputs['Vortex Bob'],
      ...(atPillar ? { innerAbs: pillarR + 0.25, diameter: (pillarR + 0.7) * 2, taper: 0.1 } : {}) });
  }
  // Web-only bait ball.  The final dropped its own in fix round 2 (at 13.5 m it sat entirely behind the
  // wall: 3.8 % of its region's pixels changed with it, compose.py 'BAIT BALL DROPPED'); a free camera
  // can swim up to it, so the web keeps one where the final had it (last exported composition
  // 'baitball': centre three (-2.89, 9.51, -11.51), 6 x 6 x 5 m, spin -1, inner 0.3, taper 0.45, bob
  // 0.17, 0.42-0.71 m/s).  Sardines now — the classic bait-ball fish, new in the library — with little
  // tuna circling in it (was saury + tuna; saury already have the diving stream and the far specks).
  fs.addVortex({ center: [-2.89, 9.51, -11.51], diameter: 6, height: 5, count: 900,
    species: [['sardine', 3, [0.18, 0.24]], ['little-tuna', 0.6, [0.3, 0.4]]], speed: [0.42, 0.71],
    spin: -1, inner: 0.3, taper: 0.45, bob: 0.17 });

  // Giants: hammerheads on a long loop at the fog edge (composition 'giants': 2.1-2.5 m, 1.2-1.6
  // m/s), and eagle rays (not in the final, a natural cruiser) on a higher, opposite loop.
  // Loops stay above every boulder top they pass (Boulder_08 3.6 m) and below the bait ball.
  const g = have('giants');
  const gSpd = g ? [g.inputs['Speed Min'], g.inputs['Speed Max']] : [1.2, 1.6];
  for (let n = 0; n < 3; n++) {
    // (QA2) the first one cruises a tighter loop whose near side passes right over the pillar,
    // ~4.5 m from the start position and inside the opening view, so a 2.3 m shark really passes
    // close through the schools every ~30 s — the 'huge fish passing close' the scene
    // promises; on the fog-edge loops alone the sharks were never nearer than ~10 m from the start
    // (a first tighter loop 6 m out read as a small pale shark behind the pillar top,
    // checks/web/qa2_shark_pass_*.png).  The loop (x -8..10, z -13.1..-3.9, y 2.7..3.3) clears every
    // rock top it crosses (pillar top 2.03 m, Boulder_02/10/11 < 0.8 m; Boulder_07 stays 2.8 m off
    // its axis), stays above both mills (< 2.1 m) and below the bait ball (> 7 m); the schools part
    // around it (fish.js giants).
    const near = n === 0;
    fs.addPath('hammerhead', 2.1 + 0.4 * fs.rng(), near
      ? { center: [1, 3.0, -8.5], rx: 9, rz: 4.6, yAmp: 0.3, speed: 1.25, theta0: 1.2, dir: -1 }
      : { center: [-1.5, 4.6 + n * 0.5, -12], rx: 15 + n * 1.5, rz: 10 + n, yAmp: 0.6,
        speed: gSpd[0] + (gSpd[1] - gSpd[0]) * fs.rng(), theta0: n * 2.1, dir: -1 });
  }
  for (let n = 0; n < 2; n++) {
    fs.addPath('eagle-ray', 1.5 + 0.3 * fs.rng(), { center: [2, 6.8 + n * 0.8, -9], rx: 13 + n * 2, rz: 15, yAmp: 0.8, speed: 0.9, theta0: n * 3.1, dir: 1 });
  }
  // sea eels slither along the sand on wide loops (composition 'eel': one along the sand).
  // The loop is nudged (centre +-3 m, radii +-30 %) until it misses every rock.  WHY: an analytic
  // loop is not steered, and the hand-set loops ran the eels through the pillar's foot (0.5 m deep)
  // and Boulders 02 / 08 (QA, 120 s of loop sampled).
  for (let n = 0; n < 3; n++) {
    const L = 0.55 + 0.15 * fs.rng();
    let c = [0.5 - n * 2, 0, -6 - n * 3], rx = 6 + n * 3, rz = 4 + n * 2;
    for (let tries = 0; tries < 60 && !fs.orbitClear(c[0], c[2], rx, rz, 0, 0.3, 0.5 * L + 0.15); tries++) {
      c = [0.5 - n * 2 + (fs.rng() * 2 - 1) * 3, 0, -6 - n * 3 + (fs.rng() * 2 - 1) * 3];
      rx = (6 + n * 3) * (0.7 + 0.6 * fs.rng()); rz = (4 + n * 2) * (0.7 + 0.6 * fs.rng());
    }
    fs.addPath('sea-eel', L, { center: c, rx, rz,
      speed: 0.45 + 0.1 * fs.rng(), theta0: n * 2, dir: n % 2 ? 1 : -1, onSand: true });
  }

  // Placed fish from scenes/final, exactly where they are (bed fish, the rockfish on Boulder_02 and at
  // the pillar foot, the John Dory and rosy dory hovering over the sand, the filefish at the pillar face,
  // the lionfish), each with the final's swim for that role (fishswim: resting / hovering, fish.js
  // swimAs).  The 'fg' fish are skipped: their A->B paths are framed for the fixed poster camera.
  for (const p of comp.placed) {
    if (p.kind === 'fg') continue;
    fs.addStatic(p.id, p.length_m, p.position.three, p.quaternion_three, p.fishswim);
  }

  // Extra benthic fish scattered over the sand so the floor stays alive wherever you swim.
  // (frutiger 10-05) on the seabed relief: the fish lies ALONG the dune slope (body up axis = the sand normal,
  // sandHeight.normalAt) and its belly sits on the sand under its centre.  WHY: on 2.8 m sand waves with up to
  // ~30 cm troughs a level fish at the centre height floats over the downhill end and cuts into the uphill
  // one (a 0.5 m flounder on a 15 % slope: +-4 cm).  Slopes are gentle, so the bbox-min offset along the
  // tilted up axis is still the right seat; 0.9 = the scan's belly sinks a little into the sand, as before.
  const rest = (id, L, x, z, yaw) => {
    const S = fs.byId[id].spec;
    const nrm = new THREE.Vector3(...env.sandHeight.normalAt(x, z, Math.max(0.1, 0.4 * L)));
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), nrm).multiply(qYaw);
    const off = -S.bbox_three.min[1] * L * 0.9;
    const p = [x + nrm.x * off, env.sandHeight.at(x, z) + nrm.y * off, z + nrm.z * off];
    return fs.addStatic(id, L, p, q.toArray(), roleSwim[id] || null);
  };
  // (2026-10-05) + yellowbarred rockfish: the final rests them on rocks and sand ('rock' placed fish)
  const bed = [['gurnard', 20], ['flounder', 14], ['goosefish', 5], ['sleeper-ray', 8], ['sailfin-poacher', 8],
    ['mudskipper', 12], ['carcharhinus-altimus', 2], ['yellowbarred-rockfish', 8]];
  for (const [id, n] of bed) {
    if (!fs.byId[id]) continue;
    for (let j = 0; j < n; j++) {
      for (let tries = 0; tries < 20; tries++) {
        const r = 2.5 + 36 * Math.pow(fs.rng(), 1.4), a = fs.rng() * 6.2832;
        const x = Math.cos(a) * r, z = -6 + Math.sin(a) * r;
        if (fs.insideKeepout(x, 0.1, z, 0.4)) continue;
        rest(id, fs.lenFor(id), x, z, fs.rng() * 6.2832);
        break;
      }
    }
  }
  // Reef hoverers near the rocks: the boxy species + pipefish + more lionfish (all 'reef' habitat),
  // and (2026-10-05) the new slow hoverers: filefish at rock faces, John Dory and rosy dory low over
  // the bottom (the final hovers one of each; here a few more, with the final's hovering swim).
  const anchors = keepouts.filter((k) => k.h < 3 || k.name.includes('Pillar'));
  const hover = [['diodon-hystrix', 4], ['lactophrys-bicaudalis', 4], ['pinecone-fish', 7], ['pipefish', 5], ['lionfish', 3],
    ['phyllopteryx-taeniolatus', 2], ['goishi-filefish', 5], ['john-dory', 3], ['rosy-dory', 3]];
  for (const [id, n] of hover) {
    if (!fs.byId[id]) continue;
    for (let j = 0; j < n; j++) {
      // retry until the whole Lissajous box (+-amp in x and z) clears every cylinder at that height
      for (let tries = 0; tries < 30; tries++) {
        const ko = anchors[Math.floor(fs.rng() * anchors.length)];
        const a = fs.rng() * 6.2832, amp = 0.25 + 0.35 * fs.rng();
        const R = ko.r + amp * 1.45 + 0.3 + 0.4 * fs.rng();
        const L = fs.lenFor(id);
        const y = Math.max(0.35, Math.min(ko.y0 + ko.h + 0.4, 0.3 + 1.4 * fs.rng())) + L * 0.3;
        const ax = ko.x + Math.cos(a) * R, az = ko.z + Math.sin(a) * R;
        if (fs.insideKeepout(ax, y, az, amp * 1.45 + 0.5 * L)) continue;
        fs.addHover(id, L, { anchor: [ax, y, az], amp: [amp, 0.08, amp], w: 0.12 + 0.1 * fs.rng(), swim: roleSwim[id] || null });
        break;
      }
    }
  }

  // (QA2 round 2) The final's hero river: every composition stream that has a box (now the snapper,
  // seabream, fusilier, snooty wrasse, stripey, parrotfish, goatfish, angelfish, knifejaw, saury,
  // sardine and mackerel slabs in front of CAM_Main), world-fixed where scenes/final has it, at its own
  // count and species mix.  See FishSystem.addStream for why.  Added LAST so the random sequence of
  // everything above is not disturbed by a stream change.  ?streams=0 turns them off (for
  // comparison), ?streams=0.5 halves them.
  const sDens = params.has('streams') ? Math.max(0, Math.min(2, +params.get('streams'))) : (MOBILE ? MOBILE_PERF.streams : 1);
  fs.streamCount = 0;
  if (sDens > 0) {
    for (const s of comp.swarms) {
      if (s.mode !== 'stream' || !s.domain_center || !s.domain_size || s.name === 'eel' || s.name === 'giants') continue;
      fs.streamCount += fs.addStream({ name: s.name, center: s.domain_center.three, size: s.domain_size, dir: s.direction.three,
        count: Math.round(s.count * sDens), species: sps(s.name), speed: spd(s.name), wanderDeg: s.args?.wander_deg ?? 12 });
    }
  }
  fs.missingSwarms = missing;
  if (missing.length) {
    console.error(`[populate] composition.json has no swarm(s) ${missing.join(', ')} — web/js/main.js populate() is out of date with the export; those layers are skipped`);
  }
}
