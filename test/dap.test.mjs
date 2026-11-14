import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createFrameReader, encodeMessage } from '../lib/frame.mjs';
import { parseCondition, matchesCondition } from '../lib/conditions.mjs';
import { parseHitCount } from '../lib/hitcounts.mjs';
import { parseKernelLine } from '../lib/kernel.mjs';
import { CAPABILITIES, EXCEPTION_FILTERS } from '../lib/capabilities.mjs';
import { evaluateExpression, expressionIdentifiers, parseVariableValue, valueKind } from '../lib/expressions.mjs';

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

test('hit count grammar accepts exact positive counts', () => {
  assert.equal(parseHitCount('1'), 1);
  assert.equal(parseHitCount(' 3 '), 3);
  assert.equal(parseHitCount(4), 4);
  for (const value of ['0', '-1', '2.5', '>= 2', '', '3x', 'third',
    '99999999999999999999', null, undefined, true, 0, -2, 2.5]) {
    assert.equal(parseHitCount(value), null, String(value));
  }
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

test('initialize advertises the full DAP capability set', async t => {
  const client = startServer(t);
  const init = await initialize(client);
  assert.deepEqual(init.body, CAPABILITIES);
  for (const key of [
    'supportsSetVariable', 'supportsVariablePaging', 'supportsExceptionFilterOptions',
    'supportsCompletionsRequest', 'supportsExceptionInfoRequest',
    'supportsHitConditionalBreakpoints', 'supportsDataBreakpoints',
    'supportsEvaluateExpressions', 'supportsStepInOutRequests', 'supportsVerifiedSourceBreakpoints',
    'supportsFrameStatsRequest', 'supportsSessionLogRequest'
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

test('completions returns evaluatable state names and filters by prefix', async t => {
  const client = startServer(t);
  await initialize(client);
  const launch = await client.request('launch', { program: multiPath, steps: [], coreBinary: stubCore });
  assert.equal(launch.success, true, launch.message);
  const variables = await client.request('variables', { variablesReference: 1 });
  assert.equal(variables.success, true, variables.message);
  const state = Object.fromEntries(
    variables.body.variables.map(variable => [variable.name, Number(variable.value)])
  );
  const all = await client.request('completions');
  assert.equal(all.success, true, all.message);
  const labels = all.body.targets.map(target => target.label);
  assert.deepEqual(labels, expressionIdentifiers(state));
  for (const target of all.body.targets) {
    assert.equal(target.type, 'variable', target.label);
    assert.equal(target.detail, valueKind(state[target.label]), target.label);
    assert.doesNotThrow(() => evaluateExpression(target.label, state), target.label);
  }
  const alpha = await client.request('completions', { text: 'al', column: 3 });
  assert.equal(alpha.success, true, alpha.message);
  assert.deepEqual(alpha.body.targets.map(target => target.label), ['alpha']);
  const beta = await client.request('completions', { text: 'count + be', column: 11 });
  assert.equal(beta.success, true, beta.message);
  assert.deepEqual(beta.body.targets.map(target => target.label), ['beta']);
  const none = await client.request('completions', { text: 'z', column: 2 });
  assert.equal(none.success, true, none.message);
  assert.deepEqual(none.body.targets, []);
  const empty = await client.request('completions', { text: '', column: 1 });
  assert.equal(empty.success, true, empty.message);
  assert.deepEqual(empty.body.targets.map(target => target.label), labels);
  await finish(client);

  const zeroBased = startServer(t);
  await zeroBased.request('initialize', { adapterID: 'opurom', columnsStartAt1: false });
  const zeroLaunch = await zeroBased.request('launch', { program: multiPath, steps: [], coreBinary: stubCore });
  assert.equal(zeroLaunch.success, true, zeroLaunch.message);
  const gamma = await zeroBased.request('completions', { text: 'ga', column: 2 });
  assert.equal(gamma.success, true, gamma.message);
  assert.deepEqual(gamma.body.targets.map(target => target.label), ['gamma']);
  await finish(zeroBased);
});

test('malformed completions arguments return a typed error and keep the server alive', async t => {
  const client = startServer(t);
  await initialize(client);
  const launch = await client.request('launch', { program: multiPath, steps: [], coreBinary: stubCore });
  assert.equal(launch.success, true, launch.message);
  const invalid = [
    { text: 42, column: 1 },
    { text: 'a', column: '1' },
    { text: 'a', column: -1 },
    { text: 'a', column: 0 },
    { text: 'a', column: 99 },
    { column: 1 }
  ];
  for (const args of invalid) {
    const response = await client.request('completions', args);
    assert.equal(response.success, false, JSON.stringify(args));
    assert.equal(response.body.error.id, 2002, JSON.stringify(args));
    assert.match(response.message, /Bad completions/);
  }
  const alive = await client.request('threads');
  assert.equal(alive.success, true);
  await finish(client);
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

test('scopes lists typed live state that tracks every step and continue', async t => {
  const client = startServer(t);
  await initialize(client);
  const launch = await client.request('launch', {
    program: irPath,
    steps: ['tap 4', 'tap 4', 'tap 4', 'tap 4', 'tap 4'],
    coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);

  const scopes = await client.request('scopes', { frameId: 1 });
  assert.equal(scopes.success, true, scopes.message);
  assert.equal(scopes.body.scopes.length, 1);
  const scope = scopes.body.scopes[0];
  assert.equal(scope.name, 'Kernel state');
  assert.equal(scope.variablesReference, 1);
  assert.equal(scope.namedVariables, 1);
  assert.equal(scope.presentationHint, 'locals');

  const countAt = async () => {
    const response = await client.request('variables', { variablesReference: 1 });
    assert.equal(response.success, true, response.message);
    const count = response.body.variables.find(variable => variable.name === 'count');
    assert.ok(count);
    return { count, version: response.body.stateVersion };
  };

  let { count, version } = await countAt();
  assert.equal(count.value, '0');
  assert.equal(count.type, 'number');
  assert.equal(version, 0);

  for (let step = 1; step <= 3; step++) {
    const next = await client.request('next', { threadId: 1 });
    assert.equal(next.success, true, next.message);
    await client.waitForEvent(
      'stopped',
      message => message.body.reason === 'step' && message.body.stateVersion === step,
      `step ${step} stopped event`
    );
    ({ count, version } = await countAt());
    assert.equal(count.value, String(step), `count after step ${step}`);
    assert.equal(count.type, 'number');
    assert.equal(version, step);
  }

  const continued = await client.request('continue', { threadId: 1 });
  assert.equal(continued.success, true, continued.message);
  await client.waitForEvent('terminated', () => true, 'terminated after continue');
  ({ count, version } = await countAt());
  assert.equal(count.value, '5');
  assert.equal(count.type, 'number');
  assert.equal(version, 5);
  await finish(client);
});

test('scopes rejects unknown frame references and unlaunched sessions', async t => {
  const client = startServer(t);
  await initialize(client);

  const beforeLaunch = await client.request('scopes', { frameId: 1 });
  assert.equal(beforeLaunch.success, false);
  assert.equal(beforeLaunch.body.error.id, 1001);
  assert.match(beforeLaunch.message, /launch a kernel session/);
  assert.equal(beforeLaunch.body.scopes, undefined);

  const launch = await client.request('launch', {
    program: irPath, steps: ['tap 4'], coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);

  const valid = await client.request('scopes', { frameId: 1 });
  assert.equal(valid.success, true, valid.message);
  assert.equal(valid.body.scopes[0].namedVariables, 1);

  const invalidFrames = [
    { frameId: 999 },
    { frameId: 2 },
    { frameId: 0 },
    { frameId: -1 },
    { frameId: 1.5 },
    { frameId: 'x' },
    { frameId: null },
    {}
  ];
  for (const args of invalidFrames) {
    const response = await client.request('scopes', args);
    assert.equal(response.success, false, JSON.stringify(args));
    assert.equal(response.body.error.id, 2005, JSON.stringify(args));
    assert.match(response.message, /Unknown scopes frame reference/, JSON.stringify(args));
    assert.equal(response.body.scopes, undefined, JSON.stringify(args));
  }

  const alive = await client.request('threads');
  assert.equal(alive.success, true);
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

test('exceptionInfo reports active kernel exceptions and filter state', async t => {
  const client = startServer(t);
  await initialize(client);
  const idle = await client.request('exceptionInfo', { threadId: 1 });
  assert.equal(idle.success, true, idle.message);
  assert.equal(idle.body.exceptionId, '');
  assert.equal(idle.body.breakMode, 'neverHalted');
  assert.equal(typeof idle.body.description, 'string');

  const filter = EXCEPTION_FILTERS[1].filter;
  const armed = await client.request('setExceptionBreakpoints', { filters: [filter] });
  assert.equal(armed.success, true, armed.message);
  assert.deepEqual(armed.body.filters, [filter]);
  const launch = await client.request('launch', { program: irPath, steps: ['bogus'], coreBinary: stubCore });
  assert.equal(launch.success, true, launch.message);
  const configured = await client.request('configurationDone');
  assert.equal(configured.success, true, configured.message);
  const stopped = await client.waitForEvent('stopped', m => m.body.reason === 'exception', 'exception stop');
  assert.deepEqual(stopped.body.filters, [filter]);
  assert.match(stopped.body.text, /unknown command/);

  const active = await client.request('exceptionInfo', { threadId: 1 });
  assert.equal(active.success, true, active.message);
  assert.equal(typeof active.body.exceptionId, 'string');
  assert.ok(EXCEPTION_FILTERS.some(entry => entry.filter === active.body.exceptionId));
  assert.equal(active.body.exceptionId, filter);
  assert.equal(active.body.description, stopped.body.text);
  assert.equal(active.body.breakMode, 'alwaysHalted');

  const continued = await client.request('continue', { threadId: 1 });
  assert.equal(continued.success, true, continued.message);
  await client.waitForEvent('terminated', () => true, 'terminated after exception');
  const cleared = await client.request('exceptionInfo', { threadId: 1 });
  assert.equal(cleared.success, true, cleared.message);
  assert.equal(cleared.body.exceptionId, '');
  assert.equal(cleared.body.breakMode, 'neverHalted');
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

test('frameStats reports adapter-measured step timing for the session', async t => {
  const client = startServer(t);
  await initialize(client);
  const before = await client.request('opurom/frameStats', { threadId: 1 });
  assert.equal(before.success, false);
  assert.match(before.message, /launch a kernel session/);
  const launch = await client.request('launch', {
    program: irPath, steps: ['tap 4', 'tap 4', 'tap 4'], coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);
  await client.request('setBreakpoints', { source: { path: irPath }, breakpoints: [{ condition: 'count == 2' }] });
  await client.request('configurationDone');
  await client.waitForEvent('stopped', m => m.body.reason === 'breakpoint', 'breakpoint hit');
  const atStop = await client.request('opurom/frameStats', { threadId: 1 });
  assert.equal(atStop.success, true, atStop.message);
  assert.equal(atStop.body.stepsPlanned, 3);
  assert.equal(atStop.body.stepsExecuted, 2);
  assert.equal(atStop.body.stateVersion, 2);
  for (const field of ['totalMs', 'lastStepMs', 'avgStepMs', 'stepsPerSecond']) {
    const value = atStop.body[field];
    assert.equal(typeof value, 'number', field);
    assert.ok(Number.isFinite(value) && value >= 0, `${field}: ${value}`);
  }
  assert.ok(atStop.body.totalMs >= atStop.body.lastStepMs);
  assert.ok(Math.abs(atStop.body.avgStepMs - atStop.body.totalMs / 2) < 1e-9);
  const expectedRate = atStop.body.totalMs > 0 ? 2000 / atStop.body.totalMs : 0;
  assert.ok(Math.abs(atStop.body.stepsPerSecond - expectedRate) < 1e-6);
  const continued = await client.request('continue', { threadId: 1 });
  assert.equal(continued.success, true, continued.message);
  await client.waitForEvent('terminated', () => true, 'terminated');
  const final = await client.request('opurom/frameStats', { threadId: 1 });
  assert.equal(final.body.stepsExecuted, 3);
  assert.equal(final.body.stateVersion, 3);
  await finish(client);
});

test('resourceStats reports the kernel resource cache accounting live', async t => {
  const client = startServer(t);
  await initialize(client);
  const before = await client.request('opurom/resourceStats');
  assert.equal(before.success, false);
  assert.match(before.message, /launch a kernel session/);

  const launch = await client.request('launch', {
    program: irPath, steps: ['tap 4'], coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);
  const stats = await client.request('opurom/resourceStats');
  assert.equal(stats.success, true, stats.message);
  assert.equal(stats.body.budget, 65536);
  assert.equal(stats.body.usedBytes, 0);
  assert.equal(stats.body.entries, 0);
  assert.equal(stats.body.stateVersion, 0);

  await client.request('continue', { threadId: 1 });
  await client.waitForEvent('terminated', () => true, 'terminated');
  const after = await client.request('opurom/resourceStats');
  assert.equal(after.success, true, after.message);
  assert.equal(after.body.stateVersion, 1);
  // Deterministic: the same request twice yields identical accounting.
  const again = await client.request('opurom/resourceStats');
  assert.deepEqual(again.body, after.body);
  await finish(client);
});

test('disconnect cleans up all sessions without leftover child processes', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opurom-debug-'));
  const pidFile = path.join(tmp, 'pids.txt');  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} });
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

test('full DAP session flow produces a framed transcript', async t => {
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

test('exact hit count pauses on the third stub kernel state change', async t => {
  const client = startServer(t);
  await initialize(client);
  const launch = await client.request('launch', {
    program: irPath,
    steps: ['tap 4', 'tap 4', 'tap 4', 'tap 4', 'tap 4'],
    coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);
  const sb = await client.request('setBreakpoints', {
    source: { path: irPath }, breakpoints: [{ hitCondition: '3' }]
  });
  assert.equal(sb.success, true, sb.message);
  assert.equal(sb.body.breakpoints.length, 1);
  assert.equal(sb.body.breakpoints[0].verified, true);
  await client.request('configurationDone');
  const stopped = await client.waitForEvent(
    'stopped', m => m.body.reason === 'breakpoint', 'third hit'
  );
  assert.equal(stopped.body.stateVersion, 3);
  assert.match(stopped.body.description, /hit 3 times/);
  assert.equal(stopped.body.condition, undefined);
  assert.deepEqual(stopped.body.hitBreakpointIds, [sb.body.breakpoints[0].id]);
  const atStop = await client.request('variables', { variablesReference: 1 });
  assert.equal(atStop.body.variables.find(v => v.name === 'count').value, '3');
  assert.equal(client.events.filter(e => e.event === 'stopped' && e.body.reason === 'breakpoint').length, 1);
  const continued = await client.request('continue', { threadId: 1 });
  assert.equal(continued.success, true, continued.message);
  await client.waitForEvent('terminated', () => true, 'terminated after the exact hit');
  const final = await client.request('variables', { variablesReference: 1 });
  assert.equal(final.body.variables.find(v => v.name === 'count').value, '5');
  assert.equal(final.body.stateVersion, 5);
  assert.equal(client.events.filter(e => e.event === 'stopped' && e.body.reason === 'breakpoint').length, 1);
  await finish(client);
});

test('hit count with a state condition counts only matching states', async t => {
  const client = startServer(t);
  await initialize(client);
  const launch = await client.request('launch', {
    program: irPath,
    steps: ['tap 4', 'tap 4', 'tap 4', 'tap 4', 'tap 4'],
    coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);
  const sb = await client.request('setBreakpoints', {
    source: { path: irPath }, breakpoints: [{ condition: 'count >= 3', hitCondition: '2' }]
  });
  assert.equal(sb.body.breakpoints[0].verified, true, sb.body.breakpoints[0].message);
  await client.request('configurationDone');
  const stopped = await client.waitForEvent(
    'stopped', m => m.body.reason === 'breakpoint', 'second matching hit'
  );
  assert.equal(stopped.body.stateVersion, 4);
  assert.equal(stopped.body.condition, 'count >= 3');
  assert.match(stopped.body.description, /hit 2 times: count >= 3/);
  assert.deepEqual(stopped.body.hitBreakpointIds, [sb.body.breakpoints[0].id]);
  const atStop = await client.request('variables', { variablesReference: 1 });
  assert.equal(atStop.body.variables.find(v => v.name === 'count').value, '4');
  assert.equal(client.events.filter(e => e.event === 'stopped' && e.body.reason === 'breakpoint').length, 1);
  const continued = await client.request('continue', { threadId: 1 });
  assert.equal(continued.success, true, continued.message);
  await client.waitForEvent('terminated', () => true, 'terminated after later hits');
  const final = await client.request('variables', { variablesReference: 1 });
  assert.equal(final.body.variables.find(v => v.name === 'count').value, '5');
  assert.equal(client.events.filter(e => e.event === 'stopped' && e.body.reason === 'breakpoint').length, 1);
  await finish(client);
});

test('source line hit count pauses on its exact hit', async t => {
  const line4 = sourceLineOfNode(irPath, 4);
  const client = startServer(t);
  await initialize(client);
  const launch = await client.request('launch', {
    program: irPath, steps: ['tap 4', 'tap 4', 'tap 4'], coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);
  const sb = await client.request('setBreakpoints', {
    source: { path: irPath }, breakpoints: [{ line: line4, hitCondition: '2' }]
  });
  assert.equal(sb.body.breakpoints[0].verified, true, sb.body.breakpoints[0].message);
  await client.request('configurationDone');
  const stopped = await client.waitForEvent(
    'stopped', m => m.body.reason === 'breakpoint', 'second line hit'
  );
  assert.equal(stopped.body.line, line4);
  assert.equal(stopped.body.source.path, irPath);
  assert.equal(stopped.body.stateVersion, 1);
  assert.deepEqual(stopped.body.hitBreakpointIds, [sb.body.breakpoints[0].id]);
  const atStop = await client.request('variables', { variablesReference: 1 });
  assert.equal(atStop.body.variables.find(v => v.name === 'count').value, '1');
  const continued = await client.request('continue', { threadId: 1 });
  assert.equal(continued.success, true, continued.message);
  await client.waitForEvent('terminated', () => true, 'terminated after the third line hit');
  const final = await client.request('variables', { variablesReference: 1 });
  assert.equal(final.body.variables.find(v => v.name === 'count').value, '3');
  assert.equal(client.events.filter(e => e.event === 'stopped' && e.body.reason === 'breakpoint').length, 1);
  await finish(client);
});

test('invalid hit conditions are rejected with a diagnostic and never pause', async t => {
  const client = startServer(t);
  await initialize(client);
  const launch = await client.request('launch', {
    program: irPath, steps: ['tap 4', 'tap 4', 'tap 4'], coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);
  const breakpoints = [
    { hitCondition: '0' },
    { hitCondition: '-1' },
    { hitCondition: '2.5' },
    { hitCondition: '>= 2' },
    { hitCondition: '' },
    { hitCondition: 'third' },
    { hitCondition: '99999999999999999999' },
    { hitCondition: 2.5 },
    { hitCondition: true },
    { condition: 'count == 2', hitCondition: 'x' }
  ];
  const sb = await client.request('setBreakpoints', { source: { path: irPath }, breakpoints });
  assert.equal(sb.success, true, sb.message);
  assert.equal(sb.body.breakpoints.length, breakpoints.length);
  for (const bp of sb.body.breakpoints) {
    assert.equal(bp.verified, false, JSON.stringify(bp));
    assert.match(bp.message, /Unsupported hit condition/);
    assert.match(bp.message, /positive integer/);
  }
  await client.request('configurationDone');
  await client.waitForEvent('terminated', () => true, 'terminated with no accepted breakpoints');
  assert.equal(client.events.filter(e => e.event === 'stopped' && e.body.reason === 'breakpoint').length, 0);
  const final = await client.request('variables', { variablesReference: 1 });
  assert.equal(final.body.variables.find(v => v.name === 'count').value, '3');
  const alive = await client.request('threads');
  assert.equal(alive.success, true);
  await finish(client);
});

test('data breakpoints stop on kernel writes to a watched state name', async t => {
  const client = startServer(t);
  const init = await initialize(client);
  assert.equal(init.body.supportsDataBreakpoints, true);
  const beforeLaunch = await client.request('dataBreakpointInfo', { name: 'count' });
  assert.equal(beforeLaunch.success, false);
  assert.equal(beforeLaunch.body.error.id, 1001);
  assert.match(beforeLaunch.message, /launch a kernel session/);
  const launch = await client.request('launch', {
    program: irPath, steps: ['tap 4', 'tap 4', 'tap 4'], coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);

  const info = await client.request('dataBreakpointInfo', { name: 'count', variablesReference: 1 });
  assert.equal(info.success, true, info.message);
  assert.equal(info.body.dataId, 'state:count');
  assert.equal(info.body.description, 'count (kernel state value)');
  assert.deepEqual(info.body.accessTypes, ['write']);
  assert.equal(info.body.canPersist, false);
  const set = await client.request('setDataBreakpoints', {
    breakpoints: [{ dataId: info.body.dataId, accessType: 'write' }]
  });
  assert.equal(set.success, true, set.message);
  assert.equal(set.body.breakpoints.length, 1);
  assert.equal(set.body.breakpoints[0].verified, true, set.body.breakpoints[0].message);
  const breakpointId = set.body.breakpoints[0].id;
  assert.equal(typeof breakpointId, 'number');

  await client.request('configurationDone');
  const first = await client.waitForEvent(
    'stopped', m => m.body.reason === 'data breakpoint', 'first data stop'
  );
  assert.equal(first.body.stateVersion, 1);
  assert.equal(first.body.description, 'State changed: count: 0 -> 1');
  assert.equal(first.body.text, 'count: 0 -> 1');
  assert.deepEqual(first.body.hitBreakpointIds, [breakpointId]);

  // A debugger edit moves the baseline, so the next stop reports the kernel's
  // own write instead of the value the debugger replaced.
  const edited = await client.request('setVariable', { variablesReference: 1, name: 'count', value: '50' });
  assert.equal(edited.success, true, edited.message);
  const continued = await client.request('continue', { threadId: 1 });
  assert.equal(continued.success, true, continued.message);
  const second = await client.waitForEvent(
    'stopped', m => m.body.reason === 'data breakpoint' && m.body.stateVersion === 2, 'second data stop'
  );
  assert.equal(second.body.description, 'State changed: count: 50 -> 2');

  const cleared = await client.request('setDataBreakpoints', { breakpoints: [] });
  assert.equal(cleared.success, true, cleared.message);
  assert.deepEqual(cleared.body.breakpoints, []);
  const done = await client.request('continue', { threadId: 1 });
  assert.equal(done.success, true, done.message);
  await client.waitForEvent('terminated', () => true, 'terminated after clearing');
  assert.equal(
    client.events.filter(e => e.event === 'stopped' && e.body.reason === 'data breakpoint').length, 2
  );
  const variables = await client.request('variables', { variablesReference: 1 });
  assert.equal(variables.body.variables.find(v => v.name === 'count').value, '3');
  await finish(client);
});

test('data breakpoint validation rejects unknown ids and non-write access', async t => {
  const client = startServer(t);
  await initialize(client);
  const launch = await client.request('launch', {
    program: irPath, steps: ['tap 4', 'tap 4'], coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);
  const unknownName = await client.request('dataBreakpointInfo', { name: 'missing' });
  assert.equal(unknownName.success, false);
  assert.equal(unknownName.body.error.id, 2001);
  assert.match(unknownName.message, /Unknown state name for a data breakpoint/);
  const badReference = await client.request('dataBreakpointInfo', { name: 'count', variablesReference: 7 });
  assert.equal(badReference.success, false);
  assert.equal(badReference.body.error.id, 2003);
  assert.match(badReference.message, /Unknown variablesReference/);

  const requested = [
    { dataId: 'state:missing' },
    { dataId: 'other:count' },
    { dataId: 42 },
    {},
    { dataId: 'state:count', accessType: 'read' }
  ];
  const set = await client.request('setDataBreakpoints', { breakpoints: requested });
  assert.equal(set.success, true, set.message);
  assert.equal(set.body.breakpoints.length, requested.length);
  for (const breakpoint of set.body.breakpoints) {
    assert.equal(breakpoint.verified, false, JSON.stringify(breakpoint));
    assert.equal(typeof breakpoint.message, 'string');
  }
  assert.match(set.body.breakpoints[0].message, /Unknown state name for a data breakpoint/);
  assert.match(set.body.breakpoints[1].message, /Unknown data breakpoint id/);
  assert.match(set.body.breakpoints[2].message, /dataId from dataBreakpointInfo/);
  assert.match(set.body.breakpoints[3].message, /dataId from dataBreakpointInfo/);
  assert.match(set.body.breakpoints[4].message, /Unsupported access type/);
  const malformed = await client.request('setDataBreakpoints', {});
  assert.equal(malformed.success, false);
  assert.equal(malformed.body.error.id, 2004);

  await client.request('configurationDone');
  await client.waitForEvent('terminated', () => true, 'terminated with no data breakpoints');
  assert.equal(client.events.filter(e => e.event === 'stopped').length, 0);
  const alive = await client.request('threads');
  assert.equal(alive.success, true);
  await finish(client);
});

test('sessionLog returns the exact kernel protocol lines seen so far', async t => {
  const client = startServer(t);
  await initialize(client);
  const before = await client.request('opurom/sessionLog');
  assert.equal(before.success, false);
  assert.equal(before.body.error.id, 1001);
  assert.match(before.message, /launch a kernel session/);

  const launch = await client.request('launch', {
    program: irPath, steps: ['tap 4', 'tap 4', 'tap 4'], coreBinary: stubCore
  });
  assert.equal(launch.success, true, launch.message);
  const initial = await client.request('opurom/sessionLog');
  assert.equal(initial.success, true, initial.message);
  assert.equal(initial.body.count, 1);
  assert.equal(initial.body.stateVersion, 0);
  assert.deepEqual(initial.body.lines, ['state [{"name":"count","value":0}] version 0']);

  await client.request('setBreakpoints', { source: { path: irPath }, breakpoints: [{ condition: 'count == 2' }] });
  await client.request('configurationDone');
  await client.waitForEvent('stopped', m => m.body.reason === 'breakpoint', 'breakpoint hit');
  const atStop = await client.request('opurom/sessionLog');
  assert.equal(atStop.success, true, atStop.message);
  assert.equal(atStop.body.count, 3);
  assert.equal(atStop.body.stateVersion, 2);
  assert.deepEqual(atStop.body.lines, [
    'state [{"name":"count","value":0}] version 0',
    'patches [{"name":"count","value":1}] version 1',
    'patches [{"name":"count","value":2}] version 2'
  ]);

  // Repeating the request yields byte-identical lines: the stream is deterministic.
  const again = await client.request('opurom/sessionLog');
  assert.deepEqual(again.body, atStop.body);

  await client.request('continue', { threadId: 1 });
  await client.waitForEvent('terminated', () => true, 'terminated');
  const final = await client.request('opurom/sessionLog');
  assert.equal(final.body.count, 4);
  assert.equal(final.body.stateVersion, 3);
  assert.equal(final.body.lines[3], 'patches [{"name":"count","value":3}] version 3');
  await finish(client);
});

test('sessionLog records kernel error lines and resets on the next launch', async t => {
  const client = startServer(t);
  await initialize(client);
  const launch = await client.request('launch', { program: irPath, steps: ['bogus'], coreBinary: stubCore });
  assert.equal(launch.success, true, launch.message);
  await client.request('configurationDone');
  await client.waitForEvent('stopped', m => m.body.reason === 'exception', 'kernel error stop');
  const errored = await client.request('opurom/sessionLog');
  assert.equal(errored.success, true, errored.message);
  assert.equal(errored.body.count, 2);
  assert.deepEqual(errored.body.lines, [
    'state [{"name":"count","value":0}] version 0',
    'error: unknown command bogus'
  ]);

  const relaunch = await client.request('launch', {
    program: multiPath, steps: [], coreBinary: stubCore
  });
  assert.equal(relaunch.success, true, relaunch.message);
  const reset = await client.request('opurom/sessionLog');
  assert.equal(reset.success, true, reset.message);
  assert.equal(reset.body.count, 1);
  assert.deepEqual(reset.body.lines, [
    'state [{"name":"alpha","value":1},{"name":"beta","value":2},{"name":"gamma","value":3},{"name":"delta","value":4}] version 0'
  ]);
  await finish(client);
});
