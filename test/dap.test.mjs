import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createFrameReader, encodeMessage } from '../lib/frame.mjs';
import { parseCondition, matchesCondition } from '../lib/conditions.mjs';
import { parseKernelLine } from '../lib/kernel.mjs';
import { CAPABILITIES } from '../lib/capabilities.mjs';
import { evaluateExpression, parseVariableValue, valueKind } from '../lib/expressions.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverPath = path.join(root, 'bin', 'server.mjs');
const irPath = path.join(root, 'test', 'fixtures', 'counter.opuir.json');
const stubCore = path.join(root, 'fixtures', 'stub-core.mjs');
const missingCore = path.join(root, 'test', 'fixtures', 'missing-opurom-core');
const realCore = path.resolve(root, '..', 'opurom-core', 'target', 'debug', 'opurom-core');
const releaseCore = path.resolve(root, '..', 'opurom-core', 'target', 'release', 'opurom-core');
fs.chmodSync(stubCore, 0o755);

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const availableRealCore = [realCore, releaseCore].find(isExecutable);
const sessionCore = availableRealCore || stubCore;
const multiPath = path.join(root, 'test', 'fixtures', 'multi.opuir.json');

// IR node ids are declared in the program text; find the 1-based text line that
// declares a given node so source breakpoint tests bind to real lines.
function sourceLineOfNode(file, id) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const re = new RegExp(`"id"\\s*:\\s*${id}(?![0-9])`);
  const index = lines.findIndex(line => re.test(line));
  assert.ok(index >= 0, `no source line declares node ${id}`);
  return index + 1;
}

function withTimeout(promise, label, ms = 8000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class DapClient {
  constructor(child) {
    this.child = child;
    this.seq = 0;
    this.pending = new Map();
    this.responses = [];
    this.events = [];
    this.waiters = [];
    this.readerErrors = [];
    this.stderr = '';
    this.transcript = [];
    this.exited = new Promise(resolve => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });
    child.stdin.on('error', () => {});
    child.stderr.on('data', chunk => { this.stderr += String(chunk); });
    const reader = createFrameReader(
      message => this.onMessage(message),
      error => this.readerErrors.push(error)
    );
    child.stdout.on('data', chunk => reader.push(chunk));
  }

  request(command, args = {}) {
    const seq = ++this.seq;
    return new Promise((resolve, reject) => {
      let timer;
      const entry = {
        resolve: response => { clearTimeout(timer); resolve(response); },
        reject
      };
      timer = setTimeout(() => {
        this.pending.delete(seq);
        reject(new Error(`Timed out waiting for response to ${command}`));
      }, 8000);
      this.pending.set(seq, entry);
      const request = { seq, type: 'request', command, arguments: args };
      this.transcript.push({ dir: 'C->S', message: request });
      try {
        this.child.stdin.write(encodeMessage(request));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(error);
      }
    });
  }

  onMessage(message) {
    this.transcript.push({ dir: 'S->C', message });
    if (message.type === 'response') this.responses.push(message);
    else if (message.type === 'event') this.events.push(message);
    else return;
    const entry = this.pending.get(message.request_seq);
    if (entry) {
      this.pending.delete(message.request_seq);
      entry.resolve(message);
    }
    const kind = message.type === 'event' ? 'event' : 'response';
    this.waiters = this.waiters.filter(waiter => {
      if (waiter.kind !== kind || !waiter.predicate(message)) return true;
      waiter.resolve(message);
      return false;
    });
  }

  waitFor(kind, predicate, label) {
    const collection = kind === 'event' ? this.events : this.responses;
    const found = collection.find(predicate);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      let waiter;
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(entry => entry !== waiter);
        reject(new Error(`Timed out waiting for ${label}`));
      }, 8000);
      waiter = {
        kind,
        predicate,
        resolve: value => { clearTimeout(timer); resolve(value); }
      };
      this.waiters.push(waiter);
    });
  }

  waitForEvent(event, predicate = () => true, label = `event ${event}`) {
    return this.waitFor('event', message => message.event === event && predicate(message), label);
  }

  waitForResponse(predicate, label) {
    return this.waitFor('response', predicate, label);
  }
}

