// Swimming camera: pointer-lock mouse look + WASD with smooth acceleration/damping, collision
// with the sand and the KEEPOUT cylinders.
//
// Keys are read from KeyboardEvent.code, never .key: with the Korean IME active, .key for W is 'ㅈ'.
// Sprint is Ctrl OR F: on macOS Ctrl+W is harmless, but on Windows/Linux Chrome Ctrl+W closes the
// tab and cannot be intercepted, so F is offered as the safe alternative.
import * as THREE from 'three';

export class SwimControls {
  constructor(camera, dom, { sand, keepouts, debug = false }) {
    this.camera = camera;
    this.dom = dom;
    this.sand = sand;
    this.keepouts = keepouts;
    this.debug = debug;
    this.yaw = 0; this.pitch = 0;
    this.vel = new THREE.Vector3();
    this.keys = new Set();
    this.locked = false;
    this.flyAlongView = false;          // V: swim where you look (incl. up/down) instead of level
    this.enabled = true;
    this.speed = 1.5;                   // m/s cruise
    this.sprint = 4.2;                  // m/s
    this.sensitivity = 0.0022;
    this.bounds = { xmin: -55, xmax: 55, zmin: -110, zmax: 40, ymax: 18 };
    this.onToggle = {};                 // code -> callback (C, H, P, R ...)
    this._bind();
  }

  setFromCamera() {
    const e = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
    this.yaw = e.y; this.pitch = e.x;
  }

