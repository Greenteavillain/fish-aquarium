// Environment: sand (+ caustics), mossy pillar, boulders, the sun, the sand height field used for
// collision, and the KEEPOUT cylinders.
import * as THREE from 'three';
import { patchMaterial, waterPatch, waterUniforms } from './water.js';

// x0.7 originally: the first (thin-line) pattern's filaments were denser than Blender's 4D Voronoi at
// the same cell scale.  (QA2) the broad-band pattern is tuned against final_f001's sand percentiles.
const CAUSTIC_GAIN = 0.6;
// (frutiger 10-05) caustic glow skirt strength (stand-in for the look's bloom on the caustic knots)
const CAUSTIC_GLOW = 0.35;

// (frutiger 10-05) the fitted albedo tints per look (see uSandTint / uRockTint below for the aquarium fit).
// frutiger: re-fitted on the frutiger fish-free plate (scenes/final/renders/webfit_plate_f059.png, 1080x1620,
// regions of checks/web/tmp/frutiger/regions.py) with the web's own fish-free poster frame at 540x810, AFTER the
// water LUT matched (open water within 0-3 levels).  WHY a new fit and not the old one: the sand tile and the rock
// textures were re-baked from the frutiger scene (neutral sand albedo 0.60/0.545/0.49 instead of the old
// cream-green, fresh-green moss), so the old multipliers — which compensated the OLD bake against compose's
// later sand / moss edits — made the sand cream-pink (249,233,211 vs the plate's 224,241,232) and the pillar
// acid yellow-green (blue 35 vs 80).  Sand: damped per-channel steps in linear light diverged at x2.5 (the
// grade's HSV curves couple the channels), so the last points were picked from a small grid:
//   0.84/0.95/0.96 -> near sand 224,241,231 (plate 224,241,232), far band 210,237,240 (200,230,238),
//   left edge 222,239,228 (228,242,231).
// Rocks: only blue was off -> blue x1.4, red x1.03 on the old tint: pillar 77,146,79 (plate 75,145,80),
//   pillar top 79,146,83 (82,146,85), right boulder 83,175,153 (85,179,151).
const LOOK_FIT = {
  frutiger: { sand: [0.84, 0.95, 0.96], rock: [1.71, 1.73, 3.02] },
};

export const envUniforms = {
  uCausticScale: { value: 2.6 },        // cells per metre (composition.caustics.scale_cells_per_m)
  uCausticStrength: { value: 2.0 },
  uSunCol: { value: new THREE.Color(1, 0.98, 0.93) },
  uShaftLand: { value: new THREE.Vector3() },
  uShaftSpot: { value: new THREE.Vector2(0.16, 0.0) },   // radius (m), strength
  uPatch: { value: new THREE.Vector4(0.18, 0.3, 0.7, 0.98) },   // noise scale, from lo/hi, baked_as
  uPatchTo: { value: new THREE.Vector2(0.88, 1.08) },
  // (QA2) sand albedo tint, FITTED (with the grain cut uSandGrain 0.6 in place) so the fish-free web
  // plate's near sand (x 62-80 %, y 84-97 % of the poster frame, median) matches the final's own
  // plate (scenes/final/renders/iter/final_plate_f001.png): 153,177,156 vs web 119,151,139 before;
  // 7 damped iterations of target/current in linear light -> 152-154,177,156.  The far sand band
  // (y 76-83 %) then lands at 128,166,160 vs the final's 135,172,169 without being fitted.
  uSandTint: { value: new THREE.Vector3(1.505, 1.365, 1.361) },
  uSandGrain: { value: 0.6 },
  // (QA2) rock albedo tint (pillar, near rocks, far rocks), with the moss blotches pulled 25 % toward
  // the texture mean (see envPatch 'rock').  Fitted on the pillar of the final's fish-free plate
  // (x 20-40 %, y 62-90 %, median 55,103,79; web was 43,81,57): a neutral gain 1.73 matched its
  // luminance but read yellower (62,103,64), so blue x1.25 / red x0.96 -> 60,103,74.  A per-channel
  // fit went to blue x2.4 and turned the boulders blue-grey (they are mostly fog at that distance),
  // so all three groups share the pillar's tint (one moss material in Blender).
  uRockTint: { value: [0, 1, 2].map(() => new THREE.Vector3(1.66, 1.73, 2.16)) },
  // contact occlusion on the sand around each rock: (x, z, radius, strength) from the KEEPOUT
  // cylinders that start on the floor (they hug the rock to within their 0.10 m margin)
  uKO: { value: Array.from({ length: 16 }, () => new THREE.Vector4(0, 0, 0, 0)) },
  uKeyDir: { value: new THREE.Vector3(0.55, -0.67, -0.5) },
  uKeyCol: { value: new THREE.Color(1, 0.92, 0.78) },
  // (frutiger 10-05) SUN_SandKey: compose light-links it to ENV_Ground ONLY (diffuse, no shadow / specular /
  // volume): a key from over the camera's shoulder that models the dune slopes (SUN_Main comes from behind
  // the scene, so the camera-facing slopes got little direct light).  Added in the sand shader only.
  uSandKeyDir: { value: new THREE.Vector3(0.55, -0.67, -0.5) },
  uSandKeyCol: { value: new THREE.Color(0, 0, 0) },
  // (frutiger 10-05) relief trough tint: albedo x (1 - tint x trough share), the share comes with the dune
  // mesh (web_export_env: TEXCOORD_1 -> attribute aTrough); build_env RELIEF_DUNES trough_tint 0.22
  uTroughTint: { value: 0 },
  // (QA frutiger 10-05) MACRO relief = build_env RELIEF_DUNES 'macro' / _sand_macro: shading-only dunes where the dug
  // relief was held back (rock pads, hero keep-pads, the conger lane = the whole poster sand window).  Strength per
  // vertex = 'sand_flat' (sand.glb uv1.y, flipped back in buildEnv).  A: amp, wavelength, rot (rad), meander;
  // B: meander_len, sharp, amp2, wavelength2; C: rot2 (rad), phase2, tint, tint_pivot.  uMacroShift: 1 = bend the
  // caustic net over the (real + virtual) height along the sun.  A.x = 0 -> off.
  uMacroA: { value: new THREE.Vector4(0, 2.4, 0, 0) },
  uMacroB: { value: new THREE.Vector4(4.3, 1.6, 0, 1.15) },
  uMacroC: { value: new THREE.Vector4(0, 0, 0, 0) },
  uMacroShift: { value: 0 },
  // (frutiger 10-05) caustic filament width in cell units (the band edge of c_edge) and the soft glow the
  // look's bloom puts around the bright knots (see CAUSTIC_GLSL)
  uCausticBand: { value: 0.24 },
  uCausticGlow: { value: 0 },
  uCausticMean: { value: 0.205 },
  // (frutiger 10-05) caustic 'received light' weights (sun energy, sand-key energy, ambient): Blender multiplies the
  // caustic emission by the light the surface receives (build_env _caustic_emission: Shader-to-RGB of a white
  // Diffuse = sum of N.L of every light + the world), so caustics are brighter on the dune slopes that face the sun
  // and weaker on the lee side — that, with the trough tint, is how the dunes read.  The web used a plain up-facing
  // mask (no N.L), so its dunes vanished under the caustic web (checks/web/tmp/frutiger/dunes_*.png).  Normalised
  // to FLAT sand (the factor is 1 there), so the fitted flat-sand look (uSandTint) does not move.  (0,0,0) = off.
  uCausRecv: { value: new THREE.Vector3(0, 0, 0) },
  uSandKeyDirC: { value: new THREE.Vector3(0.55, -0.67, -0.5) },
};