function startServer(t, extraEnv = {}) {
  const child = spawn(process.execPath, [serverPath, '--stdio'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
    detached: process.platform !== 'win32'
  });
  const client = new DapClient(child);
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }
    await withTimeout(client.exited, 'test cleanup', 1500).catch(() => {});
  });
  return client;
}

async function finish(client) {
  const response = await client.request('disconnect', { terminateDebuggee: true });
  assert.equal(response.success, true, response.message);
  const exit = await withTimeout(client.exited, 'clean server exit', 3000);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(client.stderr, '');
  assert.deepEqual(client.readerErrors, []);
}

// Render the recorded frames with the real Content-Length each one carried.
function renderTranscript(client) {
  return client.transcript.map(({ dir, message }) => {
    const json = JSON.stringify(message);
    return `${dir} Content-Length: ${Buffer.byteLength(json, 'utf8')}\\r\\n\\r\\n${json}`;
  }).join('\n');
}

async function initialize(client) {
  const init = await client.request('initialize', { adapterID: 'opurom', pathFormat: 'path' });
  assert.equal(init.success, true, init.message);
  await client.waitForEvent('initialized');
  return init;
}

async function runSession(t, options) {
  const {
    coreBinary,
    missingBinary = null,
    condition = 'count == 2',
    steps = ['tap 4', 'tap 4', 'tap 4'],
    expectedCount = '2'
  } = options;
  const client = startServer(t);
  const initialize = await client.request('initialize', {
    clientID: 'opurom-test',
    adapterID: 'opurom',
    pathFormat: 'path',
    linesStartAt1: true,
    columnsStartAt1: true
  });
  assert.equal(initialize.success, true, initialize.message);
  assert.equal(initialize.body.supportsConfigurationDoneRequest, true);
  assert.equal(initialize.body.supportsEvaluateForHovers, true);
  assert.equal(initialize.body.supportsConditionalBreakpoints, true);
  await client.waitForEvent('initialized');

  if (missingBinary) {
    const failed = await client.request('launch', {
      program: irPath,
      steps,
      coreBinary: missingBinary
    });
    assert.equal(failed.success, false);
    assert.match(failed.message, /opurom-core binary is missing or not executable/);
    assert.equal(failed.body.error.id, 1001);
    const alive = await client.request('threads');
    assert.equal(alive.success, true);
  }

  const launch = await client.request('launch', { program: irPath, steps, coreBinary });
  assert.equal(launch.success, true, launch.message);
  const breakpoints = await client.request('setBreakpoints', {
    source: { path: irPath },
    breakpoints: [{ condition }, { condition: 'count = 2' }]
  });
  assert.equal(breakpoints.success, true);
  assert.equal(breakpoints.body.breakpoints.length, 2);
  assert.equal(breakpoints.body.breakpoints[0].verified, true);
  assert.equal(breakpoints.body.breakpoints[1].verified, false);

  const configured = await client.request('configurationDone');
  assert.equal(configured.success, true, configured.message);
  const stopped = await client.waitForEvent(
    'stopped',
    message => message.body.reason === 'breakpoint',
    'breakpoint stopped event'
  );
  assert.equal(stopped.body.text, condition);
  assert.equal(stopped.body.condition, condition);
  assert.equal(stopped.body.threadId, 1);
  assert.equal(stopped.body.stateVersion, Number(expectedCount));
  assert.deepEqual(stopped.body.hitBreakpointIds, [breakpoints.body.breakpoints[0].id]);

  const threads = await client.request('threads');
  assert.deepEqual(threads.body.threads, [{ id: 1, name: 'OPUROM kernel' }]);
  const stack = await client.request('stackTrace', { threadId: 1 });
  assert.equal(stack.body.stackFrames.length, 1);
  assert.equal(stack.body.stackFrames[0].source.path, irPath);
  const scopes = await client.request('scopes', { frameId: 1 });
  assert.equal(scopes.body.scopes[0].variablesReference, 1);
  assert.equal(scopes.body.scopes[0].namedVariables, 1);
  const variables = await client.request('variables', { variablesReference: 1 });
  const count = variables.body.variables.find(variable => variable.name === 'count');
  assert.ok(count);
  assert.equal(count.value, expectedCount);
  assert.equal(count.type, 'number');
  assert.equal(variables.body.stateVersion, Number(expectedCount));

  const evaluated = await client.request('evaluate', { expression: 'count', context: 'hover' });
  assert.equal(evaluated.success, true, evaluated.message);
  assert.equal(evaluated.body.result, expectedCount);
  const unknown = await client.request('notARequest');
  assert.equal(unknown.success, false);
  assert.match(unknown.message, /Unknown DAP request: notARequest/);

  const eventCount = client.events.length;
  const continued = await client.request('continue', { threadId: 1 });
  assert.equal(continued.success, true, continued.message);
  await client.waitForEvent(
    'continued',
    message => client.events.indexOf(message) >= eventCount,
    'continued after continue'
  );
  await client.waitForEvent('terminated', () => true, 'terminated event');
  await finish(client);
  return { stopped, variables };
}

