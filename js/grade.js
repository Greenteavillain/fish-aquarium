// The colour grade of scenes/final (compose.py setup_grade), as a three.js custom tone mapping.
//
// WHY (QA2, look): without it the web frame was the UNGRADED Blender look the final's own QA had
// rejected — the stripey river read pale khaki instead of golden, and the water flat cyan instead of
// teal-blue (checks/web/qa2_t0_poster.png next to final_f001).  The final grades in four steps:
//   1. compositor Hue Correct (scene-linear, HSV): a hue curve that rotates the cyan band toward blue
//      (by look.hue_rot) and pulls yellow-green 9 deg back toward yellow, and a saturation-by-hue curve
//      that lifts ONLY the warm hues (yellow x1.64, orange x1.44, red x1.24; teal x1.06-1.10), times
//      look.warm_sat on the warm points;
//   2. Hue/Saturation: saturation x look.sat;
//   3. Lift/Gamma/Gain: look.lift / look.gain — warm highlights, cool darks;
//   4. view settings: a gentle S-curve (look.view_curve, applied before exposure, Blender's order),
//      exposure, Khronos PBR Neutral.
// The final's 5th step, a graduated multiply over the top 40 % of the frame (look.top: 0.84 = darken in
// the aquarium look, 1.08 = LIFT in the frutiger look), is NOT done here in screen space: with a free
// camera it would brighten / darken whatever you look at, including the sand.  (frutiger 10-05) It is
// done in WORLD space instead, by view elevation (water.js topLift: 'brighter toward the surface'),
// over the elevations the poster frame's top 40 % covers — the same pixels in the poster framing.
//
// (frutiger 10-05) Parametrised by composition.look (web_export_comp._look = compose LOOKS[preset] as
// saved in the scene).  WHY: the frutiger look changed every value (curve toe 0.155 -> 0.165, hue_rot
// 0.055 -> 0.045, sat 1.04 -> 1.10, warm_sat 1.08, lift/gain); hard-coded aquarium values would have
// kept the web on the old, darker grade.  Missing values fall back to the aquarium (fix3) grade.
//
// Not ported: the frutiger look's compositor BLOOM (threshold 1.25 scene-linear, strength 0.20).  WHY:
// a bloom needs the whole frame in an HDR render target + a blur chain + a resolve, i.e. the
// post-process pipeline this file exists to avoid (fish are fill/vertex bound; the canvas keeps MSAA),
// and three applies tone mapping only when drawing to the canvas, so every material's grade would move
// into an output pass.  What the bloom does in the poster — a glow on caustic knots, shaft cores and
// bubble rims — is drawn by those elements themselves (env.js caustic glow, fx.js shafts / bubbles).
//
// WHY a custom tone mapping and not a post-process pass: three applies tone mapping at the end of
// every material's fragment shader, so the grade costs a few dozen ALU ops per shaded fragment and no
// extra full-screen pass, render target or resolve (fish are fill/vertex bound; the canvas keeps
// MSAA).  Every material that is tone mapped (fish, rocks, sand, water dome, snow) gets the same
// grade, exactly like a compositor pass over the whole image.  The additive light shafts are not
// tone mapped (toneMapped:false, a glow added on top) and so are not graded either.
import * as THREE from 'three';

// Curve points of scenes/final/compose.py setup_grade.  The saturation points are the BASE curve;
// warm_sat multiplies the warm points (x <= 0.26 or x >= 0.88), as compose does.
const SAT_BASE = [[0.0, 0.62], [0.06, 0.72], [0.13, 0.82], [0.19, 0.82], [0.26, 0.62], [0.33, 0.53],
  [0.45, 0.53], [0.52, 0.55], [0.60, 0.55], [0.70, 0.53], [1.0, 0.62]];
const hueBase = (hr) => [[0.0, 0.5], [0.10, 0.5], [0.17, 0.475], [0.21, 0.475], [0.28, 0.5], [0.40, 0.5],
  [0.49, 0.5 + hr], [0.555, 0.5 + hr], [0.655, 0.5], [1.0, 0.5]];
// aquarium (fix3) values = what this file hard-coded before the frutiger look
const AQUARIUM = { hue_rot: 0.055, sat: 1.04, lift: [0.99, 1.0, 1.01], gain: [1.035, 1.0, 0.965], warm_sat: 1.0, top: 0.84,
  curve: [[0.0, 0.0], [0.18, 0.155], [0.5, 0.515], [0.82, 0.85], [1.0, 1.0]] };

/** grade parameters from composition.look (falls back to the aquarium grade for an older export) */
export function gradeParams(look) {
  const v = look?.values || {};
  const p = {
    preset: look?.preset || 'aquarium',
    hueRot: v.hue_rot ?? AQUARIUM.hue_rot, sat: v.sat ?? AQUARIUM.sat, lift: v.lift ?? AQUARIUM.lift,
    gain: v.gain ?? AQUARIUM.gain, warmSat: v.warm_sat ?? AQUARIUM.warm_sat, top: v.top ?? AQUARIUM.top,
    curve: look?.view_curve || v.curve || AQUARIUM.curve,
  };
  p.satPts = SAT_BASE.map(([x, y]) => [x, (x <= 0.26 || x >= 0.88) ? y * p.warmSat : y]);
  p.huePts = hueBase(p.hueRot);
  return p;
}

