// Light shafts (fake volumetrics) and marine snow.
import * as THREE from 'three';
import { WATER_PARS_GLSL, waterUniforms } from './water.js';

/**
 * A light shaft = the final's soft emissive streak (scenes/final/compose.py make_shafts, QA round 2),
 * drawn on the BACK faces of a cylinder around its axis.
 *
 * WHY it was rewritten (QA2): the first version reproduced round 1's narrow spot beam — a hard,
 * near-white tube from the top of the frame down to the sand — which is exactly what the final's own
 * QA called a BLOCKER ('neon tube', 'frosted-glass rod', 'brighter toward the sand') and replaced.
 * The final's beam is an emission-only field along SUN_Main's rays:
 *   radial  = bell(r/rc) + 0.22 * bell(r/(2.6 rc)),  bell(q) = max(0, 1-q^2)^3   (soft, no rim)
 *   axial   = fades in over the top 45 % and out over the bottom 60 % of its length (a streak that
 *             dissolves well above the sand, never 'brighter toward the sand')
 *   streaks = noise stretched along the beam (x28 across, x0.9 along) mapped to 0.7..1.2
 *   modest  = core about 1.3-1.5x the water beside it.
 * Per pixel the shader finds where the view ray passes closest to the axis (closed-form line-line
 * distance) and integrates the radial profile across the ray analytically (bell ~ exp(-3.5 q^2):
 * the chord integral is exp(-3.5 d^2/R^2) * 0.947 R), divided by sin(angle) because the chord grows
 * as you look along the beam (capped, like the plate's top that is bright but not clipped).
 * The result is added in DISPLAY space (toneMapped:false, no colour-space conversion): the final's
 * measured contrast is a display-space ratio, and an sRGB-encoded faint halo (the first version
 * encoded linear values, x12.9 near black) was what made the old beam read wide AND hard.
 * WHY back faces: each pixel is shaded once even when the camera is inside the beam, and fish in
 * front still occlude it (depth test on); a fish can only hide the part of the beam behind it.
 */