  _bind() {
    const d = this.dom.ownerDocument;
    d.addEventListener('pointerlockchange', () => {
      this.locked = d.pointerLockElement === this.dom;
      if (this.locked) this._drag = null;
      this.onLockChange?.(this.locked);
    });
    d.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // WHY the clamp: Chrome (seen on Windows) sometimes reports one huge movementX/Y (hundreds to
      // thousands of px) right after the lock is taken or the window regains focus, which spun the
      // view round in a single frame.  A real flick at 125 Hz polling stays well under 250 px/event.
      const c = (v) => Math.max(-250, Math.min(250, v || 0));
      this._look(c(e.movementX), c(e.movementY));
    });
    // Fallback when pointer lock is refused (iframes, automation, phones): drag to look.
    // WHY pointer events, not mouse events: with touch-action:none on the canvas a finger drag fires
    // no mousemove at all, so phones/tablets could not look around; pointer events cover mouse, pen
    // and touch with one path.  Capture keeps the drag alive when the finger leaves the canvas.
    this.dom.addEventListener('pointerdown', (e) => {
      if (this.locked || (e.pointerType === 'mouse' && e.button !== 0)) return;
      this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      try { this.dom.setPointerCapture(e.pointerId); } catch (err) { /* not capturable: still works */ }
    });
    this.dom.addEventListener('pointermove', (e) => {
      if (this.locked || !this._drag || e.pointerId !== this._drag.id) return;
      // the button came up somewhere we did not hear it (a context menu ate the pointerup):
      // without this the view kept turning with a released mouse
      if (e.pointerType === 'mouse' && e.buttons === 0) { this._drag = null; return; }
      this._look(e.clientX - this._drag.x, e.clientY - this._drag.y);
      this._drag.x = e.clientX; this._drag.y = e.clientY;
    });
    const endDrag = (e) => { if (this._drag && e.pointerId === this._drag.id) this._drag = null; };
    this.dom.addEventListener('pointerup', endDrag);
    this.dom.addEventListener('pointercancel', endDrag);
    // no browser menu on the scene: on macOS Ctrl (= sprint) + click IS a right click, and the menu
    // popping up mid-swim stole the drag
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());
    d.addEventListener('keydown', (e) => {
      if (e.repeat && this.keys.has(e.code)) return;
      this.keys.add(e.code);
      if (this.onToggle[e.code] && !e.metaKey && !e.altKey) { this.onToggle[e.code](); e.preventDefault(); }
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab'].includes(e.code)) e.preventDefault();
    });
    d.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      // macOS swallows the keyup of every key released while Cmd is held (Cmd+Shift+4, Cmd+`...),
      // so W pressed before Cmd stayed 'held' and the camera swam on by itself.  When Cmd goes up,
      // forget everything; keys still physically down send a fresh keydown on their next repeat.
      if (e.code === 'MetaLeft' || e.code === 'MetaRight') this.keys.clear();
    });
    window.addEventListener('blur', () => { this.keys.clear(); this._drag = null; });
    d.addEventListener('visibilitychange', () => { if (d.hidden) this.keys.clear(); });
  }

  _look(dx, dy) {
    this.yaw -= dx * this.sensitivity;
    this.pitch -= dy * this.sensitivity;
    this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch));   // +-83 deg: never flip over the pole
  }

  /**
   * Ask for pointer lock; resolves true once locked, false if refused.
   * Plain request, no { unadjustedMovement }: that option is not supported everywhere (macOS
   * Chrome may reject it), and a retry from the rejection handler would run outside the click's
   * user gesture.  If the lock is refused (iframe, automation), drag-to-look still works.
   * WHY a promise that also listens to the events: Chrome returns a promise, Firefox/older Safari
   * return undefined and report through pointerlockchange / pointerlockerror; iOS has no API.
   */
  lock() {
    const d = this.dom.ownerDocument;
    if (this.locked) return Promise.resolve(true);
    if (!this.dom.requestPointerLock) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        d.removeEventListener('pointerlockchange', onChange);
        d.removeEventListener('pointerlockerror', onError);
        resolve(ok);
      };
      const onChange = () => { if (d.pointerLockElement === this.dom) finish(true); };
      const onError = () => finish(false);
      d.addEventListener('pointerlockchange', onChange);
      d.addEventListener('pointerlockerror', onError);
      try {
        const p = this.dom.requestPointerLock();
        if (p && p.then) p.then(() => finish(true), () => finish(false));
      } catch (e) { finish(false); }
      setTimeout(() => finish(d.pointerLockElement === this.dom), 1500);   // neither event came
    });
  }

  update(dt) {
    dt = Math.max(0, Math.min(dt, 1 / 20));
    const k = this.keys;
    if (this.debug) {                                  // ?debug=1: arrows look (no pointer lock needed)
      const r = 1.6 * dt;
      if (k.has('ArrowLeft')) this.yaw += r;
      if (k.has('ArrowRight')) this.yaw -= r;
      if (k.has('ArrowUp')) this.pitch = Math.min(1.45, this.pitch + r);
      if (k.has('ArrowDown')) this.pitch = Math.max(-1.45, this.pitch - r);
    }
    const fwdIn = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
    const rightIn = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    const upIn = (k.has('Space') || k.has('KeyE') ? 1 : 0) - (k.has('ShiftLeft') || k.has('ShiftRight') || k.has('KeyQ') ? 1 : 0);
    const fast = k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyF');
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const wish = new THREE.Vector3();
    if (this.flyAlongView) {
      const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
      wish.set(-sy * cp * fwdIn + cy * rightIn, sp * fwdIn + upIn, -cy * cp * fwdIn - sy * rightIn);
    } else {
      wish.set(-sy * fwdIn + cy * rightIn, upIn * 0.8, -cy * fwdIn - sy * rightIn);
    }
    if (!this.enabled) wish.set(0, 0, 0);
    if (wish.lengthSq() > 1) wish.normalize();
    wish.multiplyScalar(fast ? this.sprint : this.speed);
    // swimming feel: ease toward the wish (accelerate ~0.5 s), glide out slower (~0.9 s)
    const rate = wish.lengthSq() > 0 ? 2.6 : 1.4;
    this.vel.lerp(wish, 1 - Math.exp(-dt * rate));
    const p = this.camera.position;
    p.addScaledVector(this.vel, dt);
    this._collide(p);
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }

  _collide(p) {
    const b = this.bounds;
    p.x = Math.max(b.xmin, Math.min(b.xmax, p.x));
    p.z = Math.max(b.zmin, Math.min(b.zmax, p.z));
    const pad = 0.28;                     // camera body radius beyond the cylinders' own 0.10 margin
    // Two passes: a push out of one cylinder can land inside a neighbour (the pillar is a stack of
    // four) or below a higher dune; one pass left that to the next frame (a one-frame jitter).
    for (let pass = 0; pass < 2; pass++) {
      const floor = this.sand.at(p.x, p.z) + 0.3;
      if (p.y < floor) { p.y = floor; if (this.vel.y < 0) this.vel.y = 0; }
      if (p.y > b.ymax) { p.y = b.ymax; if (this.vel.y > 0) this.vel.y = 0; }
      for (const ko of this.keepouts) {
        const top = ko.y0 + ko.h;
        if (p.y < ko.y0 - pad || p.y > top + pad) continue;
        const dx = p.x - ko.x, dz = p.z - ko.z, R = ko.r + pad;
        const d2 = dx * dx + dz * dz;
        if (d2 >= R * R) continue;
        const d = Math.sqrt(d2) || 1e-4;
        // Leave by the shorter way.  WHY: sinking onto a rock from above was always resolved
        // RADIALLY, so coming down onto the pillar's top threw the camera up to 0.85 m sideways in
        // one frame (QA: Shift over the pillar -> x jumped 0.52 m).  Now a rock top is a floor you
        // settle on, and the sides still slide.
        if (top + pad - p.y < R - d) { p.y = top + pad; if (this.vel.y < 0) this.vel.y = 0; continue; }
        const nx = dx / d, nz = dz / d;
        p.x = ko.x + nx * R; p.z = ko.z + nz * R;
        const vn = this.vel.x * nx + this.vel.z * nz;      // slide along the rock, no bounce
        if (vn < 0) { this.vel.x -= vn * nx; this.vel.z -= vn * nz; }
      }
    }
  }
}
