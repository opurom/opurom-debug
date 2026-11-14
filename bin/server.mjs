import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFrameReader, encodeMessage } from '../lib/frame.mjs';
import { parseCondition, matchesCondition } from '../lib/conditions.mjs';
import { parseHitCount } from '../lib/hitcounts.mjs';
import { evaluateExpression, expressionIdentifiers, parseVariableValue, valueKind, valueText } from '../lib/expressions.mjs';
import { CAPABILITIES, EXCEPTION_FILTERS } from '../lib/capabilities.mjs';
import { KernelSession } from '../lib/kernel.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultCoreBinary = path.resolve(root, '..', 'opurom-core', 'target', 'debug', 'opurom-core');

const ERR_GENERIC = 1001;
const ERR_FRAME = 1002;
const ERR_VARIABLE = 2001;
const ERR_EXPRESSION = 2002;
const ERR_PAGE = 2003;
const ERR_BREAKPOINT = 2004;
const ERR_SCOPE = 2005;

const FRAME_ID = 1;

const KNOWN_EXCEPTION_FILTERS = new Set(EXCEPTION_FILTERS.map(entry => entry.filter));

class DapError extends Error {
  constructor(message, errorId = ERR_GENERIC) {
    super(message);
    this.errorId = errorId;
  }
}

function readProgram(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('launch requires arguments.program, an IR v0.1 JSON path');
  }
  const program = path.resolve(value);
  let text;
  let ir;
  try {
    text = fs.readFileSync(program, 'utf8');
    ir = JSON.parse(text);
  } catch (error) {
    throw new Error(`cannot read IR JSON ${program}: ${error.message}`);
  }
  if (ir?.ir !== '0.1') throw new Error(`unsupported IR version in ${program}: expected "0.1"`);
  return { program, text };
}

function readSteps(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('launch arguments.steps must be an array of strings');
  return value.map(step => {
    if (typeof step !== 'string' || step.trim() === '' || /[\r\n]/.test(step)) {
      throw new Error('launch arguments.steps entries must be non-empty single-line strings');
    }
    const command = step.trim();
    if (command === 'quit' || command.startsWith('quit ')) {
      throw new Error('launch arguments.steps cannot contain quit');
    }
    return command;
  });
}

// IR node ids are declared in the program text. Map each id to its 1-based text
// line so source breakpoints bind to real, verifiable lines.
function buildSourceMap(text) {
  const nodeLines = new Map();
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    const re = /"id"\s*:\s*(\d+)/g;
    let match;
    while ((match = re.exec(line))) nodeLines.set(Number(match[1]), index + 1);
  });
  return { nodeLines, breakableLines: new Set(nodeLines.values()), lineCount: lines.length };
}

// A core command such as `tap 4` or `input 4 text` runs the handler of node 4.
function stepLineFor(step, nodeLines) {
  const match = /^(?:tap|input)\s+(\d+)(?:\s|$)/.exec(step.trim());
  if (!match) return null;
  return nodeLines.get(Number(match[1])) ?? null;
}

class DapServer {
  constructor() {
    this.seq = 1;
    this.queue = Promise.resolve();
    this.output = Promise.resolve();
    this.kernel = null;
    this.sessions = new Set();
    this.program = null;
    this.sourcePath = null;
    this.nodeLines = new Map();
    this.breakableLines = new Set();
    this.steps = [];
    this.stepIndex = 0;
    this.currentLine = 1;
    this.breakpointsBySource = new Map();
    this.breakpointId = 0;
    this.dataBreakpoints = new Map();
    this.dataBreakpointId = 0;
    this.exceptionFilters = [];
    this.columnsStartAt1 = true;
    this.exception = null;
    this.stepStats = { executed: 0, totalMs: 0, lastMs: 0 };
    this.running = false;
    this.stopped = false;
    this.completed = false;
    this.pauseRequested = false;
    this.ended = false;
    this.closing = false;
    this.terminated = false;
    this.stepTask = null;
    this.skipLineBreakpoint = false;
  }

  write(message) {
    const frame = encodeMessage({ ...message, seq: this.seq++ });
    this.output = this.output.then(() => new Promise(resolve => {
      process.stdout.write(frame, resolve);
    })).catch(() => {});
    return this.output;
  }

