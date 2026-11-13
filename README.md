# opurom-debug

An independent, zero-dependency Node project implementing an extended DAP subset for OPUROM. It
speaks `Content-Length: N\r\n\r\n<JSON>` framing on stdio and drives the real `opurom-core` binary
through its stdin command protocol. There are no npm dependencies and no build step.

Run the adapter with:

```sh
node bin/server.mjs --stdio
```

The default core binary is the sibling `../opurom-core/target/debug/opurom-core`. A launch request
may override it with `coreBinary`. Print the exact `initialize` response body as one line of JSON:

```sh
node bin/capabilities.mjs
```

## Launch arguments

| Argument | Meaning |
| --- | --- |
| `program` | Absolute path to an IR v0.1 JSON file. |
| `steps` | Array of core stdin commands, for example `["tap 4", "tap 4", "tap 4"]`. |
| `coreBinary` | Optional executable path for `opurom-core`; useful for tests and alternate builds. |

The adapter reads the initial `state [...]` line from the kernel, applies every `patches [...]` line
after a step, and returns `variables` from that live state map. A missing core binary produces a
DAP error response, and the server stays alive.

## Supported requests

`initialize`, `launch`, `setBreakpoints`, `setExceptionBreakpoints`, `configurationDone`,
`threads`, `stackTrace`, `scopes`, `variables`, `setVariable`, `evaluate`, `continue`, `next`,
`stepIn`, `stepOut`, `pause`, `disconnect`. Unknown requests and malformed frames get proper DAP
error responses without terminating the server. Events: `initialized`, `stopped`, `continued`,
`terminated`.

`initialize` advertises the standard DAP capabilities `supportsConfigurationDoneRequest`,
`supportsEvaluateForHovers`, `supportsConditionalBreakpoints`, `supportsSetVariable`,
`supportsVariablePaging`, `supportsExceptionFilterOptions` and `exceptionBreakpointFilters`
(`all`, `uncaught`), plus three documented OPUROM extension flags that DAP has no boolean for:
`supportsEvaluateExpressions`, `supportsStepInOutRequests`, `supportsVerifiedSourceBreakpoints`.
`lib/capabilities.mjs` is the single source of truth; a test asserts a real framed `initialize`
response deep-equals it, and `bin/capabilities.mjs` prints the same object.

### Breakpoints

State-condition breakpoints use `name OP number` with `==`, `!=`, `>`, `<`, `>=`, `<=`, and are
evaluated against real kernel state after each step. The `stopped` event uses reason `breakpoint`
with the matched text and `hitBreakpointIds`.

Source breakpoints set a `line` on the launched IR file's `source`. A line is `verified` only when
it declares an IR node id in the program text: the adapter builds a node-id to text-line map from
the IR JSON, and a core command such as `tap 4` runs the handler of node 4 on that line. A verified
source breakpoint fires when the kernel reaches that node's command; the `stopped` event names the
correct `source.path`, `line` and `hitBreakpointIds`, and `stackTrace` reports that line. Lines with
no executable node are reported `verified: false`. Malformed lines and unknown sources get typed
error responses.

`setExceptionBreakpoints` accepts `filters` and `filterOptions` (`all`, `uncaught`), stores them,
and an exception `stopped` event reports the armed filters. Unknown filters get a typed error.

### Expressions and variables

`evaluate` parses a safe arithmetic/comparison expression over live state: state names, numbers,
`+ - * / %`, parentheses, unary signs and `== != > < >= <=`. It never uses `eval`. For example
`count * 2 + 1`. A bare state name returns its current value; malformed expressions, unknown names
and non-finite results return a typed error and the server stays alive.

`setVariable` mutates a live state value by name. The new `value` string is decoded without
changing the variable's type; an unknown name, wrong type or non-finite number returns a typed
error. `variables` supports `start`/`count` paging; an invalid or out-of-range page returns a typed
error.

### Stepping and shutdown

`next`, `stepIn` and `stepOut` each advance exactly one kernel command and emit a real `stopped`
event with reason `step`, the current source line and the new `stateVersion`. `continue` runs the
remaining commands. IR-state debugging has one frame and no call stack, so step-in and step-out
have nothing deeper to enter and only the top frame to leave; they are single real steps, not
no-ops.

`disconnect` terminates every kernel session the adapter created (the response reports
`sessionsClosed`), clears state and exits cleanly. The suite verifies no child process is left
behind.

## Typed errors

| id | Meaning |
| --- | --- |
| 1001 | Generic request error. |
| 1002 | Malformed DAP frame. |
| 2001 | Invalid `setVariable` value or unknown variable. |
| 2002 | Bad `evaluate` expression. |
| 2003 | Invalid / out-of-range `variables` page or unknown reference. |
| 2004 | Unknown or malformed breakpoint or exception filter. |

## Verify

```sh
node --test
```

The suite drives real Content-Length-framed DAP sessions over stdio against the counter IR and a
multi-variable IR, using the real `opurom-core` debug binary when available plus a checked-in
protocol-compatible stub so it stays self-contained. It covers every request, the error paths (bad
expression, invalid variable, unknown breakpoint, out-of-range page), session cleanup with no
leftover child processes, and a full `initialize -> launch -> setBreakpoints -> configurationDone
-> hit -> evaluate -> setVariable -> stepIn -> stepOut -> continue -> disconnect` flow. Set
`OPR_TRANSCRIPT_FILE` to write that full framed transcript to a file for inspection.

## Scope

This is a DAP subset over IR state. The VS Code contribution in `../opurom-ide-plugins` is a
descriptor that points at this adapter.

`setVariable` edits the debugger's state mirror because the core stdin protocol has no set-state
command, so the next kernel step may overwrite the value. Source lines come from IR node-id
declarations in the program JSON, not from a compiled source map or an `.opu` text file. There is
a single thread and one stack frame, and `pause` takes effect at a kernel command boundary.
`launch` may be called more than once so all-session cleanup can be tested, but only one kernel
is active at a time.
