# Race Arena – Scheduling Engine (backend)

`scheduler-engine.js` is a dependency-free JavaScript port of the scheduling behaviour in the original `scheduler.c`. It replaces the C/WebAssembly build for the static website: no server, database, Emscripten or `.wasm` file is needed.

The engine is independent of the UI. It never touches the DOM, HTML, CSS or form fields. It works in a browser (as the global `SchedulerEngine`) and in Node.js (`require`).

`scheduler.c` is kept unchanged as the original reference implementation. The test suite compiles it and compares it with the JavaScript engine (see [Tests](#tests)).

## Files

| File | Purpose |
| --- | --- |
| `scheduler-engine.js` | The engine (browser + Node, no dependencies) |
| `scheduler-engine.test.js` | Automated tests (Node's built-in test runner) |
| `README-BACKEND.md` | This document |
| `PROJECT-STATUS.md` | Hand-off notes for the next phase |
| `scheduler.c` | Original C program, unchanged, used as the reference |

## Quick start

```js
// Node.js
const SchedulerEngine = require('./scheduler-engine.js');

const out = SchedulerEngine.runSimulation({
  processes: [
    { id: 'P1', arrivalTime: 0, burstTime: 5 },
    { id: 'P2', arrivalTime: 1, burstTime: 3 }
  ],
  algorithms: ['FCFS', 'SJN', 'RR'], // optional, default is all three
  quantum: 2                         // required only when RR is selected
});

if (out.ok) {
  console.log(out.byAlgorithm.RR.summary.averageWaitingTime);
} else {
  console.log(out.errors);
}
```

## Functions

All functions are on the `SchedulerEngine` object. None of them throw for bad user input; they return `{ ok: false, errors: [...] }` instead.

| Function | Description |
| --- | --- |
| `runSimulation(request)` | Main entry point. Validates the request and runs the selected algorithms. |
| `runFCFS(processes, options?)` | Runs only FCFS. Returns one result object. |
| `runSJN(processes, options?)` | Runs only non-preemptive SJN. Returns one result object. |
| `runRoundRobin(processes, quantum, options?)` | Runs only Round Robin. Returns one result object. |
| `validateInput(request)` | Validates and normalizes a request without running it. |
| `verifyResult(result)` | Consistency checker. Returns an array of problem strings (empty = consistent). |

`options` for the single-algorithm helpers is `{ limits: {...} }` (optional).

Constants: `ALGORITHMS`, `DEFAULT_LIMITS`, `C_LIMITS`, `IDLE_LABEL` (`"IDLE"`).

## Input format

### `runSimulation(request)`

```js
{
  processes: [ { id: 'P1', arrivalTime: 0, burstTime: 5 }, ... ],  // required
  algorithms: ['FCFS', 'SJN', 'RR'],  // optional; array or a single string
  quantum: 2,                         // required only if RR is selected
  limits: { ... }                     // optional overrides, see Limits
}
```

**Processes**

| Field | Rule |
| --- | --- |
| `id` | Non-empty string (or finite number, converted to a string). Trimmed. Must be unique. `"IDLE"` (any case) is reserved. |
| `arrivalTime` | Integer `>= 0`. |
| `burstTime` | Integer `>= 1`. Zero and negative bursts are rejected (same as the C program). |

Integers may be given as numbers or as plain decimal strings (`"5"`, `" 5 "`, `"+5"`), so values read from form fields can be passed straight in. Decimals (`1.5`), exponent notation (`"1e3"`), hex (`"0x10"`), `NaN`, `Infinity`, `null`, booleans and empty strings are rejected.

The order of the `processes` array matters: it is the tie-break order (see [Scheduling rules](#scheduling-rules)) and the order of the per-process results.

**Algorithms** – accepted names (case-insensitive, spaces/underscores ignored): `FCFS`, `SJN`, `RR`, or `First Come First Served`, `Shortest Job Next`, `Round Robin`. Results are returned in the order requested; duplicates run once and add a warning.

**Quantum** – integer `>= 1`. It is ignored (not even validated) when RR is not selected.

### Limits

Defaults are larger than the C program's limits. Pass `limits` to override any of them.

| Limit | `DEFAULT_LIMITS` | `C_LIMITS` (original C values) |
| --- | --- | --- |
| `maxProcesses` | 2000 | 20 |
| `maxArrivalTime` | 1,000,000 | 1000 |
| `maxBurstTime` | 1,000,000 | 100 |
| `maxQuantum` | 1,000,000 | 100 |
| `maxEvents` | 200,000 | 3000 |

`maxEvents` bounds the timeline length (run, idle and context-switch events all count, as in C) so a huge Round Robin workload cannot freeze the page. To reproduce the C program exactly, pass `limits: SchedulerEngine.C_LIMITS`.

## Output format

### Success

```js
{
  ok: true,
  warnings: [],                       // e.g. DUPLICATE_ALGORITHM
  input: { processes: [...], quantum: 2 },   // the normalized input
  results: [ result, result, ... ],   // in requested order
  byAlgorithm: { FCFS: result, SJN: result, RR: result }  // only requested ones
}
```

Each `result`:

```js
{
  ok: true,
  algorithm: 'FCFS',                  // 'FCFS' | 'SJN' | 'RR'
  name: 'First Come First Served',
  quantum: null,                      // the quantum for RR, otherwise null
  gantt: [ ... ],                     // run + idle blocks only: use this to draw the chart
  events: [ ... ],                    // gantt + zero-length context_switch markers
  processes: [ ... ],                 // one record per process, in INPUT order
  summary: { ... }
}
```

**`gantt` event** (contiguous, starts at time 0, no gaps or overlaps):

```js
{ type: 'run',  process: 'P1', label: 'P1',   start: 0, end: 3, duration: 3 }
{ type: 'idle', process: null, label: 'IDLE', start: 3, end: 5, duration: 2 }
```

`label` is always safe to display. `type` tells you how to style it.

**`events` extra entry** (not in `gantt`):

```js
{ type: 'context_switch', process: 'P2', from: 'P1', to: 'P2', label: 'P1 -> P2', start: 5, end: 5, duration: 0 }
```

**`processes[i]`**

```js
{ id, arrivalTime, burstTime, firstStartTime, completionTime, turnaroundTime, waitingTime, responseTime }
```

- `turnaroundTime = completionTime - arrivalTime`
- `waitingTime = turnaroundTime - burstTime`
- `responseTime = firstStartTime - arrivalTime`

**`summary`**

| Field | Meaning |
| --- | --- |
| `averageWaitingTime`, `averageTurnaroundTime`, `averageResponseTime` | Sum divided by process count (unrounded numbers; format in the UI) |
| `cpuUtilization` | Percentage `100 * busyTime / totalTime`, range 0–100 |
| `contextSwitches` | See [Context switches](#context-switches) |
| `totalTime` | End of the last event (the timeline starts at 0) |
| `busyTime`, `idleTime` | Time executing / idle; they add up to `totalTime` |

Complete example (`runFCFS` for P1 0/3 and P2 5/2):

```json
{
  "ok": true,
  "algorithm": "FCFS",
  "name": "First Come First Served",
  "quantum": null,
  "gantt": [
    { "type": "run",  "process": "P1", "label": "P1",   "start": 0, "end": 3, "duration": 3 },
    { "type": "idle", "process": null, "label": "IDLE", "start": 3, "end": 5, "duration": 2 },
    { "type": "run",  "process": "P2", "label": "P2",   "start": 5, "end": 7, "duration": 2 }
  ],
  "events": [ "... same three events here (no context switches in this example) ..." ],
  "processes": [
    { "id": "P1", "arrivalTime": 0, "burstTime": 3, "firstStartTime": 0, "completionTime": 3, "turnaroundTime": 3, "waitingTime": 0, "responseTime": 0 },
    { "id": "P2", "arrivalTime": 5, "burstTime": 2, "firstStartTime": 5, "completionTime": 7, "turnaroundTime": 2, "waitingTime": 0, "responseTime": 0 }
  ],
  "summary": {
    "averageWaitingTime": 0,
    "averageTurnaroundTime": 2.5,
    "averageResponseTime": 0,
    "cpuUtilization": 71.42857142857143,
    "contextSwitches": 0,
    "totalTime": 7,
    "busyTime": 5,
    "idleTime": 2
  }
}
```

### Failure

```js
{
  ok: false,
  errors: [ { code, message, index?, field?, value?, algorithm? }, ... ],
  warnings: []
}
```

All input problems are collected in one pass (up to about 100, then a `TOO_MANY_ERRORS` entry). `index` is the position in the `processes` array and `field` names the property, so a UI can highlight the right row.

| Code | Meaning |
| --- | --- |
| `INVALID_INPUT` | Request is not an object |
| `PROCESSES_NOT_ARRAY`, `NO_PROCESSES`, `TOO_MANY_PROCESSES` | Problem with the process list |
| `INVALID_PROCESS` | An entry is not an object |
| `INVALID_ID`, `RESERVED_ID`, `DUPLICATE_ID` | Problem with an id |
| `INVALID_ARRIVAL_TIME`, `ARRIVAL_TIME_TOO_SMALL`, `ARRIVAL_TIME_TOO_LARGE` | Not a whole number / negative / above limit |
| `INVALID_BURST_TIME`, `BURST_TIME_TOO_SMALL`, `BURST_TIME_TOO_LARGE` | Not a whole number / zero or negative / above limit |
| `INVALID_QUANTUM`, `QUANTUM_TOO_SMALL`, `QUANTUM_TOO_LARGE` | Same checks for the RR quantum |
| `INVALID_ALGORITHMS`, `UNKNOWN_ALGORITHM` | Bad algorithm selection |
| `INVALID_LIMITS` | Bad `limits` override |
| `EVENT_LIMIT_EXCEEDED` | Timeline would exceed `maxEvents` (use a larger quantum or raise the limit) |
| `INTERNAL_CONSISTENCY_ERROR` | The built-in self-check failed (should never happen; please report it) |
| `INTERNAL_ERROR` | Unexpected exception inside an algorithm |
| `TOO_MANY_ERRORS` | Error list was cut off |

A simulation is **all-or-nothing**: if any requested algorithm cannot finish, no results are returned.

## Scheduling rules

These reproduce `scheduler.c`.

- **Timeline** starts at `t = 0`. If nothing has arrived yet, the CPU is idle until the first arrival, and that idle time counts against CPU utilization.
- **FCFS** – by arrival time. Tied arrivals keep input order.
- **SJN (non-preemptive)** – whenever the CPU is free, pick the arrived, unfinished process with the smallest burst. Ties: earlier arrival first, then the earlier position in the input array. A running job is never interrupted.
- **Round Robin** – FIFO ready queue, slice = `min(remaining, quantum)`. Every process that has arrived by the **end** of a slice (including exactly at the end) is queued **before** the preempted process is put back. Simultaneous arrivals keep input order.
- **Merged blocks** – if the same process runs again immediately (for example it is alone in the queue), the slices appear as one Gantt block.

### Context switches

A context switch is counted when one process stops and a **different** process starts at exactly the same instant. Not counted: the very first dispatch, a dispatch after an idle period, and a process continuing with its next slice. Each counted switch also appears as a zero-length `context_switch` entry in `events`.

### Where the C program is ambiguous or limited (documented, not changed)

1. **Context-switch definition** – the C code only counts back-to-back different processes (above). A stricter textbook definition (also counting dispatch from idle) would give different numbers. The engine keeps the C definition.
2. **Timeline starts at 0, not at the first arrival** – so a workload whose first arrival is at `t = 5` shows 5 idle units and utilization below 100%. Kept as in C.
3. **Round Robin tie rule** – arrivals at the exact end of a slice go before the preempted process. This is a convention (other textbooks do it the other way). Kept as in C; a test covers it.
4. **C event-capacity limit** – the C program stores at most 3000 timeline events (`MAX_EVENTS`). Some *valid* workloads exceed that. For example 20 processes, all arriving at 0 with burst 100, at quantum 1 need about 4000 events, and the C program reports a failed self-check for them. The JavaScript engine's default limit is higher, so it succeeds. `limits: SchedulerEngine.C_LIMITS` reproduces the C failure (`EVENT_LIMIT_EXCEEDED`). A test demonstrates this against the real C program.
5. **Process ids** – C always generates `P1…Pn`. The engine accepts your own ids and uses the array position (not the id text) for tie-breaking.

## Tests

Requires Node.js 18 or newer. There is nothing to install.

```bash
node --test scheduler-engine.test.js
```

Run the command in the folder that contains the three files. If `scheduler.c` is in the same folder and a C compiler (`gcc`, `cc` or `clang`) is on the PATH, the suite also compiles the original C program into a temporary folder and compares its output with the engine. Otherwise those tests are skipped and the rest still run.

What is covered:

- Hand-calculated expected output (Gantt, completion, turnaround, waiting, response, averages, utilization, context switches) for several workloads on all three algorithms
- Tied arrivals, tied bursts, SJN tie-breaks, idle gaps, leading idle, single-process workloads
- Round Robin queue ordering, merged slices, quantum 1, large quantum
- Invalid input: zero/negative/fractional/non-numeric values, missing fields, bad ids, bad quantum, bad algorithm names, limits, garbage input that must not throw
- 300 random workloads checked against independent invariants, 2000-process workload, event-limit guard
- Browser-style load in a bare JavaScript context (no `require`, no DOM)
- Differential test: 250 random workloads compared event-by-event with the original `scheduler.c`

## How the frontend should call the engine

Load the script before your own code:

```html
<script src="scheduler-engine.js"></script>
<script>
  function runFromForm(rows, quantumText, selected) {
    // rows: [{ id: 'P1', arrival: '0', burst: '5' }, ...]  <- values straight from inputs
    const out = SchedulerEngine.runSimulation({
      processes: rows.map(r => ({ id: r.id, arrivalTime: r.arrival, burstTime: r.burst })),
      algorithms: selected === 'all' ? ['FCFS', 'SJN', 'RR'] : [selected],
      quantum: quantumText
    });

    if (!out.ok) {
      // Show out.errors[i].message; use .index / .field to highlight the input.
      showErrors(out.errors);
      return;
    }

    for (const result of out.results) {
      drawGantt(result.algorithm, result.gantt);   // each event: start, end, duration, label, type
      fillMetrics(result.algorithm, result.summary);
      fillProcessTable(result.algorithm, result.processes);
    }
  }
</script>
```

Guidelines:

- Treat `ok === false` as the only error signal and display `errors[i].message`.
- Draw the chart from `gantt`; style `type === 'idle'` blocks differently; position blocks with `start` and `end`.
- The total chart width is `Math.max(...results.map(r => r.summary.totalTime))`, so several algorithms can share one time axis.
- Colour by process `id` (or its position in `out.input.processes`), not by parsing the id text.
- Round numbers only when displaying (for example `value.toFixed(2)`).
- Keep the engine calls out of rendering code. `runSimulation` is synchronous and fast (milliseconds for hundreds of processes).

### Mapping from the old C/WebAssembly `timeline.json`

| C JSON | Engine |
| --- | --- |
| `algorithms.FCFS / SJN / RR` | `byAlgorithm.FCFS / SJN / RR` |
| `events[]` (`type`, `process`, `start`, `end`, `duration`, `label`) | `events[]` (same names; `label` is now the short id, `IDLE`, or `P1 -> P2`) |
| `process_metrics[]` | `processes[]` |
| `arrival`, `burst` | `arrivalTime`, `burstTime` |
| `completion_time`, `turnaround_time`, `waiting_time`, `response_time` | `completionTime`, `turnaroundTime`, `waitingTime`, `responseTime` |
| `average_waiting_time`, `average_turnaround_time`, `average_response_time` | `summary.averageWaitingTime`, `summary.averageTurnaroundTime`, `summary.averageResponseTime` |
| `context_switches`, `total_time`, `cpu_utilization` | `summary.contextSwitches`, `summary.totalTime`, `summary.cpuUtilization` |
| `metadata.quantum` | `input.quantum` / `result.quantum` |