// Caustics, written for this project (not a copied shadertoy): warped Voronoi cell borders
// (F2 - F1 small) in two layers, feature points circling so the web shimmers; bright knots where the
// layers cross.  The Blender version is 4D Voronoi + warp + intensity noise; the look is the same
// family (thin bright filaments), not a pixel match — it was never baked into the web textures.
const CAUSTIC_GLSL = /* glsl */`
uniform float uCausticScale, uCausticStrength, uCausticBand, uCausticGlow, uCausticMean, uTroughTint;
uniform vec4 uMacroA, uMacroB, uMacroC;
uniform float uMacroShift;
// (QA frutiger 10-05) macro relief, the GLSL twin of build_env._sand_macro (same formula, Blender coordinates
// pb = (x, -z)): returns (H, dH/dx_b, dH/dy_b, h1).  H <= 0 (0 on a crest).  Blender takes the bump's slope from
// screen derivatives of H; here the gradient is analytic (no faceting, no extra derivative cost).
vec4 sandMacro(vec2 pb) {
  if (uMacroA.x <= 0.0) return vec4(0.0, 0.0, 0.0, 1.0);
  const float TAU = 6.2831853;
  float r1 = uMacroA.z, L1 = uMacroA.y, mea = uMacroA.w, ml = uMacroB.x, sh = uMacroB.y;
  float s1 = (pb.y * cos(r1) + pb.x * sin(r1)) / L1 + mea * sin(TAU * pb.x / ml);
  vec2 ds1 = vec2(sin(r1) / L1 + mea * cos(TAU * pb.x / ml) * TAU / ml, cos(r1) / L1);
  float th1 = TAU * s1, b1 = max(0.5 + 0.5 * cos(th1), 1e-6);
  float h1 = pow(b1, sh);
  float dh1 = sh * pow(b1, sh - 1.0) * (-0.5 * sin(th1)) * TAU;            // dh1 / ds1
  float r2 = uMacroC.x, L2 = uMacroB.w;
  float th2 = TAU * (pb.x * sin(r2) + pb.y * cos(r2)) / L2 + uMacroC.y;
  vec2 ds2 = vec2(sin(r2), cos(r2)) / L2;
  float b2 = max(0.5 + 0.5 * cos(th2), 1e-6);
  float h2 = pow(b2, 1.3);
  float dh2 = 1.3 * pow(b2, 0.3) * (-0.5 * sin(th2)) * TAU;
  float H = uMacroA.x * (h1 - 1.0) + uMacroB.z * (h2 - 1.0);
  vec2 g = uMacroA.x * dh1 * ds1 + uMacroB.z * dh2 * ds2;
  return vec4(H, g, h1);
}
uniform vec3 uCausRecv, uSandKeyDirC;
uniform vec3 uSunCol;
uniform vec3 uShaftLand;
uniform vec2 uShaftSpot;
uniform vec4 uPatch;
uniform vec2 uPatchTo;
uniform vec3 uSandTint;
uniform float uSandGrain;
uniform vec4 uKO[16];
varying vec3 vEnvW;
// soft darkening of the sand where a rock meets it.  WHY: without it boulders read as pasted on
// (or floating) when seen from above; EEVEE got this from ambient occlusion / soft shadows.
float contactAO(vec2 p) {
  float ao = 1.0;
  for (int i = 0; i < 16; i++) {
    vec4 k = uKO[i];
    if (k.w <= 0.0) continue;
    float d = length(p - k.xy);
    float u = clamp((d - k.z * 0.8) / (k.z * 1.1 + 0.25), 0.0, 1.0);    // 0 at the rock foot -> 1 out
    ao *= 1.0 - k.w * (1.0 - u) * (1.0 - u);
  }
  return ao;
}
vec2 c_hash2(vec2 p) {
  p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
  return fract(sin(p) * 43758.5453);
}
float c_edge(vec2 p, float t) {
  vec2 n = floor(p), f = fract(p);
  float f1 = 8.0, f2 = 8.0;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 g = vec2(float(i), float(j));
    vec2 o = c_hash2(n + g);
    o = 0.5 + 0.38 * sin(t * (0.6 + 0.5 * o.yx) + 6.2831 * o);
    vec2 r = g + o - f;
    float d = dot(r, r);
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) { f2 = d; }
  }
  return sqrt(f2) - sqrt(f1);
}
float v_noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = c_hash2(i).x, b = c_hash2(i + vec2(1, 0)).x, c = c_hash2(i + vec2(0, 1)).x, d = c_hash2(i + vec2(1, 1)).x;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float caustic(vec2 p, float t) {
  vec2 w = p + 0.32 * vec2(sin(p.y * 0.83 + t * 0.55), cos(p.x * 0.71 - t * 0.47));
  // (QA2) band width 0.13 -> 0.24 and softer knots: next to final_f001 the thin, crisp, evenly bright
  // lines read as cracked tiles / dried mud (checks/web/qa2_sand_cmp), where Blender's caustic is
  // broad soft bands with dappled brightness.  The mean changes with the width: CAUSTIC_MEAN below.
  // (frutiger 10-05) the width is uCausticBand (the look's caustic_width 0.085 vs build_env's 0.10 = a
  // thinner, crisper web) and uCausticGlow adds a wide soft skirt around every filament: the look's
  // bloom (threshold 1.25 scene-linear) makes exactly the caustic knots on the white sand glow
  // (frutiger/crops/nat_sand.png); a bloom pass is not ported (grade.js), so the glow is drawn here.
  float ea = c_edge(w, t), eb = c_edge(w * 1.41 + vec2(3.7, 1.9), t * 1.21);
  float a = 1.0 - smoothstep(0.0, uCausticBand, ea);
  float b = 1.0 - smoothstep(0.0, uCausticBand, eb);
  float ga = 1.0 - smoothstep(0.0, uCausticBand * 3.0, ea), gb = 1.0 - smoothstep(0.0, uCausticBand * 3.0, eb);
  // slow intensity patches (Blender's caustic has an 'intensity noise' too): without them the
  // network reads as a uniform tiled mesh when seen from above (checks/web/web_view_down_high.png)
  float k = 0.45 + 1.1 * v_noise(p * 0.22 + vec2(t * 0.04, -t * 0.03));
  return (a * a * 0.5 + b * b * 0.32 + a * b * 0.55 + uCausticGlow * (ga * ga * 0.5 + gb * gb * 0.32)) * k;
}
`;
// mean of caustic() = what distant sand fades to.  (QA2) Computed numerically (400k samples of a
// numpy replica, scratch caus.py): 0.205 for this pattern.  The old value 0.19 was 47 % above the old
// pattern's own mean (0.129), so sand got brighter with distance between 8 and 30 m.
// (frutiger 10-05) a uniform now: the mean depends on the band width and the glow, so it is estimated at
// load by causticMean() (a JS replica of caustic(), 12k samples) whenever those change.
const CAUSTIC_MEAN = 'uCausticMean';

