import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LevelOverlay } from '../../web/js/pages/scalper-chart-levels.js';

test('touch leaves the price menu available after release; mouse still hides it', () => {
  const previous = globalThis.document;
  const previousMedia = globalThis.matchMedia;
  const previousBridge = globalThis.TradeLockApp;
  const previousNavigator = globalThis.navigator;
  const previousFrame = globalThis.requestAnimationFrame;
  const previousTimeout = globalThis.setTimeout;
  const previousClearTimeout = globalThis.clearTimeout;
  let fireHold;
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.TradeLockApp = undefined;
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'TradeLock Android WebView', maxTouchPoints: 0 } });
  globalThis.requestAnimationFrame = fn => fn();
  globalThis.setTimeout = fn => { fireHold = fn; return 1; };
  globalThis.clearTimeout = () => {};
  const element = () => ({ style: {}, dataset: {}, offsetHeight: 32, setAttribute() {}, addEventListener() {}, remove() {} });
  globalThis.document = { createElement: element, addEventListener() {}, body: { append() {} } };
  try {
    const overlay = Object.create(LevelOverlay.prototype);
    Object.assign(overlay, {
      host: { ...element(), append() {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
      view: { draw: { tool: 'cursor' } },
      chart: { timeScale: () => ({ width: () => 300, coordinateToTime: () => 123 }), subscribeCrosshairMove() {}, options: () => ({ handleScroll: true, handleScale: true }), applyOptions(o) { this.lastOptions = o; }, setCrosshairPosition(price) { this.crosshairPrice = price; }, clearCrosshairPosition() { this.crosshairClears = (this.crosshairClears || 0) + 1; } },
      series: { coordinateToPrice: y => 200 - y, priceToCoordinate: price => 200 - price },
      hits: [], orders: [], alerts: [], alertHandles: new Map(), menu: { hidden: true },
    });
    overlay.buildUi();
    assert.equal(overlay.plus.hidden, true, 'no plus appears before chart interaction');
    overlay.bind();
    overlay.onCross({ point: { x: 100, y: 90 } });
    assert.equal(overlay.plus.hidden, true, 'crosshair updates do not reveal it');
    const touch = {
      pointerType: 'touch', pointerId: 1, target: { closest: () => false }, clientX: 100, clientY: 50,
      preventDefault() {}, stopImmediatePropagation() {},
    };
    overlay.on.down(touch);
    assert.equal(overlay.plus.hidden, true, 'a tap alone does not show the plus');
    assert.equal(overlay.chart.lastOptions, undefined, 'touch-down leaves normal chart interaction enabled');
    fireHold();
    assert.equal(overlay.plus.hidden, false, 'press-and-hold reveals the plus');
    assert.equal(overlay.dragPoint.hidden, false, 'press-and-hold reveals a dedicated drag point');
    assert.equal(overlay.plusY, 50, 'the held price starts exactly under the finger');
    assert.equal(overlay.chart.lastOptions.handleScroll, false, 'the chart locks only after the 700 ms hold delay');
    assert.equal(overlay.chart.crosshairClears, 1, 'the action line replaces the normal crosshair');
    overlay.on.move({ ...touch, clientY: 80 });
    assert.equal(overlay.plus.hidden, false, 'dragging after the hold keeps the plus visible');
    assert.equal(overlay.host.dataset.lvlTouchSelected, '1', 'only a real drag enables the mobile plus');
    assert.equal(overlay.plusY, 80);
    assert.equal(overlay.plus.style.top, '64px', 'the button center matches the dragged level');
    assert.equal(overlay.dragPoint.style.top, '64px', 'the drag point center stays on the selected line');
    assert.equal(overlay.chart.crosshairPrice, undefined, 'the normal chart crosshair is not replaced');
    overlay.on.move({ ...touch, clientY: 100 });
    assert.equal(overlay.plusY, 100, 'the plus tracks the finger vertically');
    assert.equal(overlay.chart.crosshairPrice, undefined, 'dragging the action line leaves the crosshair alone');
    overlay.onCross({ point: { x: 100, y: 90 } });
    assert.equal(overlay.plusY, 100, 'crosshair updates do not move it');
    overlay.on.up(touch);
    assert.equal(overlay.chart.lastOptions.handleScroll, true, 'chart scrolling resumes after release');
    assert.equal(overlay.chart.crosshairPrice, undefined, 'release still leaves the normal crosshair untouched');
    const adjust = { ...touch, pointerId: 2, clientY: 100 };
    overlay.on.down(adjust);
    assert.equal(overlay.priceTouch.selecting, true, 'the marked action line is immediately draggable');
    overlay.on.move({ ...adjust, clientY: 120 });
    overlay.on.up({ ...adjust, clientY: 120 });
    assert.equal(overlay.plusY, 120, 'the marked line and plus can be adjusted after release');
    overlay.on.leave(touch);
    overlay.onCross({});
    assert.equal(overlay.plus.hidden, false, 'the next tap can reach the menu');
    assert.equal(overlay.plusY, 120, 'the adjusted price is retained');
    overlay.clearSelection();
    overlay.set({ orders: [], alerts: [{ id: 9, price: 100, dir: 'above' }] });
    const handle = overlay.alertHandles.get('9');
    assert.ok(handle, 'alerts receive a real touch-action drag handle');
    const alertDrag = { ...touch, pointerId: 3, clientY: 100, target: { closest: selector => selector === '.sc-lvl-alert-drag' ? handle : false } };
    overlay.on.down(alertDrag);
    assert.equal(overlay.drag?.id, 9, 'a phone touch grabs the alert line');
    assert.equal(overlay.priceTouch, null, 'alert dragging cancels the competing long-press selector');
    overlay.on.move({ ...alertDrag, clientY: 110 });
    assert.equal(overlay.drag.price, 90, 'the alert follows the finger price smoothly');
  } finally {
    globalThis.document = previous;
    globalThis.matchMedia = previousMedia;
    globalThis.TradeLockApp = previousBridge;
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previousNavigator });
    globalThis.requestAnimationFrame = previousFrame;
    globalThis.setTimeout = previousTimeout;
    globalThis.clearTimeout = previousClearTimeout;
  }
});