  sendResponse(request, success, body, message, errorId = ERR_GENERIC) {
    const response = {
      type: 'response',
      request_seq: Number.isInteger(request?.seq) ? request.seq : 0,
      success,
      command: typeof request?.command === 'string' ? request.command : ''
    };
    if (success) {
      if (body !== undefined) response.body = body;
    } else {
      response.message = message;
      response.body = { error: { id: errorId, format: message, showUser: true } };
    }
    return this.write(response);
  }

  sendError(request, message, errorId = ERR_GENERIC) {
    return this.sendResponse(request, false, undefined, message, errorId);
  }

  sendEvent(event, body = {}) {
    return this.write({ type: 'event', event, body });
  }

  onMessage(message) {
    this.queue = this.queue
      .then(() => this.dispatch(message))
      .catch(error => this.sendError(message, error?.message || String(error), error?.errorId ?? ERR_GENERIC))
      .catch(() => {});
  }

  onFrameError(text) {
    this.sendError({ seq: 0, command: '' }, `Malformed DAP frame: ${text}`, ERR_FRAME);
  }

  async dispatch(message) {
    if (!message || message.type !== 'request' || typeof message.command !== 'string') {
      throw new Error('Invalid DAP request');
    }
    const args = message.arguments && typeof message.arguments === 'object' ? message.arguments : {};
    switch (message.command) {
      case 'initialize':
        this.columnsStartAt1 = typeof args.columnsStartAt1 === 'boolean' ? args.columnsStartAt1 : true;
        this.sendResponse(message, true, CAPABILITIES);
        this.sendEvent('initialized');
        return;
      case 'launch':
        await this.launch(message, args);
        return;
      case 'setBreakpoints':
        this.setBreakpoints(message, args);
        return;
      case 'setExceptionBreakpoints':
        this.setExceptionBreakpoints(message, args);
        return;
      case 'configurationDone':
        this.requireKernel();
        this.sendResponse(message, true);
        this.startSteps();
        return;
      case 'threads':
        this.sendResponse(message, true, { threads: [{ id: 1, name: 'OPUROM kernel' }] });
        return;
      case 'stackTrace':
        this.stackTrace(message);
        return;
      case 'scopes':
        this.scopes(message, args);
        return;
      case 'variables':
        this.variables(message, args);
        return;
      case 'setVariable':
        this.setVariable(message, args);
        return;
      case 'dataBreakpointInfo':
        this.dataBreakpointInfo(message, args);
        return;
      case 'setDataBreakpoints':
        this.setDataBreakpoints(message, args);
        return;
      case 'evaluate':
        this.evaluate(message, args);
        return;
      case 'completions':
        this.completions(message, args);
        return;
      case 'exceptionInfo':
        this.exceptionInfo(message);
        return;
      case 'opurom/frameStats':
        this.frameStats(message);
        return;
      case 'opurom/resourceStats':
        await this.resourceStats(message);
        return;
      case 'opurom/layers':
        await this.layers(message);
        return;
      case 'opurom/networkStats':
        await this.networkStats(message);
        return;
      case 'opurom/navigation':
        this.navigation(message);
        return;
      case 'opurom/sessionLog':
        this.sessionLog(message);
        return;
      case 'continue':
        this.requireKernel();
        this.stopped = false;
        this.sendResponse(message, true, { allThreadsContinued: true });
        this.startSteps();
        return;
      case 'next':
        this.stepOnce(message, 'Completed one kernel step');
        return;
      case 'stepIn':
        this.stepOnce(message, 'Stepped into one kernel command');
        return;
      case 'stepOut':
        this.stepOnce(message, 'Stepped out of one kernel command');
        return;
      case 'pause':
        this.pause(message);
        return;
      case 'disconnect': {
        this.sendResponse(message, true, { sessionsClosed: this.sessions.size });
        await this.shutdown();
        return;
      }
      default:
        throw new Error(`Unknown DAP request: ${message.command}`);
    }
  }

  requireKernel() {
    if (!this.kernel) throw new Error('launch a kernel session before this request');
  }