// (frutiger 10-05) blend: 'add' (QA2 calibration, aquarium look) or 'screen' = src x (1 - dst) + dst.  WHY screen
// for the frutiger look: the water behind the beams is already near the top of the display range (top rows
// 136-164, 215-229, 249-251), so a plain display-space ADD clipped every beam core to pure 255 white in all three
// channels (measured on the fish-free plate: 0.15-row peaks 255,255,255 where Blender has 215,240,252).  In Blender
// the emission is added BEFORE the Neutral view transform, whose highlight shoulder rolls the core off toward
// white without clipping; a screen blend is the display-space equivalent of that roll-off (it adds nothing to a
// channel already at 1), so the cores whiten like Blender's (red rises most) and never hit 255 on every channel.
export function makeShaft({ top, bottom, rc = 0.07, gain = 0.16, color = [1.0, 0.96, 0.86], seed = 0, blend = 'add' }) {
  const A = new THREE.Vector3().fromArray(top), B = new THREE.Vector3().fromArray(bottom);
  const len = A.distanceTo(B);
  const U = B.clone().sub(A).normalize();                           // direction light travels
  const R = rc * 2.6 * 1.08;                                         // the mesh just covers the halo
  // CLOSED (caps on).  WHY (QA2 round 2): with an open tube, a view ray that leaves through an end
  // opening hits no back face, so looking up along a beam (the 'up' view: every shaft converges to
  // the sun point) showed a disc-shaped HOLE in the glow with a hard rim where the streak was cut
  // (qa2r_up_plate.png: 228 -> 174 in one pixel).  A closed convex hull gives every ray exactly one
  // back-face fragment; the axial fade is 0 at both ends, so the caps themselves never show.
  const geo = new THREE.CylinderGeometry(R, R, len, 20, 1, false);
  geo.translate(0, -len / 2, 0);                                   // top at origin, extends down -Y
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...waterUniforms,
      uA: { value: A }, uU: { value: U }, uLen: { value: len },
      uRc: { value: rc },
      uCol: { value: new THREE.Color(...color) },     // display-space tint, used as is
      uGain: { value: gain },
      uSeed: { value: seed },
      uPixAng: { value: 0.001 },      // radians per pixel, set per frame (main.js)
    },
    vertexShader: /* glsl */`
      varying vec3 vW;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vW = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      ${WATER_PARS_GLSL}
      uniform vec3 uA, uU, uCol;
      uniform float uLen, uRc, uGain, uSeed, uPixAng;
      varying vec3 vW;
      float sh_hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float sh_noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(sh_hash(i), sh_hash(i + vec2(1, 0)), f.x), mix(sh_hash(i + vec2(0, 1)), sh_hash(i + vec2(1, 1)), f.x), f.y);
      }
      void main() {
        vec3 o = cameraPosition;
        vec3 ray = vW - o;
        float sFrag = length(ray);
        vec3 v = ray / sFrag;
        vec3 w0 = o - uA;
        float b = dot(v, uU), d = dot(v, w0), e = dot(uU, w0);
        float den = max(1.0 - b * b, 1e-4);
        float s = clamp((b * e - d) / den, 0.0, sFrag);
        float t = clamp(e + b * s, 0.0, uLen);       // axis parameter of the closest point
        vec3 off = o + v * s - (uA + uU * t);
        float dist = length(off);
        // never thinner than ~1.5 px: a sub-pixel core aliases into a shimmering line far away.
        // Widening keeps the integrated brightness (amplitude x rc / r).
        float r = max(uRc, 1.5 * uPixAng * s);
        float w = uRc / r;
        float rh = 2.6 * r;
        float radial = (exp(-3.5 * dist * dist / (r * r)) * r + 0.22 * exp(-3.5 * dist * dist / (rh * rh)) * rh) * 0.947 / uRc * w;
        // axial fades, in the final's object-space terms: zz = +1 at the top .. -1 at the bottom
        float zz = 1.0 - 2.0 * t / uLen;
        float fin = clamp((1.0 - zz) / 0.9, 0.0, 1.0), fout = clamp(zz + 1.0, 0.0, 1.0);
        float axial = fin * fin * (3.0 - 2.0 * fin) * fout * fout * (3.0 - 2.0 * fout);
        // streaks: noise across (signed lateral offset, x28 per m) and along (x0.9 per m) the beam
        vec3 side = normalize(cross(uU, v) + vec3(1e-5));
        float lat = dot(off, side);
        float n = sh_noise(vec2(lat * 28.0 + uSeed * 17.0, t * 0.9 + uSeed * 5.0)) * 0.65 + sh_noise(vec2(lat * 61.0, t * 2.1 + uSeed)) * 0.35;
        float streak = mix(0.7, 1.2, clamp((n - 0.3) / 0.4, 0.0, 1.0));
        float chord = 1.0 / max(sqrt(den), 0.55);     // looking along the beam: longer chord, capped
        // emission seen through the water in front of it; and nothing within 0.25 m of the eye
        // (the camera can swim through a beam: no flash of the full chord right at the lens)
        float I = uGain * radial * axial * streak * chord * exp(-uFogSigma * s) * smoothstep(0.1, 0.6, s);
        gl_FragColor = vec4(uCol * I, 1.0);
      }`,
    side: THREE.BackSide,
    transparent: true,
    depthWrite: false,
    blending: blend === 'screen' ? THREE.CustomBlending : THREE.AdditiveBlending,
    ...(blend === 'screen' ? { blendEquation: THREE.AddEquation, blendSrc: THREE.OneMinusDstColorFactor, blendDst: THREE.OneFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor } : {}),
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  // orient the cylinder's -Y along U, top at A
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), U);
  mesh.position.copy(A);
  mesh.renderOrder = 5;
  mesh.name = 'FX_Shaft';
  return mesh;
}

/**
 * Marine snow: specks in a box that wraps around the camera (so you can swim anywhere and it is
 * always there), drifting down and swaying.  The box edges fade so wrapping never pops.
 */
