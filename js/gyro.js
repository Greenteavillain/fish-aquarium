// Phone 'magic window' look (mobile 10-05): the phone is a window into the sea.  Turn or tilt it and the
// view turns with it, as if you were holding a pane of glass into the water.
//
// DeviceOrientationEvent (alpha, beta, gamma, degrees) -> a camera quaternion in three's Y-up world:
//   q = Euler(beta, alpha, -gamma, 'YXZ') * Rx(-90 deg) * Rz(-screenAngle)
// (the formula of three's old DeviceOrientationControls, removed from three in r134).
//  - Euler 'YXZ' with (beta, alpha, -gamma) is the W3C intrinsic Z-X'-Y'' device rotation re-expressed
//    in a Y-up frame (the device's Z / earth-up becomes three's Y).
//  - Rx(-90): the camera looks out of the BACK of the phone, not out of its top edge, so a phone held
//    upright (beta 90) looks at the horizon.
//  - Rz(-screenAngle): in landscape the screen's axes are the device's axes turned by 90 deg.
// Checked directions (synthetic events, SYSTEMS.md mobile section): beta 90 -> horizon; alpha up
// (phone turned left) -> view turns left; beta > 90 (top tilted back) -> looks up; landscape (angle 90,
// alpha 90, beta 0, gamma -90) -> horizon.
//
// On top of the sensor:
//  - yawOff: a world-Y offset calibrated when the gyro comes on, so the view keeps facing where it faced
//    (alpha is relative and arbitrary: 0 is wherever the phone pointed when the sensor started).
//  - dragYaw / dragPitch: a finger drag adds a turn around the world vertical (turn round without
//    spinning on the spot) and a tilt about the screen's own horizontal axis.
//  - smoothing: a 1-euro style low-pass on the quaternion (heavy when still, light when moving).
// WHY slerp on quaternions and not a low-pass on alpha: alpha wraps 359 -> 0; averaging the angle made
// the view whip round once per turn.  Quaternion slerp (three flips to the short arc) has no wrap.
import * as THREE from 'three';

const D2R = Math.PI / 180;
const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);
const Q_BACK = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);    // -90 deg about X
// scratch objects.  _qz is deviceQuat's own: callers pass their own `out` (a shared scratch here once made
// out === the screen-rotation scratch, so every reading collapsed to the identity = 'always the horizon').
const _e = new THREE.Euler(), _q = new THREE.Quaternion(), _qz = new THREE.Quaternion(), _qn = new THREE.Quaternion();
const _f = new THREE.Vector3(), _u = new THREE.Vector3();

/** device orientation (degrees) + screen angle (degrees) -> camera quaternion (written into out) */
export function deviceQuat(out, alpha, beta, gamma, screenDeg) {
  _e.set(beta * D2R, alpha * D2R, -gamma * D2R, 'YXZ');
  return out.setFromEuler(_e).multiply(Q_BACK).multiply(_qz.setFromAxisAngle(AZ, -screenDeg * D2R));
}

/**
 * Heading (yaw, three convention: 0 = -Z, + = turned left) and pitch (+ = up) of a camera quaternion.
 * WHY not Euler YXZ's y: with the phone flat (looking straight down at the sand) the forward vector is
 * vertical and Euler yaw is undefined — it jittered by tens of degrees, and the joystick's 'forward'
 * with it.  Here the heading blends in the screen's top edge as the view nears vertical: looking down,
 * the top of the phone points where you are headed; looking up, the top points back at you.
 * (QA 10-05) The forward's own heading wherever it is well defined (view within ~70 deg of level), the top
 * edge only near the vertical, smoothstep between (|fwd_h| 0.35 -> 0.10, i.e. 69.5 -> 84 deg).
 * WHY not the first version's single formula  fwd_h * |fwd_h| - up_h * fwd.y : it is exact only for a phone
 * held without roll.  Hands hold phones rolled, and up_h then has a sideways part weighted by sin^2(pitch):
 * rolled 10 deg and looking 40 deg down, the joystick's 'forward' swam 6.4 deg beside the screen centre;
 * 20 deg / 40 deg: 12.7; a phone turned sideways with the rotation lock on (roll 90) / 40 deg down: 47.6.
 * Now 0 for any roll up to 69.5 deg of pitch (checked: pitch 0..-69 x roll 0..90, and +40 / +70).
 * Noise is no reason to blend earlier: at |fwd_h| 0.35 the sensor's ~0.05 deg shimmer is 0.15 deg of heading.
 */
