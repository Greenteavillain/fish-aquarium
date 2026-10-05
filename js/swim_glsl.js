// FishSwim (tools/swim_rig.py, node group v6) ported to GLSL.
//
// WHY a hand port instead of baking animation: the Blender rig is a Geometry-Nodes deformer that runs
// per vertex every frame.  Baking it would mean 6 variants x 240 frames x 23 species of vertex data;
// a vertex-shader port is a few dozen ALU ops per vertex and lets every instance have its own phase
// and a tail-beat tempo tied to its real swim speed (the rig itself is speed-agnostic).
//
// Reference: tools/web_fishswim_ref.py deform() (numpy, verified against Blender's evaluated node
// group to 7e-7).  web/dev/swim_test.html runs THIS GLSL through transform feedback and compares it
// with numbers written by tools/web_swim_testdata.py from that reference — so a typo here shows up
// as a failed check, not as a subtly wrong wiggle.
//
// Frame: everything below works in the Blender canonical fish frame (x along the body, head +x,
// x in -0.5..0.5; y lateral; z dorsal).  The GLB is three.js Y-up, so the caller converts
// b = (p.x, -p.z, p.y) and back p = (b.x, b.z, -b.y)  (checked in species.json bbox_three: the
// dorsal extent is on three Y, the lateral extent on three Z).
//
// Inputs (set by the caller before swimDeform):
//   sw_tau   = fract(tail beats so far)   — the rig's mod(cycles*frame, 240)/240.  Because only
//              integer multiples of tau appear (k = 1,2,3,4), passing fract(beats) is exact.
//   sw_phase = per-instance phase (0..1), sw_amp = amplitude (species amp x per-instance mult)
//   uniforms uSwimA = (amp, wavelength, detail, bias), uSwimB = (rigid_front, ymax, zmax, 0)
// The style is a compile-time define SW_STYLE (0..9) so each material only pays for its own style.

export const SWIM_STYLES = ['carangiform', 'thunniform', 'anguilliform', 'rajiform_flap',
  'rajiform_undulate', 'flatfish_wave', 'ostraciiform', 'hover_drift', 'benthic_rest', 'prop'];

