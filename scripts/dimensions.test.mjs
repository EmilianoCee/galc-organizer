import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDimensionPair, resolveDimensions } from './lib/dimensions.mjs';

const PORTRAIT = { width: 360, height: 460 };
const LANDSCAPE = { width: 460, height: 360 };

test('parses every inch-mark variant seen in the collection', () => {
  const cases = [
    ['23.5 x 18.5"', 23.5, 18.5],
    ["22 x 31''", 22, 31],
    ['23 x 28.5”', 23, 28.5],
    ['19.25 x 25', 19.25, 25],
    ['25.5 x 31.5', 25.5, 31.5],
    ['25 X 27"', 25, 27],
    ['16.5" x 23 "', 16.5, 23],
    ['12" x 15.5"', 12, 15.5]
  ];
  for (const [raw, first, second] of cases) {
    assert.deepEqual(parseDimensionPair(raw), { first, second }, raw);
  }
});

test('rejects blanks and junk', () => {
  for (const raw of [null, undefined, '', '   ', 'unknown', '0 x 12"']) {
    assert.equal(parseDimensionPair(raw), null, String(raw));
  }
});

test('the image decides which number is the height', () => {
  // Same string, opposite images -> opposite assignments.
  const tall = resolveDimensions('18.5 x 23.5"', PORTRAIT);
  assert.deepEqual([tall.width_in, tall.height_in], [18.5, 23.5]);
  assert.equal(tall.orientation, 'portrait');

  const wide = resolveDimensions('18.5 x 23.5"', LANDSCAPE);
  assert.deepEqual([wide.width_in, wide.height_in], [23.5, 18.5]);
  assert.equal(wide.orientation, 'landscape');
});

test('string order is ignored, not just passed through', () => {
  const a = resolveDimensions('23.5 x 18.5"', PORTRAIT);
  const b = resolveDimensions('18.5 x 23.5"', PORTRAIT);
  assert.deepEqual([a.width_in, a.height_in], [b.width_in, b.height_in]);
});

test('confidence reflects text/image agreement', () => {
  // 18.5/23.5 = 0.787, image 360/460 = 0.783 -> agrees
  assert.equal(resolveDimensions('23.5 x 18.5"', PORTRAIT).confidence, 'high');
  // 10/30 = 0.33 against a 0.78 image -> orientation kept, numbers flagged
  assert.equal(resolveDimensions('30 x 10"', PORTRAIT).confidence, 'medium');
  // no image at all -> height-first fallback
  const noImage = resolveDimensions('23.5 x 18.5"', null);
  assert.equal(noImage.confidence, 'low');
  assert.deepEqual([noImage.width_in, noImage.height_in], [18.5, 23.5]);
  assert.equal(resolveDimensions(null, PORTRAIT).confidence, 'none');
});

test('square-ish items are labelled square', () => {
  assert.equal(resolveDimensions('15 x 15"', PORTRAIT).orientation, 'square');
});

test('unparseable input keeps the raw string for display', () => {
  const r = resolveDimensions('see notes', PORTRAIT);
  assert.equal(r.raw, 'see notes');
  assert.equal(r.width_in, null);
});
