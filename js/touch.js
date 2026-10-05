// Phone controls (mobile 10-05): the on-screen joystick, the hold-to-rise / hold-to-sink buttons and the
// small button row (네온 / 자이로 / 정면 / 처음).  Markup and styles live in index.html (#touchUI); this
// file only wires them to SwimControls (stick / touchUp / touchFast) and to main.js's callbacks.
//
// WHY Pointer Events everywhere (not touch events): one path for fingers, a stylus and the mouse, so the
// controls also work in a desktop browser's phone emulation and on touch laptops; every element tracks
// its own pointerId, so a thumb on the joystick and another on 위로 (or dragging the view) do not fight.
// setPointerCapture keeps a press alive when the finger slides off the button / out of the stick.

const KNOB_TRAVEL = 46;     // px from the stick's centre to full speed (the ring's inner radius)
const DEAD = 0.12;          // share of the travel that does nothing (a resting thumb never drifts)
const DOUBLE_TAP_MS = 320;  // a second press this soon after letting go = sprint while held

export function setupTouch({ controls, onNeon, onGyro, onFront, onHome }) {
  const $ = (id) => document.getElementById(id);
  const ui = $('touchUI');

  // ---- joystick ----
  const stick = $('stick'), knob = stick.querySelector('.knob');
  let sp = null, lastRelease = -1e9;
  const setKnob = (x, y) => { knob.style.transform = `translate(${x}px, ${y}px)`; };
  const stickMove = (e) => {
    let dx = e.clientX - sp.cx, dy = e.clientY - sp.cy;
    const len = Math.hypot(dx, dy);
    if (len > KNOB_TRAVEL) { dx *= KNOB_TRAVEL / len; dy *= KNOB_TRAVEL / len; }
    setKnob(dx, dy);
    const m = Math.min(1, len / KNOB_TRAVEL);
    const mm = m <= DEAD ? 0 : (m - DEAD) / (1 - DEAD);       // rescaled so full push is still 1
    controls.stick.x = len > 0 ? (dx / Math.min(len, KNOB_TRAVEL)) * mm : 0;
    controls.stick.y = len > 0 ? (-dy / Math.min(len, KNOB_TRAVEL)) * mm : 0;   // screen up = forward
  };
  const stickEnd = (e) => {
    if (!sp || e.pointerId !== sp.id) return;
    sp = null; lastRelease = e.timeStamp;
    controls.stick.x = controls.stick.y = 0; controls.touchFast = false;
    stick.classList.remove('on', 'fast');
    setKnob(0, 0);
  };
  stick.addEventListener('pointerdown', (e) => {
    if (sp) return;
    e.preventDefault();
    const r = stick.getBoundingClientRect();
    sp = { id: e.pointerId, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
    controls.touchFast = e.timeStamp - lastRelease < DOUBLE_TAP_MS;
    stick.classList.add('on');
    stick.classList.toggle('fast', controls.touchFast);
    try { stick.setPointerCapture(e.pointerId); } catch (err) { /* still works without capture */ }
    stickMove(e);
  });
  stick.addEventListener('pointermove', (e) => { if (sp && e.pointerId === sp.id) stickMove(e); });
  stick.addEventListener('pointerup', stickEnd);
  stick.addEventListener('pointercancel', stickEnd);
  stick.addEventListener('lostpointercapture', stickEnd);
  // (QA 10-05) also hear the lift anywhere on the page.  WHY: if the capture did not take (it throws for
  // a pointer the browser no longer tracks), the pointerup of a thumb that slid off the ring lands on the
  // canvas, sp stayed set, and `if (sp) return` then ignored every later press: a dead joystick that kept
  // swimming.  stickEnd matches the pointerId, so the duplicate from the captured path is a no-op.
  addEventListener('pointerup', stickEnd);
  addEventListener('pointercancel', stickEnd);

  // ---- 위로 / 아래로 (hold) ----
  const held = { up: null, down: null };
  const applyUp = () => { controls.touchUp = (held.up != null ? 1 : 0) - (held.down != null ? 1 : 0); };
  for (const [key, el] of [['up', $('tUp')], ['down', $('tDown')]]) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      held[key] = e.pointerId; el.classList.add('on'); applyUp();
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* ok */ }
    });
    const end = (e) => { if (held[key] !== e.pointerId) return; held[key] = null; el.classList.remove('on'); applyUp(); };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('lostpointercapture', end);
    addEventListener('pointerup', end);           // (QA 10-05) same reason as the stick's window listeners
    addEventListener('pointercancel', end);
  }

  // ---- button row ----
  // A press = the finger lifts INSIDE the button (a tap that turns into a drag off it is not a press).
  // (QA 10-05) WHY pointerup and not only click: a browser makes a click only from a single-finger tap.
  // With the other thumb on the joystick, a tap on 네온 / 정면 / 처음 is a second pointer, and Chrome's
  // gesture detector (ported from Android's, which cancels taps on a second pointer) and iOS's tap recogniser
  // do not turn it into a click: the button did nothing while you swam (from the platforms' tap rules; not
  // reproducible in an emulator).  The click that DOES follow a lone tap is swallowed (tapped < 400 ms ago), so one tap = one
  // press; a click with no pointerup before it (keyboard Enter / Space) still works.
  // 자이로 stays click-only: its handler calls DeviceOrientationEvent.requestPermission(), and iOS counts a
  // click (or touchend) as the user gesture for that prompt; a pointerup is not guaranteed to be one.
  const tap = (el, fn) => {
    let tapped = -1e9, downId = null;
    // the press must also START here (a mouse dragged from one pill and let go on the next is no press)
    el.addEventListener('pointerdown', (e) => { downId = e.pointerId; });
    el.addEventListener('pointerup', (e) => {
      if (e.pointerId !== downId || (e.pointerType === 'mouse' && e.button !== 0)) return;
      downId = null;
      const r = el.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return;
      tapped = e.timeStamp; fn();
    });
    el.addEventListener('pointercancel', (e) => { if (e.pointerId === downId) downId = null; });
    el.addEventListener('click', (e) => { if (e.timeStamp - tapped > 400) fn(); });
  };
  tap($('tNeon'), onNeon);
  $('tGyro').addEventListener('click', onGyro);
  tap($('tFront'), onFront);
  tap($('tHome'), onHome);

  // no long-press menu / text selection / double-tap zoom anywhere on the controls (a long press on
  // Android fires contextmenu, which cancels the pointer and dropped the 위로 hold)
  ui.addEventListener('contextmenu', (e) => e.preventDefault());

  // a phone call, the app switcher or a notification shade can swallow the pointerup: let go of
  // everything so the camera does not swim on by itself when you come back
  const releaseAll = () => {
    sp = null; controls.stick.x = controls.stick.y = 0; controls.touchFast = false; setKnob(0, 0);
    stick.classList.remove('on', 'fast');
    held.up = held.down = null; applyUp();
    $('tUp').classList.remove('on'); $('tDown').classList.remove('on');
  };
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  return {
    show() { ui.classList.add('on'); },
    /** gyro button look: on / waiting / unavailable */
    setGyro(state) {
      const b = $('tGyro');
      b.setAttribute('aria-pressed', state === 'on' || state === 'waiting' ? 'true' : 'false');
      b.classList.toggle('dim', state === 'unavailable' || state === 'denied');
    },
    releaseAll,
  };
}