  async launch(request, args) {
    if (this.running) throw new Error('cannot launch while the session is running');
    const { program, text } = readProgram(args.program);
    const steps = readSteps(args.steps);
    if (args.coreBinary !== undefined && (typeof args.coreBinary !== 'string' || args.coreBinary.trim() === '')) {
      throw new Error('launch arguments.coreBinary must be a non-empty string when provided');
    }
    const binary = args.coreBinary ? path.resolve(args.coreBinary) : defaultCoreBinary;
    const kernel = new KernelSession(binary, program);
    this.sessions.add(kernel);
    try {
      await kernel.start();
    } catch (error) {
      await kernel.quit();
      this.sessions.delete(kernel);
      throw error;
    }
    const map = buildSourceMap(text);
    this.kernel = kernel;
    this.program = program;
    this.sourcePath = program;
    this.nodeLines = map.nodeLines;
    this.breakableLines = map.breakableLines;
    this.steps = steps;
    this.stepIndex = 0;
    this.currentLine = 1;
    this.completed = false;
    this.stopped = false;
    this.terminated = false;
    this.pauseRequested = false;
    this.skipLineBreakpoint = false;
    this.breakpointsBySource.clear();
    this.breakpointId = 0;
    this.dataBreakpoints.clear();
    this.dataBreakpointId = 0;
    this.exception = null;
    this.stepStats = { executed: 0, totalMs: 0, lastMs: 0 };
    this.sendResponse(request, true);
  }

  setBreakpoints(request, args) {
    const source = typeof args.source?.path === 'string' ? args.source.path : (this.program || 'default');
    this.sourcePath = source;
    const requested = Array.isArray(args.breakpoints) ? args.breakpoints : [];
    const accepted = [];
    const reported = requested.map(breakpoint => {
      const id = ++this.breakpointId;
      const bp = breakpoint && typeof breakpoint === 'object' ? breakpoint : {};
      const hasLine = Object.hasOwn(bp, 'line');
      if (hasLine && (!Number.isInteger(bp.line) || bp.line < 1)) {
        throw new DapError('breakpoint line must be a positive integer', ERR_BREAKPOINT);
      }
      const line = hasLine ? bp.line : null;
      const conditionText = typeof bp.condition === 'string' ? bp.condition.trim() : '';
      const condition = conditionText ? parseCondition(conditionText) : null;
      const hasHitCondition = bp.hitCondition !== undefined && bp.hitCondition !== null;
      const hitCount = hasHitCondition ? parseHitCount(bp.hitCondition) : null;
      const reportedBp = { id, verified: true };
      if (line !== null) {
        reportedBp.line = line;
        reportedBp.source = { name: path.basename(source), path: source };
      }
      let message = null;
      if (conditionText && !condition) {
        message = `Unsupported condition: ${conditionText}`;
      } else if (hasHitCondition && hitCount === null) {
        message = `Unsupported hit condition: ${JSON.stringify(bp.hitCondition)}; expected a positive integer`;
      } else if (line !== null && !this.breakableLines.has(line)) {
        message = `Unknown breakpoint line ${line}: no executable IR node on that line`;
      } else if (line === null && !condition && hitCount === null) {
        message = 'A state condition, source line or hit count is required';
      }
      if (message) {
        reportedBp.verified = false;
        reportedBp.message = message;
      } else {
        accepted.push({ id, source, line, condition, text: conditionText, hitCount, hits: 0 });
      }
      return reportedBp;
    });
    this.breakpointsBySource.set(source, accepted);
    this.sendResponse(request, true, { breakpoints: reported });
  }

  setExceptionBreakpoints(request, args) {
    const filters = Array.isArray(args.filters) ? args.filters.filter(entry => typeof entry === 'string') : [];
    const options = Array.isArray(args.filterOptions)
      ? args.filterOptions.filter(entry => entry && typeof entry.filterId === 'string').map(entry => entry.filterId)
      : [];
    const combined = [...filters, ...options];
    const unknown = combined.filter(entry => !KNOWN_EXCEPTION_FILTERS.has(entry));
    if (unknown.length) {
      throw new DapError(`Unknown exception breakpoint filter: ${unknown.join(', ')}`, ERR_BREAKPOINT);
    }
    this.exceptionFilters = [...new Set(combined)];
    this.sendResponse(request, true, { filters: this.exceptionFilters });
  }

  stackTrace(request) {
    const source = this.sourcePath || this.program || 'OPUROM state';
    this.sendResponse(request, true, {
      stackFrames: [{
        id: FRAME_ID,
        name: 'OPUROM state',
        source: { name: path.basename(source), path: source },
        line: this.currentLine || 1,
        column: 1,
        presentationHint: 'normal'
      }],
      totalFrames: 1
    });
  }

