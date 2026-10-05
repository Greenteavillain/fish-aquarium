// Fish material: MeshStandardMaterial + FishSwim in the vertex shader + neon recolour + fish-only
// lights + water fog.
//
// WHY onBeforeCompile on MeshStandardMaterial (not a ShaderMaterial): we keep three's PBR lighting,
// the double-sided normal flip and the colour pipeline for free, and only splice in (a) the swim
// deformation where the vertex position/normal are first read, (b) the recolour right after the
// atlas is sampled, (c) extra directional lights that only fish receive, (d) the water fog.
import * as THREE from 'three';
import { SWIM_GLSL, SWIM_STYLES } from './swim_glsl.js';
import { patchMaterial, waterPatch, waterUniforms } from './water.js';

// shared by every fish material
export const fishUniforms = {
  uNeon: { value: 0 },     // 0 = scanned colours untouched, 1 = neon palette (animated in between)
  // Light linking emulation.  In scenes/final SUN_Key / SUN_Bounce / SUN_CamFill only light fish
  // (collections LL_NoGround / LL_NoEnv); three.js lights hit everything, so these three are added
  // inside the fish shader instead of as scene lights.  World-space direction the light TRAVELS.
  uFishLightDir: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
  uFishLightCol: { value: [new THREE.Color(), new THREE.Color(), new THREE.Color()] },
  // (frutiger 10-05) the look's fish COAT (compose lit_material Coat Weight / Roughness: frutiger 0.22 / 0.14,
  // aquarium 0.15 / 0.20): a second, sharper specular lobe for the key light only = small glossy wet highlights
  // on the flanks.  WHY not MeshPhysicalMaterial.clearcoat: that adds a clearcoat evaluation for EVERY light and
  // the environment term to every fish fragment, and the fish are fill-bound; one GGX lobe for the key is the
  // part that shows (bounce / fill have specular 0 / 0.1 in the scene).
  uCoat: { value: new THREE.Vector2(0, 0.2) },
  // (frutiger 10-05) SUN_SchoolFill (light-linked in compose to SWARM_parrot_low only: the dark-teal parrotfish
  // band over the now bright sand read as dark blobs; lifted with light, not colour).  Direction / colour here;
  // which fish get it is decided per material (SCHOOL_FILL define, see makeFishMaterial) and by height:
  // uSchoolFillY = (full below, zero above) world y, the parrot_low band's height.
  uSchoolFillDir: { value: new THREE.Vector3(0, 0, -1) },
  uSchoolFillCol: { value: new THREE.Color(0, 0, 0) },
  uSchoolFillY: { value: new THREE.Vector2(1.5, 2.5) },
  // (frutiger 10-05) environment reflection strength (0 = off, the aquarium web look): the fish's specular lobe
  // reflects the WATER around it (water.js waterColor of the reflected direction = the same radiance the
  // background shows there).  WHY: three has no environment for these materials (no envMap), so the specular
  // reflected only the three direct lights and the silver species (mackerel, saury, sardine, needlefish:
  // metalness 0.3) read dark grey-blue next to the poster, where EEVEE reflects the bright surface water
  // (light silver flanks, the glossy wet sheen of the look).  Fed into three's own indirect-specular path
  // (radiance -> RE_IndirectSpecular), so roughness / Fresnel / metalness weight it like an envMap would.
  uFishEnv: { value: 0 },
};

// (frutiger 10-05) environment reflection for the frutiger look, see uFishEnv.  Frozen-frame A/B of the poster frame
// (checks/web/tmp/frutiger/envB_0/1/15.png): 0 -> 1 lifts meanL 0.609 -> 0.628 and turns the needlefish / saury from
// dark grey-blue to light silver with a sheen; 1.5 starts to wash the warm fish (warm share 13.7 -> 12.5 %).  1.0 =
// the physical amount (the LUT IS the water radiance in that direction).
const FISH_ENV_FRUTIGER = 1.0;

