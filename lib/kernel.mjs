import fs from 'node:fs';
import { spawn } from 'node:child_process';

const OUTPUT_LINE = /^(state|patches)\s+(\[.*\])(?:\s+version\s+(\d+))?\s*$/;
const RESOURCE_LINE = /^resource\s+(\{.*\})(?:\s+version\s+(\d+))?\s*$/;
const LAYERS_LINE = /^layers\s+(\[.*\])(?:\s+version\s+(\d+))?\s*$/;
const NETWORK_LINE = /^network\s+(\[.*\])(?:\s+version\s+(\d+))?\s*$/;
const PAGES_LINE = /^pages\s+(\[.*\])(?:\s+version\s+(\d+))?\s*$/;
const TIMEOUT_MS = 5000;

export function parseKernelLine(line) {
  const trimmed = line.trim();
  const resource = RESOURCE_LINE.exec(trimmed);
  if (resource) {
    try {
      const stats = JSON.parse(resource[1]);
      if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return null;
      return {
        kind: 'resource',
        stats,
        version: resource[2] === undefined ? null : Number(resource[2]),
      };
    } catch {
      return null;
    }
  }
  const layers = LAYERS_LINE.exec(trimmed);
  if (layers) {
    try {
      const records = JSON.parse(layers[1]);
      if (!Array.isArray(records) || !records.every(record =>
        record && typeof record === 'object' && Object.hasOwn(record, 'id') && Object.hasOwn(record, 'kind')
      )) {
        return null;
      }
      return {
        kind: 'layers',
        records,
        version: layers[2] === undefined ? null : Number(layers[2]),
      };
    } catch {
      return null;
    }
  }
  const network = NETWORK_LINE.exec(trimmed);
  if (network) {
    try {
      const records = JSON.parse(network[1]);
      if (!Array.isArray(records) || !records.every(record =>
        record && typeof record === 'object' && typeof record.method === 'string' && typeof record.url === 'string'
      )) {
        return null;
      }
      return {
        kind: 'network',
        records,
        version: network[2] === undefined ? null : Number(network[2]),
      };
    } catch {
      return null;
    }
  }
  const pages = PAGES_LINE.exec(trimmed);
  if (pages) {
    try {
      const records = JSON.parse(pages[1]);
      if (!Array.isArray(records) || !records.every(name => typeof name === 'string')) return null;
      return { kind: 'pages', records, version: pages[2] === undefined ? null : Number(pages[2]) };
    } catch {
      return null;
    }
  }
  const match = OUTPUT_LINE.exec(trimmed);
  if (!match) return null;
  try {
    const entries = JSON.parse(match[2]);
    const valid = Array.isArray(entries) && entries.every(entry =>
      entry && typeof entry === 'object' && typeof entry.name === 'string' && Object.hasOwn(entry, 'value')
    );
    if (!valid) return null;
    return { kind: match[1], entries, version: match[3] === undefined ? null : Number(match[3]) };
  } catch {
    return null;
  }
}

export class KernelSession {
  constructor(binary, program) {
    this.binary = binary;
    this.program = program;
    this.state = {};
    this.version = 0;
    this.stderr = '';
    this.dead = false;
    this.child = null;
    this.pending = null;
    this.initial = null;
    this.lineBuffer = '';
    this.timer = null;
    // Every kernel protocol line the adapter parsed, in arrival order, so a
    // client can read the exact state/patches stream the kernel supplied.
    this.log = [];
    // Navigation signals (`@nav` patches) are not state: they are recorded in
    // order so a client can inspect the session's page navigation history.
    this.navigation = [];
    // Declared route names, read live from the kernel's `pages` command.
    this.pages = [];
  }

