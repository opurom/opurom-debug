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

`initialize`, `launch`, `setBreakpoints`, `setExceptionBreakpoints`, `dataBreakpointInfo`,
`setDataBreakpoints`, `configurationDone`,
`threads`, `stackTrace`, `scopes`, `variables`, `setVariable`, `evaluate`, `completions`,
`exceptionInfo`, `opurom/frameStats`, `opurom/sessionLog`, `opurom/resourceStats`, `continue`, `next`, `stepIn`, `stepOut`,
`pause`,
`disconnect`. Unknown requests
and malformed frames get proper DAP error responses without terminating the server. Events:
`initialized`, `stopped`, `continued`, `terminated`.

`initialize` advertises the standard DAP capabilities `supportsConfigurationDoneRequest`,
`supportsEvaluateForHovers`, `supportsConditionalBreakpoints`,
`supportsHitConditionalBreakpoints`, `supportsSetVariable`, `supportsVariablePaging`,
`supportsExceptionFilterOptions`, `supportsCompletionsRequest`, `supportsExceptionInfoRequest`,
`supportsDataBreakpoints` and
`exceptionBreakpointFilters` (`all`, `uncaught`), plus five documented OPUROM extension flags
that DAP has no boolean for: `supportsEvaluateExpressions`, `supportsStepInOutRequests`,
`supportsVerifiedSourceBreakpoints`, `supportsFrameStatsRequest`, `supportsSessionLogRequest`.
`lib/capabilities.mjs` is the single source of truth; a test asserts a real framed `initialize`
response deep-equals it, and `bin/capabilities.mjs` prints the same object.

### Breakpoints

State-condition breakpoints use `name OP number` with `==`, `!=`, `>`, `<`, `>=`, `<=`, and are
evaluated against real kernel state after each step. The `stopped` event uses reason `breakpoint`
with the matched text and `hitBreakpointIds`.

Hit-count breakpoints use `hitCondition` as a positive integer, for example `"3"`. A hit is one
kernel step that matches the breakpoint's condition or source line; a breakpoint with only a hit
count is hit once per kernel step. The breakpoint pauses on that exact hit and stays silent
afterwards, including across `continue` and step requests. Conditions and hit counts can be
combined. Invalid hit counts (zero, negatives, non-integers or expressions such as `>= 3`) are
reported `verified: false` with an `Unsupported hit condition` message and never pause.

Source breakpoints set a `line` on the launched IR file's `source`. A line is `verified` only when
it declares an IR node id in the program text: the adapter builds a node-id to text-line map from
the IR JSON, and a core command such as `tap 4` runs the handler of node 4 on that line. A verified
source breakpoint fires when the kernel reaches that node's command; the `stopped` event names the
correct `source.path`, `line` and `hitBreakpointIds`, and `stackTrace` reports that line. Lines with
no executable node are reported `verified: false`. Malformed lines and unknown sources get typed
error responses.

`setExceptionBreakpoints` accepts `filters` and `filterOptions` (`all`, `uncaught`), stores them,
and an exception `stopped` event reports the armed filters. Unknown filters get a typed error.

### Data breakpoints

`dataBreakpointInfo` resolves a live state name to an opaque `dataId` (`state:<name>`) with
`accessTypes: ["write"]` and `canPersist: false`; an unknown name returns error 2001, an unknown
`variablesReference` error 2003, and a request before `launch` the generic request error.
`setDataBreakpoints` replaces the full watch set (an empty array clears it) and returns one
`Breakpoint` per entry: entries with an unknown `dataId`, an unknown state name or an access type
other than `write` come back `verified: false` with the reason, a malformed request gets error
2004. After each kernel step the adapter compares every watched name with its baseline; the first
value that moved produces a `stopped` event with reason `data breakpoint`, a description of the
form `State changed: <name>: <before> -> <after>` and the breakpoint id in `hitBreakpointIds`.
Kernel steps are the only writes observed: a `setVariable` edit advances the baseline instead of
firing, so the next stop reports the kernel's own write.

`exceptionInfo` reports the active kernel error recorded by the exception `stopped` event. Its
`exceptionId` names the first armed filter, or the kernel error text when no filter is armed;
`description` repeats the kernel error text, and `breakMode` is `alwaysHalted` while the exception
is active. When no exception is active, the response has an empty `exceptionId` and
`breakMode: neverHalted`.

### Expressions and variables

`scopes` requires a launched kernel and a `frameId` matching the sole stack frame (`1`). It returns
one `Kernel state` scope whose `namedVariables` reflects the live state; a following `variables`
request lists each state name with its current `value` and `type`, and those values track every step
and `continue`. An unknown or missing `frameId`, or a `scopes` request before `launch`, returns a
typed error (id 2005) rather than an empty success.