export function headingPitch(q, out = {}) {
  _f.set(0, 0, -1).applyQuaternion(q);
  _u.set(0, 1, 0).applyQuaternion(q);
  const fh = Math.hypot(_f.x, _f.z);
  const ux = -_u.x * _f.y, uz = -_u.z * _f.y, ul = Math.hypot(ux, uz);   // top edge (looking up: its back)
  const t = Math.max(0, Math.min(1, (fh - 0.1) / 0.25)), w = t * t * (3 - 2 * t);   // weight of the forward
  let hx = 0, hz = 0;
  if (fh > 1e-9) { hx += w * _f.x / fh; hz += w * _f.z / fh; }
  if (ul > 1e-9) { hx += (1 - w) * ux / ul; hz += (1 - w) * uz / ul; }
  // the two can only cancel for a phone upside down near the vertical: then the top edge alone decides
  if (Math.hypot(hx, hz) < 1e-6 && ul > 1e-9) { hx = ux; hz = uz; }
  out.yaw = Math.atan2(-hx, -hz);
  out.pitch = Math.asin(Math.max(-1, Math.min(1, _f.y)));
  return out;
}

// 1-euro filter on the rotation: cutoff = FC_MIN + BETA * angular speed (rad/s).
// Still phone (sensor noise ~0.05 deg): 1.5 Hz (tau ~0.1 s) hides the shimmer; a slow pan at 20 deg/s
// -> 3.6 Hz (lag < 1 deg); a quick turn at 90 deg/s -> 11 Hz (tau 14 ms), i.e. it keeps up.
// (Units matter here: BETA is Hz per rad/s of the ROTATION, not per pixel.)
const FC_MIN = 1.5, BETA = 6, SPEED_TAU = 0.1;
const GLIDE_S = 0.45;            // calibration / recenter: glide from the old view instead of a jump
const PITCH_DRAG_MAX = 1.05;     // +-60 deg of finger tilt on top of the phone's own
const PITCH_LIMIT = 1.45;        // +-83 deg (the desktop clamp): the drag never takes the view over the pole
// silence that counts as a sensor restart.  WHY 2 s and not less: a main-thread hitch (a shader compile when a
// new species comes near) also delays readings, and a resync then would drop the turn made during it; the real
// restart case (app switch, screen lock) is caught by visibilitychange anyway.  This is the backstop.
const RESYNC_GAP_S = 2;