// Monotone cubic (Fritsch-Carlson).  WHY: Blender's curves use AUTO_CLAMPED handles, which keep
// flat runs flat and never overshoot between points (the final's fixer measured that plain AUTO
// handles overshot the hue curve to 0.521 at teal and shifted ALL water +7.6 deg).  A monotone
// Hermite spline has the same two properties.
function monotone(pts) {
  const n = pts.length, dx = [], m = [], t = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) { dx[i] = pts[i + 1][0] - pts[i][0]; m[i] = (pts[i + 1][1] - pts[i][1]) / dx[i]; }
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], h = Math.hypot(a, b);
    if (h > 3) { t[i] = 3 * a / h * m[i]; t[i + 1] = 3 * b / h * m[i]; }
  }
  return (x) => {
    if (x <= pts[0][0]) return pts[0][1] + t[0] * (x - pts[0][0]);
    if (x >= pts[n - 1][0]) return pts[n - 1][1] + t[n - 1] * (x - pts[n - 1][0]);
    let i = 0; while (x > pts[i + 1][0]) i++;
    const h = dx[i], s = (x - pts[i][0]) / h, s2 = s * s, s3 = s2 * s;
    return (2 * s3 - 3 * s2 + 1) * pts[i][1] + (s3 - 2 * s2 + s) * h * t[i] + (-2 * s3 + 3 * s2) * pts[i + 1][1] + (s3 - s2) * h * t[i + 1];
  };
}
const N = 64;
const tableOf = (f) => Array.from({ length: N + 1 }, (_, i) => +f(i / N).toFixed(5));

/** the grade's lookup tables (the SAME 65-sample tables the shader interpolates, so the JS twin below
 *  reproduces the GPU result, not the ideal curve) */
function buildTables(P) {
  const hue = monotone(P.huePts), sat = monotone(P.satPts), s = monotone(P.curve);
  const T = { hue: tableOf(hue), sat: tableOf(sat), s: tableOf(s) };
  T.s1 = +s(1).toFixed(5);
  T.sEnd = +((s(1) - s(1 - 1 / N)) * N).toFixed(5);        // slope used above 1.0
  return T;
}

function gradeGLSL(P, T) {
  const L = [2 - P.lift[0], 2 - P.lift[1], 2 - P.lift[2]].map((v) => v.toFixed(5)).join(', ');
  const G = P.gain.map((v) => (+v).toFixed(5)).join(', ');
  return /* glsl */`
const float GR_HUE[${N + 1}] = float[${N + 1}](${T.hue.map((v) => v.toFixed(5)).join(', ')});
const float GR_SAT[${N + 1}] = float[${N + 1}](${T.sat.map((v) => v.toFixed(5)).join(', ')});
const float GR_S[${N + 1}] = float[${N + 1}](${T.s.map((v) => v.toFixed(5)).join(', ')});
#define GR_LUT(T, x) mix(T[int(floor(clamp(x, 0.0, 1.0) * ${N.toFixed(1)}))], T[min(${N}, int(floor(clamp(x, 0.0, 1.0) * ${N.toFixed(1)})) + 1)], fract(clamp(x, 0.0, 1.0) * ${N.toFixed(1)}))
vec3 gr_rgb2hsv(vec3 c) {
  float mx = max(c.r, max(c.g, c.b)), mn = min(c.r, min(c.g, c.b)), d = mx - mn;
  float h = 0.0;
  if (d > 1e-8) {
    if (mx == c.r) h = (c.g - c.b) / d + (c.g < c.b ? 6.0 : 0.0);
    else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
    else h = (c.r - c.g) / d + 4.0;
    h /= 6.0;
  }
  return vec3(h, mx > 1e-8 ? d / mx : 0.0, mx);
}
vec3 gr_hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
float gr_lin2srgb(float x) { return x < 0.0031308 ? 12.92 * x : 1.055 * pow(x, 1.0 / 2.4) - 0.055; }
float gr_srgb2lin(float x) { return x < 0.04045 ? x / 12.92 : pow((x + 0.055) / 1.055, 2.4); }
float gr_s(float x) { return x > 1.0 ? ${T.s1.toFixed(5)} + ${T.sEnd.toFixed(5)} * (x - 1.0) : GR_LUT(GR_S, x); }
vec3 CustomToneMapping(vec3 color) {
  vec3 c = max(color, vec3(0.0));
  // 1. Hue Correct: hue shift first, then saturation evaluated at the SHIFTED hue (Blender order)
  vec3 hsv = gr_rgb2hsv(c);
  hsv.x += GR_LUT(GR_HUE, hsv.x) - 0.5;
  hsv.y *= 2.0 * GR_LUT(GR_SAT, hsv.x - floor(hsv.x));
  // 2. Hue/Saturation x look.sat
  hsv.y = clamp(hsv.y * ${(+P.sat).toFixed(5)}, 0.0, 1.0);
  hsv.x -= floor(hsv.x);
  c = gr_hsv2rgb(hsv);
  // 3. Lift/Gamma/Gain, Blender's formula (in sRGB-encoded values): ((srgb - 1) * (2 - lift) + 1) * gain
  const vec3 LIFT = vec3(${L}), GAIN = vec3(${G});
  c = vec3(gr_lin2srgb(c.r), gr_lin2srgb(c.g), gr_lin2srgb(c.b));
  c = max(((c - 1.0) * LIFT + 1.0) * GAIN, 0.0);
  c = vec3(gr_srgb2lin(c.r), gr_srgb2lin(c.g), gr_srgb2lin(c.b));
  // 4. view S-curve per channel (before exposure), then exposure + Khronos PBR Neutral
  c = vec3(gr_s(c.r), gr_s(c.g), gr_s(c.b));
  return NeutralToneMapping(c);
}
`;
}

