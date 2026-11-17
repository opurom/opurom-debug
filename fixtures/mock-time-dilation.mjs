// Injectable time dilation hook for framed DAP tests. OPR_TIMEDILATION_MOCK=throw
// makes the hook fail so the adapter must report an explicit typed error.
export async function createTimeDilationSetter() {
  return async scale => {
    if (process.env.OPR_TIMEDILATION_MOCK === 'throw') throw new Error('mock time dilation hook failed');
    return scale;
  };
}
