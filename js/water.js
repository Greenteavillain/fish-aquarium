// Water: the teal depth fog, the background, and the shared uniforms every material reads.
//
// WHY a custom fog instead of THREE.FogExp2:
//  1. three applies fog AFTER tone mapping and the sRGB transfer (fog_fragment comes last), so a fog
//     colour measured in scene-linear light would be mixed in display space and come out wrong.
//     The Blender water is a volume in scene-linear light, then the Khronos PBR Neutral view
//     transform.  We mix before tone mapping, which is the same order.
//  2. The water colour depends on the view ELEVATION (dark below the horizon, bright teal toward the
//     surface), measured from a fish-free Blender plate (composition.fog_measured).  A single fog
//     colour would turn the upward view into a grey wall.
//  3. Extinction is the exact Beer–Lambert 1 - exp(-sigma d) with sigma = water.extinction_per_m
//     (FogExp2 is exp(-(k d)^2): too clear up close, too thick far away).

import * as THREE from 'three';
import { neutral } from './grade.js';

export const WATER_LUT_N = 25;    // elevation -90..+90 deg in 7.5 deg steps
// (frutiger 10-05) The QA2 fit table WATER_FIT (per-node multipliers fitted against the fix3 final's plate,
// because the old LUT inverted only exposure + Neutral and so applied the grade twice) is gone: the LUT is
// now built by inverting the WHOLE web pipeline (grade.js makeForward: grade + exposure + Neutral + sRGB, and
// waterColor's sun term + topLift) for every measured row.  WHY: the frutiger look re-graded everything
// (curve, hue rotation, saturation, top lift), so the fitted multipliers no longer meant anything, and an
// exact inversion follows any future re-export without a re-fit.  Old table in checks/web/tmp/frutiger/backup.

// shared uniform objects: every patched material references these SAME objects, so one update per
// frame reaches all of them.
export const waterUniforms = {
  uWaterLUT: { value: Array.from({ length: WATER_LUT_N }, () => new THREE.Vector3()) },
  uFogSigma: { value: 0.045 },
  uSunDirW: { value: new THREE.Vector3(0.373, -0.889, 0.267) },   // direction the light TRAVELS (three)
  // (QA2) was (0.03, 0.05, 0.05) 'small: the LUT already holds the sun side'.  But the final plate is
  // much brighter on the sun side: row at 10 % height, left edge 163,212,238 vs right 81,140,179;
  // the web plate was flat (118,175,211 vs 85,143,183).  Scale fitted on the left 40 % of the final
  // plate's top 30 % (k = 0.38 of the glow's own colour 0.56 : 0.91 : 1, measured as left minus
  // right in linear light): rms 6.7 levels at k 0.45, 8.5 at 0.3, 30 with the old value.
  uSunScatter: { value: new THREE.Vector3(0.213, 0.346, 0.38) },
  uTime: { value: 0 },
  // (QA2) neon mode's water (0..1, follows fishUniforms.uNeon in main.js); see waterColor()
  uNeonWater: { value: 0 },
  // (frutiger 10-05) the look's graduated top multiply, in WORLD space: x (from, to elevation in radians,
  // factor at 'to').  See topLift() and grade.js.  (0, 1, 1) = off.
  uTopLift: { value: new THREE.Vector3(0, 1, 1) },
};

/**
 * Build the elevation LUT (scene-linear, before exposure) so that three's output MATCHES the
 * measured Blender plate on screen.
 * (frutiger 10-05) composition.fog_measured = the fish-free plate rendered WITH the scene's look
 * (display_srgb_255 per row, right half of the frame).  Each row's display colour is pushed back
 * through the exact forward model of the web pipeline (`forward` = grade.js makeForward: Hue Correct,
 * saturation, lift/gain, view curve, exposure, Neutral, sRGB) together with what waterColor() adds on
 * top of the LUT in that direction (sun in-scatter term, topLift) — Gauss-Newton with a numeric
 * Jacobian.  The plate's rows sample the right half of the frame, so the direction used for the sun
 * term is the one at ndc x = +0.5 of the poster camera.
 * Rows at -3 deg and below saw sand, not water; the downward half and the zenith are continuations of
 * the measured gradient (see below).
 */