test('condition grammar evaluates numeric kernel state', () => {
  const state = { count: 3 };
  const cases = [
    ['count == 3', true],
    ['count != 3', false],
    ['count > 2.5', true],
    ['count < 3', false],
    ['count >= 3', true],
    ['count <= -1', false]
  ];
  for (const [text, expected] of cases) {
    const condition = parseCondition(text);
    assert.ok(condition, text);
    assert.equal(matchesCondition(condition, state), expected, text);
  }
  assert.equal(parseCondition('count = 3'), null);
  assert.equal(parseCondition('count == nope'), null);
  assert.equal(matchesCondition(parseCondition('missing == 3'), state), false);
});

test('kernel output lines expose state and patch arrays', () => {
  assert.deepEqual(parseKernelLine('state [{"name":"count","value":2}] version 2'), {
    kind: 'state',
    entries: [{ name: 'count', value: 2 }],
    version: 2
  });
  assert.deepEqual(parseKernelLine('patches [{"name":"count","value":3}] version 3'), {
    kind: 'patches',
    entries: [{ name: 'count', value: 3 }],
    version: 3
  });
  assert.equal(parseKernelLine('error: unknown command'), null);
});

test('full DAP session stops on kernel state and exits cleanly', async t => {
  await runSession(t, { coreBinary: sessionCore });
});

test('full DAP session is self-contained with a stub kernel', async t => {
  await runSession(t, {
    coreBinary: stubCore,
    condition: 'count == 1',
    steps: ['tap 4', 'tap 4'],
    expectedCount: '1'
  });
});

test('missing core returns an error, then a stub core recovers the server', async t => {
  await runSession(t, {
    coreBinary: stubCore,
    missingBinary: missingCore,
    condition: 'count == 1',
    steps: ['tap 4'],
    expectedCount: '1'
  });
});

test('malformed frames and unknown requests do not kill the server', async t => {
  const client = startServer(t);
  client.child.stdin.write('Content-Length: 5\r\n\r\n{bad}');
  client.child.stdin.write('Not-A-Length: 0\r\n\r\n');
  await client.waitForResponse(
    () => client.responses.filter(response =>
      response.success === false && response.request_seq === 0
    ).length >= 2,
    'two malformed frame errors'
  );
  const frameErrors = client.responses.filter(response =>
    response.success === false && response.request_seq === 0
  );
  assert.ok(frameErrors.some(response => /valid JSON/.test(response.message)));
  assert.ok(frameErrors.some(response => /Content-Length/.test(response.message)));
  assert.equal(frameErrors[0].body.error.id, 1002);

  const initialize = await client.request('initialize', { adapterID: 'opurom-test' });
  assert.equal(initialize.success, true, initialize.message);
  const unknown = await client.request('doesNotExist');
  assert.equal(unknown.success, false);
  assert.match(unknown.message, /Unknown DAP request: doesNotExist/);
  const threads = await client.request('threads');
  assert.equal(threads.success, true);
  await finish(client);
});