export const SWIM_GLSL = /* glsl */`
uniform vec4 uSwimA;   // amp, wavelength, detail, bias
uniform vec4 uSwimB;   // rigid_front, ymax, zmax, unused
float sw_tau;
float sw_phase;
float sw_amp;

// Blender Map Range SMOOTHSTEP.  NOT GLSL smoothstep(): the rig uses e0 > e1 (a falling edge) in
// several places, which is undefined behaviour for the GLSL builtin.
float sw_ss(float e0, float e1, float v) {
  float t = clamp((v - e0) / (e1 - e0), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
float sw_wave(float sv, float lam, float k, float off) {
  return sin(6.283185307179586 * (sv / lam - k * sw_tau + sw_phase + off));
}
float sw_rigid(float sv) {
  return uSwimB.x > 1e-4 ? sw_ss(uSwimB.x, uSwimB.x + 0.2, sv) : 1.0;
}
// lateral (or, for flatfish, dorsal) displacement of the body centre line at s (0 snout .. 1 tail)
float sw_d(float sv) {
#if SW_STYLE == 0
  return sw_amp * (0.1 + 0.9 * sv * sv) * sw_rigid(sv) * sw_wave(sv, uSwimA.y, 1.0, 0.0);
#elif SW_STYLE == 1
  float r = clamp((sv - 0.70) / 0.30, 0.0, 1.0);
  return sw_amp * (0.04 + 0.96 * pow(r, 1.6)) * sw_rigid(sv) * sw_wave(sv, uSwimA.y, 1.0, 0.0);
#elif SW_STYLE == 2
  return sw_amp * (0.35 + 0.65 * sv) * sw_rigid(sv) * sw_wave(sv, uSwimA.y, 1.0, 0.0);
#elif SW_STYLE == 4
  float e = sw_ss(0.5, 1.0, sv);
  return sw_amp * 1.3 * uSwimA.z * e * e * sw_wave(sv, 0.9, 1.0, 0.0);
#elif SW_STYLE == 5
  return sw_amp * (0.25 + 0.75 * sv * sv) * sw_wave(sv, uSwimA.y, 1.0, 0.0);
#elif SW_STYLE == 6
  float r = clamp((sv - 0.75) / 0.25, 0.0, 1.0);
  return sw_amp * pow(r, 1.6) * sw_wave(sv, uSwimA.y, 1.0, 0.0);
#elif SW_STYLE == 7
  return sw_amp * (0.3 + 0.7 * sv) * sw_wave(sv, uSwimA.y, 1.0, 0.0);
#elif SW_STYLE == 8
  return sw_amp * sw_ss(0.55, 1.0, sv) * sw_wave(sv, uSwimA.y, 1.0, 0.0);
#else
  return 0.0;
#endif
}
float sw_dwave(float sv, float lam, float k, float off) {     // d wave / d sv
  return (6.283185307179586 / lam) * cos(6.283185307179586 * (sv / lam - k * sw_tau + sw_phase + off));
}
// The rig's 'bend': the centre line across = d(s) is followed by rotating each cross-section by the
// local slope, but only near the body axis (w -> 0 beyond |across| 0.22, so wide fins shear instead
// of swinging round).  Returns (along', across') plus the 2x2 Jacobian, for exact normals:
//   ja = d(along', across')/d along,   jc = d(along', across')/d across.
// The slope m and its derivative come from the same three d() samples (central differences), so the
// Jacobian is free.  WHY a Jacobian and not 'rotate the normal by atan(m)': the rotation ignores
// the stretch along the bent axis and the curvature term (y * dsn/dx), which near the tail of a deep
// body tilts normals by 10-30 deg (measured with dev/swim_test.html: p99 28 deg -> see that page).
vec2 sw_bendJ(float s, float along, float across, out vec2 ja, out vec2 jc) {
  const float H = 0.002;
  float dm = sw_d(s - H), d0 = sw_d(s), dp = sw_d(s + H);
  float m = (dm - dp) / (2.0 * H);             // slope of the centre line w.r.t. along (= -d'(s))
  // dm/ds.  Clamped: thunniform/ostraciiform use pow(r, 1.6) from a clamp edge, whose 2nd derivative
  // is singular at r = 0; a vertex within H of that edge got a flipped normal (dev/swim_test.html:
  // max 166 deg).  Legit |dm/ds| is amp*(2 pi/lambda)^2 <= ~6 for every species, so 25 never bites
  // elsewhere; the real mesh's vertex spacing (~0.01) smooths that kink in Blender's normals too.
  float k = clamp(-(dp - 2.0 * d0 + dm) / (H * H), -25.0, 25.0);
  float c = inversesqrt(1.0 + m * m);
  float sn = m * c;
  float c3 = c * c * c;                        // dsn/dm = c^3, dc/dm = -m c^3
  float t = clamp((abs(across) - 0.22) / (0.10 - 0.22), 0.0, 1.0);
  float w = t * t * (3.0 - 2.0 * t);
  float dw = (t > 0.0 && t < 1.0) ? 6.0 * t * (1.0 - t) / (0.10 - 0.22) * sign(across) : 0.0;
  ja = vec2(1.0 + w * across * c3 * k, m + w * across * m * c3 * k);           // ds/dalong = -1
  jc = vec2(-sn * (w + across * dw), 1.0 - (w + across * dw) * (1.0 - c));
  return vec2(along - w * across * sn, d0 + across * (1.0 - w * (1.0 - c)));
}
#if SW_STYLE == 3
float sw_flapDz(float x, float y) {          // rajiform_flap: wing-tip lift, a height field over (x,y)
  float s = 0.5 - x;
  float ry = abs(y) / max(uSwimB.y, 1e-4);
  float mask = sw_ss(0.85, 0.62, s);
  return pow(ry, 1.5) * mask * sw_amp * sw_wave(s, uSwimA.y, 1.0, 0.0) + uSwimA.w * pow(ry, 3.0) * mask;
}
#endif
#if SW_STYLE == 4
float sw_undDz(float x, float y) {           // rajiform_undulate: disc-margin ripple
  float s = 0.5 - x;
  float ry = abs(y) / max(uSwimB.y, 1e-4);
  return sw_amp * ry * ry * sw_ss(0.72, 0.50, s) * sw_wave(s, uSwimA.y, 1.0, 0.0);
}
#endif

// P, N: canonical Blender-frame position / normal.  Deforms P in place and returns the deformed
// (unnormalised) normal.  The normal is the cofactor of the deformation Jacobian J = [j0 j1 j2]
// (columns = images of the x, y, z axes):  n' = nx (j1 x j2) + ny (j2 x j0) + nz (j0 x j1)
// (= det(J) J^-T n), i.e. what recomputing smooth normals on the deformed mesh converges to.
// Terms are analytic, except the ray height fields (cheap one-sided differences) and the gill pulse's
// along-body derivative (+-2.5 % of y, omitted).
vec3 swimDeform(inout vec3 P, vec3 N) {
  float x = P.x, y = P.y, z = P.z;
  float s = 0.5 - x;
  float ry = abs(y) / max(uSwimB.y, 1e-4);
  vec2 ja = vec2(1.0, 0.0), jc = vec2(0.0, 1.0);
  vec3 j0 = vec3(1.0, 0.0, 0.0), j1 = vec3(0.0, 1.0, 0.0), j2 = vec3(0.0, 0.0, 1.0);
#if SW_STYLE == 0 || SW_STYLE == 1 || SW_STYLE == 2 || SW_STYLE == 6
  vec2 b = sw_bendJ(s, x, y, ja, jc);
  P = vec3(b.x, b.y, z);
  j0 = vec3(ja, 0.0); j1 = vec3(jc, 0.0);
#elif SW_STYLE == 3
  const float h = 0.002;
  float g = sw_flapDz(x, y);
  float gx = (sw_flapDz(x + h, y) - g) / h;
  float gy = (sw_flapDz(x, y + h) - g) / h;
  P = vec3(x, y, z + g);
  j0 = vec3(1.0, 0.0, gx); j1 = vec3(0.0, 1.0, gy);
#elif SW_STYLE == 4
  const float h = 0.002;
  float g = sw_undDz(x, y);
  float gx = (sw_undDz(x + h, y) - g) / h;
  float gy = (sw_undDz(x, y + h) - g) / h;
  vec2 b = sw_bendJ(s, x, y, ja, jc);        // both terms read the ORIGINAL x,y (as the rig does)
  P = vec3(b.x, b.y, z + g);
  j0 = vec3(ja, gx); j1 = vec3(jc, gy);
#elif SW_STYLE == 5
  vec2 b = sw_bendJ(s, x, z, ja, jc);        // flatfish: the wave runs in the dorsal plane (x,z)
  float rr = clamp((ry - 0.6) / 0.4, 0.0, 1.0);
  float A = 0.25 * sw_amp * uSwimA.z;
  float rim = A * rr * rr * sw_wave(s, 0.25, 2.0, 0.0);
  float drr = (rr > 0.0 && rr < 1.0) ? sign(y) / (0.4 * max(uSwimB.y, 1e-4)) : 0.0;
  P = vec3(b.x, y, b.y + rim);
  j0 = vec3(ja.x, 0.0, ja.y - A * rr * rr * sw_dwave(s, 0.25, 2.0, 0.0));
  j1 = vec3(0.0, 1.0, A * 2.0 * rr * drr * sw_wave(s, 0.25, 2.0, 0.0));
  j2 = vec3(jc.x, 0.0, jc.y);
#elif SW_STYLE == 7
  vec2 b = sw_bendJ(s, x, y, ja, jc);
  float R = max(max(uSwimB.y, uSwimB.z), 1e-4);
  float rad2 = (y * y + z * z) / (R * R);
  float E = 0.006 * uSwimA.z;
  float wv = sw_wave(s, 0.15, 4.0, 0.0);
  float yn = b.y + E * rad2 * wv;
  float rho = 0.05 * uSwimA.z * sw_wave(0.0, 1.0, 1.0, 0.25);   // slow whole-body roll
  float cr = cos(rho), sr = sin(rho);
  P = vec3(b.x, yn * cr - z * sr, yn * sr + z * cr);
  j0 = vec3(ja.x, ja.y - E * rad2 * sw_dwave(s, 0.15, 4.0, 0.0), 0.0);
  j1 = vec3(jc.x, jc.y + E * wv * 2.0 * y / (R * R), 0.0);
  j2 = vec3(0.0, E * wv * 2.0 * z / (R * R), 1.0);
  mat3 Rx = mat3(1.0, 0.0, 0.0,  0.0, cr, sr,  0.0, -sr, cr);   // columns; (y,z) -> (y cr - z sr, y sr + z cr)
  j0 = Rx * j0; j1 = Rx * j1; j2 = Rx * j2;
#elif SW_STYLE == 8
  vec2 b = sw_bendJ(s, x, y, ja, jc);
  float gill = sw_ss(0.08, 0.20, s) * sw_ss(0.45, 0.30, s);
  float G = 0.025 * uSwimA.z * gill * sw_wave(0.0, 1.0, 1.0, 0.0);
  float yn = b.y + y * G;
  float fr = clamp((ry - 0.45) / 0.55, 0.0, 1.0);
  float F = 0.008 * uSwimA.z;
  float dfr = (fr > 0.0 && fr < 1.0) ? sign(y) / (0.55 * max(uSwimB.y, 1e-4)) : 0.0;
  P = vec3(b.x, yn, z + F * fr * fr * sw_wave(s, 0.3, 3.0, 0.0));
  j0 = vec3(ja.x, ja.y, -F * fr * fr * sw_dwave(s, 0.3, 3.0, 0.0));
  j1 = vec3(jc.x, jc.y + G, F * 2.0 * fr * dfr * sw_wave(s, 0.3, 3.0, 0.0));
#else
  return N;
#endif
  return N.x * cross(j1, j2) + N.y * cross(j2, j0) + N.z * cross(j0, j1);
}
`;
