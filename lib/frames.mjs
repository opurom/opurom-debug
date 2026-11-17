// Deterministic frame timing: host-injected integer microseconds, no wall clock.
// Jank rule source: packages/devtools_app/lib/src/screens/performance/panes/
// flutter_frames/flutter_frame_model.dart:117-138 @ 85f945ac (strictly greater
// than one frame; shader threshold is one quarter of that target).
// Phase source: engine/src/flutter/flow/frame_timings.h:35-42 @ ab2912035e.
const TIERS = new Set(['full', 'reduced', 'minimal']);

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer of microseconds`);
  }
  return value;
}

export function checkRefreshHz(refreshHz) {
  if (!Number.isFinite(refreshHz) || refreshHz <= 0) {
    throw new Error('refreshHz must be a positive finite number');
  }
  return refreshHz;
}

export function isJanky(durationUs, refreshHz) {
  return durationUs * checkRefreshHz(refreshHz) > 1_000_000;
}

export function makeFrame(raw, refreshHz) {
  checkRefreshHz(refreshHz);
  const input = raw && typeof raw === 'object' ? raw : {};
  if (!Number.isSafeInteger(input.frameNumber) || input.frameNumber < 1) {
    throw new Error('frameNumber must be a positive integer');
  }
  const buildUs = nonNegativeInteger(input.buildUs, 'buildUs');
  const rasterUs = input.rasterUs === null || input.rasterUs === undefined
    ? null : nonNegativeInteger(input.rasterUs, 'rasterUs');
  const shaderUs = input.shaderUs === null || input.shaderUs === undefined
    ? null : nonNegativeInteger(input.shaderUs, 'shaderUs');
  const tier = input.tier === null || input.tier === undefined ? null : input.tier;
  if (tier !== null && !TIERS.has(tier)) {
    throw new Error(`tier must be full, reduced, minimal or null; got ${String(tier)}`);
  }
  const rasterJank = rasterUs !== null && isJanky(rasterUs, refreshHz);
  return {
    frameNumber: input.frameNumber,
    vsyncUs: nonNegativeInteger(input.vsyncUs, 'vsyncUs'),
    buildUs,
    rasterUs,
    shaderUs,
    tier,
    jank: isJanky(buildUs, refreshHz) || rasterJank,
    shaderJank: rasterJank && shaderUs !== null && shaderUs * refreshHz * 4 > 1_000_000
  };
}

export function appendFrame(frames, frame, limit = 200) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('frame ring limit must be positive');
  return [...frames, frame].slice(-limit);
}
