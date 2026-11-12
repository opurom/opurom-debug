import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFrameReader, encodeMessage } from '../lib/frame.mjs';
import { parseCondition, matchesCondition } from '../lib/conditions.mjs';
import { evaluateExpression, parseVariableValue, valueKind, valueText } from '../lib/expressions.mjs';
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
    this.exceptionFilters = [];
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
        this.scopes(message);
        return;
      case 'variables':
        this.variables(message, args);
        return;
      case 'setVariable':
        this.setVariable(message, args);
        return;
      case 'evaluate':
        this.evaluate(message, args);
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
      const reportedBp = { id, verified: true };
      if (line !== null) {
        reportedBp.line = line;
        reportedBp.source = { name: path.basename(source), path: source };
      }
      let message = null;
      if (conditionText && !condition) {
        message = `Unsupported condition: ${conditionText}`;
      } else if (line !== null && !this.breakableLines.has(line)) {
        message = `Unknown breakpoint line ${line}: no executable IR node on that line`;
      } else if (line === null && !condition) {
        message = 'A state condition or source line is required';
      }
      if (message) {
        reportedBp.verified = false;
        reportedBp.message = message;
      } else {
        accepted.push({ id, source, line, condition, text: conditionText });
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
        id: 1,
        name: 'OPUROM state',
        source: { name: path.basename(source), path: source },
        line: this.currentLine || 1,
        column: 1,
        presentationHint: 'normal'
      }],
      totalFrames: 1
    });
  }

  scopes(request) {
    const state = this.kernel?.state || {};
    this.sendResponse(request, true, {
      scopes: [{
        name: 'Kernel state',
        variablesReference: 1,
        namedVariables: Object.keys(state).length,
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
    this.sendResponse(request, true, {
      value: valueText(parsed.value),
      type: valueKind(parsed.value),
      variablesReference: 0
    });
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

  stepOnce(request, description) {
    this.requireKernel();
    if (this.running) throw new Error('the session is running');
    this.stopped = false;
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

  matchedConditionBreakpoint() {
    return this.allBreakpoints().find(record =>
      record.line === null && record.condition && matchesCondition(record.condition, this.kernel.state)
    ) || null;
  }

  lineBreakpointAt(line) {
    return this.allBreakpoints().find(record =>
      record.line === line && (!record.condition || matchesCondition(record.condition, this.kernel.state))
    ) || null;
  }

  startSteps(single = false, stopDescription = 'Completed one kernel step') {
    if (!this.kernel || this.running || this.ended || this.closing || this.completed) return;
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
        await this.kernel.command(step);
        if (this.ended || this.closing) return;
        if (stepLine !== null) this.currentLine = stepLine;
        if (this.pauseRequested) {
          this.pauseRequested = false;
          this.stopped = true;
          this.emitStopped('pause', { description: 'Paused after a kernel step' });
          return;
        }
        const condition = this.matchedConditionBreakpoint();
        if (condition) {
          this.stopped = true;
          this.emitStopped('breakpoint', {
            description: `State breakpoint matched: ${condition.text}`,
            text: condition.text,
            condition: condition.text,
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
