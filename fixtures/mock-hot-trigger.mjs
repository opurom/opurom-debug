// Injectable hot trigger for framed DAP tests. OPR_HOT_MOCK_MODE selects the
// outcome; no cli-dev endpoint is involved.
const mode = process.env.OPR_HOT_MOCK_MODE || 'success';

export async function createHotTrigger() {
  return async action => {
    if (mode === 'timeout') return new Promise(() => {});
    if (mode === 'build-error') {
      return { ok: false, code: 'build-error', category: 'build-error', message: 'mock build failed' };
    }
    if (mode === 'restart-required') {
      return { ok: false, code: 'restart-required', category: 'restart-required', message: 'mock reload rejected' };
    }
    if (mode === 'invalid') return { action };
    if (mode === 'missing') throw new Error('mock trigger is unavailable');
    return { ok: true, version: 7, action };
  };
}
