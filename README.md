# opurom-debug

An independent, zero-dependency Node project implementing the R3 DAP subset for OPUROM. It speaks
`Content-Length: N\r\n\r\n<JSON>` framing on stdio and drives the real `opurom-core` binary through
its stdin command protocol. There are no npm dependencies and no build step.

Run the adapter with:

```sh
node bin/server.mjs --stdio
```

The default core binary is the sibling `../opurom-core/target/debug/opurom-core`. A launch request
may override it with `coreBinary`.

## Launch arguments

| Argument | Meaning |
| --- | --- |
| `program` | Absolute path to an IR v0.1 JSON file. |
| `steps` | Array of core stdin commands, for example `["tap 4", "tap 4", "tap 4"]`. |
| `coreBinary` | Optional executable path for `opurom-core`; useful for tests and alternate builds. |

The adapter reads the initial `state [...]` line from the kernel, applies every `patches [...]` line
after a step, and returns `variables` from that live state map. A missing core binary produces a
DAP error response, and the server stays alive.

## DAP subset

Supported requests: `initialize`, `launch`, `setBreakpoints`, `configurationDone`, `threads`,
`stackTrace`, `scopes`, `variables`, `continue`, `next`, `pause`, and `disconnect`. Hover expressions
accept a state name or one simple condition. Unknown requests and malformed frames receive proper DAP
error responses without terminating the server.

Events: `initialized`, `stopped`, `continued`, and `terminated`. `initialize` advertises
`supportsConfigurationDoneRequest`, `supportsEvaluateForHovers`, and
`supportsConditionalBreakpoints`.

State-change breakpoints use the grammar `name OP number`, with `==`, `!=`, `>`, `<`, `>=`, and
`<=`. Conditions are evaluated against real kernel state after every step. The `stopped` event uses
reason `breakpoint` and reports the matched condition. `source.path` identifies the breakpoint set;
it does not map to source lines.

## Verify

```sh
node --test
```

The suite drives a complete framed DAP session against the counter IR and three `tap 4` steps. It
uses the real `opurom-core` debug binary when available, plus a checked-in protocol-compatible stub
so the suite stays self-contained. It also checks condition parsing, kernel output parsing, unknown
requests, malformed frame recovery, recovery from a missing core binary, and clean process exit.

## Honest scope

This is a DAP subset, not a full debugger. No GUI client tested. There are no real source
breakpoints, no watch expressions, no step-in/out, and no multi-thread debugging; those are R4+.
`next` advances one kernel command, and `pause` takes effect at a kernel command boundary. The VS
Code contribution is a descriptor only: no editor debug session has been exercised here.
