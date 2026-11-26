// Phones: the panel is a bottom sheet with three heights (peek, half, nearly full). Drag the handle, tap it to
// switch between half and full, or use the arrow keys on it.

const SNAPS = [0.3, 0.58, 0.92];

/** reset: back to half height (a newly opened panel); refresh: keep the chosen height after a resize. */
export interface Sheet { height(): number; reset(): void; refresh(): void }

export function initSheet(panel: HTMLElement, handle: HTMLButtonElement, active: () => boolean, onChange: (px: number) => void): Sheet {
  let idx = 1, dragging = false, startY = 0, startH = 0, moved = false, lastY = 0, lastT = 0, v = 0;
  const px = (i: number) => Math.round(window.innerHeight * SNAPS[i]);
  const apply = (h: number, snapped: boolean) => {
    panel.style.height = `${h}px`;
    document.body.classList.toggle('sheet-peek', snapped && idx === 0);
    handle.setAttribute('aria-valuenow', String(Math.round((h / window.innerHeight) * 100)));
    if (snapped) onChange(h);
  };
  const snap = (i: number) => { idx = Math.max(0, Math.min(SNAPS.length - 1, i)); apply(px(idx), true); };

  handle.addEventListener('pointerdown', (e) => {
    if (!active()) return;
    dragging = true; moved = false;
    startY = lastY = e.clientY; lastT = e.timeStamp; v = 0;
    startH = panel.getBoundingClientRect().height;
    handle.setPointerCapture(e.pointerId);
    panel.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) moved = true;
    if (e.timeStamp > lastT) v = (e.clientY - lastY) / (e.timeStamp - lastT); // px per ms, + = down
    lastY = e.clientY; lastT = e.timeStamp;
    apply(Math.max(px(0) * 0.8, Math.min(px(SNAPS.length - 1), startH - dy)), false);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    panel.classList.remove('dragging');
    if (!moved) { snap(idx === 2 ? 1 : 2); return; }
    const h = panel.getBoundingClientRect().height;
    // a flick goes one step in its direction; a slow drag lands on the nearest height
    if (Math.abs(v) > 0.5) {
      let below = 0;
      SNAPS.forEach((f, i) => { if (f * window.innerHeight < h) below = i; });
      const above = SNAPS.findIndex((f) => f * window.innerHeight > h);
      snap(v > 0 ? below : above < 0 ? SNAPS.length - 1 : above);
      return;
    }
    let best = 0;
    SNAPS.forEach((_, i) => { if (Math.abs(px(i) - h) < Math.abs(px(best) - h)) best = i; });
    snap(best);
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
  handle.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowUp') { e.preventDefault(); snap(idx + 1); }
    if (e.key === 'ArrowDown') { e.preventDefault(); snap(idx - 1); }
  });

  return {
    height: () => (active() ? px(idx) : 0),
    reset: () => {
      if (active()) { idx = 1; apply(px(idx), true); }
      else { panel.style.height = ''; document.body.classList.remove('sheet-peek'); }
    },
    // phones resize the window whenever the address bar slides in or out: keep the reader's chosen height
    refresh: () => {
      if (active()) apply(px(idx), true);
      else { panel.style.height = ''; document.body.classList.remove('sheet-peek'); }
    },
  };
}