test('initialize advertises the full R9 DAP capability set', async t => {
  const client = startServer(t);
  const init = await initialize(client);
  assert.deepEqual(init.body, CAPABILITIES);
  for (const key of [
    'supportsSetVariable', 'supportsVariablePaging', 'supportsExceptionFilterOptions',
    'supportsEvaluateExpressions', 'supportsStepInOutRequests', 'supportsVerifiedSourceBreakpoints'
  ]) {
    assert.equal(init.body[key], true, key);
  }
  assert.deepEqual(init.body.exceptionBreakpointFilters.map(entry => entry.filter), ['all', 'uncaught']);
  await finish(client);
});

test('expression evaluator computes arithmetic and validates input', () => {
  const state = { count: 4, label: 'ok', flag: true };
  assert.equal(evaluateExpression('count + 1', state), 5);
  assert.equal(evaluateExpression('count * 2 + 1', state), 9);
  assert.equal(evaluateExpression('(count - 2) * 3', state), 6);
  assert.equal(evaluateExpression('count / 2', state), 2);
  assert.equal(evaluateExpression('-count + 10', state), 6);
  assert.equal(evaluateExpression('count >= 4', state), true);
  assert.equal(evaluateExpression('count != 4', state), false);
  assert.equal(evaluateExpression('label', state), 'ok');
  assert.equal(evaluateExpression('flag', state), true);
  assert.throws(() => evaluateExpression('missing + 1', state), /unknown state name/);
  assert.throws(() => evaluateExpression('count +', state), /unexpected token/);
  assert.throws(() => evaluateExpression('count garbage', state), /unexpected trailing input/);
  assert.throws(() => evaluateExpression('1 / 0', state), /non-finite result/);
  assert.throws(() => evaluateExpression('', state), /non-empty string/);
  assert.deepEqual(parseVariableValue('42', 4), { value: 42 });
  assert.deepEqual(parseVariableValue('hello', 'x'), { value: 'hello' });
  assert.match(parseVariableValue('nope', 4).error, /expected number/);
  assert.match(parseVariableValue('true', 4).error, /expected number/);
  assert.equal(valueKind(null), 'null');
});