// JS replica of the GLSL caustic() for its MEAN (the GPU's sin-hash differs bit-wise from double
// precision, so the field differs point by point, but its statistics are the same).  Checked against the
// QA2 number: band 0.24, glow 0 -> 0.20-0.21 (QA2's numpy replica: 0.205).
export function causticMean(band, glow, n = 12000) {
  const fr = (x) => x - Math.floor(x);
  const h2 = (x, y) => [fr(Math.sin(x * 127.1 + y * 311.7) * 43758.5453), fr(Math.sin(x * 269.5 + y * 183.3) * 43758.5453)];
  const edge = (px, py) => {
    const nx = Math.floor(px), ny = Math.floor(py), fx = px - nx, fy = py - ny;
    let f1 = 8, f2 = 8;
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const o = h2(nx + i, ny + j);
      const ox = 0.5 + 0.38 * Math.sin(6.2831 * o[0]), oy = 0.5 + 0.38 * Math.sin(6.2831 * o[1]);
      const rx = i + ox - fx, ry = j + oy - fy, d = rx * rx + ry * ry;
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    return Math.sqrt(f2) - Math.sqrt(f1);
  };
  const ss = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  let seed = 9871, acc = 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < n; k++) {
    const x = rnd() * 400, y = rnd() * 400;
    const ea = edge(x, y), eb = edge(x * 1.41 + 3.7, y * 1.41 + 1.9);
    const a = 1 - ss(0, band, ea), b = 1 - ss(0, band, eb);
    const ga = 1 - ss(0, band * 3, ea), gb = 1 - ss(0, band * 3, eb);
    acc += a * a * 0.5 + b * b * 0.32 + a * b * 0.55 + glow * (ga * ga * 0.5 + gb * gb * 0.32);
  }
  return acc / n;           // x the intensity-patch factor, whose mean is 0.45 + 1.1 x 0.5 = 1.0
}

