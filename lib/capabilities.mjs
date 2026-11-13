// Single source of truth for the DAP initialize response body. The server sends
// this object verbatim, `bin/capabilities.mjs` prints it, and a test asserts a
// real framed initialize response equals it, so the three cannot drift apart.

export const EXCEPTION_FILTERS = [
  { filter: 'all', label: 'All OPUROM kernel errors', default: false },
  { filter: 'uncaught', label: 'Uncaught kernel errors', default: false }
];

export const CAPABILITIES = {
  supportsConfigurationDoneRequest: true,
  supportsEvaluateForHovers: true,
  supportsConditionalBreakpoints: true,
  supportsSetVariable: true,
  supportsVariablePaging: true,
  supportsExceptionFilterOptions: true,
  supportsCompletionsRequest: true,
  supportsExceptionInfoRequest: true,
  exceptionBreakpointFilters: EXCEPTION_FILTERS,
  // OPUROM extension flags: DAP has no standard boolean for these requests.
  supportsEvaluateExpressions: true,
  supportsStepInOutRequests: true,
  supportsVerifiedSourceBreakpoints: true
};