`evaluate` parses a safe arithmetic/comparison expression over live state: state names, numbers,
`+ - * / %`, parentheses, unary signs and `== != > < >= <=`. It never uses `eval`. For example
`count * 2 + 1`. A bare state name returns its current value; malformed expressions, unknown names
and non-finite results return a typed error and the server stays alive.

`completions` returns `CompletionItem` objects for state names accepted by `evaluateExpression`.
Each item carries `type: 'variable'` and a `detail` with the state value kind. `text` and `column`
select the identifier prefix at the caret; when both are omitted, the full list is returned. The
`column` base follows `columnsStartAt1` from `initialize`. Malformed `text` or `column` values
return error id 2002.

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

### Frame statistics

`opurom/frameStats` reports the step counters the adapter collects for the active kernel session:
`stepsPlanned` (commands queued at launch), `stepsExecuted` (commands the kernel answered),
`totalMs`, `lastStepMs` and `avgStepMs` (wall-clock duration of each kernel command as the adapter
times it), the derived `stepsPerSecond`, and the current kernel `stateVersion`. The counters come
from timing the adapter's own kernel commands, describe exactly the current session, and reset at
each `launch`. The request requires a launched kernel and returns a typed error before one.

## Resource accounting

`opurom/resourceStats` reports the kernel's plugin-result cache accounting for the running
session: `budget` (the configured byte budget), `usedBytes` (bytes currently cached), `entries`
(cached result count) and the current kernel `stateVersion`. The adapter reads it live over a
`resource` kernel command, so it reflects the running session rather than a local mirror. The
request requires a launched kernel and returns a typed error before one.

## Session log

`opurom/sessionLog` returns the kernel protocol lines the adapter has read for the currentsession in arrival order: `lines` is the exact sequence of `state [...]` and `patches [...]`
lines the kernel printed, plus any `error: ...` lines. `count` is the line total and
`stateVersion` is the current kernel version. The adapter stores the lines verbatim while it
parses them, so this request exposes the real kernel stream rather than a re-rendered summary
and needs no additional kernel command. The request requires a launched kernel and returns a
typed error before one; the log resets at each `launch`.

## Typed errors

| id | Meaning |
| --- | --- |
| 1001 | Generic request error. |
| 1002 | Malformed DAP frame. |
| 2001 | Invalid `setVariable` value or unknown variable. |
| 2002 | Bad `evaluate` expression or malformed `completions` arguments. |
| 2003 | Invalid / out-of-range `variables` page or unknown reference. |
| 2004 | Unknown or malformed breakpoint or exception filter. |
| 2005 | Unknown or missing `scopes` frame reference. |

## Verify

```sh
node --test
```

The suite drives real Content-Length-framed DAP sessions over stdio against the counter IR and a
multi-variable IR, using the real `opurom-core` debug binary when available plus a checked-in
protocol-compatible stub so it stays self-contained. It covers every request, the error paths (bad
expression, malformed completions arguments, invalid variable, invalid hit condition, unknown
breakpoint, out-of-range page), completion labels and prefix filtering, `exceptionInfo` with and
without an active exception, `opurom/frameStats` counters before launch, at a breakpoint stop and
after the final step, exact hit counts over several stub-kernel state changes, initialize
capability equality, data breakpoint stops on watched state writes (including a baseline moved by
`setVariable`), rejected data breakpoint ids and access types, session cleanup with no leftover
child processes, and a full
`initialize -> launch -> setBreakpoints -> configurationDone -> hit -> evaluate -> setVariable
-> stepIn -> stepOut -> continue -> disconnect` flow. Set `OPR_TRANSCRIPT_FILE` to write that full
framed transcript to a file for inspection.

## Scope

This is a DAP subset over IR state. The VS Code contribution in `../opurom-ide-plugins` is a
descriptor that points at this adapter.

`setVariable` edits the debugger's state mirror because the core stdin protocol has no set-state
command, so the next kernel step may overwrite the value. Source lines come from IR node-id
declarations in the program JSON, not from a compiled source map or an `.opu` text file. There is
a single thread and one stack frame, and `pause` takes effect at a kernel command boundary.
`launch` may be called more than once so all-session cleanup can be tested, but only one kernel
is active at a time. Hit counts accept exact positive integers only; DAP comparison expressions
such as `>= 3` are rejected with a diagnostic. A `setBreakpoints` call replaces a source's
breakpoints, which resets their hit counters.