function envPatch({ caustics = 1, patchiness = false, shaftSpot = false, keyLight = false, contact = false, rock = -1, sandKey = false, trough = false }) {
  return {
    key: `env${caustics}${patchiness ? 'p' : ''}${shaftSpot ? 's' : ''}${keyLight ? 'k' : ''}${contact ? 'c' : ''}r${rock}${sandKey ? 'K' : ''}${trough ? 't' : ''}`,
    apply(shader) {
      Object.assign(shader.uniforms, envUniforms, waterUniforms);
      if (trough) {
        // (frutiger 10-05) relief trough share per vertex (aTrough = the dune mesh's uv1, see buildEnv)
        // (QA frutiger 10-05) aTrough.y = 'sand_flat' = the macro relief's strength (see uMacroA); gMacro is computed
        // once at map_fragment (albedo tint) and reused for the normal tilt and the caustic shift below.
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec2 aTrough;\nvarying float vTrough;\nvarying float vFlat;')
          .replace('#include <project_vertex>', '#include <project_vertex>\nvTrough = aTrough.x;\nvFlat = aTrough.y;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vTrough;\nvarying float vFlat;\nvec4 gMacro;\nfloat gFlat;')
          .replace('#include <map_fragment>', `#include <map_fragment>
          diffuseColor.rgb *= 1.0 - uTroughTint * vTrough;
          gFlat = clamp(vFlat, 0.0, 1.0);
          gMacro = sandMacro(vec2(vEnvW.x, -vEnvW.z));
          // albedo x (1 + tint k (pivot - trough share)), share = 1 - h1 (build_env _sand_macro)
          diffuseColor.rgb *= 1.0 + uMacroC.z * gFlat * (uMacroC.w - (1.0 - gMacro.w));`)
          .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          {
            // macro slope: height field y = H(x, z) in three world -> normal tilt (-dH/dx, 0, -dH/dz),
            // dH/dx = g.x, dH/dz = -dH/dy_blender = -g.y; scaled by the strength (Blender: Bump Strength = k)
            vec3 tW = gFlat * vec3(-gMacro.y, 0.0, gMacro.z);
            normal = normalize(normal + (viewMatrix * vec4(tW, 0.0)).xyz);
          }`);
      }
      if (sandKey) {
        // (frutiger 10-05) SUN_SandKey: diffuse only (compose: specular 0, no shadow), sand only
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uSandKeyDir;\nuniform vec3 uSandKeyCol;')
          .replace('#include <lights_fragment_maps>', `{
            vec3 skD = normalize((viewMatrix * vec4(-uSandKeyDir, 0.0)).xyz);
            reflectedLight.directDiffuse += saturate(dot(geometryNormal, skD)) * uSandKeyCol * BRDF_Lambert(material.diffuseColor);
          }
          #include <lights_fragment_maps>`);
      }
      if (rock >= 0) {
        // (QA2) rock albedo: moss blotches pulled 25 % toward the texture's mean (its last mip)
        // and a fitted tint per group (uRockTint[0] pillar, [1] near rocks, [2] far rocks).  WHY:
        // the textures were baked before scenes/final calmed the moss (compose.py edit_env: hue/sat
        // 0.70, wider noise range = lower contrast, crack layer); next to the final's fish-free
        // plate the web pillar read darker and camouflage-blotched (median 43,80,57 vs 55,103,79).
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uRockTint[3];')
          .replace('#include <map_fragment>', `#include <map_fragment>
          #ifdef USE_MAP
          diffuseColor.rgb = mix(textureLod(map, vMapUv, 12.0).rgb, diffuseColor.rgb, 0.75);
          #endif
          diffuseColor.rgb *= uRockTint[${rock}];`);
      }
      if (keyLight) {
        // scenes/final light linking: SUN_Key's receivers are 'LL_NoGround' = everything except the
        // sand, so the warm key lights the pillar and boulders too (that is what makes the pillar's
        // camera side olive-yellow in the final; SUN_Main is behind it).  three lights can't be
        // linked, so the key is added in this shader only.
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uKeyDir;\nuniform vec3 uKeyCol;')
          .replace('#include <lights_fragment_maps>', `{
            IncidentLight kL; kL.color = uKeyCol; kL.visible = true;
            kL.direction = normalize((viewMatrix * vec4(-uKeyDir, 0.0)).xyz);
            RE_Direct(kL, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
          }
          #include <lights_fragment_maps>`);
      }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vEnvW;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvEnvW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      let frag = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + CAUSTIC_GLSL);
      if (patchiness) {
        // composition sand.macro_patchiness: the 5 m patches were taken OUT of the seamless tile so
        // it can repeat; multiply them back in world space.
        frag = frag.replace('#include <map_fragment>', `#include <map_fragment>
        {
          // (QA2) the final's sand edit (compose.py edit_env, after this tile was baked): grain
          // contrast cut ~40 % (per-cell 0.62-1.15 -> 0.74-1.06) and a warmer, brighter albedo.
          // Next to the final's own fish-free plate the web sand was 'teal-grey terrazzo', 35-40 %
          // darker (row at 85 % height: 121,156,144 vs 193,210,181).  The grain is pulled toward the
          // tile's mean colour (its last mip level), then tinted by uSandTint (fitted, see buildEnv).
          #ifdef USE_MAP
          diffuseColor.rgb = mix(textureLod(map, vMapUv, 12.0).rgb, diffuseColor.rgb, uSandGrain);
          #endif
          diffuseColor.rgb *= uSandTint;
        }
        {
          float pn = v_noise(vEnvW.xz * uPatch.x) * 0.55 + v_noise(vEnvW.xz * uPatch.x * 2.03 + 7.1) * 0.3 + v_noise(vEnvW.xz * uPatch.x * 4.1 + 3.3) * 0.15;
          float pm = mix(uPatchTo.x, uPatchTo.y, clamp((pn - uPatch.y) / (uPatch.z - uPatch.y), 0.0, 1.0));
          diffuseColor.rgb *= pm / uPatch.w;
        }`);
      }
      if (contact) {
        frag = frag.replace('#include <map_fragment>', `#include <map_fragment>
        float cAO = contactAO(vEnvW.xz);
        diffuseColor.rgb *= cAO;`);
      }
      // caustic light added as emission: albedo x pattern x up-facing x sun colour, fading to its
      // mean with distance (8 -> 30 m, as in Blender) so far sand does not shimmer.
      frag = frag.replace('#include <aomap_fragment>', `#include <aomap_fragment>
      {
        vec3 nW = (vec4(normal, 0.0) * viewMatrix).xyz;
        float up = smoothstep(0.2, 0.85, nW.y);
        if (uCausRecv.x > 0.0) {
          // received light on this normal / on flat sand (see envUniforms.uCausRecv)
          vec3 nn = normalize(nW);
          float rN = uCausRecv.x * max(dot(nn, -uSunDirW), 0.0) + uCausRecv.y * max(dot(nn, -uSandKeyDirC), 0.0) + uCausRecv.z;
          float rF = uCausRecv.x * max(-uSunDirW.y, 0.0) + uCausRecv.y * max(-uSandKeyDirC.y, 0.0) + uCausRecv.z;
          up *= rN / max(rF, 1e-3);
        }
        float dcam = length(vViewPosition);
        // (QA2) fade to the mean from 5 m (was 8): looking down from 9 m the full-contrast network
        // covered the whole floor like a cracked-tile mosaic (checks/web/qa2_final_views.png)
        float cf = smoothstep(5.0, 26.0, dcam);
        vec2 cxz = vEnvW.xz;
        ${trough ? `if (uMacroShift > 0.5) {
          // (QA frutiger) the net where the sun ray through this point crossed y = 0 (real + virtual height):
          // caustic lines bend over the dunes, as build_env _sand_macro's caustic_shift
          float ze = vEnvW.y + gFlat * gMacro.x;
          cxz += uSunDirW.xz * (-ze / min(uSunDirW.y, -0.05));
        }` : ''}
        float cp = dcam < 30.0 ? caustic(cxz * uCausticScale, uTime * 0.9) : ${CAUSTIC_MEAN};
        float cv = mix(cp, ${CAUSTIC_MEAN}, cf)${contact ? ' * cAO' : ''};
        totalEmissiveRadiance += diffuseColor.rgb * uSunCol * (cv * uCausticStrength * ${caustics.toFixed(2)} * up);
        ${shaftSpot ? `
        vec2 ds = vEnvW.xz - uShaftLand.xz;
        totalEmissiveRadiance += diffuseColor.rgb * uSunCol * uShaftSpot.y * up * exp(-dot(ds, ds) / (uShaftSpot.x * uShaftSpot.x));` : ''}
      }`);
      shader.fragmentShader = frag;
    },
  };
}