  scopes(request, args) {
    this.requireKernel();
    if (Number(args.frameId) !== FRAME_ID) {
      throw new DapError(`Unknown scopes frame reference: ${String(args.frameId)}`, ERR_SCOPE);
    }
    this.sendResponse(request, true, {
      scopes: [{
        name: 'Kernel state',
        variablesReference: 1,
        namedVariables: Object.keys(this.kernel.state).length,
        expensive: false,
        presentationHint: 'locals'
      }]
    });
  }

  variables(request, args) {
    this.requireKernel();
    if (Number(args.variablesReference) !== 1) {
      throw new DapError(`Unknown variablesReference: ${args.variablesReference}`, ERR_PAGE);
    }
    const all = Object.entries(this.kernel.state).map(([name, value]) => ({
      name,
      value: valueText(value),
      type: valueKind(value),
      variablesReference: 0
    }));
    let start = 0;
    let count = all.length;
    if (args.start !== undefined) {
      if (!Number.isInteger(args.start) || args.start < 0) {
        throw new DapError('variables.start must be a non-negative integer', ERR_PAGE);
      }
      start = args.start;
    }
    if (args.count !== undefined) {
      if (!Number.isInteger(args.count) || args.count < 0) {
        throw new DapError('variables.count must be a non-negative integer', ERR_PAGE);
      }
      count = args.count;
    }
    if (start > all.length) {
      throw new DapError(`variables page out of range: start ${start} exceeds ${all.length} variables`, ERR_PAGE);
    }
    this.sendResponse(request, true, {
      variables: all.slice(start, start + count),
      stateVersion: this.kernel.version
    });
  }

  setVariable(request, args) {
    this.requireKernel();
    if (Number(args.variablesReference) !== 1) {
      throw new DapError(`Unknown variablesReference: ${args.variablesReference}`, ERR_VARIABLE);
    }
    const name = args.name;
    if (typeof name !== 'string' || !Object.hasOwn(this.kernel.state, name)) {
      throw new DapError(`Unknown variable: ${String(name)}`, ERR_VARIABLE);
    }
    const parsed = parseVariableValue(args.value, this.kernel.state[name]);
    if (parsed.error) throw new DapError(`Invalid value for ${name}: ${parsed.error}`, ERR_VARIABLE);
    this.kernel.setState(name, parsed.value);
    // A debugger edit is not a kernel write, so it advances the watched
    // baseline instead of firing the data breakpoint on the next step.
    const watched = this.dataBreakpoints.get(`state:${name}`);
    if (watched) watched.last = parsed.value;
    this.sendResponse(request, true, {
      value: valueText(parsed.value),
      type: valueKind(parsed.value),
      variablesReference: 0
    });
  }

  dataBreakpointInfo(request, args) {
    this.requireKernel();
    const name = args.name;
    if (args.variablesReference !== undefined && Number(args.variablesReference) !== 1) {
      throw new DapError(`Unknown variablesReference: ${args.variablesReference}`, ERR_PAGE);
    }
    if (typeof name !== 'string' || !Object.hasOwn(this.kernel.state, name)) {
      throw new DapError(`Unknown state name for a data breakpoint: ${String(name)}`, ERR_VARIABLE);
    }
    this.sendResponse(request, true, {
      dataId: `state:${name}`,
      description: `${name} (kernel state value)`,
      accessTypes: ['write'],
      canPersist: false
    });
  }

  setDataBreakpoints(request, args) {
    this.requireKernel();
    const requested = Array.isArray(args.breakpoints) ? args.breakpoints : null;
    if (!requested) {
      throw new DapError('setDataBreakpoints requires a breakpoints array', ERR_BREAKPOINT);
    }
    const accepted = new Map();
    const reported = requested.map(entry => {
      const bp = entry && typeof entry === 'object' ? entry : {};
      const dataId = typeof bp.dataId === 'string' ? bp.dataId : '';
      const accessType = bp.accessType === undefined ? 'write' : bp.accessType;
      const name = dataId.startsWith('state:') ? dataId.slice('state:'.length) : '';
      let message = null;
      if (!dataId) message = 'A dataId from dataBreakpointInfo is required';
      else if (!name) message = `Unknown data breakpoint id: ${dataId}`;
      else if (!Object.hasOwn(this.kernel.state, name)) {
        message = `Unknown state name for a data breakpoint: ${name}`;
      } else if (accessType !== 'write') {
        message = `Unsupported access type: ${JSON.stringify(accessType)}; kernel steps only write state`;
      }
      if (message) return { verified: false, message };
      const id = ++this.dataBreakpointId;
      accepted.set(dataId, { id, dataId, name, last: this.kernel.state[name] });
      return { id, verified: true, dataId, description: `${name} (kernel state value)` };
    });
    this.dataBreakpoints = accepted;
    this.sendResponse(request, true, { breakpoints: reported });
  }

