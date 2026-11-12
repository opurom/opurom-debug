#!/usr/bin/env node
// Print the DAP initialize response body as one line of JSON. The server sends
// this exact object (lib/capabilities.mjs is the single source of truth) and a
// test asserts a real framed initialize response equals it.
import { CAPABILITIES } from '../lib/capabilities.mjs';

process.stdout.write(`${JSON.stringify(CAPABILITIES)}\n`);