export function patchEnvMaterial(mat, opts) {
  return patchMaterial(mat, [envPatch(opts), waterPatch]);
}

/**
 * Height field of the sand for camera/fish floor collision.  WHY a grid: raycasting a 30k-triangle
 * mesh every frame per fish is far too slow; the dunes are smooth, so a 0.5 m grid sampled by
 * rasterising every triangle once at load is exact enough (bilinear between cells).
 * (frutiger 10-05) 0.5 -> 0.25 m for the seabed relief: 2.8 m sand waves with narrow crests plus 1.15 m
 * megaripples; a 0.5 m bilinear grid cut the crests by up to ~4 cm (a resting fish sank into a crest,
 * the camera floor lagged the shape).  481 x 529 floats (1 MB), rasterised once (~10 ms).
 */
export class SandHeight {
  constructor(geometry, cell = 0.25) {
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    this.cell = cell;
    this.x0 = bb.min.x; this.z0 = bb.min.z;
    this.nx = Math.ceil((bb.max.x - bb.min.x) / cell) + 1;
    this.nz = Math.ceil((bb.max.z - bb.min.z) / cell) + 1;
    this.outside = -0.12;
    const h = (this.h = new Float32Array(this.nx * this.nz).fill(NaN));
    const pos = geometry.attributes.position.array;
    const idx = geometry.index ? geometry.index.array : null;
    const nt = idx ? idx.length / 3 : pos.length / 9;
    for (let t = 0; t < nt; t++) {
      const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
      const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
      const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
      const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - this.x0) / cell));
      const i1 = Math.min(this.nx - 1, Math.ceil((Math.max(ax, bx, cx) - this.x0) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - this.z0) / cell));
      const j1 = Math.min(this.nz - 1, Math.ceil((Math.max(az, bz, cz) - this.z0) / cell));
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < 1e-12) continue;
      for (let j = j0; j <= j1; j++) {
        const pz = this.z0 + j * cell;
        for (let i = i0; i <= i1; i++) {
          const px = this.x0 + i * cell;
          const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det;
          const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det;
          const l3 = 1 - l1 - l2;
          if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
          const y = l1 * ay + l2 * by + l3 * cy;
          const k = j * this.nx + i;
          if (!(h[k] >= y)) h[k] = y;
        }
      }
    }
    for (let k = 0; k < h.length; k++) if (Number.isNaN(h[k])) h[k] = this.outside;
  }
  at(x, z) {
    const fx = (x - this.x0) / this.cell, fz = (z - this.z0) / this.cell;
    if (fx < 0 || fz < 0 || fx >= this.nx - 1 || fz >= this.nz - 1) return this.outside;
    const i = fx | 0, j = fz | 0, tx = fx - i, tz = fz - j, n = this.nx, h = this.h;
    const a = h[j * n + i], b = h[j * n + i + 1], c = h[(j + 1) * n + i], d = h[(j + 1) * n + i + 1];
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz;
  }
  /** (frutiger 10-05) unit surface normal (three, +Y up) from central differences over +-step m: benthic fish
   *  scattered by main.js lie along the dune slope instead of floating over / cutting into it */
  normalAt(x, z, step = 0.2) {
    const dx = (this.at(x + step, z) - this.at(x - step, z)) / (2 * step);
    const dz = (this.at(x, z + step) - this.at(x, z - step)) / (2 * step);
    const l = Math.hypot(dx, 1, dz);
    return [-dx / l, 1 / l, -dz / l];
  }
}