export function setupFishLights(comp, gain = 1) {
  const names = ['SUN_Key', 'SUN_Bounce', 'SUN_CamFill'];
  names.forEach((n, i) => {
    const L = comp.lights.find((l) => l.name === n);
    if (!L) return;
    fishUniforms.uFishLightDir.value[i].fromArray(L.direction.three).normalize();
    fishUniforms.uFishLightCol.value[i].setRGB(...L.color).multiplyScalar(L.energy * L.diffuse_factor * gain);
  });
  const v = comp.look?.values;
  if (v && v.coat != null) fishUniforms.uCoat.value.set(v.coat, v.coat_rough ?? 0.2);
  if (comp.look?.preset === 'frutiger') fishUniforms.uFishEnv.value = FISH_ENV_FRUTIGER;
  const sf = comp.lights.find((l) => l.name === 'SUN_SchoolFill');
  if (sf) {
    fishUniforms.uSchoolFillDir.value.fromArray(sf.direction.three).normalize();
    fishUniforms.uSchoolFillCol.value.setRGB(...sf.color).multiplyScalar(sf.energy * sf.diffuse_factor * gain);
    // the receiving swarm's height band (three y): full fill up to its centre, fading out by its top
    const names2 = sf.light_linking_receiver?.included || [];
    const sw = comp.swarms.find((s) => names2.includes(s.object));
    if (sw && sw.domain_center) {
      const yc = sw.domain_center.three[1], hh = (sw.domain_size?.[2] ?? 1) / 2;
      fishUniforms.uSchoolFillY.value.set(yc, yc + hh + 0.5);
    }
    return sw ? sw.species.map((x) => x.id) : [];
  }
  return [];
}

// Neon palette, picked from the reference video (sRGB hex) with rough weights.
// (QA2 round 2) weights re-balanced against a hue histogram of the frame (saturated non-water pixels):
// ref_aquarium vs the neon start view had yellow 0.10 vs 0.16-0.18, orange 0.10 vs 0.12-0.15, violet
// 0.09 vs 0.05 -> yellow/orange 0.15/0.14 -> 0.11/0.11, violet 0.05 -> 0.10, lime 0.10 -> 0.12.
// (pickTint draws one random number whatever the weights, so the population is otherwise unchanged)
export const NEON_PALETTE = [
  ['#ff1f7a', 0.22], ['#ff3fb4', 0.10], ['#f2231d', 0.16], ['#ff7a12', 0.11],
  ['#ffcf1a', 0.11], ['#9de21c', 0.12], ['#2f74ff', 0.08], ['#a35bff', 0.10],
].map(([hex, w]) => [new THREE.Color(hex), w]);     // THREE.Color(hex) converts sRGB -> linear

const FISH_VERT_PARS = /* glsl */`
attribute vec4 aSwim;   // tau (fract of tail beats), phase, amplitude multiplier, unused
attribute vec4 aTint;   // neon colour (linear rgb), brightness jitter
varying vec4 vTint;
${SWIM_GLSL}
`;

const FISH_BEGIN = /* glsl */`
sw_tau = aSwim.x; sw_phase = aSwim.y; sw_amp = uSwimA.x * aSwim.z;
// GLB (three, Y-up) -> rig frame (Blender canonical): b = (x, -z, y);  back: p = (b.x, b.z, -b.y)
vec3 swP = vec3(position.x, -position.z, position.y);
vec3 swN = swimDeform(swP, vec3(normal.x, -normal.z, normal.y));
vec3 objectNormal = vec3(swN.x, swN.z, -swN.y);
vec3 swPos = vec3(swP.x, swP.z, -swP.y);
vTint = aTint;
`;

const FISH_FRAG_PARS = /* glsl */`
varying vec4 vTint;
uniform float uNeon;
uniform vec3 uFishLightDir[3];
uniform vec3 uFishLightCol[3];
uniform vec2 uCoat;
uniform float uFishEnv;
#ifdef SCHOOL_FILL
uniform vec3 uSchoolFillDir, uSchoolFillCol;
uniform vec2 uSchoolFillY;
varying float vFishY;
#endif
`;