  evaluate(request, args) {
    this.requireKernel();
    const expression = typeof args.expression === 'string' ? args.expression.trim() : '';
    let value;
    try {
      value = evaluateExpression(expression, this.kernel.state);
    } catch (error) {
      throw new DapError(`Bad expression: ${error.message}`, ERR_EXPRESSION);
    }
    this.sendResponse(request, true, {
      result: valueText(value),
      type: valueKind(value),
      variablesReference: 0
    });
  }

  completions(request, args) {
    this.requireKernel();
    const text = args.text;
    const column = args.column;
    if (text !== undefined && typeof text !== 'string') {
      throw new DapError('Bad completions: text must be a string', ERR_EXPRESSION);
    }
    if (column !== undefined && text === undefined) {
      throw new DapError('Bad completions: column requires text', ERR_EXPRESSION);
    }
    if (column !== undefined) {
      const min = this.columnsStartAt1 ? 1 : 0;
      const max = text.length + (this.columnsStartAt1 ? 1 : 0);
      if (!Number.isInteger(column) || column < min || column > max) {
        throw new DapError('Bad completions: column is outside text', ERR_EXPRESSION);
      }
    }
    let prefix = '';
    if (text !== undefined) {
      const caret = column === undefined ? text.length : column - (this.columnsStartAt1 ? 1 : 0);
      prefix = /[A-Za-z_][A-Za-z0-9_]*$/.exec(text.slice(0, Math.max(0, caret)))?.[0] || '';
    }
    const targets = expressionIdentifiers(this.kernel.state)
      .filter(name => name.startsWith(prefix))
      .map(name => ({ label: name, type: 'variable', detail: valueKind(this.kernel.state[name]) }));
    this.sendResponse(request, true, { targets });
  }

  exceptionInfo(request) {
    if (!this.exception) {
      this.sendResponse(request, true, {
        exceptionId: '',
        description: 'No active kernel exception',
        breakMode: 'neverHalted'
      });
      return;
    }
    this.sendResponse(request, true, {
      exceptionId: this.exception.filters[0] || this.exception.description,
      description: this.exception.description,
      breakMode: 'alwaysHalted'
    });
  }

  // The counters come from timing the adapter's own kernel commands, so they
  // describe exactly this session and need no kernel protocol support.
  frameStats(request) {
    this.requireKernel();
    const { executed, totalMs, lastMs } = this.stepStats;
    this.sendResponse(request, true, {
      stepsPlanned: this.steps.length,
      stepsExecuted: executed,
      totalMs,
      lastStepMs: lastMs,
      avgStepMs: executed ? totalMs / executed : 0,
      stepsPerSecond: totalMs > 0 ? (executed * 1000) / totalMs : 0,
      stateVersion: this.kernel.version
    });
  }

  // Resource-cache accounting from the kernel: the plugin result cache's byte
  // budget, used bytes and entry count. Read live over the kernel protocol so a
  // memory inspection reflects the running session, not a local mirror.
  async resourceStats(request) {
    this.requireKernel();
    const output = await this.kernel.command('resource');
    const stats = output.stats || {};
    this.sendResponse(request, true, {
      budget: stats.budget,
      usedBytes: stats.usedBytes,
      entries: stats.entries,
      stateVersion: this.kernel.version
    });
  }

  // Layer inspection for the live display list: one {id, kind, effects} record
  // per node the renderer receives, read over a `layers` kernel command so the
  // debugger shows the same layer view as the CLI inspect.
  async layers(request) {
    this.requireKernel();
    const output = await this.kernel.command('layers');
    this.sendResponse(request, true, {
      layers: output.records || [],
      stateVersion: this.kernel.version
    });
  }