/** KEEPOUT cylinders in three.js coords: base centre (x, y0, z), radius (incl. 0.10 margin), height. */
export function keepoutsFrom(comp) {
  return comp.keepouts.map((k) => ({
    name: k.name, x: k.base_center.three[0], y0: k.base_center.three[1], z: k.base_center.three[2],
    r: k.radius, h: k.height,
  }));
}

export function buildEnv(scene, assets, comp) {
  const env = new THREE.Group();
  env.name = 'ENV';
  // composition.caustics
  envUniforms.uCausticScale.value = comp.caustics?.scale_cells_per_m ?? 2.6;
  // (gain: see CAUSTIC_GAIN at the top)
  envUniforms.uCausticStrength.value = (comp.caustics?.strength ?? 2.0) * CAUSTIC_GAIN;
  // (frutiger 10-05) the look's caustic web: thinner filaments (caustic_width 0.085 vs build_env's 0.10 ->
  // the web's band scaled by the same ratio) with a soft glow skirt standing in for the look's bloom
  // (grade.js), on 1.5x stronger caustics (3.1, read through caustics.strength above).  Glow 0.35: see
  // SYSTEMS.md frutiger web section (A/B against the Blender plate's sand window).
  const cw = comp.caustics?.width ?? 0.10;
  envUniforms.uCausticBand.value = 0.24 * cw / 0.10;
  envUniforms.uCausticGlow.value = comp.look?.values?.bloom ? CAUSTIC_GLOW : 0;
  envUniforms.uCausticMean.value = causticMean(envUniforms.uCausticBand.value, envUniforms.uCausticGlow.value);
  envUniforms.uTroughTint.value = comp.env_files?.sand?.relief?.trough_tint ?? 0;
  // (QA frutiger 10-05) macro relief parameters (composition.sand_relief.rel.macro = build_env RELIEF_DUNES 'macro')
  const mac = comp.sand_relief?.rel?.macro;
  if (mac) {
    const rad = (d) => (d * Math.PI) / 180;
    envUniforms.uMacroA.value.set(mac.amp, mac.wavelength, rad(mac.rot_deg), mac.meander);
    envUniforms.uMacroB.value.set(mac.meander_len, mac.sharp, mac.amp2, mac.wavelength2);
    envUniforms.uMacroC.value.set(rad(mac.rot2_deg), mac.phase2, mac.tint, mac.tint_pivot ?? 0);
    envUniforms.uMacroShift.value = mac.caustic_shift ? 1 : 0;
  }
  const fit = LOOK_FIT[comp.look?.preset];
  if (fit) {
    envUniforms.uSandTint.value.set(...fit.sand);
    envUniforms.uRockTint.value.forEach((v) => v.set(...fit.rock));
  }
  envUniforms.uShaftLand.value.fromArray(comp.light_shaft.lands_on_sand.three);
  const mp = comp.env_files.sand.macro_patchiness;
  envUniforms.uPatch.value.set(mp.noise_scale_per_m, mp.from_range[0], mp.from_range[1], mp.baked_as);
  envUniforms.uPatchTo.value.set(mp.to_range[0], mp.to_range[1]);
  comp.keepouts.filter((k) => k.base_center.three[1] < 0.05).slice(0, 16).forEach((k, i) => {
    const r = k.radius - (k.margin ?? 0.1);                // the rock's own footprint
    envUniforms.uKO.value[i].set(k.base_center.three[0], k.base_center.three[2], r, Math.min(0.85, 0.68 + 0.05 * k.height));
  });

  const prep = (gltf, opts, rough, order = 3) => {
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.renderOrder = order;          // after the fish (early-z), see fish.js buildMeshes
      const m = o.material;
      m.roughness = rough; m.metalness = 0;
      if (m.map) m.map.anisotropy = 8;
      patchEnvMaterial(m, opts);
      o.matrixAutoUpdate = false; o.updateMatrix();
    });
    env.add(gltf.scene);
    return gltf.scene;
  };
  prep(assets.env.pillar, { caustics: 0.35, keyLight: true, rock: 0 }, 0.92);
  prep(assets.env.rocks_near, { caustics: 0.35, keyLight: true, rock: 1 }, 0.92);
  prep(assets.env.rocks_far, { caustics: 0.3, keyLight: true, rock: 2 }, 0.95);
  const hasKey = !!comp.lights.find((l) => l.name === 'SUN_SandKey');
  // (frutiger 10-05) relief: the trough share rides in the dune mesh's second uv set (uv1); renamed so the shader can
  // declare it unconditionally (three declares uv1 only under USE_UV1, which a material without a uv1 map never sets)
  let hasTrough = false;
  // (QA frutiger 10-05) uv1.y carries 'sand_flat', but Blender's glTF exporter flips v (three reads 1 - flat): the copy
  // flips it back, so aTrough = (trough share, flat) and the skirt's zeros mean 'no trough, no macro relief'.
  assets.env.sand.scene.traverse((o) => {
    if (o.isMesh && o.geometry.attributes.uv1) {
      const u1 = o.geometry.attributes.uv1, a = new Float32Array(u1.count * 2);
      for (let i = 0; i < u1.count; i++) { a[i * 2] = u1.getX(i); a[i * 2 + 1] = 1.0 - u1.getY(i); }
      o.geometry.setAttribute('aTrough', new THREE.BufferAttribute(a, 2));
      hasTrough = true;
    }
  });
  const sandScene = prep(assets.env.sand, { caustics: 1, patchiness: true, shaftSpot: true, contact: true, sandKey: hasKey, trough: hasTrough }, 1.0, 4);
  let sandMesh = null;
  sandScene.traverse((o) => { if (o.isMesh && !sandMesh) sandMesh = o; });
  const sandMat = sandMesh.material;
  if (sandMat.map) { sandMat.map.wrapS = sandMat.map.wrapT = THREE.RepeatWrapping; }
  if (sandMat.normalMap) { sandMat.normalMap.wrapS = sandMat.normalMap.wrapT = THREE.RepeatWrapping; }

  // The dune mesh covers x -60..60, z -120..12 (three).  Behind the start camera it ends 12 m away,
  // well inside the fog, so a big flat skirt continues the floor below the dunes (y -0.12, under the
  // dunes' lowest point -0.10) with the SAME sand material and the same world-locked UVs.
  // world-space copy: the glTF node may carry a transform, the height grid and UV fit need world xz
  sandScene.updateMatrixWorld(true);
  const sandW = sandMesh.geometry.clone().applyMatrix4(sandMesh.matrixWorld);
  const uvFit = fitUV(sandW);
  // (frutiger 10-05) the skirt now has a HOLE under the dune mesh (its bbox inset by 0.5 m).  WHY: the relief
  // digs troughs to ~0.3 m below the old floor, i.e. below the skirt's y -0.12, and the flat skirt poked up
  // through every trough as pale flat patches.  Lowering the skirt instead would have opened a step at the
  // dune mesh's edge 12 m behind the start; with the hole nothing changes outside the dune mesh.
  sandW.computeBoundingBox();
  const bb = sandW.boundingBox, ins = 0.5;
  const outer = new THREE.Shape();
  // world x -300..300, z -340..260 (the old 600 m plane centred at z -40); shape y = -z
  outer.moveTo(-300, -260); outer.lineTo(300, -260); outer.lineTo(300, 340); outer.lineTo(-300, 340); outer.lineTo(-300, -260);
  const hole = new THREE.Path();
  // shape xy = world (x, -z) (rotateX(-90 deg) below maps shape y to world -z)
  hole.moveTo(bb.min.x + ins, -(bb.max.z - ins)); hole.lineTo(bb.min.x + ins, -(bb.min.z + ins));
  hole.lineTo(bb.max.x - ins, -(bb.min.z + ins)); hole.lineTo(bb.max.x - ins, -(bb.max.z - ins)); hole.lineTo(bb.min.x + ins, -(bb.max.z - ins));
  outer.holes.push(hole);
  const skirtGeo = new THREE.ShapeGeometry(outer).rotateX(-Math.PI / 2);
  const sp = skirtGeo.attributes.position;
  const su = new Float32Array(sp.count * 2);
  for (let i = 0; i < sp.count; i++) {
    su[i * 2] = uvFit.u[0] * sp.getX(i) + uvFit.u[1] * sp.getZ(i) + uvFit.u[2];
    su[i * 2 + 1] = uvFit.v[0] * sp.getX(i) + uvFit.v[1] * sp.getZ(i) + uvFit.v[2];
  }
  skirtGeo.setAttribute('uv', new THREE.BufferAttribute(su, 2));
  skirtGeo.setAttribute('aTrough', new THREE.BufferAttribute(new Float32Array(sp.count * 2), 2));   // flat: no trough
  skirtGeo.translate(0, -0.12, 0);
  const skirt = new THREE.Mesh(skirtGeo, sandMat);
  skirt.name = 'ENV_SandSkirt';
  // AFTER the dunes: both share one material, so with equal renderOrder three sorts them by
  // distance and could draw the 600 m skirt first, then shade the whole floor again on top
  // (measured: sand ~10 ms of a 1440p frame).  Drawn last, it fails early-z under the dunes.
  skirt.renderOrder = 5;
  env.add(skirt);

  scene.add(env);
  const sandHeight = new SandHeight(sandW);
  sandW.dispose();
  return { group: env, sandHeight, sandMesh, uvFit };
}