export function buildWaterLUT(comp, exposure, forward) {
  const sun = comp.lights?.find((l) => l.name === 'SUN_Main');
  if (sun) waterUniforms.uSunDirW.value.fromArray(sun.direction.three).normalize();
  waterUniforms.uFogSigma.value = comp.water?.fog_three?.sigma ?? 0.045;
  const cam = comp.camera, c3 = cam.three;
  const f = new THREE.Vector3().fromArray(c3.forward), u = new THREE.Vector3().fromArray(c3.up), r = new THREE.Vector3().fromArray(c3.right);
  const ty = Math.tan(THREE.MathUtils.degToRad(cam.fov_vertical_deg) / 2), tx = Math.tan(THREE.MathUtils.degToRad(cam.fov_horizontal_deg) / 2);
  const dirAt = (nx, ny) => f.clone().addScaledVector(u, ny * ty).addScaledVector(r, nx * tx).normalize();
  const elevOf = (d) => THREE.MathUtils.radToDeg(Math.asin(d.y));
  // ndc y of the centre column at a given elevation (bisection; elevation rises with ndc y)
  const ndcYAt = (e) => { let lo = -3, hi = 3; for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (elevOf(dirAt(0, m)) < e) lo = m; else hi = m; } return (lo + hi) / 2; };
  // (frutiger 10-05) rows below +2.5 deg are dropped: the plate's horizon rows are medians over the right half
  // of the frame, where the right-hand boulders and the far sand line sit, and came out green-teal (1.05 deg:
  // 50,174,197) while the open water there is the same sky-blue as above (37,175,238 in the plate's own
  // pixels down to the sand line).  With them the web drew a teal band along the horizon.
  const rows = (comp.fog_measured?.rows || []).filter((q) => q.elevation_deg > 2.5).sort((a, b) => a.elevation_deg - b.elevation_deg);
  const lin = (c) => c.map((v) => srgbToLinear(v / 255));
  const disp = (l) => l.map((v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)));
  // Continuations outside the measured elevations (display sRGB 0-255):
  //  * below the horizon (fog colour of the sand at distance, looking down): the old hand-set shape
  //    (-90: 16,52,60 / -45: 30,88,98 / -15: 46,120,130 / 0: 60,142,148, made for a lowest water row of
  //    39,117,147) scaled per channel, in linear light, by how much the lowest measured row changed ->
  //    the frutiger turquoise floor haze is as much brighter as its horizon is;
  //  * above the top row (~50 deg): toward the surface the water keeps brightening at the slope of the
  //    top 10 deg of rows and eases toward a near-white aqua at the zenith (Frutiger: 'water fading to
  //    near-white toward the surface'), never past it.
  const lo0 = rows[0], hiR = rows[rows.length - 1];
  // (frutiger 10-05) the shape is anchored at its OWN 0 deg value (60,142,148) = the lowest clean water row, and
  // that row's colour is carried flat down to 0 deg (was: anchored on 39,117,147 and its 0 deg point kept,
  // which put a brighter green-teal node right under the lowest row = the horizon band above).
  const kLow = lin(lo0.display_srgb_255).map((v, j) => v / lin([60, 142, 148])[j]);
  const down = [[-90, [16, 52, 60]], [-45, [30, 88, 98]], [-15, [46, 120, 130]], [0, [60, 142, 148]]]
    .map(([e, c]) => [e, disp(lin(c).map((v, j) => Math.min(1, v * kLow[j])))]);
  const ZEN = [208, 244, 252];
  const hi10 = rows.filter((q) => q.elevation_deg > hiR.elevation_deg - 10.5)[0];
  const slope = hiR.display_srgb_255.map((v, j) => (v - hi10.display_srgb_255[j]) / Math.max(1, hiR.elevation_deg - hi10.elevation_deg));
  const up = [62, 75, 90].map((e) => {
    const lin1 = hiR.display_srgb_255.map((v, j) => v + slope[j] * (e - hiR.elevation_deg));
    const w = (e - hiR.elevation_deg) / (90 - hiR.elevation_deg);
    return [e, lin1.map((v, j) => Math.min(ZEN[j], v + (ZEN[j] - v) * w * w))];
  });
  const pts = [...down.filter(([e]) => e < 0), [Math.min(0, lo0.elevation_deg - 1), lo0.display_srgb_255], ...rows.map((q) => [q.elevation_deg, q.display_srgb_255]),
    ...up.filter(([e]) => e > hiR.elevation_deg)].sort((a, b) => a[0] - b[0]);
  const lut = waterUniforms.uWaterLUT.value;
  const linRows = rows.filter((q) => q.linear_rgb).map((q) => [q.elevation_deg, q.linear_rgb]);
  const sunDir = waterUniforms.uSunDirW.value, sc = waterUniforms.uSunScatter.value, tl = waterUniforms.uTopLift.value;
  const report = [];
  for (let i = 0; i < WATER_LUT_N; i++) {
    const e = -90 + (180 * i) / (WATER_LUT_N - 1);
    let k = 0;
    while (k < pts.length - 2 && pts[k + 1][0] < e) k++;
    const [e0, c0] = pts[k], [e1, c1] = pts[k + 1];
    const t = Math.min(1, Math.max(0, (e - e0) / (e1 - e0)));
    const target = [0, 1, 2].map((j) => (c0[j] + (c1[j] - c0[j]) * t) / 255);
    // the direction this node is seen in, in the measured half of the poster frame (sun term)
    const d = (e > -60 && e < 75) ? dirAt(0.5, ndcYAt(e)) : new THREE.Vector3(0, Math.sin(THREE.MathUtils.degToRad(e)), -Math.cos(THREE.MathUtils.degToRad(e)));
    const mu = -d.dot(sunDir), g = 0.55, hg = (1 - g * g) / Math.pow(1 + g * g - 2 * g * mu, 1.5), hs = hg - 0.75;
    const er = THREE.MathUtils.degToRad(e);
    const tlf = 1 + (tl.z - 1) * smooth(tl.x, tl.y, er);
    const shown = (L) => forward([0, 1, 2].map((j) => (hs > 0 ? L[j] + sc.getComponent(j) * hs * 0.25 : L[j] * (1 + hs * 0.35)) * tlf));
    const err = (L) => { const y = shown(L); return Math.max(...target.map((v, j) => Math.abs(v - y[j]))); };
    // Damped Gauss-Newton on the 3 channels, from several starts, keeping the best.
    // (frutiger 10-05) WHY several starts: from the Neutral-only inverse alone the solve stalled on the
    // saturated sky-blue rows (display 35-45,175,238: the grade's HSV hue curve + the R channel clamped at 0
    // trapped it) and the open water came out royal blue (24,132,239) in a band across the frame.  The
    // plate's own scene-linear radiance at that elevation (fog_measured linear_rgb, the SAME pixels before the
    // view transform) is an almost exact start — the web forward model maps it to the plate's display colour
    // within 1-4 levels — and the previous node's solution covers the continuations outside the rows.
    const starts = [invNeutral(target.map(srgbToLinear)).map((v) => v / exposure)];
    if (linRows.length) {
      const ee = Math.min(linRows[linRows.length - 1][0], Math.max(linRows[0][0], e));
      let q = 0; while (q < linRows.length - 2 && linRows[q + 1][0] < ee) q++;
      const u = Math.min(1, Math.max(0, (ee - linRows[q][0]) / Math.max(1e-6, linRows[q + 1][0] - linRows[q][0])));
      starts.push([0, 1, 2].map((j) => (linRows[q][1][j] + (linRows[q + 1][1][j] - linRows[q][1][j]) * u) / tlf));
    }
    if (i > 0) starts.push(lut[i - 1].toArray());
    let best = null, bestErr = Infinity;
    for (const s0 of starts) {
      let L = s0.slice(), e0 = err(L);
      for (let it = 0; it < 60 && e0 > 1e-5; it++) {
        const y0 = shown(L), res = target.map((v, j) => v - y0[j]);
        const J = [0, 1, 2].map((j) => { const h = Math.max(1e-5, L[j] * 1e-3); const Lp = L.slice(); Lp[j] += h; const y1 = shown(Lp); return y1.map((v, m) => (v - y0[m]) / h); });
        // J[j][m] = d y_m / d L_j  -> solve (J^T)^T dx = res, i.e. A dx = res with A[m][j] = J[j][m]
        const A = [0, 1, 2].map((m) => [J[0][m], J[1][m], J[2][m]]);
        const dx = solve3(A, res);
        if (!dx) break;
        // backtracking: take the largest of 1, 1/2, 1/4 ... that lowers the error
        let k = 1, ok = false;
        for (let h = 0; h < 10; h++, k *= 0.5) {
          const Ln = L.map((v, j) => Math.max(0, v + k * dx[j])), en = err(Ln);
          if (en < e0) { L = Ln; e0 = en; ok = true; break; }
        }
        if (!ok) break;
      }
      if (e0 < bestErr) { bestErr = e0; best = L; }
    }
    const L = best;
    lut[i].set(L[0], L[1], L[2]);
    report.push({ e, target: target.map((v) => Math.round(v * 255)), got: shown(L).map((v) => Math.round(v * 255)), lin: L.map((v) => +v.toFixed(4)) });
  }
  return report;
}

