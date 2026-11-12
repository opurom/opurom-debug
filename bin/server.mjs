import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFrameReader, encodeMessage } from '../lib/frame.mjs';
import { parseCondition, matchesCondition } from '../lib/conditions.mjs';
import { KernelSession } from '../lib/kernel.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultCoreBinary = path.resolve(root, '..', 'opurom-core', 'target', 'debug', 'opurom-core');

function readProgram(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('launch requires arguments.program, an IR v0.1 JSON path');
  }
  const program = path.resolve(value);
  let ir;
  try {
    ir = JSON.parse(fs.readFileSync(program, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read IR JSON ${program}: ${error.message}`);
  }
  if (ir?.ir !== '0.1') throw new Error(`unsupported IR version in ${program}: expected "0.1"`);
  return program;
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

function variableType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function variableText(value) {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

class DapServer {
  constructor() {
    this.seq = 1;
    this.queue = Promise.resolve();
    this.output = Promise.resolve();
    this.kernel = null;
    this.program = null;
    this.sourcePath = null;
    this.steps = [];
    this.stepIndex = 0;
    this.breakpointsBySource = new Map();
    this.breakpointId = 0;
    this.running = false;
    this.stopped = false;
    this.completed = false;
    this.pauseRequested = false;
    this.ended = false;
    this.closing = false;
    this.terminated = false;
    this.stepTask = null;
  }

  write(message) {
    const frame = encodeMessage({ ...message, seq: this.seq++ });
    this.output = this.output.then(() => new Promise(resolve => {
      process.stdout.write(frame, resolve);
    })).catch(() => {});
    return this.output;
  }

  sendResponse(request, success, body, message, errorId = 1001) {
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

  sendError(request, message, errorId = 1001) {
    return this.sendResponse(request, false, undefined, message, errorId);
  }

  sendEvent(event, body = {}) {
    return this.write({ type: 'event', event, body });
  }

  onMessage(message) {
    this.queue = this.queue
      .then(() => this.dispatch(message))
      .catch(error => this.sendError(message, error?.message || String(error)))
      .catch(() => {});
  }

  onFrameError(text) {
    this.sendError({ seq: 0, command: '' }, `Malformed DAP frame: ${text}`, 1002);
  }

  async dispatch(message) {
    if (!message || message.type !== 'request' || typeof message.command !== 'string') {
      throw new Error('Invalid DAP request');
    }
    const args = message.arguments && typeof message.arguments === 'object' ? message.arguments : {};
    switch (message.command) {
      case 'initialize':
        this.sendResponse(message, true, {
          supportsConfigurationDoneRequest: true,
          supportsEvaluateForHovers: true,
          supportsConditionalBreakpoints: true
        });
        this.sendEvent('initialized');
        return;
      case 'launch':
        await this.launch(message, args);
        return;
      case 'setBreakpoints':
        this.setBreakpoints(message, args);
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
        this.next(message);
        return;
      case 'pause':
        this.pause(message);
        return;
      case 'disconnect':
        this.sendResponse(message, true);
        await this.shutdown();
        return;
      default:
        throw new Error(`Unknown DAP request: ${message.command}`);
    }
  }

  requireKernel() {
    if (!this.kernel) throw new Error('launch a kernel session before this request');
  }

  async launch(request, args) {
    if (this.kernel) throw new Error('a debug session is already running');
    const program = readProgram(args.program);
    const steps = readSteps(args.steps);
    if (args.coreBinary !== undefined && (typeof args.coreBinary !== 'string' || args.coreBinary.trim() === '')) {
      throw new Error('launch arguments.coreBinary must be a non-empty string when provided');
    }
    const binary = args.coreBinary ? path.resolve(args.coreBinary) : defaultCoreBinary;
    const kernel = new KernelSession(binary, program);
    try {
      await kernel.start();
    } catch (error) {
      await kernel.quit();
      throw error;
    }
    this.kernel = kernel;
    this.program = program;
    this.sourcePath = program;
    this.steps = steps;
    this.stepIndex = 0;
    this.completed = false;
    this.stopped = false;
    this.pauseRequested = false;
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
      const condition = typeof breakpoint?.condition === 'string' ? breakpoint.condition : '';
      const parsed = parseCondition(condition);
      if (parsed) {
        accepted.push({ ...parsed, id });
        return { id, verified: true };
      }
      return {
        id,
        verified: false,
        message: condition ? `Unsupported condition: ${condition}` : 'A state condition is required'
      };
    });
    this.breakpointsBySource.set(source, accepted);
    this.sendResponse(request, true, { breakpoints: reported });
  }

  stackTrace(request) {
    const source = this.sourcePath || this.program || 'OPUROM state';
    this.sendResponse(request, true, {
      stackFrames: [{
        id: 1,
        name: 'OPUROM state',
        source: { name: path.basename(source), path: source },
        line: 1,
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
      throw new Error(`Unknown variablesReference: ${args.variablesReference}`);
    }
    const variables = Object.entries(this.kernel.state).map(([name, value]) => ({
      name,
      value: variableText(value),
      type: variableType(value),
      variablesReference: 0
    }));
    this.sendResponse(request, true, { variables, stateVersion: this.kernel.version });
  }

  evaluate(request, args) {
    this.requireKernel();
    const expression = typeof args.expression === 'string' ? args.expression.trim() : '';
    const condition = parseCondition(expression);
    let value;
    if (condition) {
      value = matchesCondition(condition, this.kernel.state);
    } else if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expression) && Object.hasOwn(this.kernel.state, expression)) {
      value = this.kernel.state[expression];
    } else {
      throw new Error('Hover evaluation supports state names and simple numeric conditions only');
    }
    this.sendResponse(request, true, {
      result: variableText(value),
      type: variableType(value),
      variablesReference: 0
    });
  }

  next(request) {
    this.requireKernel();
    if (this.running) throw new Error('the session is running');
    this.stopped = false;
    this.sendResponse(request, true);
    if (this.stepIndex >= this.steps.length) {
      this.emitTerminated();
      return;
    }
    this.startSteps(true);
  }

  pause(request) {
    this.requireKernel();
    if (this.running) this.pauseRequested = true;
    else if (!this.completed && !this.stopped) {
      this.stopped = true;
      this.emitStopped('pause', null, 'Paused');
    }
    this.sendResponse(request, true);
  }

  allBreakpoints() {
    const list = [];
    for (const conditions of this.breakpointsBySource.values()) list.push(...conditions);
    return list;
  }

  matchedBreakpoint() {
    return this.allBreakpoints().find(condition => matchesCondition(condition, this.kernel.state)) || null;
  }

  startSteps(single = false) {
    if (!this.kernel || this.running || this.ended || this.closing || this.completed) return;
    this.running = true;
    this.stopped = false;
    this.sendEvent('continued', { threadId: 1, allThreadsContinued: true });
    const task = this.runSteps(single).finally(() => {
      if (this.stepTask === task) this.stepTask = null;
    });
    this.stepTask = task;
  }

  async runSteps(single) {
    try {
      while (!this.ended && !this.closing && this.stepIndex < this.steps.length) {
        const step = this.steps[this.stepIndex++];
        await this.kernel.command(step);
        if (this.ended || this.closing) return;
        if (this.pauseRequested) {
          this.pauseRequested = false;
          this.stopped = true;
          this.emitStopped('pause', null, 'Paused after a kernel step');
          return;
        }
        const condition = this.matchedBreakpoint();
        if (condition) {
          this.stopped = true;
          this.emitStopped('breakpoint', condition);
          return;
        }
        if (single) {
          this.stopped = true;
          this.emitStopped('step', null, 'Completed one kernel step');
          return;
        }
      }
      this.completed = !this.ended && !this.closing && this.stepIndex >= this.steps.length;
    } catch (error) {
      this.stopped = true;
      if (!this.ended && !this.closing) this.emitStopped('exception', null, error.message);
      return;
    } finally {
      this.running = false;
    }
    if (this.completed && !this.ended && !this.closing) this.emitTerminated();
  }

  emitStopped(reason, condition, description) {
    const body = {
      reason,
      description: condition ? `State breakpoint matched: ${condition.text}` : description,
      threadId: 1,
      allThreadsStopped: true,
      stateVersion: this.kernel?.version ?? 0
    };
    if (condition) {
      body.text = condition.text;
      body.condition = condition.text;
      body.hitBreakpointIds = [condition.id];
    }
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
    if (this.kernel) await this.kernel.quit();
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
