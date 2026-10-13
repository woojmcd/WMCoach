// The tab bar must reach the screen's bottom edge on iPhone (Walter, 2026-10-13).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenGap } from '../../app/layout.js';

const iphone = { standalone: true, innerWidth: 393, screenWidth: 393, screenHeight: 852 };

test('a full-screen home-screen app has no gap; the gap iOS left (about 55 pt) is measured', () => {
  assert.equal(screenGap({ ...iphone, innerHeight: 852 }), 0);
  assert.equal(screenGap({ ...iphone, innerHeight: 797 }), 55);
});

test('no correction in a browser tab, while typing, or for implausible numbers', () => {
  assert.equal(screenGap({ ...iphone, standalone: false, innerHeight: 700 }), 0, 'Safari tab: toolbars are real');
  assert.equal(screenGap({ ...iphone, innerHeight: 500, typing: true }), 0, 'keyboard');
  assert.equal(screenGap({ ...iphone, innerHeight: 600 }), 0, 'over 120 px is not this bug');
  assert.equal(screenGap({ ...iphone, innerHeight: 860 }), 0);
});

test('landscape compares with the short side of the screen', () => {
  assert.equal(screenGap({ standalone: true, innerWidth: 852, innerHeight: 393, screenWidth: 393, screenHeight: 852 }), 0);
  assert.equal(screenGap({ standalone: true, innerWidth: 852, innerHeight: 360, screenWidth: 393, screenHeight: 852 }), 33);
});
