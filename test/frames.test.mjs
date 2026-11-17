import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFrame, isJanky, makeFrame } from '../lib/frames.mjs';

const FRAME = { frameNumber: 1, vsyncUs: 1000, buildUs: 4000, rasterUs: 5000, shaderUs: null, tier: 'full' };

test('frame jank uses strict microsecond boundaries', () => {
  assert.equal(makeFrame({ ...FRAME, buildUs: 16666 }, 60).jank, false);
  assert.equal(makeFrame({ ...FRAME, buildUs: 16667 }, 60).jank, true);
  assert.equal(makeFrame({ ...FRAME, rasterUs: 16666 }, 60).jank, false);
  assert.equal(makeFrame({ ...FRAME, rasterUs: 16667 }, 60).jank, true);
  assert.equal(makeFrame({ ...FRAME, rasterUs: 20000, shaderUs: 4166 }, 60).shaderJank, false);
  assert.equal(makeFrame({ ...FRAME, rasterUs: 20000, shaderUs: 4167 }, 60).shaderJank, true);
  assert.equal(isJanky(8333, 120), false);
  assert.equal(isJanky(8334, 120), true);
});

test('missing raster and shader sources stay null instead of fabricating values', () => {
  const frame = makeFrame({ frameNumber: 2, vsyncUs: 10, buildUs: 9000, tier: null }, 60);
  assert.equal(frame.rasterUs, null);
  assert.equal(frame.shaderUs, null);
  assert.equal(frame.jank, false);
  assert.equal(frame.shaderJank, false);
  assert.equal(makeFrame({ frameNumber: 3, vsyncUs: 10, buildUs: 20000 }, 60).jank, true);
  const quietRaster = makeFrame({ frameNumber: 4, vsyncUs: 10, buildUs: 100, rasterUs: 100, shaderUs: 20000 }, 60);
  assert.equal(quietRaster.shaderJank, false);
});

test('identical frame input yields identical records and a bounded ring', () => {
  const one = makeFrame({ ...FRAME }, 60);
  const two = makeFrame({ ...FRAME }, 60);
  assert.deepEqual(one, two);
  let ring = [];
  for (let frameNumber = 1; frameNumber <= 205; frameNumber++) {
    ring = appendFrame(ring, makeFrame({ ...FRAME, frameNumber }, 60));
  }
  assert.equal(ring.length, 200);
  assert.equal(ring[0].frameNumber, 6);
  assert.equal(ring.at(-1).frameNumber, 205);
});

test('invalid frame input is rejected', () => {
  assert.throws(() => makeFrame({ ...FRAME }, 0), /refreshHz/);
  assert.throws(() => makeFrame({ ...FRAME, frameNumber: 0 }, 60), /frameNumber/);
  assert.throws(() => makeFrame({ ...FRAME, buildUs: -1 }, 60), /buildUs/);
  assert.throws(() => makeFrame({ ...FRAME, rasterUs: 1.5 }, 60), /rasterUs/);
  assert.throws(() => makeFrame({ ...FRAME, tier: 'low' }, 60), /tier/);
});