// Least-squares fit uv = A [x, z, 1] on the dune mesh, so the skirt uses the exact same mapping
// (composition: uv = world xy / tile_m with glTF's v flip; fitted rather than assumed).
function fitUV(geo) {
  const p = geo.attributes.position, uv = geo.attributes.uv;
  const n = Math.min(p.count, 4000), step = Math.max(1, Math.floor(p.count / n));
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bu = [0, 0, 0], bv = [0, 0, 0];
  for (let i = 0; i < p.count; i += step) {
    const r = [p.getX(i), p.getZ(i), 1];
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) M[a][b] += r[a] * r[b];
      bu[a] += r[a] * uv.getX(i); bv[a] += r[a] * uv.getY(i);
    }
  }
  const solve = (A, b) => {
    const m = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < 3; c++) {
      let piv = c; for (let r = c + 1; r < 3; r++) if (Math.abs(m[r][c]) > Math.abs(m[piv][c])) piv = r;
      [m[c], m[piv]] = [m[piv], m[c]];
      for (let r = 0; r < 3; r++) if (r !== c) { const f = m[r][c] / m[c][c]; for (let k = c; k < 4; k++) m[r][k] -= f * m[c][k]; }
    }
    return [m[0][3] / m[0][0], m[1][3] / m[1][1], m[2][3] / m[2][2]];
  };
  return { u: solve(M, bu), v: solve(M, bv) };
}