  // Network capture: the requests the session's network.request capability made,
  // in order, read live over a `network` kernel command.
  async networkStats(request) {
    this.requireKernel();
    const output = await this.kernel.command('network');
    this.sendResponse(request, true, {
      requests: output.records || [],
      stateVersion: this.kernel.version
    });
  }

  // The kernel speaks a plain line protocol on stdin/stdout; these are the exact
  // state/patches/error lines it produced for this session, unmodified.
  // Navigation history: one {page, version} record per `@nav` signal, in order.
  navigation(request) {
    this.requireKernel();
    this.sendResponse(request, true, {
      navigations: [...this.kernel.navigation],
      count: this.kernel.navigation.length,
      stateVersion: this.kernel.version
    });
  }

  sessionLog(request) {
    this.requireKernel();
    this.sendResponse(request, true, {
      lines: [...this.kernel.log],
      count: this.kernel.log.length,
      stateVersion: this.kernel.version
    });
  }

  stepOnce(request, description) {
    this.requireKernel();
    if (this.running) throw new Error('the session is running');
    this.stopped = false;
    this.exception = null;
    if (this.stepIndex >= this.steps.length) {
      this.sendResponse(request, true);
      this.emitTerminated();
      return;
    }
    this.sendResponse(request, true);
    this.startSteps(true, description);
  }

  pause(request) {
    this.requireKernel();
    if (this.running) this.pauseRequested = true;
    else if (!this.completed && !this.stopped) {
      this.stopped = true;
      this.emitStopped('pause', { description: 'Paused' });
    }
    this.sendResponse(request, true);
  }

  allBreakpoints() {
    const list = [];
    for (const records of this.breakpointsBySource.values()) list.push(...records);
    return list;
  }

  // Count every hit of each matching breakpoint so exact counts survive continue
  // and stepping; without a hit condition a breakpoint still fires on every hit.
  matchedBreakpoint(matches) {
    let firing = null;
    for (const record of this.allBreakpoints()) {
      if (!matches(record)) continue;
      record.hits += 1;
      if (!firing && (record.hitCount === null || record.hits === record.hitCount)) firing = record;
    }
    return firing;
  }

  matchedConditionBreakpoint() {
    return this.matchedBreakpoint(record =>
      record.line === null && (!record.condition || matchesCondition(record.condition, this.kernel.state))
    );
  }

  lineBreakpointAt(line) {
    return this.matchedBreakpoint(record =>
      record.line === line && (!record.condition || matchesCondition(record.condition, this.kernel.state))
    );
  }

  // Kernel steps are the only writes a data breakpoint observes: every watched
  // name is compared after each step and its baseline advances either way, so a
  // change fires once and later steps stay quiet until the value moves again.
  matchedDataBreakpoint() {
    let changed = null;
    for (const record of this.dataBreakpoints.values()) {
      const value = this.kernel.state[record.name];
      if (Object.is(record.last, value)) continue;
      const before = record.last;
      record.last = value;
      if (!changed) changed = { name: record.name, before, value, id: record.id };
    }
    return changed;
  }

  startSteps(single = false, stopDescription = 'Completed one kernel step') {
    if (!this.kernel || this.running || this.ended || this.closing || this.completed) return;
    this.exception = null;
    this.running = true;
    this.stopped = false;
    this.sendEvent('continued', { threadId: 1, allThreadsContinued: true });
    const task = this.runSteps(single, stopDescription).finally(() => {
      if (this.stepTask === task) this.stepTask = null;
    });
    this.stepTask = task;
  }