export function makeSnow(count = 3500, box = [20, 12, 20], seed0 = 1234567) {
  const geo = new THREE.BufferGeometry();
  const p = new Float32Array(count * 3), a = new Float32Array(count * 4);
  let seed = seed0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < count; i++) {
    p[i * 3] = rnd(); p[i * 3 + 1] = rnd(); p[i * 3 + 2] = rnd();
    const r = rnd();
    a[i * 4] = 0.0016 + 0.0034 * r * r * r;          // size (m), composition.marine_snow
    a[i * 4 + 1] = rnd() * 6.2831;                    // sway phase
    a[i * 4 + 2] = 0.006 + 0.02 * rnd();              // fall speed (m/s)
    a[i * 4 + 3] = 0.01 + 0.05 * rnd();               // sway amplitude (m)
  }
  geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
  geo.setAttribute('aSnow', new THREE.BufferAttribute(a, 4));
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...waterUniforms, uBox: { value: new THREE.Vector3(...box) }, uFocal: { value: 800 } },
    vertexShader: /* glsl */`
      uniform vec3 uBox; uniform float uFocal, uTime;
      attribute vec4 aSnow;
      varying float vA, vSz; varying vec3 vRay;
      void main() {
        vec3 base = position * uBox;
        base.y -= uTime * aSnow.z;
        base.x += aSnow.w * sin(uTime * 0.31 + aSnow.y);
        base.z += aSnow.w * cos(uTime * 0.23 + aSnow.y * 1.7);
        vec3 rel = mod(base - cameraPosition + 0.5 * uBox, uBox) - 0.5 * uBox;
        vec3 edge = smoothstep(0.5 * uBox, 0.5 * uBox - min(vec3(1.5), 0.3 * uBox), abs(rel));
        vec3 w = cameraPosition + rel;
        vec4 mv = viewMatrix * vec4(w, 1.0);
        gl_Position = projectionMatrix * mv;
        float dist = -mv.z;
        float px = aSnow.x * uFocal / max(dist, 0.05);
        // (QA2) CAM_Main's depth of field on the specks only (28 mm f/2.8 focused at 3 m: aperture
        // 0.01 m, blur angle = 0.01 * |1/d - 1/3|): near specks open into soft bokeh discs, specks
        // at ~3 m stay crisp points, far ones soften.  WHY: next to the final's fish-free plate
        // (crisp points + soft discs + a few big bokeh) the web water had almost no visible snow —
        // 1-px points that 4x MSAA resolved to a quarter of their brightness — and the snow is
        // the main cue that the water itself has depth.  Energy is spread over the disc
        // (alpha ~ speck size / disc size), so a disc is fainter the more it is blurred.
        float coc = uFocal * 0.01 * abs(1.0 / max(dist, 0.05) - 1.0 / 3.0);
        float sz = clamp(max(px * 2.0, coc), 2.0, 28.0);
        gl_PointSize = sz;
        vSz = sz;
        vA = edge.x * edge.y * edge.z * clamp((px * 2.0 + 0.6) / sz, 0.0, 1.0) * (1.0 - smoothstep(9.0, 11.0, dist));
        vRay = rel;
      }`,
    fragmentShader: /* glsl */`
      ${WATER_PARS_GLSL}
      varying float vA, vSz; varying vec3 vRay;
      void main() {
        vec2 c = gl_PointCoord - 0.5;
        // small: soft point; blurred: a flat disc with a soft rim (bokeh)
        float r = length(c);
        float m = mix(smoothstep(0.5, 0.15, r), 1.0 - smoothstep(0.34, 0.5, r), smoothstep(2.5, 6.0, vSz));
        float dist = length(vRay);
        // (QA2) sunlit particles: brighter than the old 0.75-0.86 (the final's specks read near-white)
        vec3 speck = vec3(1.0, 1.1, 1.08);
        vec3 col = mix(speck, waterColor(vRay / max(dist, 1e-4)), 1.0 - exp(-uFogSigma * dist));
        gl_FragColor = vec4(col, vA * m);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = 4;
  pts.name = 'FX_Snow';
  return pts;
}

/**
 * (frutiger 10-05) Bubbles = compose.py make_bubbles (ENV_Bubbles, material F_Bubble), the Aero accent of the
 * frutiger look: the same vents / per-bubble attributes (composition.bubbles, exported from the scene) and the
 * same loopable motion, evaluated on the GPU per instance:
 *   T = fract(time / 10 s)  (240 frames at 24 fps),  t = fract(T * b_cyc + b_phase)          life 0..1
 *   rise  +t * b_rise (up),  sway a = 2 pi (T * b_k + b_ph2), s = b_amp (0.4 + 0.8 t),
 *         offset blender (sin a s, cos a s 0.6, 0) -> three (sin a s, 0, -cos a s 0.6)
 *   radius = b_size * min(8 t, 6.5 (1 - t), 1) * (0.8 + 0.4 t)   (grows in, shrinks out: no pop at the wrap)
 * Shading = F_Bubble's: rim = facing^2 with Layer Weight 'Facing' at blend 0.35 (1 - |cos|^0.7), mixed
 * 0.05 + 0.92 rim between see-through and (rim emission b_glow x 0.9 x (0.85, 0.97, 1.0) + a sharp glint).
 * WHY camera-facing quads with a sphere evaluated per pixel and not a sphere mesh: a 3-17 mm bubble covers a few
 * pixels to a few dozen; 216 (+ the web extras) quads cost nothing, and the per-pixel sphere gives the exact
 * rim / centre profile at any size.  WHY the depth of field here (like the snow): the look's 'soft bokeh orbs'
 * are bubbles near the lens that CAM_Main's f/2.8 blurs (compose 'near' vent, 0.9-1.6 m from the lens); a
 * blurred bubble becomes a soft disc with the same energy spread over it.
 * opts.wrap = [x, y, z] box (m): instead of fixed world vents, the points are positions in a box that wraps
 * with the camera (web-only ambient bubbles so a free camera meets them wherever it swims; the box edges fade).
 */
export function makeBubbles({ points, attrs, rim = 0.9, rimColor = [0.85, 0.97, 1.0], loopSeconds = 10, wrap = null, name = 'FX_Bubbles' }) {
  const n = points.length / 3;
  const geo = new THREE.InstancedBufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
  geo.setIndex([0, 1, 2, 0, 2, 3]);
  geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(new Float32Array(points), 3));
  const b0 = new Float32Array(n * 4), b1 = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    b0.set([attrs.b_phase[i], attrs.b_cyc[i], attrs.b_rise[i], attrs.b_size[i]], i * 4);
    b1.set([attrs.b_amp[i], attrs.b_ph2[i], attrs.b_k[i], attrs.b_glow[i]], i * 4);
  }
  geo.setAttribute('aB0', new THREE.InstancedBufferAttribute(b0, 4));
  geo.setAttribute('aB1', new THREE.InstancedBufferAttribute(b1, 4));
  geo.instanceCount = n;
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...waterUniforms,
      uFocal: { value: 800 },             // px per radian at the screen centre (main.js, per frame)
      uLoop: { value: loopSeconds },
      uRim: { value: rim },
      uRimCol: { value: new THREE.Color().setRGB(...rimColor) },   // scene-linear, as F_Bubble's emission colour
      uWrap: { value: new THREE.Vector3(...(wrap || [0, 0, 0])) },
      uGlintCol: { value: new THREE.Color(1, 1, 1) },
    },
    defines: wrap ? { BUB_WRAP: 1 } : {},
    vertexShader: /* glsl */`
      uniform float uTime, uFocal, uLoop;
      uniform vec3 uWrap;
      attribute vec3 aBase;
      attribute vec4 aB0, aB1;
      varying vec2 vUv;
      varying float vExpand, vFade, vGlow, vDist, vDpx;
      varying vec3 vRay;
      void main() {
        float T = fract(uTime / uLoop);
        float t = fract(T * aB0.y + aB0.x);
        float a = 6.2831853 * (T * aB1.z + aB1.y);
        float s = aB1.x * (0.4 + 0.8 * t);
        vec3 w = aBase + vec3(sin(a) * s, t * aB0.z, -cos(a) * s * 0.6);
        float fade = 1.0;
        #ifdef BUB_WRAP
        vec3 rel = mod(w - cameraPosition + 0.5 * uWrap, uWrap) - 0.5 * uWrap;
        vec3 edge = smoothstep(0.5 * uWrap, 0.5 * uWrap - min(vec3(1.0), 0.3 * uWrap), abs(rel));
        fade = edge.x * edge.y * edge.z;
        w = cameraPosition + rel;
        #endif
        float rad = aB0.w * min(min(8.0 * t, 6.5 * (1.0 - t)), 1.0) * (0.8 + 0.4 * t);
        vec4 mv = viewMatrix * vec4(w, 1.0);
        float dist = max(-mv.z, 0.05);
        // projected radius (px) and CAM_Main's depth-of-field blur (28 mm f/2.8 = 0.01 m aperture, focus 3 m:
        // CoC diameter px = focal_px * 0.01 * |1/d - 1/3|, as fx.js makeSnow)
        float rpx = rad * uFocal / dist;
        float coc = uFocal * 0.01 * abs(1.0 / dist - 1.0 / 3.0);
        float dpx = max(rpx, max(0.5 * coc, 0.75));          // drawn disc radius (px)
        vExpand = dpx / max(rpx, 1e-4);                      // >1 when blurred or sub-pixel
        // the quad covers the drawn disc + 1.5 px of soft edge
        float qpx = dpx + 1.5;
        mv.xy += position.xy * qpx * dist / uFocal;
        vUv = position.xy * qpx / dpx;                       // 1.0 at the drawn disc's edge
        gl_Position = projectionMatrix * mv;
        // energy kept when blurred / sub-pixel: the bubble's area over the drawn disc's area
        vFade = fade * (rad > 0.0 ? 1.0 : 0.0) * min(1.0, 1.0 / (vExpand * vExpand)) * smoothstep(0.08, 0.2, dist);
        vGlow = aB1.w;
        vDist = dist;
        vDpx = dpx;
        vRay = w - cameraPosition;
      }`,
    fragmentShader: /* glsl */`
      ${WATER_PARS_GLSL}
      uniform float uRim;
      uniform vec3 uRimCol, uGlintCol;
      varying vec2 vUv;
      varying float vExpand, vFade, vGlow, vDist, vDpx;
      varying vec3 vRay;
      void main() {
        float r = length(vUv);
        if (r > 1.0 + 1.5 / 8.0 || vFade <= 0.0) discard;
        // sharp: the bubble's own profile; blurred (vExpand > 1): a soft disc (bokeh orb) carrying its mean
        float rs = min(r, 0.999);
        float cosv = sqrt(1.0 - rs * rs);
        float facing = 1.0 - pow(cosv, 0.7);                 // Layer Weight Facing, blend 0.35
        float rim = facing * facing;
        float f = 0.05 + 0.92 * rim;
        // (A/B against the Blender plate's bubble column, checks/web/tmp/frutiger/bub_crop: the web rings read
        // thin and faint) two things the EEVEE render has that the plain rim profile lacks:
        //  * the glossy shell's Fresnel reflection of the bright surface water: white at grazing angles
        //    (Schlick, F0 0.04), i.e. on the rim, on top of the rim emission;
        //  * a ring at least ~1 px wide: a 3-8 px bubble's physical rim is sub-pixel, which EEVEE's 1.5 px
        //    pixel filter (and the look's bloom) widen into a visible white ring.
        vec3 nV = vec3(vUv, cosv);
        float fres = 0.04 + 0.96 * pow(1.0 - cosv, 5.0);
        float dEdge = (1.0 - r) * vDpx;                       // px inside the drawn edge
        float pixRing = exp(-dEdge * dEdge / 1.1) * step(r, 1.0 + 1.0 / max(vDpx, 1.0));
        f = max(f, 0.8 * pixRing);
        // sharp glint: the sun / bright surface reflected on the upper side (glossy roughness 0.05)
        float glint = pow(max(dot(nV, normalize(vec3(-0.35, 0.75, 0.56))), 0.0), 60.0);
        vec3 E = uRim * vGlow * uRimCol + vec3(0.62, 0.92, 1.0) * 0.9 * max(fres, pixRing) + uGlintCol * glint * 1.6;
        float edgeAA = 1.0 - smoothstep(1.0 - 0.12 / max(1.0, 1.0 / vExpand), 1.0 + 0.12, r);
        float blur = smoothstep(1.3, 3.0, vExpand);
        // orb: flat disc with a faint brighter rim (a bokeh disc), mean of f over the sphere's disc ~0.42
        float orbA = (0.42 + 0.25 * smoothstep(0.55, 0.95, r)) * (1.0 - smoothstep(0.9, 1.05, r));
        float a = mix(f * edgeAA, orbA, blur);
        vec3 col = mix(E, uRim * vGlow * uRimCol * 1.1, blur);
        // seen through the water in front of it: the bubble fades into the haze
        float tr = exp(-uFogSigma * vDist);
        gl_FragColor = vec4(col, clamp(a * vFade * tr, 0.0, 1.0));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = 6;
  mesh.name = name;
  return mesh;
}