// Recolour: keep the scan's luminance pattern (fin rays, eye, belly, stripes) as SHADING, replace hue
// with the instance colour; the brightest parts lift toward white a little (like the lit fish in the
// reference).  uNeon == 0 leaves diffuseColor exactly as sampled (natural mode = untouched atlas).
// (QA2) Dark marks used to go to 10 % of the colour, so the stripey and knifejaw scans stayed boldly
// black-banded and read as 'painted striped fish', not the reference's glowing, nearly solid tetras.
// They now keep 45 % of the colour (the pattern still reads, as darker bands of the same hue), and
// the fish get a faint self-glow (neonGlow, added as emission below): fluorescent aquarium fish stay
// vivid on their shadow side and under the haze, which is what makes the reference read as lit
// confetti rather than painted shapes.
const FISH_RECOLOR = /* glsl */`
vec3 neonGlow = vec3(0.0);
if (uNeon > 0.0 && vTint.a > 0.0) {      // vTint.a = 0: never recolour (the shark-jaw prop is bone)
  float lum = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  // (QA2 round 2) The luminance pattern is taken 75 % from a blurred atlas level (mip 5.5, ~45
  // texels of a 1024 atlas: the stripey's bands repeat every 60-80 texels, so mip 3 — tried first —
  // left them fully visible; the pale belly / darker back / dark tail stay).  WHY: with the river in the
  // opening view, neon mode reads as the reference's confetti wall, but the hero stripey and knifejaw
  // kept their bold bands (as darker stripes of the same hue, and the white lift turned the pale
  // bands into whitish stripes) — 'candy-striped' painted fish next to the reference's solid glowing
  // tetras.  The atlases are dilated (0.1-1.8 % near-black texels at 128 px), so the blur does not
  // pull dark background in at UV-island edges.
  #ifdef USE_MAP
  lum = mix(lum, dot(textureLod(map, vMapUv, 5.5).rgb, vec3(0.2126, 0.7152, 0.0722)), 0.75);
  #endif
  float k = smoothstep(0.004, 0.30, lum);
  // (QA2) the palette is the reference's most saturated pixels; used as is (and lifted again by the
  // grade's warm-hue saturation) the fish measured HSL S 0.86-0.91 against the reference's 0.43-0.54
  // (checks/web/qa2_t7_poster_neon.png vs ref_aquarium.png, fish pixels by hue band): flat primary
  // colours, not the reference's milky glowing tetras.  So the tint is pulled 40 % toward its luma.
  vec3 tint = mix(vec3(dot(vTint.rgb, vec3(0.2126, 0.7152, 0.0722))), vTint.rgb, 0.6);
  vec3 neon = tint * (0.45 + 0.70 * k) * vTint.a + vec3(0.9) * max(lum - 0.32, 0.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, neon, uNeon);
  neonGlow = tint * vTint.a * (0.35 + 0.65 * k) * 0.22 * uNeon;
}
`;

// Key = full PBR (Blender specular 0.85).  Bounce / CamFill have specular 0 / 0.1 in scenes/final, so
// they are diffuse-only here: two fewer GGX evaluations per fish fragment (fish are fill-bound).
const FISH_LIGHTS = /* glsl */`
{
  IncidentLight fLight;
  fLight.color = uFishLightCol[0];
  fLight.direction = normalize((viewMatrix * vec4(-uFishLightDir[0], 0.0)).xyz);
  fLight.visible = true;
  RE_Direct(fLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight);
  for (int fli = 1; fli < 3; fli++) {
    vec3 fd = normalize((viewMatrix * vec4(-uFishLightDir[fli], 0.0)).xyz);
    reflectedLight.directDiffuse += saturate(dot(geometryNormal, fd)) * uFishLightCol[fli] * BRDF_Lambert(material.diffuseColor);
  }
  // (frutiger 10-05) coat lobe on the key (see fishUniforms.uCoat): GGX, F0 0.04 (IOR 1.5), roughness uCoat.y
  if (uCoat.x > 0.0) {
    vec3 cH = normalize(fLight.direction + geometryViewDir);
    float cNL = saturate(dot(geometryNormal, fLight.direction)), cNV = saturate(dot(geometryNormal, geometryViewDir));
    float cA = pow2(uCoat.y);
    float cF = F_Schlick(vec3(0.04), 1.0, saturate(dot(geometryViewDir, cH))).x;
    reflectedLight.directSpecular += uCoat.x * cNL * fLight.color * cF * V_GGX_SmithCorrelated(cA, cNL, cNV) * D_GGX(cA, saturate(dot(geometryNormal, cH)));
  }
  #ifdef SCHOOL_FILL
  {
    vec3 sfd = normalize((viewMatrix * vec4(-uSchoolFillDir, 0.0)).xyz);
    float sfw = 1.0 - smoothstep(uSchoolFillY.x, uSchoolFillY.y, vFishY);
    reflectedLight.directDiffuse += sfw * saturate(dot(geometryNormal, sfd)) * uSchoolFillCol * BRDF_Lambert(material.diffuseColor);
  }
  #endif
}
`;