  async runSteps(single, stopDescription) {
    try {
      while (!this.ended && !this.closing && this.stepIndex < this.steps.length) {
        const skipLineCheck = this.skipLineBreakpoint;
        this.skipLineBreakpoint = false;
        const step = this.steps[this.stepIndex];
        const stepLine = stepLineFor(step, this.nodeLines);
        if (!skipLineCheck && stepLine !== null) {
          const lineBp = this.lineBreakpointAt(stepLine);
          if (lineBp) {
            this.stopped = true;
            this.currentLine = stepLine;
            this.skipLineBreakpoint = true;
            this.emitStopped('breakpoint', {
              description: `Source breakpoint hit: ${path.basename(lineBp.source)}:${stepLine}`,
              hitBreakpointIds: [lineBp.id],
              line: stepLine,
              source: { name: path.basename(lineBp.source), path: lineBp.source }
            });
            return;
          }
        }
        this.stepIndex++;
        const startedAt = performance.now();
        await this.kernel.command(step);
        const stepMs = performance.now() - startedAt;
        this.stepStats.executed += 1;
        this.stepStats.lastMs = stepMs;
        this.stepStats.totalMs += stepMs;
        if (this.ended || this.closing) return;
        if (stepLine !== null) this.currentLine = stepLine;
        if (this.pauseRequested) {
          this.pauseRequested = false;
          this.stopped = true;
          this.emitStopped('pause', { description: 'Paused after a kernel step' });
          return;
        }
        const dataChange = this.matchedDataBreakpoint();
        if (dataChange) {
          this.stopped = true;
          this.emitStopped('data breakpoint', {
            description: `State changed: ${dataChange.name}: ${valueText(dataChange.before)} -> ${valueText(dataChange.value)}`,
            text: `${dataChange.name}: ${valueText(dataChange.before)} -> ${valueText(dataChange.value)}`,
            hitBreakpointIds: [dataChange.id]
          });
          return;
        }
        const condition = this.matchedConditionBreakpoint();
        if (condition) {
          this.stopped = true;
          this.emitStopped('breakpoint', {
            description: condition.hitCount !== null
              ? `State breakpoint hit ${condition.hits} times${condition.text ? `: ${condition.text}` : ''}`
              : `State breakpoint matched: ${condition.text}`,
            text: condition.text || undefined,
            condition: condition.text || undefined,
            hitBreakpointIds: [condition.id]
          });
          return;
        }
        if (single) {
          this.stopped = true;
          const source = this.sourcePath || this.program || 'OPUROM state';
          this.emitStopped('step', {
            description: stopDescription,
            line: this.currentLine,
            source: { name: path.basename(source), path: source }
          });
          return;
        }
      }
      this.completed = !this.ended && !this.closing && this.stepIndex >= this.steps.length;
    } catch (error) {
      this.stopped = true;
      if (!this.ended && !this.closing) this.emitStopped('exception', {
        description: error.message,
        text: error.message,
        filters: this.exceptionFilters.length ? [...this.exceptionFilters] : undefined
      });
      return;
    } finally {
      this.running = false;
    }
    if (this.completed && !this.ended && !this.closing) this.emitTerminated();
  }

  emitStopped(reason, detail = {}) {
    if (reason === 'exception') {
      this.exception = {
        description: detail.description || reason,
        filters: detail.filters ? [...detail.filters] : []
      };
    }
    const body = {
      reason,
      description: detail.description || reason,
      threadId: 1,
      allThreadsStopped: true,
      stateVersion: this.kernel?.version ?? 0
    };
    if (detail.text !== undefined) body.text = detail.text;
    if (detail.condition !== undefined) body.condition = detail.condition;
    if (detail.hitBreakpointIds) body.hitBreakpointIds = detail.hitBreakpointIds;
    if (detail.line !== undefined) body.line = detail.line;
    if (detail.source) body.source = detail.source;
    if (detail.filters) body.filters = detail.filters;
    this.sendEvent('stopped', body);
  }

  emitTerminated() {
    if (this.terminated) return;
    this.terminated = true;
    this.sendEvent('terminated', { restart: false });
  }

  async shutdown() {
    if (this.closing) return;
    this.closing = true;
    this.ended = true;
    const stepTask = this.stepTask;
    for (const session of this.sessions) await session.quit();
    this.sessions.clear();
    this.kernel = null;
    this.breakpointsBySource.clear();
    this.exceptionFilters = [];
    this.exception = null;
    this.steps = [];
    if (stepTask) await stepTask.catch(() => {});
    this.emitTerminated();
    await this.output;
    process.exit(0);
  }
}

if (!process.argv.includes('--stdio')) {
  process.stderr.write('usage: node bin/server.mjs --stdio\n');
  process.exit(2);
}

const server = new DapServer();
const reader = createFrameReader(
  message => server.onMessage(message),
  error => server.onFrameError(error)
);
process.stdin.on('data', chunk => reader.push(chunk));
process.stdin.on('error', () => {});
process.stdin.on('end', () => { void server.shutdown(); });