function smooth(e0, e1, x) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
function solve3(A, b) {
  const m = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < 3; c++) {
    let piv = c; for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
    if (Math.abs(m[piv][c]) < 1e-12) return null;
    [m[c], m[piv]] = [m[piv], m[c]];
    for (let r = 0; r < 3; r++) if (r !== c) { const k = m[r][c] / m[c][c]; for (let q = c; q < 4; q++) m[r][q] -= k * m[c][q]; }
  }
  return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
}

/** (frutiger 10-05) the look's top multiply by view elevation: x1 below the elevation the poster frame's 60 %
 *  height row looks at, x top at its top row's elevation (smoothstep), like compose setup_grade's screen
 *  ramp in the poster framing, but tied to the world (looking up = brighter, wherever you are). */
export function setTopLift(comp, top) {
  const cam = comp.camera;
  const half = cam.fov_vertical_deg / 2, pitch = cam.three.pitch_deg_up ?? 17;
  const e60 = pitch + THREE.MathUtils.radToDeg(Math.atan(0.2 * Math.tan(THREE.MathUtils.degToRad(half))));
  waterUniforms.uTopLift.value.set(THREE.MathUtils.degToRad(e60), THREE.MathUtils.degToRad(pitch + half), top ?? 1);
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
// three.js NeutralToneMapping (Khronos PBR Neutral) inverse (forward: grade.js neutral).  By fixed-point on the
// toe offset (its only coupling) plus the closed-form inverse of the highlight compression.
function invNeutral(out) {
  let v = out.map((c) => c + 0.04);
  for (let it = 0; it < 40; it++) {               // Newton-free: correct by the residual
    const f = neutral(v);
    v = v.map((c, j) => Math.max(0, c + (out[j] - f[j])));
  }
  return v;
}

export const WATER_PARS_GLSL = /* glsl */`
#define WATER_LUT_N ${WATER_LUT_N}
uniform vec3 uWaterLUT[WATER_LUT_N];
uniform float uFogSigma;
uniform vec3 uSunDirW;
uniform vec3 uSunScatter;
uniform float uTime;
uniform float uNeonWater;
uniform vec3 uTopLift;
// (frutiger 10-05) graduated 'brighter toward the surface' multiply by view elevation (see setTopLift)
float topLift(vec3 d) {
  return 1.0 + (uTopLift.z - 1.0) * smoothstep(uTopLift.x, uTopLift.y, asin(clamp(d.y, -1.0, 1.0)));
}
// water radiance seen along world direction d (scene-linear, before exposure)
vec3 waterColor(vec3 d) {
  float e = asin(clamp(d.y, -1.0, 1.0));
  float f = (e + 1.5707963) / 3.1415927 * float(WATER_LUT_N - 1);
  int i = clamp(int(floor(f)), 0, WATER_LUT_N - 2);
  // (QA2) Catmull-Rom between the 7.5-deg nodes instead of linear: with the fitted, unevenly sloped
  // nodes (WATER_FIT) a linear ramp has a slope break at every node, which reads as faint contour
  // rings round the zenith when looking up (Mach bands).  Same values at the nodes.
  float u = clamp(f - float(i), 0.0, 1.0);
  vec3 p0 = uWaterLUT[max(i - 1, 0)], p1 = uWaterLUT[i], p2 = uWaterLUT[i + 1], p3 = uWaterLUT[min(i + 2, WATER_LUT_N - 1)];
  vec3 c = p1 + 0.5 * u * (p2 - p0 + u * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3 + u * (3.0 * (p1 - p2) + p3 - p0)));
  c = max(c, vec3(0.0));
  // Forward in-scatter toward the sun (Henyey-Greenstein, g = water anisotropy 0.55).  The LUT holds
  // the elevation gradient (fitted with this term in place, see WATER_FIT); this adds the azimuthal
  // part: a cyan-white glow toward the sun (up-left of CAM_Main), slightly darker water away from it.
  // (QA2) The darker side is MULTIPLICATIVE (at most -20 %): with the stronger glow an additive
  // negative term would drive the dark downward water below zero (= black) away from the sun.
  float mu = dot(d, -uSunDirW);
  const float g = 0.55;
  float hg = (1.0 - g * g) / pow(1.0 + g * g - 2.0 * g * mu, 1.5);
  float hs = hg - 0.75;
  c = hs > 0.0 ? c + uSunScatter * hs * 0.25 : c * (1.0 + hs * 0.35);
  // (QA2) Neon mode evokes the reference: a bright aquarium tank whose water is a pale blue with a
  // touch of lavender (reference top: hue ~216 deg, HSL S 0.49, L 0.62), not the open sea's deeper
  // teal-blue (graded: ~200 deg, L 0.50).  Same luminance gradient, brighter (x1.25), hue moved to
  // ~215 deg in linear (outside the grade's cyan-rotation window, so it stays there).  A redder
  // (0.72, 0.93, 1.40) x1.35 measured 223 deg / L 0.69 at the top and read grey-violet.  Everything
  // fogs toward this colour, so far fish and sand get the tank's pastel haze too.
  if (uNeonWater > 0.0) {
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = mix(c, l * vec3(0.66, 0.95, 1.36) * 1.25, 0.6 * uNeonWater);
  }
  return c;
}
`;

// GLSL that fogs `outgoingLight` (MeshStandardMaterial naming); inserted before <opaque_fragment>.
export const WATER_APPLY_GLSL = /* glsl */`
{
  vec3 wRay = (vec4(-vViewPosition, 0.0) * viewMatrix).xyz;   // camera -> fragment, world space
  float wDist = length(wRay);
  // (QA2 round 2) neon mode: a milkier tank (fog x1.6).  WHY: next to ref_aquarium the neon fish
  // stayed vivid to the back of the school (fish HSL S median 0.67 vs the reference's 0.51), where the
  // reference's tetras dissolve into a pastel, lavender haze a few metres back — that haze is most of
  // its depth.  Natural mode (uNeonWater 0) is unchanged.
  float wFog = 1.0 - exp(-uFogSigma * (1.0 + 0.6 * uNeonWater) * wDist);
  vec3 wDir = wRay / max(wDist, 1e-5);
  outgoingLight = mix(outgoingLight, waterColor(wDir), wFog) * topLift(wDir);
}
`;

/** The far background: what fog converges to at infinite distance (a camera-centred dome). */
export function makeBackground() {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...waterUniforms },
    // Camera-centred by construction: only the view ROTATION is applied, so the dome can never be
    // left behind.  (First version moved the mesh in onBeforeRender, which runs after three has
    // computed matrixWorld: after a jump — R, or a fast swim — the camera was outside the dome for a
    // frame and saw black sky with a fake horizon; caught in checks/web/web_hammerhead.png.)
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = position;
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = vec4(p.xy, p.w * 0.99999, p.w);   // just inside the far plane: behind everything
      }`,
    fragmentShader: /* glsl */`
      ${WATER_PARS_GLSL}
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        gl_FragColor = vec4(waterColor(d) * topLift(d), 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // (QA2) +-0.5 LSB dither: the open-water gradient changes ~1 level per 15 px (looking up), which
        // shows as contour rings on 8-bit displays and in compressed screen recordings
        gl_FragColor.rgb += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;
      }`,
    side: THREE.BackSide,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 24), mat);
  mesh.frustumCulled = false;
  // drawn LAST among opaque objects: at the far plane with depth test on, it only shades the pixels
  // nothing else covered (most of the frame is fish / sand)
  mesh.renderOrder = 100;
  return mesh;
}

/**
 * Compose shader patches onto a built-in material.  Each patch is {key, apply(shader)}.
 * WHY explicit customProgramCacheKey: three's default cache key is onBeforeCompile.toString(); all
 * our materials share the same wrapper text, so without the key two materials with DIFFERENT patches
 * would silently share one compiled program.
 */
export function patchMaterial(material, patches) {
  material.onBeforeCompile = (shader) => { for (const p of patches) p.apply(shader, material); };
  const key = patches.map((p) => p.key).join('|');
  material.customProgramCacheKey = () => key;
  return material;
}

export const waterPatch = {
  key: 'water',
  apply(shader) {
    Object.assign(shader.uniforms, waterUniforms);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + WATER_PARS_GLSL)
      .replace('#include <opaque_fragment>', WATER_APPLY_GLSL + '\n#include <opaque_fragment>');
  },
};