// ---- JS twin of the GLSL above (+ three's NeutralToneMapping and the sRGB output transfer) ----
const lin2srgb = (x) => (x < 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
const srgb2lin = (x) => (x < 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const fract = (x) => x - Math.floor(x);
function lut(T, x) {
  const c = Math.min(1, Math.max(0, x)) * N, i = Math.floor(c);
  return T[i] + (T[Math.min(N, i + 1)] - T[i]) * (c - i);
}
function rgb2hsv([r, g, b]) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-8) {
    if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, mx > 1e-8 ? d / mx : 0, mx];
}
function hsv2rgb([h, s, v]) {
  return [1, 2 / 3, 1 / 3].map((o) => {
    const p = Math.min(1, Math.max(0, Math.abs(fract(h + o) * 6 - 3) - 1));
    return v * (1 + (p - 1) * s);
  });
}
/** three.js NeutralToneMapping (Khronos PBR Neutral) on an already-exposed colour */
export function neutral([r, g, b]) {
  const sc = 0.76, ds = 0.15;
  const x = Math.min(r, g, b), off = x < 0.08 ? x - 6.25 * x * x : 0.04;
  r -= off; g -= off; b -= off;
  const peak = Math.max(r, g, b);
  if (peak < sc) return [r, g, b];
  const d = 1 - sc, np = 1 - (d * d) / (peak + d - sc);
  r *= np / peak; g *= np / peak; b *= np / peak;
  const gg = 1 - 1 / (ds * (peak - np) + 1);
  return [r + (np - r) * gg, g + (np - g) * gg, b + (np - b) * gg];
}
/**
 * (frutiger 10-05) forward model of what the screen shows for a scene-linear colour (before exposure):
 * the same grade + exposure + Neutral + sRGB OETF as the shaders.  Returns display sRGB 0..1.  Used by
 * water.js to build the water LUT straight from the Blender plate's display colours (inverting this).
 */
export function makeForward(P, exposure) {
  const T = buildTables(P);
  const LIFT = P.lift.map((v) => 2 - v), GAIN = P.gain;
  const sCurve = (x) => (x > 1 ? T.s1 + T.sEnd * (x - 1) : lut(T.s, x));
  return (col) => {
    let c = col.map((v) => Math.max(0, v));
    const hsv = rgb2hsv(c);
    hsv[0] += lut(T.hue, hsv[0]) - 0.5;
    hsv[1] *= 2 * lut(T.sat, fract(hsv[0]));
    hsv[1] = Math.min(1, Math.max(0, hsv[1] * P.sat));
    hsv[0] = fract(hsv[0]);
    c = hsv2rgb(hsv).map(lin2srgb).map((v, j) => Math.max(0, ((v - 1) * LIFT[j] + 1) * GAIN[j])).map(srgb2lin);
    c = c.map(sCurve).map((v) => v * exposure);
    return neutral(c).map((v) => lin2srgb(Math.min(1, Math.max(0, v))));
  };
}

/** Swap three's empty CustomToneMapping for the grade.  Must run before any material compiles.
 *  look = composition.look (frutiger 10-05); returns the grade parameters (or null when it fell back). */
export function installGrade(renderer, look) {
  const chunk = THREE.ShaderChunk.tonemapping_pars_fragment;
  const stub = /vec3 CustomToneMapping\(\s*vec3 color\s*\)\s*\{\s*return color;\s*\}/;
  if (!stub.test(chunk)) {
    // a three.js update changed the chunk: keep the plain Neutral look rather than break shaders
    console.warn('grade: CustomToneMapping stub not found, grade off');
    renderer.toneMapping = THREE.NeutralToneMapping;
    return null;
  }
  const P = gradeParams(look);
  THREE.ShaderChunk.tonemapping_pars_fragment = chunk.replace(stub, gradeGLSL(P, buildTables(P)));
  renderer.toneMapping = THREE.CustomToneMapping;
  return P;
}