  start() {
    return new Promise((resolve, reject) => {
      try {
        fs.accessSync(this.binary, fs.constants.X_OK);
      } catch {
        reject(new Error(`opurom-core binary is missing or not executable: ${this.binary}`));
        return;
      }
      this.initial = { resolve, reject };
      try {
        this.child = spawn(this.binary, [this.program], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        this.initial = null;
        reject(new Error(`could not start opurom-core: ${error.message}`));
        return;
      }
      const child = this.child;
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', chunk => this.onStdout(chunk));
      child.stderr.on('data', chunk => this.recordStderr(chunk));
      child.on('error', error => this.fail(new Error(`could not start opurom-core: ${error.message}`)));
      child.on('close', (code, signal) => this.fail(
        new Error(`opurom-core exited before a response (code ${code}, signal ${signal || 'none'})`)
      ));
      this.timer = setTimeout(() => this.fail(new Error('opurom-core did not print its initial state')), TIMEOUT_MS);
    });
  }

  command(line) {
    if (this.dead || !this.child || !this.child.stdin.writable) {
      return Promise.reject(new Error('opurom-core is not running'));
    }
    if (this.pending) return Promise.reject(new Error('another opurom-core command is pending'));
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.timer = setTimeout(() => this.fail(new Error('opurom-core command timed out')), TIMEOUT_MS);
      try {
        this.child.stdin.write(`${line}\n`);
      } catch (error) {
        this.pending = null;
        clearTimeout(this.timer);
        this.timer = null;
        reject(error);
      }
    });
  }

  setState(name, value) {
    // shortcut: the core stdin protocol has no state write-back, so this edits
    // the debugger's state mirror only; the next kernel step may overwrite it.
    // Upgrade when opurom-core exposes a set-state command.
    this.state[name] = value;
    this.version += 1;
  }

  async quit() {
    clearTimeout(this.timer);
    this.timer = null;
    const child = this.child;
    if (!child) return;
    this.dead = true;
    await new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.stdin.end('quit\n');
      } catch {
        child.kill();
      }
    });
  }

  onStdout(chunk) {
    this.lineBuffer += chunk;
    for (;;) {
      const newline = this.lineBuffer.indexOf('\n');
      if (newline === -1) return;
      const line = this.lineBuffer.slice(0, newline).trim();
      this.lineBuffer = this.lineBuffer.slice(newline + 1);
      if (line) this.onLine(line);
    }
  }

  onLine(line) {
    if (line.startsWith('error:')) {
      this.log.push(line);
      this.rejectPending(new Error(line.slice(6).trim() || 'opurom-core command failed'));
      return;
    }
    const output = parseKernelLine(line);
    if (!output) {
      this.recordStderr(`${line}\n`);
      return;
    }
    this.log.push(line);
    if (output.kind === 'state') {
      const next = {};
      for (const entry of output.entries) next[entry.name] = entry.value;
      this.state = next;
    } else if (output.kind === 'pages') {
      this.pages = [...output.records];
    } else if (output.kind === 'patches') {
      for (const entry of output.entries) {
        // The kernel emits a reserved `@nav` patch for each navigation and
        // `@validate` for each form check; both are signals, not state fields,
        // so neither enters the state mirror. Navigation history is recorded.
        if (entry.name === '@nav') {
          this.navigation.push({ page: entry.value, version: output.version });
        } else if (entry.name !== '@validate') {
          this.state[entry.name] = entry.value;
        }
      }
    }
    if (output.version !== null) this.version = output.version;
    this.resolvePending(output);
  }

  resolvePending(output) {
    const target = this.pending || this.initial;
    if (!target) return;
    this.pending = null;
    if (this.initial) {
      this.initial = null;
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    target.resolve(output);
  }

  rejectPending(error) {
    const target = this.pending || this.initial;
    if (!target) return;
    this.pending = null;
    this.initial = null;
    clearTimeout(this.timer);
    this.timer = null;
    target.reject(error);
  }

  fail(error) {
    this.dead = true;
    clearTimeout(this.timer);
    this.timer = null;
    const detail = this.stderr.trim() ? `: ${this.stderr.trim()}` : '';
    this.rejectPending(new Error(`${error.message}${detail}`));
    if (this.child && !this.child.killed) this.child.kill();
  }

  recordStderr(text) {
    this.stderr = (this.stderr + text).slice(-8192);
  }
}