// (frutiger 10-05) environment reflection (see fishUniforms.uFishEnv); after three's lights_fragment_maps, where
// an envMap would have added its radiance
const FISH_ENV = /* glsl */`
#if defined( RE_IndirectSpecular )
if (uFishEnv > 0.0) {
  vec3 rW = inverseTransformDirection(reflect(-geometryViewDir, geometryNormal), viewMatrix);
  radiance += waterColor(rW) * uFishEnv;
}
#endif
`;

function fishPatch(style, fill) {
  return {
    key: 'fish' + style + (fill ? 'F' : ''),
    apply(shader, material) {
      Object.assign(shader.uniforms, fishUniforms, material.userData.swimUniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\n' + FISH_VERT_PARS)
        .replace('#include <beginnormal_vertex>', FISH_BEGIN)
        .replace('#include <begin_vertex>', 'vec3 transformed = swPos;');
      if (material.defines.SCHOOL_FILL) {
        // world height of the fish (instance origin) for the school fill's height band
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying float vFishY;')
          .replace('#include <project_vertex>', '#include <project_vertex>\nvFishY = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).y;');
      }
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\n' + FISH_FRAG_PARS)
        .replace('#include <map_fragment>', '#include <map_fragment>\n' + FISH_RECOLOR)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += neonGlow;')
        .replace('#include <lights_fragment_maps>', FISH_LIGHTS + '\n#include <lights_fragment_maps>\n' + FISH_ENV);
    },
  };
}

/**
 * spec: one species.json entry.  map: its atlas texture (shared by near and far LOD).
 * swim: {amp, wavelength, detail, bias, rigid_front}
 */
export function makeFishMaterial(spec, map, swim, { schoolFill = false } = {}) {
  const styleIndex = SWIM_STYLES.indexOf(spec.swim_style);
  const m = new THREE.MeshStandardMaterial({
    map,
    roughness: spec.material.roughness,
    metalness: spec.material.metalness,
    // species.json three_notes: diodon, gurnard and pinecone-fish must be FrontSide (crossed fin
    // skins after decimation show dark flecks double-sided); the rest are single-sheet-fin scans.
    side: spec.material.doubleSided ? THREE.DoubleSide : THREE.FrontSide,
  });
  // (2026-10-05 web sync) compose.py VALUE_LIFT: a per-species brightness factor on the scan colour
  // (fix3: angelfish 1.15, red-naped wrasse 1.12; 1.0 for the rest), read from the saved scene by
  // web_export_comp.  material.color multiplies the atlas in linear space, which is where Blender
  // multiplies it (the fs_rand map range), so this is the same operation.  WHY it matters: without it
  // the deep-red wrasse read maroon and the angelfish's blue lines dull under the haze (final fix3).
  m.color.setScalar(spec.material.value_lift ?? 1);
  m.defines = { SW_STYLE: styleIndex };
  if (schoolFill) m.defines.SCHOOL_FILL = 1;
  m.userData.swimUniforms = {
    uSwimA: { value: new THREE.Vector4(swim.amp, swim.wavelength, swim.detail ?? 1, swim.bias ?? 0) },
    uSwimB: { value: new THREE.Vector4(swim.rigid_front ?? 0, spec.rig_extents.ymax, spec.rig_extents.zmax, 0) },
  };
  return patchMaterial(m, [fishPatch(styleIndex, schoolFill), waterPatch]);
}

export { waterUniforms };