export class GyroLook {
  constructor() {
    // 'off' | 'waiting' (asked, no reading yet) | 'on' | 'unavailable' (no readings within 1 s) | 'denied'
    this.state = 'off';
    this.wanted = false;              // the user wants it on (start tap / the 자이로 button)
    this.onState = null;              // (state) => void, for the button / toast
    this.qT = new THREE.Quaternion();  // latest reading (target)
    this.qS = new THREE.Quaternion();  // smoothed
    this.has = false;
    this.omega = 0;                   // smoothed angular speed of the readings, rad/s
    this.lastStamp = 0;
    this.yawOff = 0; this.dragYaw = 0; this.dragPitch = 0;
    this.pitchLo = -PITCH_DRAG_MAX; this.pitchHi = PITCH_DRAG_MAX;
    this.needCalib = true;
    this.calibYaw = null;             // null: keep the heading the camera has when the gyro takes over
    // (start-pitch 10-06) pitch calibration target: 'cam' = keep the camera's pitch when the gyro takes over,
    // a number = that pitch (rad), null = leave dragPitch alone.  WHY: a level 'true window' looks ~30 deg down
    // at the sand for the usual phone hold (beta ~60), so the first thing friends saw after the tap was sand,
    // not the opening composition (pitch ~+17).  The offset rides in dragPitch, so a finger drag / 정면 behave
    // as before and the phone's own tilting still moves the view 1:1.
    this.pitchTarget = null; this.startPitch = null;
    this.glide = null;
    this.out = new THREE.Quaternion();
    this.yaw = 0; this.pitch = 0;     // heading / pitch of the last applied view (SwimControls swims along them)
    this.dragK = 0.0045;              // rad per CSS px of finger travel (see drag())
    this.events = 0;
    this._hp = {};
    this._onEvent = this._onEvent.bind(this);
    // (QA 10-05) the sensor's yaw zero is NOT kept across a pause.  alpha is relative to an arbitrary
    // heading (iOS: where the phone pointed when motion updates started; Android Chrome: the game
    // rotation vector's free yaw), and the browser stops the sensor while the page is hidden.  Back from
    // KakaoTalk or a screen lock, the same pose can read alpha + 180: the view whipped half way round in
    // one frame (synthetic check: yaw 20 -> -160).  So the first reading after the page was hidden (or
    // after a 2 s silence) re-seeds the filter and recalibrates the yaw: the view keeps facing where it
    // faced, pitch and roll stay true (they are gravity-based).
    this.resync = false;
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.resync = true; });
  }

  get active() { return this.state === 'on' && this.has; }

  /** screen rotation in degrees; a method so checks can fake landscape (emulators keep angle 0) */
  screenAngle() {
    // (QA 10-05) window.orientation FIRST, screen.orientation.angle only where it is missing.  WHY: iOS
    // Safari 16.4 shipped screen.orientation with the landscape angles mirrored (it read 90 where
    // window.orientation said -90 = 270; WebKit bugs 254863 / 255388, fixed after 16.4), which turns one
    // of the two landscape holds upside down.  window.orientation (counter-clockwise degrees, 0/90/-90/180)
    // is what three's DeviceOrientationControls read for years and agrees with the fixed angle mod 360
    // on iOS and Android; desktop browsers do not have it, and they fall through to screen.orientation.
    if (typeof window.orientation === 'number') return window.orientation;
    const so = screen.orientation;
    return so && typeof so.angle === 'number' ? so.angle : 0;
  }

  _set(s) { if (this.state !== s) { this.state = s; this.onState?.(s); } }

  /**
   * Turn the gyro on.  MUST be called synchronously inside a user tap: iOS 13+ only shows its
   * 'motion & orientation access' prompt from DeviceOrientationEvent.requestPermission() called in a
   * gesture (an await before it loses the gesture and the call rejects).  Resolves to the state after
   * up to 1 s: 'on', 'unavailable' (no sensor readings: desktop, some Android browsers, emulators) or
   * 'denied' (no readings and the permission was refused).  A reading that arrives later still switches
   * it on (slow sensor start on some phones) — the listener stays attached while the user wants the gyro.
   */
  enable() {
    this.wanted = true;
    this.needCalib = true; this.calibYaw = null; this.dragYaw = 0; this.dragPitch = 0;
    this.pitchTarget = 'cam';
    const DOE = window.DeviceOrientationEvent;
    if (!DOE) { this._set('unavailable'); return Promise.resolve(this.state); }
    let perm;
    if (typeof DOE.requestPermission === 'function') {
      try { perm = DOE.requestPermission(); } catch (e) { perm = Promise.reject(e); }
    } else perm = Promise.resolve('granted');
    this._set(this.has ? 'on' : 'waiting');
    // The readings decide, not the permission answer: the listener goes on whatever requestPermission
    // said, and only 'no reading within 1 s' turns the gyro off.  WHY: current Chrome also has
    // requestPermission, and it answers from the sensor permission state — the built-in browser pane
    // answered 'denied' while a phone's Chrome allows motion sensors by default.  Trusting the answer
    // would risk a phone that has readings never listening for them.  'denied' is only the toast's
    // wording (iOS: the person said no).
    return Promise.resolve(perm).catch(() => 'error').then((r) => {
      if (!this.wanted) return this.state;          // switched off again while the prompt was up
      this.permission = r;
      window.addEventListener('deviceorientation', this._onEvent);
      if (this.has) { this._set('on'); return this.state; }
      return new Promise((res) => {
        clearTimeout(this._wait);
        this._waitRes = res;
        this._wait = setTimeout(() => {
          if (this.state === 'waiting') this._set(r === 'denied' ? 'denied' : 'unavailable');
          this._waitRes = null; res(this.state);
        }, 1000);
      });
    });
  }

  disable() {
    this.wanted = false;
    window.removeEventListener('deviceorientation', this._onEvent);
    clearTimeout(this._wait);
    if (this._waitRes) { this._waitRes('off'); this._waitRes = null; }
    this.has = false;               // a stale reading must not be used when it comes back on
    this._set('off');
  }

  /** face `yaw` (radians, three convention) again: drops the finger offsets and recalibrates */
  recenter(yaw) {
    // (start-pitch 10-06) back to the opening pitch too, for however the phone is held now (was: level)
    this.calibYaw = yaw; this.needCalib = true; this.dragPitch = 0; this.pitchTarget = this.startPitch ?? 0;
  }

  _onEvent(e) {
    if (!this.wanted) return;
    // Chrome on a machine without sensors fires one event with every value null: not a reading
    if (e.beta == null || e.gamma == null) return;
    const qn = deviceQuat(_qn, e.alpha ?? 0, e.beta, e.gamma, this.screenAngle());
    const stamp = (e.timeStamp || performance.now()) / 1000;
    if (this.has && (this.resync || stamp - this.lastStamp > RESYNC_GAP_S)) {
      // sensor restarted (see the constructor): a new yaw zero, not a turn.  Re-seed, keep the view.
      // (calibYaw is left alone: a 정면 / 처음 press still pending wins.)
      this.qS.copy(qn); this.omega = 0; this.needCalib = true;
    } else if (this.has) {
      const dtE = Math.max(1 / 240, Math.min(0.25, stamp - this.lastStamp));
      const ang = 2 * Math.acos(Math.min(1, Math.abs(this.qT.dot(qn))));
      this.omega += (ang / dtE - this.omega) * (1 - Math.exp(-dtE / SPEED_TAU));
    } else {
      this.qS.copy(qn); this.omega = 0;
    }
    this.qT.copy(qn);
    this.lastStamp = stamp;
    this.resync = false;
    this.has = true;
    this.events++;
    if (this.state === 'waiting' || this.state === 'unavailable' || this.state === 'denied') {
      if (this.state !== 'waiting') this.needCalib = true;         // late sensor: keep the current view
      this._set('on');
      clearTimeout(this._wait);
      if (this._waitRes) { this._waitRes('on'); this._waitRes = null; }
    }
  }

  /** finger drag on the view, CSS px.  'Grab the water' convention (the scene follows the finger, as
   *  in 360-degree photos on phones): finger right -> view turns left; finger down -> view tilts up. */
  drag(dx, dy) {
    this.dragYaw += dx * this.dragK;
    this.dragPitch = Math.max(this.pitchLo, Math.min(this.pitchHi, this.dragPitch + dy * this.dragK));
  }

  /**
   * Write this frame's view into `cam` (the camera's quaternion; its current value is where the
   * calibration glide starts).  Sets this.yaw / this.pitch for swimming.
   */
  apply(cam, dt) {
    if (this.needCalib) {
      this.qS.copy(this.qT);
      const camHP = headingPitch(cam, {}), devHP = headingPitch(this.qS, {});
      const keep = this.calibYaw ?? camHP.yaw;
      this.yawOff = keep - devHP.yaw;
      this.dragYaw = 0;
      if (this.pitchTarget !== null) {
        const tgt = this.pitchTarget === 'cam' ? camHP.pitch : this.pitchTarget;
        if (this.pitchTarget === 'cam') this.startPitch = tgt;
        this.dragPitch = Math.max(-PITCH_DRAG_MAX, Math.min(PITCH_DRAG_MAX, tgt - devHP.pitch));
        this.pitchTarget = null;
      }
      this.needCalib = false; this.calibYaw = null;
      this.glide = { from: cam.clone(), t: 0 };
    }
    const fc = FC_MIN + BETA * this.omega;
    this.qS.slerp(this.qT, 1 - Math.exp(-dt * 2 * Math.PI * fc));
    // finger tilt limit: the phone's own pitch + the drag stays within +-83 deg (approx.: exact for a
    // phone without roll, which is how it is held)
    const devPitch = headingPitch(this.qS, this._hp).pitch;
    this.pitchLo = Math.min(0, Math.max(-PITCH_DRAG_MAX, -PITCH_LIMIT - devPitch));
    this.pitchHi = Math.max(0, Math.min(PITCH_DRAG_MAX, PITCH_LIMIT - devPitch));
    const pe = Math.max(this.pitchLo, Math.min(this.pitchHi, this.dragPitch));
    this.out.setFromAxisAngle(AY, this.yawOff + this.dragYaw).multiply(this.qS).multiply(_q.setFromAxisAngle(AX, pe));
    if (this.glide) {
      this.glide.t = Math.min(1, this.glide.t + dt / GLIDE_S);
      const s = this.glide.t * this.glide.t * (3 - 2 * this.glide.t);
      cam.slerpQuaternions(this.glide.from, this.out, s);
      if (this.glide.t >= 1) this.glide = null;
    } else cam.copy(this.out);
    headingPitch(cam, this._hp);
    this.yaw = this._hp.yaw; this.pitch = this._hp.pitch;
  }
}