test('evaluate computes arithmetic expressions over live state', async t => {
  const client = startServer(t);
  await initialize(client);
  const launch = await client.request('launch', {
    program: irPath, steps: ['tap 4', 'tap 4', 'tap 4'], coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);
  await client.request('setBreakpoints', { source: { path: irPath }, breakpoints: [{ condition: 'count == 2' }] });
  await client.request('configurationDone');
  const stopped = await client.waitForEvent('stopped', m => m.body.reason === 'breakpoint', 'breakpoint hit');
  assert.equal(stopped.body.stateVersion, 2);
  const cases = [
    ['count', '2', 'number'],
    ['count + 1', '3', 'number'],
    ['count * 2 + 1', '5', 'number'],
    ['(count - 1) * 3', '3', 'number'],
    ['count == 2', 'true', 'boolean'],
    ['count > 5', 'false', 'boolean']
  ];
  for (const [expression, result, type] of cases) {
    const response = await client.request('evaluate', { expression, context: 'repl' });
    assert.equal(response.success, true, `${expression}: ${response.message}`);
    assert.equal(response.body.result, result, expression);
    assert.equal(response.body.type, type, expression);
  }
  for (const expression of ['count +', 'unknown + 1', '1 / 0', '']) {
    const response = await client.request('evaluate', { expression, context: 'repl' });
    assert.equal(response.success, false, expression);
    assert.equal(response.body.error.id, 2002, expression);
    assert.match(response.message, /Bad expression/);
  }
  const alive = await client.request('threads');
  assert.equal(alive.success, true);
  await finish(client);
});

test('setVariable mutates live state and rejects invalid values', async t => {
  const client = startServer(t);
  await initialize(client);
  const launch = await client.request('launch', {
    program: irPath, steps: ['tap 4', 'tap 4', 'tap 4'], coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);
  await client.request('setBreakpoints', { source: { path: irPath }, breakpoints: [{ condition: 'count == 2' }] });
  await client.request('configurationDone');
  await client.waitForEvent('stopped', m => m.body.reason === 'breakpoint', 'breakpoint hit');
  const set = await client.request('setVariable', { variablesReference: 1, name: 'count', value: '42' });
  assert.equal(set.success, true, set.message);
  assert.equal(set.body.value, '42');
  assert.equal(set.body.type, 'number');
  const vars = await client.request('variables', { variablesReference: 1 });
  assert.equal(vars.body.variables.find(v => v.name === 'count').value, '42');
  assert.equal(vars.body.stateVersion, 3);
  const evaluated = await client.request('evaluate', { expression: 'count + 8' });
  assert.equal(evaluated.body.result, '50');
  const invalid = [
    { variablesReference: 1, name: 'count', value: 'not-a-number' },
    { variablesReference: 1, name: 'missing', value: '1' },
    { variablesReference: 99, name: 'count', value: '1' },
    { variablesReference: 1, name: 'count', value: 12 }
  ];
  for (const args of invalid) {
    const response = await client.request('setVariable', args);
    assert.equal(response.success, false, JSON.stringify(args));
    assert.equal(response.body.error.id, 2001, JSON.stringify(args));
  }
  const alive = await client.request('threads');
  assert.equal(alive.success, true);
  await finish(client);
});

test('variables paging returns slices and rejects out-of-range pages', async t => {
  const client = startServer(t);
  await initialize(client);
  const launch = await client.request('launch', { program: multiPath, steps: [], coreBinary: stubCore });
  assert.equal(launch.success, true, launch.message);
  const names = async args => {
    const response = await client.request('variables', args);
    assert.equal(response.success, true, response.message);
    return response.body.variables.map(v => v.name);
  };
  assert.deepEqual(await names({ variablesReference: 1 }), ['alpha', 'beta', 'gamma', 'delta']);
  assert.deepEqual(await names({ variablesReference: 1, start: 0, count: 2 }), ['alpha', 'beta']);
  assert.deepEqual(await names({ variablesReference: 1, start: 1, count: 2 }), ['beta', 'gamma']);
  assert.deepEqual(await names({ variablesReference: 1, start: 2 }), ['gamma', 'delta']);
  assert.deepEqual(await names({ variablesReference: 1, count: 0 }), []);
  const invalid = [
    { variablesReference: 1, start: 99 },
    { variablesReference: 1, count: -1 },
    { variablesReference: 1, start: -1 },
    { variablesReference: 1, start: 1.5 },
    { variablesReference: 5 }
  ];
  for (const args of invalid) {
    const response = await client.request('variables', args);
    assert.equal(response.success, false, JSON.stringify(args));
    assert.equal(response.body.error.id, 2003, JSON.stringify(args));
  }
  await finish(client);
});

test('setExceptionBreakpoints stores filters and reports unknown ones', async t => {
  const client = startServer(t);
  const init = await initialize(client);
  assert.equal(init.body.supportsExceptionFilterOptions, true);
  const ok = await client.request('setExceptionBreakpoints', { filters: ['all', 'uncaught'] });
  assert.equal(ok.success, true, ok.message);
  assert.deepEqual(ok.body.filters, ['all', 'uncaught']);
  const options = await client.request('setExceptionBreakpoints', { filterOptions: [{ filterId: 'all' }] });
  assert.equal(options.success, true, options.message);
  assert.deepEqual(options.body.filters, ['all']);
  const unknown = await client.request('setExceptionBreakpoints', { filters: ['bogus'] });
  assert.equal(unknown.success, false);
  assert.equal(unknown.body.error.id, 2004);
  assert.match(unknown.message, /Unknown exception breakpoint filter/);
  await client.request('setExceptionBreakpoints', { filters: ['all'] });
  const launch = await client.request('launch', { program: irPath, steps: ['bogus'], coreBinary: stubCore });
  assert.equal(launch.success, true, launch.message);
  await client.request('configurationDone');
  const stopped = await client.waitForEvent('stopped', m => m.body.reason === 'exception', 'exception stop');
  assert.deepEqual(stopped.body.filters, ['all']);
  assert.match(stopped.body.text, /unknown command/);
  await finish(client);
});

test('source breakpoints are verified and stopped events name file and line', async t => {
  const line4 = sourceLineOfNode(irPath, 4);
  const line3 = sourceLineOfNode(irPath, 3);
  assert.notEqual(line4, line3);
  const client = startServer(t);
  await initialize(client);
  const launch = await client.request('launch', {
    program: irPath, steps: ['tap 3', 'tap 4', 'tap 3'], coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);
  const sb = await client.request('setBreakpoints', {
    source: { path: irPath },
    breakpoints: [{ line: line4 }, { line: 99999 }]
  });
  assert.equal(sb.success, true);
  assert.equal(sb.body.breakpoints.length, 2);
  const good = sb.body.breakpoints[0];
  assert.equal(good.verified, true);
  assert.equal(good.line, line4);
  assert.equal(good.source.path, irPath);
  const bad = sb.body.breakpoints[1];
  assert.equal(bad.verified, false);
  assert.match(bad.message, /Unknown breakpoint/);
  const malformed = await client.request('setBreakpoints', {
    source: { path: irPath }, breakpoints: [{ line: 0 }]
  });
  assert.equal(malformed.success, false);
  assert.equal(malformed.body.error.id, 2004);
  await client.request('configurationDone');
  const stopped = await client.waitForEvent('stopped', m => m.body.reason === 'breakpoint', 'source hit');
  assert.equal(stopped.body.line, line4);
  assert.equal(stopped.body.source.path, irPath);
  assert.deepEqual(stopped.body.hitBreakpointIds, [good.id]);
  const stack = await client.request('stackTrace', { threadId: 1 });
  assert.equal(stack.body.stackFrames[0].line, line4);
  assert.equal(stack.body.stackFrames[0].source.path, irPath);
  await finish(client);
});

test('stepIn and stepOut advance real kernel steps', async t => {
  const client = startServer(t);
  await initialize(client);
  const launch = await client.request('launch', {
    program: irPath, steps: ['tap 4', 'tap 4', 'tap 4', 'tap 4'], coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);
  await client.request('setBreakpoints', { source: { path: irPath }, breakpoints: [{ condition: 'count == 1' }] });
  await client.request('configurationDone');
  await client.waitForEvent('stopped', m => m.body.reason === 'breakpoint', 'first hit');
  const line4 = sourceLineOfNode(irPath, 4);
  const stepIn = await client.request('stepIn', { threadId: 1 });
  assert.equal(stepIn.success, true, stepIn.message);
  const first = await client.waitForEvent(
    'stopped', m => m.body.reason === 'step' && m.body.stateVersion === 2, 'stepIn stop'
  );
  assert.match(first.body.description, /Stepped into/);
  assert.equal(first.body.line, line4);
  const stepOut = await client.request('stepOut', { threadId: 1 });
  assert.equal(stepOut.success, true, stepOut.message);
  const second = await client.waitForEvent(
    'stopped', m => m.body.reason === 'step' && m.body.stateVersion === 3, 'stepOut stop'
  );
  assert.match(second.body.description, /Stepped out/);
  assert.equal(second.body.line, line4);
  const cont = await client.request('continue', { threadId: 1 });
  assert.equal(cont.success, true, cont.message);
  await client.waitForEvent('terminated', () => true, 'terminated');
  await finish(client);
});

test('disconnect cleans up all sessions without leftover child processes', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-debug-'));
  const pidFile = path.join(tmp, 'pids.txt');
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
  const client = startServer(t, { OPR_PID_FILE: pidFile });
  await initialize(client);
  const first = await client.request('launch', { program: irPath, steps: ['tap 4'], coreBinary: stubCore });
  assert.equal(first.success, true, first.message);
  const second = await client.request('launch', { program: multiPath, steps: [], coreBinary: stubCore });
  assert.equal(second.success, true, second.message);
  const pids = fs.readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
  assert.equal(pids.length, 2, 'two kernel children were started');
  const disconnect = await client.request('disconnect', { terminateDebuggee: true });
  assert.equal(disconnect.success, true, disconnect.message);
  assert.equal(disconnect.body.sessionsClosed, 2);
  const exit = await withTimeout(client.exited, 'clean server exit', 3000);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(client.stderr, '');
  assert.deepEqual(client.readerErrors, []);
  const deadline = Date.now() + 3000;
  for (;;) {
    const alive = pids.filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (alive.length === 0) break;
    if (Date.now() > deadline) assert.fail(`leftover child processes: ${alive.join(', ')}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
});

test('full R9 DAP session flow produces a framed transcript', async t => {
  const client = startServer(t);
  const init = await initialize(client);
  assert.deepEqual(init.body, CAPABILITIES);
  await client.request('setExceptionBreakpoints', { filters: ['all'] });
  const launch = await client.request('launch', {
    program: irPath, steps: ['tap 4', 'tap 4', 'tap 4', 'tap 4'], coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);
  const sb = await client.request('setBreakpoints', {
    source: { path: irPath }, breakpoints: [{ condition: 'count == 1' }]
  });
  assert.equal(sb.body.breakpoints[0].verified, true);
  await client.request('configurationDone');
  const hit = await client.waitForEvent('stopped', m => m.body.reason === 'breakpoint', 'hit');
  assert.equal(hit.body.stateVersion, 1);
  const evaluated = await client.request('evaluate', { expression: 'count + 1', context: 'repl' });
  assert.equal(evaluated.body.result, '2');
  const set = await client.request('setVariable', { variablesReference: 1, name: 'count', value: '7' });
  assert.equal(set.success, true, set.message);
  assert.equal(set.body.value, '7');
  const stepIn = await client.request('stepIn', { threadId: 1 });
  assert.equal(stepIn.success, true, stepIn.message);
  await client.waitForEvent('stopped', m => m.body.reason === 'step' && m.body.stateVersion === 2, 'stepIn stop');
  const stepOut = await client.request('stepOut', { threadId: 1 });
  assert.equal(stepOut.success, true, stepOut.message);
  await client.waitForEvent('stopped', m => m.body.reason === 'step' && m.body.stateVersion === 3, 'stepOut stop');
  const cont = await client.request('continue', { threadId: 1 });
  assert.equal(cont.success, true, cont.message);
  await client.waitForEvent('terminated', () => true, 'terminated');
  const disconnect = await client.request('disconnect', { terminateDebuggee: true });
  assert.equal(disconnect.success, true, disconnect.message);
  assert.equal(disconnect.body.sessionsClosed, 1);
  const exit = await withTimeout(client.exited, 'clean server exit', 3000);
  assert.deepEqual(exit, { code: 0, signal: null });
  assert.equal(client.stderr, '');
  assert.deepEqual(client.readerErrors, []);
  const transcript = renderTranscript(client);
  for (const command of ['initialize', 'launch', 'setBreakpoints', 'configurationDone',
    'evaluate', 'setVariable', 'stepIn', 'stepOut', 'continue', 'disconnect']) {
    assert.ok(transcript.includes(`"command":"${command}"`), command);
  }
  assert.ok(transcript.includes('"event":"stopped"'));
  assert.ok(transcript.includes('"event":"terminated"'));
  // Opt-in only: writing an artifact never happens during a normal `node --test`.
  if (process.env.OPR_TRANSCRIPT_FILE) fs.writeFileSync(process.env.OPR_TRANSCRIPT_FILE, transcript);
});
