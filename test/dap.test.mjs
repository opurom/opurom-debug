import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFrameReader, encodeMessage } from '../lib/frame.mjs';
import { parseCondition, matchesCondition } from '../lib/conditions.mjs';
import { parseKernelLine } from '../lib/kernel.mjs';

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
      try {
        this.child.stdin.write(encodeMessage({
          seq,
          type: 'request',
          command,
          arguments: args
        }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(seq);
        reject(error);
      }
    });
  }

  onMessage(message) {
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

function startServer(t) {
  const child = spawn(process.execPath, [serverPath, '--stdio'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
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