/** (frutiger 10-05) seeded bubble attributes for web-only vents / the wrapped ambient field, drawn from the same
 *  distributions as compose make_bubbles (phase, cycles, rise x0.85-1.1, size, sway amp, k 3-6, 15 % big). */
export function bubbleAttrs(sites, seed = 7) {
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const gauss = () => Math.sqrt(-2 * Math.log(Math.max(1e-9, rnd()))) * Math.cos(6.2831853 * rnd());
  const points = [], attrs = { b_phase: [], b_cyc: [], b_rise: [], b_size: [], b_amp: [], b_ph2: [], b_k: [], b_glow: [] };
  for (const site of sites) {
    for (let i = 0; i < site.n; i++) {
      const p = site.at ? site.at(rnd) : [site.base[0] + gauss() * site.spread, site.base[1], site.base[2] + gauss() * site.spread];
      points.push(...p);
      attrs.b_phase.push(rnd());
      attrs.b_cyc.push(site.cycs[Math.floor(rnd() * site.cycs.length)]);
      attrs.b_rise.push(site.rise * (0.85 + 0.25 * rnd()));
      attrs.b_size.push((site.size[0] + (site.size[1] - site.size[0]) * rnd()) * (rnd() > 0.15 ? 1 : 1.6));
      attrs.b_amp.push(site.amp ? site.amp[0] + (site.amp[1] - site.amp[0]) * rnd() : 0.01 + 0.025 * rnd());
      attrs.b_ph2.push(rnd());
      attrs.b_k.push([3, 4, 5, 6][Math.floor(rnd() * 4)]);
      attrs.b_glow.push(site.glow ?? 1);
    }
  }
  return { points, attrs };
}
