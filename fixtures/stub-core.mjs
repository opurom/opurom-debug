#!/usr/local/bin/node
// Protocol-compatible test kernel: it interprets IR state instead of hardcoding values.
import fs from 'node:fs';
import readline from 'node:readline';

// Tests set OPR_PID_FILE to verify disconnect reaps every child process.
if (process.env.OPR_PID_FILE) {
  try {
    fs.appendFileSync(process.env.OPR_PID_FILE, `${process.pid}\n`);
  } catch {}
}

const program = process.argv[2];
if (!program) {
  console.error('error: missing IR path');
  process.exit(1);
}

let ir;
try {
  ir = JSON.parse(fs.readFileSync(program, 'utf8'));
} catch (error) {
  console.error(`error: cannot load IR: ${error.message}`);
  process.exit(1);
}
if (ir.ir !== '0.1' || !Array.isArray(ir.state) || !ir.tree) {
  console.error('error: invalid IR v0.1');
  process.exit(1);
}

const state = new Map(ir.state.map(entry => [entry.name, entry.init]));
const nodes = new Map();
function visit(node) {
  if (!node || typeof node !== 'object') return;
  nodes.set(Number(node.id), node);
  for (const child of node.children || []) visit(child);
}
visit(ir.tree);

let version = 0;
function snapshot() {
  return [...state].map(([name, value]) => ({ name, value }));
}
function printState() {
  console.log(`state ${JSON.stringify(snapshot())} version ${version}`);
}
function effectKinds(node) {
  const props = node.props || {};
  const kinds = [];
  if (Number.isFinite(props.shadow) && props.shadow > 0) kinds.push('shadow');
  if (props.glass === true) kinds.push('glass');
  if (String(props.gradient ?? '').includes(',')) kinds.push('gradient');
  if (Number.isFinite(props.opacity) && props.opacity < 1) kinds.push('opacity');
  for (const effect of Array.isArray(props.effects) ? props.effects : []) {
    if (typeof effect?.kind === 'string' && !kinds.includes(effect.kind)) kinds.push(effect.kind);
  }
  return kinds;
}
function collectLayers(node, out) {
  out.push({ id: Number(node.id), kind: node.kind, effects: effectKinds(node) });
  for (const child of node.children || []) collectLayers(child, out);
  return out;
}
function printLayers() {
  console.log(`layers ${JSON.stringify(collectLayers(ir.tree, []))} version ${version}`);
}
function actionsFor(handler) {
  if (Array.isArray(handler)) return handler;
  if (handler && Array.isArray(handler.actions)) return handler.actions;
  if (handler && typeof handler === 'object' && typeof handler.op === 'string') return [handler];
  return [];
}
function dispatch(eventName, nodeId, text) {
  const node = nodes.get(nodeId);
  if (!node) throw new Error(`unknown node ${nodeId}`);
  const actions = actionsFor(node.events?.[eventName]);
  if (actions.length === 0) throw new Error(`node ${nodeId} has no ${eventName} handler`);
  const patches = [];
  for (const action of actions) {
    // A push is a navigation signal: no state mutation, just the reserved
    // `@nav` patch the real kernel emits.
    if (action.op === 'push') {
      patches.push({ name: '@nav', value: action.target });
      continue;
    }
    // A validate is a built-in form signal, likewise reserved and state-free.
    if (action.op === 'validate') {
      patches.push({ name: '@validate', value: action.target });
      continue;
    }
    if (!state.has(action.target)) throw new Error(`unknown state ${action.target}`);
    let value;
    if (action.op === 'add' || action.op === 'sub') {
      const rhs = Number(action.valueFrom !== undefined ? state.get(action.valueFrom) : action.value);
      value = action.op === 'sub'
        ? state.get(action.target) - rhs
        : state.get(action.target) + rhs;
    }
    else if (action.op === 'toggle') value = !state.get(action.target);
    else if (action.op === 'set') {
      if (action.value !== undefined) value = action.value;
      else if (action.valueFrom !== undefined) value = state.get(action.valueFrom);
      else value = text;
    } else throw new Error(`unsupported action ${action.op}`);
    state.set(action.target, value);
    patches.push({ name: action.target, value });
  }
  version += 1;
  console.log(`patches ${JSON.stringify(patches)} version ${version}`);
}

printState();
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', raw => {
  const line = raw.trim();
  if (!line) return;
  if (line === 'quit') {
    input.close();
    return;
  }
  if (line === 'state') {
    printState();
    return;
  }
  if (line === 'resource') {
    // Mirror the real kernel: a fixed budget with no cached plugin results yet.
    console.log(`resource ${JSON.stringify({ budget: 65536, usedBytes: 0, entries: 0 })} version ${version}`);
    return;
  }
  if (line === 'layers') {
    printLayers();
    return;
  }
  if (line === 'network') {
    // Mirror the real kernel: one captured request through the network capability.
    console.log(`network ${JSON.stringify([{ method: 'GET', url: 'https://api.example.com/items', status: 200, requestBytes: 48, responseBytes: 64 }])} version ${version}`);
    return;
  }
  if (line === 'pages') {
    console.log(`pages ${JSON.stringify(Array.isArray(ir.pages) ? ir.pages : [])} version ${version}`);
    return;
  }
  const split = line.indexOf(' ');
  const command = split === -1 ? line : line.slice(0, split);
  const rest = split === -1 ? '' : line.slice(split + 1).trim();
  try {
    if (command === 'tap') {
      const id = Number(rest);
      if (!Number.isInteger(id)) throw new Error('tap expects `tap <id>`');
      dispatch('tap', id);
    } else if (command === 'input') {
      const match = /^(\d+)\s+(.*)$/.exec(rest);
      if (!match) throw new Error('input expects `input <id> <text>`');
      dispatch('input', Number(match[1]), match[2]);
    } else {
      throw new Error(`unknown command ${command}`);
    }
  } catch (error) {
    console.log(`error: ${error.message}`);
  }
});
