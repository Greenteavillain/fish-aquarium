// Phone controls.
// (mobile-hold 10-06) 유저: "그냥 꾹 누르면 보는 방향으로 직진, 위를 보고 누르고 있으면 위로 가는 식.
// 조이스틱 이런 거 필요 없음. 더블클릭하면 출처 버튼이랑 정면 버튼만."
// 그래서 조이스틱·위로/아래로·네온/자이로/처음 버튼(10-05판)을 없애고 두 가지만 남김:
//   1) 화면을 꾹 누르고 있으면 앞으로 헤엄 — controls.stick.y = 1.  main.js 가 폰에서 flyAlongView 를 켜 두어
//      '앞' = 카메라가 보는 방향(위아래 포함)이라, 위를 보고 누르면 위로 간다.  위로/아래로 버튼이 따로 필요 없음.
//   2) 정면 버튼 (출처 링크는 index.html 의 <a>).  둘 다 평소엔 숨김, 화면 두 번 톡이면 나옴(main.js).
//
// 꾹 누르기 판정: 누른 채 HOLD_MS 가 지나야 헤엄 시작.  WHY 바로 시작하지 않나: 두 번 톡(UI 토글)·화면 끌기
// (둘러보기)와 같은 손가락 동작이라, 짧은 톡마다 앞으로 미끄러지면 안 된다.  HOLD_MS 전에 MOVE_PX 넘게 움직이면
// '끌기' 로 보고 그 손가락은 헤엄시키지 않는다.  헤엄이 시작된 뒤 끄는 건 허용 = 누른 채로 방향 틀기.
// main.js 의 두 번 톡 판정도 같은 HOLD_MS 를 써서(톡 = HOLD_MS 미만) 둘이 겹치지 않는다.
//
// WHY Pointer Events: 손가락·펜·마우스 한 경로(데스크톱 브라우저의 폰 에뮬레이션에서도 동작), pointerId 로
// 손가락마다 따로 추적.

export const HOLD_MS = 220;
const MOVE_PX = 12;

export function setupTouch({ controls, canvas, onFront }) {
  const $ = (id) => document.getElementById(id);
  const ui = $('touchUI');

  // ---- 꾹 눌러 헤엄 ----
  const holds = new Map();      // pointerId -> { x, y, timer, swimming, drag }
  const apply = () => {
    let on = false;
    for (const h of holds.values()) if (h.swimming) on = true;
    controls.stick.y = on ? 1 : 0;
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const h = { x: e.clientX, y: e.clientY, swimming: false, drag: false, timer: 0 };
    h.timer = setTimeout(() => { if (!h.drag && holds.get(e.pointerId) === h) { h.swimming = true; apply(); } }, HOLD_MS);
    holds.set(e.pointerId, h);
  });
  canvas.addEventListener('pointermove', (e) => {
    const h = holds.get(e.pointerId);
    if (h && !h.swimming && !h.drag && Math.hypot(e.clientX - h.x, e.clientY - h.y) > MOVE_PX) h.drag = true;
  });
  const end = (e) => {
    const h = holds.get(e.pointerId);
    if (!h) return;
    clearTimeout(h.timer); holds.delete(e.pointerId); apply();
  };
  // window 에서도 듣는다: 손가락이 버튼 위에서 떨어지거나 캡처가 안 잡혀도 헤엄이 멈추게 (10-05 QA 와 같은 이유)
  for (const t of [canvas, window]) {
    t.addEventListener('pointerup', end);
    t.addEventListener('pointercancel', end);
  }

  // ---- 정면 버튼 ----
  // 누름 = 버튼 안에서 손가락이 떨어짐.  WHY pointerup 도 듣나(click 만이 아니라): 다른 손가락이 화면을 누르고
  // 헤엄치는 중이면 두 번째 손가락의 톡은 브라우저가 click 으로 안 만들어 준다(10-05 QA).  뒤따르는 click 은
  // 400ms 안이면 삼킨다 → 한 번 톡 = 한 번.
  const tap = (el, fn) => {
    let tapped = -1e9, downId = null;
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
  tap($('tFront'), onFront);

  // 길게 눌렀을 때 뜨는 메뉴 금지 (안드로이드는 contextmenu 가 포인터를 취소해 헤엄이 끊긴다)
  for (const t of [ui, canvas]) t.addEventListener('contextmenu', (e) => e.preventDefault());

  // 전화·앱 전환·알림창이 pointerup 을 삼킬 수 있다: 돌아왔을 때 혼자 헤엄치지 않게 전부 놓기
  const releaseAll = () => {
    for (const h of holds.values()) clearTimeout(h.timer);
    holds.clear(); apply();
  };
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  return {
    show() { ui.classList.add('on'); },
    setGyro() { /* (mobile-hold 10-06) 자이로 버튼 없앰 — main.js 호출 호환용 */ },
    releaseAll,
  };
}