/** Sun + ambient.  Values are Blender's (sun strength in W/m^2 = three intensity: both use
 *  radiance = albedo/pi * E), scaled by `gain` for the transmittance the Blender sun loses in the
 *  water volume before it reaches the floor (tuned against the fish-free plate). */
export function buildLights(scene, comp, { sunGain = 0.55, ambient = 1.0, keyGain = 0.38 } = {}) {
  const sun = comp.lights.find((l) => l.name === 'SUN_Main');
  const dl = new THREE.DirectionalLight(new THREE.Color(...sun.color), sun.energy * sunGain);
  const d = new THREE.Vector3().fromArray(sun.direction.three).normalize();
  dl.position.copy(d).multiplyScalar(-30);
  dl.target.position.set(0, 0, 0);
  scene.add(dl, dl.target);
  envUniforms.uSunCol.value.setRGB(...sun.color).multiplyScalar(sun.energy * sunGain);
  const key = comp.lights.find((l) => l.name === 'SUN_Key');
  if (key) {
    envUniforms.uKeyDir.value.fromArray(key.direction.three).normalize();
    envUniforms.uKeyCol.value.setRGB(...key.color).multiplyScalar(key.energy * keyGain);
  }
  // (frutiger 10-05) SUN_SandKey (light-linked to the sand only, see envUniforms): same water-transmittance gain as
  // the key it copies (same direction, same colour)
  const sk = comp.lights.find((l) => l.name === 'SUN_SandKey');
  if (sk) {
    envUniforms.uSandKeyDir.value.fromArray(sk.direction.three).normalize();
    envUniforms.uSandKeyCol.value.setRGB(...sk.color).multiplyScalar(sk.energy * keyGain);
  }
  // (frutiger 10-05) caustic received-light weights (envUniforms.uCausRecv), only for the frutiger look (the aquarium
  // web look was calibrated without it): Blender energies — SUN_Main, SUN_SandKey and the world (strength x ~0.6, the
  // mean of its bottom->top blend over the upper hemisphere a floor sees)
  envUniforms.uSandKeyDirC.value.copy(sk ? envUniforms.uSandKeyDir.value : envUniforms.uKeyDir.value);
  if (comp.look?.preset === 'frutiger') envUniforms.uCausRecv.value.set(sun.energy, sk ? sk.energy : 0, comp.water.world.strength * 0.6);
  // world: background = mix(bottom, top, smoothstep(-0.4, 0.9, dir.z)) * strength (radiance).
  // three's hemisphere 'colour' is irradiance, and a uniform sky of radiance L gives E = pi L.
  const w = comp.water.world;
  const hemi = new THREE.HemisphereLight(
    new THREE.Color(...w.top_color).multiplyScalar(w.strength * Math.PI * 0.5 * ambient),
    new THREE.Color(...w.bottom_color).multiplyScalar(w.strength * Math.PI * 0.5 * ambient), 1);
  scene.add(hemi);
  return { sun: dl, hemi };
}
