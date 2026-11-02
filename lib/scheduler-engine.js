/**
 * scheduler-engine.js
 * ---------------------------------------------------------------------------
 * Race Arena - CPU scheduling engine (FCFS, SJN, Round Robin).
 *
 * A pure JavaScript port of the scheduling behaviour of the original C program
 * (scheduler.c). It has no dependencies, never touches the DOM, and runs
 * unchanged in a browser (<script src="scheduler-engine.js">, which exposes the
 * global `SchedulerEngine`) and in Node.js (`require('./scheduler-engine.js')`).
 *
 * Behaviour notes (all inherited from scheduler.c unless marked "JS"):
 *  - The timeline always starts at t = 0. If the first process arrives later,
 *    the leading gap is an idle event and counts against CPU utilization.
 *  - FCFS: order by arrival time; ties keep input order.
 *  - SJN (non-preemptive): among arrived, unfinished processes pick the
 *    smallest burst; ties -> earlier arrival; remaining ties -> input order.
 *  - Round Robin: FIFO ready queue. Processes that arrive up to and including
 *    the instant a slice ends are queued BEFORE the preempted process is
 *    re-queued. Simultaneous arrivals keep input order.
 *  - A "context switch" is counted only when one process stops and a DIFFERENT
 *    process starts at exactly the same instant. The very first dispatch and
 *    dispatches that follow an idle period are not counted. A process that
 *    continues into its next slice is merged into one Gantt block, no switch.
 *  - Response time = first CPU start - arrival. Waiting = turnaround - burst.
 *  - CPU utilization = 100 * busy time / total time (total time starts at 0).
 *  - JS: limits are configurable. The defaults are much larger than the C
 *    limits (20 processes, MAX_EVENTS 3000). Use `SchedulerEngine.C_LIMITS` to
 *    reproduce the C limits exactly, including its event-capacity failure.
 *
 * Public API: runSimulation, runFCFS, runSJN, runRoundRobin, validateInput,
 * verifyResult, plus the constants ALGORITHMS, DEFAULT_LIMITS, C_LIMITS,
 * IDLE_LABEL. See README-BACKEND.md.
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module !== null && module.exports) {
    module.exports = factory();
  } else {
    root.SchedulerEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ------------------------------------------------------------------ constants

  var IDLE_LABEL = 'IDLE';
  var MAX_REPORTED_ERRORS = 100;

  var ALGORITHMS = Object.freeze({
    FCFS: Object.freeze({ key: 'FCFS', name: 'First Come First Served' }),
    SJN: Object.freeze({ key: 'SJN', name: 'Shortest Job Next (non-preemptive)' }),
    RR: Object.freeze({ key: 'RR', name: 'Round Robin' })
  });

  var ALGORITHM_ALIASES = Object.freeze({
    FCFS: 'FCFS',
    FIRSTCOMEFIRSTSERVED: 'FCFS',
    SJN: 'SJN',
    SHORTESTJOBNEXT: 'SJN',
    RR: 'RR',
    ROUNDROBIN: 'RR'
  });

  /** Defaults used by the JS engine (deliberately larger than the C limits). */
  var DEFAULT_LIMITS = Object.freeze({
    maxProcesses: 2000,
    maxArrivalTime: 1000000,
    maxBurstTime: 1000000,
    maxQuantum: 1000000,
    maxEvents: 200000
  });

  /** The exact limits compiled into scheduler.c. */
  var C_LIMITS = Object.freeze({
    maxProcesses: 20,
    maxArrivalTime: 1000,
    maxBurstTime: 100,
    maxQuantum: 100,
    maxEvents: 3000
  });

  // ------------------------------------------------------------------- helpers

  function makeError(code, message, extra) {
    var e = { code: code, message: message };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k];
      }
    }
    return e;
  }

  /**
   * Strict integer parsing. Accepts safe-integer numbers and strings that are
   * nothing but an optional sign and decimal digits (like strtol with no
   * trailing garbage). Returns NaN for anything else.
   */
  function toInteger(value) {
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) return NaN;
      return value + 0; // turns -0 into 0
    }
    if (typeof value === 'string') {
      if (!/^\s*[+-]?\d+\s*$/.test(value)) return NaN;
      var n = Number(value.trim());
      return Number.isSafeInteger(n) ? n + 0 : NaN;
    }
    return NaN;
  }

  function isPlainObject(v) {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }

  function normalizeAlgorithmKey(value) {
    if (typeof value !== 'string') return null;
    var squashed = value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return Object.prototype.hasOwnProperty.call(ALGORITHM_ALIASES, squashed)
      ? ALGORITHM_ALIASES[squashed]
      : null;
  }

  // ---------------------------------------------------------------- validation

  /** Resolve the effective limits object, collecting errors for bad overrides. */
  function resolveLimits(overrides, errors) {
    var limits = {};
    var k;
    for (k in DEFAULT_LIMITS) limits[k] = DEFAULT_LIMITS[k];
    if (overrides === undefined || overrides === null) return limits;
    if (!isPlainObject(overrides)) {
      errors.push(makeError('INVALID_LIMITS', 'limits must be an object.', { field: 'limits' }));
      return limits;
    }
    for (k in overrides) {
      if (!Object.prototype.hasOwnProperty.call(overrides, k)) continue;
      if (!Object.prototype.hasOwnProperty.call(DEFAULT_LIMITS, k)) {
        errors.push(makeError('INVALID_LIMITS', 'Unknown limit "' + k + '".', { field: 'limits.' + k }));
        continue;
      }
      var v = toInteger(overrides[k]);
      if (!(v >= 1)) {
        errors.push(makeError('INVALID_LIMITS', 'limits.' + k + ' must be an integer >= 1.', { field: 'limits.' + k }));
        continue;
      }
      limits[k] = v;
    }
    return limits;
  }

  /** Validate one integer field and push an error if it is unusable. */
  function checkIntegerField(raw, spec, errors, where) {
    // spec: {name, label, min, max, codeBase}
    var v = toInteger(raw);
    var extra = {};
    var k;
    for (k in where) extra[k] = where[k];
    extra.field = spec.name;
    extra.value = raw === undefined ? undefined : raw;
    if (Number.isNaN(v)) {
      errors.push(makeError('INVALID_' + spec.codeBase,
        spec.label + ' must be a whole number' + (raw === undefined ? ' (missing).' : '.'), extra));
      return null;
    }
    if (v < spec.min) {
      errors.push(makeError(spec.codeBase + '_TOO_SMALL',
        spec.label + ' must be at least ' + spec.min + ' (got ' + v + ').', extra));
      return null;
    }
    if (v > spec.max) {
      errors.push(makeError(spec.codeBase + '_TOO_LARGE',
        spec.label + ' must be at most ' + spec.max + ' (got ' + v + ').', extra));
      return null;
    }
    return v;
  }

  /**
   * Validate and normalize a simulation request.
   *
   * @param {object} request {processes, algorithms?, quantum?, limits?}
   * @returns {{ok:boolean, errors:Array, warnings:Array, normalized:(object|null)}}
   *   normalized = {processes:[{id,arrivalTime,burstTime}], algorithms:[keys],
   *                 quantum:(number|null), limits:{...}}
   */
  function validateInput(request) {
    var errors = [];
    var warnings = [];

    function fail() {
      return { ok: false, errors: errors, warnings: warnings, normalized: null };
    }

    if (!isPlainObject(request)) {
      errors.push(makeError('INVALID_INPUT', 'Request must be an object with a "processes" array.'));
      return fail();
    }

    var limits = resolveLimits(request.limits, errors);

    // ---- algorithms
    var algorithms = [];
    var rawAlgs = request.algorithms;
    if (rawAlgs === undefined || rawAlgs === null) {
      algorithms = ['FCFS', 'SJN', 'RR'];
    } else {
      if (typeof rawAlgs === 'string') rawAlgs = [rawAlgs];
      if (!Array.isArray(rawAlgs) || rawAlgs.length === 0) {
        errors.push(makeError('INVALID_ALGORITHMS',
          'algorithms must be a non-empty array such as ["FCFS","SJN","RR"].', { field: 'algorithms' }));
      } else {
        for (var a = 0; a < rawAlgs.length; a++) {
          var key = normalizeAlgorithmKey(rawAlgs[a]);
          if (key === null) {
            errors.push(makeError('UNKNOWN_ALGORITHM',
              'Unknown algorithm ' + JSON.stringify(rawAlgs[a]) + '. Use FCFS, SJN or RR.',
              { field: 'algorithms', index: a }));
          } else if (algorithms.indexOf(key) !== -1) {
            warnings.push({ code: 'DUPLICATE_ALGORITHM', message: 'Algorithm ' + key + ' was listed more than once; it runs once.' });
          } else {
            algorithms.push(key);
          }
        }
      }
    }

    // ---- quantum (only needed when RR is selected)
    var quantum = null;
    if (algorithms.indexOf('RR') !== -1) {
      quantum = checkIntegerField(request.quantum,
        { name: 'quantum', label: 'Round Robin quantum', min: 1, max: limits.maxQuantum, codeBase: 'QUANTUM' },
        errors, {});
    }

    // ---- processes
    var processes = [];
    var raw = request.processes;
    if (!Array.isArray(raw)) {
      errors.push(makeError('PROCESSES_NOT_ARRAY', 'processes must be an array.', { field: 'processes' }));
    } else if (raw.length === 0) {
      errors.push(makeError('NO_PROCESSES', 'At least one process is required.', { field: 'processes' }));
    } else if (raw.length > limits.maxProcesses) {
      errors.push(makeError('TOO_MANY_PROCESSES',
        'At most ' + limits.maxProcesses + ' processes are allowed (got ' + raw.length + ').', { field: 'processes' }));
    } else {
      var seen = Object.create(null);
      for (var i = 0; i < raw.length; i++) {
        if (errors.length >= MAX_REPORTED_ERRORS) {
          errors.push(makeError('TOO_MANY_ERRORS', 'Further errors were omitted.'));
          break;
        }
        var p = raw[i];
        var where = { index: i };
        if (!isPlainObject(p)) {
          errors.push(makeError('INVALID_PROCESS', 'Process #' + i + ' must be an object {id, arrivalTime, burstTime}.', where));
          continue;
        }

        var id = null;
        var rawId = p.id;
        if (typeof rawId === 'number' && Number.isFinite(rawId)) rawId = String(rawId);
        if (typeof rawId !== 'string' || rawId.trim() === '') {
          errors.push(makeError('INVALID_ID', 'Process #' + i + ' needs a non-empty id (string or number).',
            { index: i, field: 'id' }));
        } else {
          id = rawId.trim();
          if (id.toUpperCase() === IDLE_LABEL) {
            errors.push(makeError('RESERVED_ID', 'Process id "' + id + '" is reserved for idle periods.',
              { index: i, field: 'id' }));
            id = null;
          } else if (seen[id]) {
            errors.push(makeError('DUPLICATE_ID', 'Duplicate process id "' + id + '".', { index: i, field: 'id' }));
            id = null;
          } else {
            seen[id] = true;
          }
        }

        var at = checkIntegerField(p.arrivalTime,
          { name: 'arrivalTime', label: 'Arrival time of process #' + i, min: 0, max: limits.maxArrivalTime, codeBase: 'ARRIVAL_TIME' },
          errors, where);
        var bt = checkIntegerField(p.burstTime,
          { name: 'burstTime', label: 'Burst time of process #' + i, min: 1, max: limits.maxBurstTime, codeBase: 'BURST_TIME' },
          errors, where);

        if (id !== null && at !== null && bt !== null) {
          processes.push({ id: id, arrivalTime: at, burstTime: bt });
        }
      }
    }

    if (errors.length > 0) return fail();
    return {
      ok: true,
      errors: errors,
      warnings: warnings,
      normalized: { processes: processes, algorithms: algorithms, quantum: quantum, limits: limits }
    };
  }

  // ------------------------------------------------------------ timeline builder

  /** Thrown internally when the event capacity is exhausted. */
  function EventLimitSignal() { this.isEventLimitSignal = true; }

  /**
   * Builds the event timeline exactly like add_event/add_idle/add_run in C:
   *  - consecutive slices of the same process are merged into one run event
   *  - a zero-duration context_switch marker is inserted when a different
   *    process starts at the very instant the previous run ended
   *  - markers and idle events count towards maxEvents
   */
  function createTimeline(processes, maxEvents) {
    var events = [];
    var firstStart = new Array(processes.length);
    for (var i = 0; i < firstStart.length; i++) firstStart[i] = -1;
    var state = { busyTime: 0, contextSwitches: 0 };

    function push(ev) {
      if (events.length >= maxEvents) throw new EventLimitSignal();
      events.push(ev);
    }

    return {
      events: events,
      firstStart: firstStart,
      state: state,

      addIdle: function (start, end) {
        push({ type: 'idle', process: null, label: IDLE_LABEL, start: start, end: end, duration: end - start });
      },

      addRun: function (index, start, end) {
        var id = processes[index].id;
        var last = events.length > 0 ? events[events.length - 1] : null;
        state.busyTime += end - start;

        if (last !== null && last.type === 'run' && last.end === start) {
          if (last.process === id) {
            last.end = end;
            last.duration = end - last.start;
            return;
          }
          push({
            type: 'context_switch', process: id, from: last.process, to: id,
            label: last.process + ' -> ' + id, start: start, end: start, duration: 0
          });
          state.contextSwitches++;
        }

        if (firstStart[index] < 0) firstStart[index] = start;
        push({ type: 'run', process: id, label: id, start: start, end: end, duration: end - start });
      }
    };
  }

  /** Indices sorted by (arrivalTime, inputIndex) - same as C's stable sort. */
  function sortedByArrival(processes) {
    var order = [];
    for (var i = 0; i < processes.length; i++) order.push(i);
    order.sort(function (a, b) {
      return (processes[a].arrivalTime - processes[b].arrivalTime) || (a - b);
    });
    return order;
  }

  // ---------------------------------------------------------------- algorithms
  // Each core receives normalized processes and returns
  // {timeline, completion[], totalTime}. They contain no validation.

  function coreFCFS(processes, limits) {
    var tl = createTimeline(processes, limits.maxEvents);
    var completion = new Array(processes.length);
    var order = sortedByArrival(processes);
    var time = 0;
    for (var k = 0; k < order.length; k++) {
      var idx = order[k];
      var p = processes[idx];
      if (time < p.arrivalTime) {
        tl.addIdle(time, p.arrivalTime);
        time = p.arrivalTime;
      }
      tl.addRun(idx, time, time + p.burstTime);
      time += p.burstTime;
      completion[idx] = time;
    }
    return { timeline: tl, completion: completion, totalTime: time };
  }

  /** SJN selection rule from pick_shortest() in C. */
  function pickShortest(processes, done, time) {
    var best = -1;
    for (var i = 0; i < processes.length; i++) {
      if (done[i] || processes[i].arrivalTime > time) continue;
      if (best < 0 ||
          processes[i].burstTime < processes[best].burstTime ||
          (processes[i].burstTime === processes[best].burstTime &&
           processes[i].arrivalTime < processes[best].arrivalTime)) {
        best = i;
      }
    }
    return best;
  }

  function coreSJN(processes, limits) {
    var n = processes.length;
    var tl = createTimeline(processes, limits.maxEvents);
    var completion = new Array(n);
    var done = new Array(n);
    for (var i = 0; i < n; i++) done[i] = false;
    var completed = 0;
    var time = 0;

    while (completed < n) {
      var pid = pickShortest(processes, done, time);
      if (pid < 0) {
        var next = -1;
        for (var j = 0; j < n; j++) {
          if (!done[j] && (next < 0 || processes[j].arrivalTime < next)) next = processes[j].arrivalTime;
        }
        tl.addIdle(time, next);
        time = next;
        continue;
      }
      tl.addRun(pid, time, time + processes[pid].burstTime);
      time += processes[pid].burstTime;
      completion[pid] = time;
      done[pid] = true;
      completed++;
    }
    return { timeline: tl, completion: completion, totalTime: time };
  }

  function coreRR(processes, quantum, limits) {
    var n = processes.length;
    var tl = createTimeline(processes, limits.maxEvents);
    var completion = new Array(n);
    var remaining = new Array(n);
    for (var i = 0; i < n; i++) remaining[i] = processes[i].burstTime;

    var order = sortedByArrival(processes);
    // Circular FIFO of process indices. A process is queued at most once at a
    // time, so capacity n is always enough (same design as the C Queue).
    var items = new Array(n);
    var head = 0;
    var count = 0;
    var next = 0;
    var completed = 0;
    var time = 0;

    function push(v) { items[(head + count) % n] = v; count++; }
    function pop() { var v = items[head]; head = (head + 1) % n; count--; return v; }
    function enqueueArrivals() {
      while (next < n && processes[order[next]].arrivalTime <= time) {
        push(order[next]);
        next++;
      }
    }

    while (completed < n) {
      enqueueArrivals();

      if (count === 0) {
        if (next >= n) {
          // Cannot happen for valid input; guards against an endless loop.
          throw new Error('Round Robin internal error: no runnable or future process.');
        }
        var arrive = processes[order[next]].arrivalTime;
        tl.addIdle(time, arrive);
        time = arrive;
        continue;
      }

      var pid = pop();
      var slice = remaining[pid] < quantum ? remaining[pid] : quantum;
      tl.addRun(pid, time, time + slice);
      time += slice;
      remaining[pid] -= slice;

      // Arrivals up to and including the slice end go BEFORE the preempted process.
      enqueueArrivals();

      if (remaining[pid] > 0) {
        push(pid);
      } else {
        completion[pid] = time;
        completed++;
      }
    }
    return { timeline: tl, completion: completion, totalTime: time };
  }

  // -------------------------------------------------------- result construction

  function buildResult(algKey, processes, core, quantum) {
    var tl = core.timeline;
    var n = processes.length;
    var perProcess = [];
    var sumW = 0, sumT = 0, sumR = 0;

    for (var i = 0; i < n; i++) {
      var p = processes[i];
      var completionTime = core.completion[i];
      var turnaround = completionTime - p.arrivalTime;
      var waiting = turnaround - p.burstTime;
      var response = tl.firstStart[i] - p.arrivalTime;
      sumW += waiting;
      sumT += turnaround;
      sumR += response;
      perProcess.push({
        id: p.id,
        arrivalTime: p.arrivalTime,
        burstTime: p.burstTime,
        firstStartTime: tl.firstStart[i],
        completionTime: completionTime,
        turnaroundTime: turnaround,
        waitingTime: waiting,
        responseTime: response
      });
    }

    var totalTime = core.totalTime;
    var busy = tl.state.busyTime;

    var gantt = [];
    for (var e = 0; e < tl.events.length; e++) {
      var ev = tl.events[e];
      if (ev.type === 'context_switch') continue;
      gantt.push({ type: ev.type, process: ev.process, label: ev.label, start: ev.start, end: ev.end, duration: ev.duration });
    }

    var events = [];
    for (var f = 0; f < tl.events.length; f++) {
      var copy = {};
      for (var key in tl.events[f]) copy[key] = tl.events[f][key];
      events.push(copy);
    }

    return {
      ok: true,
      algorithm: algKey,
      name: ALGORITHMS[algKey].name,
      quantum: algKey === 'RR' ? quantum : null,
      gantt: gantt,
      events: events,
      processes: perProcess,
      summary: {
        averageWaitingTime: sumW / n,
        averageTurnaroundTime: sumT / n,
        averageResponseTime: sumR / n,
        cpuUtilization: totalTime > 0 ? (100 * busy) / totalTime : 0,
        contextSwitches: tl.state.contextSwitches,
        totalTime: totalTime,
        busyTime: busy,
        idleTime: totalTime - busy
      }
    };
  }

  /**
   * Consistency checker (port of verify_result() in C, plus a few extra
   * identity checks). Returns an array of problem descriptions; empty = OK.
   */
  function verifyResult(result) {
    var problems = [];
    if (!result || !Array.isArray(result.events) || !Array.isArray(result.processes) || !result.summary) {
      return ['Result object is malformed.'];
    }
    var byId = Object.create(null);
    var i;
    for (i = 0; i < result.processes.length; i++) byId[result.processes[i].id] = { ran: 0, lastEnd: -1, p: result.processes[i] };

    var expected = 0;
    var switches = 0;
    var busy = 0;
    var ganttCount = 0;
    for (i = 0; i < result.events.length; i++) {
      var e = result.events[i];
      if (e.start !== expected || e.end < e.start || e.duration !== e.end - e.start) {
        problems.push('Event ' + i + ' has a gap, overlap or wrong duration.');
      }
      if (e.type === 'run') {
        ganttCount++;
        var rec = byId[e.process];
        if (!rec) {
          problems.push('Event ' + i + ' runs unknown process ' + e.process + '.');
        } else {
          if (e.start < rec.p.arrivalTime) problems.push(e.process + ' runs before it arrives.');
          if (e.duration <= 0) problems.push('Run event ' + i + ' has no duration.');
          rec.ran += e.duration;
          rec.lastEnd = e.end;
        }
        busy += e.duration;
      } else if (e.type === 'idle') {
        ganttCount++;
        if (e.duration <= 0) problems.push('Idle event ' + i + ' has no duration.');
      } else if (e.type === 'context_switch') {
        switches++;
        if (e.duration !== 0) problems.push('Context switch event ' + i + ' has non-zero duration.');
      } else {
        problems.push('Event ' + i + ' has unknown type ' + e.type + '.');
      }
      expected = e.end;
    }

    var s = result.summary;
    if (expected !== s.totalTime) problems.push('Total time mismatch.');
    if (busy !== s.busyTime) problems.push('Busy time mismatch.');
    if (s.busyTime + s.idleTime !== s.totalTime) problems.push('Busy + idle does not equal total time.');
    if (switches !== s.contextSwitches) problems.push('Context switch count mismatch.');
    if (Array.isArray(result.gantt) && result.gantt.length !== ganttCount) problems.push('Gantt chart does not match events.');

    for (i = 0; i < result.processes.length; i++) {
      var p = result.processes[i];
      var r = byId[p.id];
      if (r.ran !== p.burstTime) problems.push(p.id + ' ran ' + r.ran + ' units but burst is ' + p.burstTime + '.');
      if (r.lastEnd !== p.completionTime) problems.push(p.id + ' completion time does not match its last run.');
      if (p.turnaroundTime !== p.completionTime - p.arrivalTime) problems.push(p.id + ' turnaround mismatch.');
      if (p.waitingTime !== p.turnaroundTime - p.burstTime) problems.push(p.id + ' waiting mismatch.');
      if (p.responseTime !== p.firstStartTime - p.arrivalTime) problems.push(p.id + ' response mismatch.');
      if (p.waitingTime < 0 || p.responseTime < 0) problems.push('Negative metric for ' + p.id + '.');
    }
    return problems;
  }

  // ------------------------------------------------------------------ public API

  function failure(errors, warnings) {
    return { ok: false, errors: errors, warnings: warnings || [] };
  }

  /** Run one algorithm on already-normalized input. Returns result or {ok:false}. */
  function executeAlgorithm(key, normalized) {
    var core;
    try {
      if (key === 'FCFS') core = coreFCFS(normalized.processes, normalized.limits);
      else if (key === 'SJN') core = coreSJN(normalized.processes, normalized.limits);
      else core = coreRR(normalized.processes, normalized.quantum, normalized.limits);
    } catch (err) {
      if (err && err.isEventLimitSignal) {
        return failure([makeError('EVENT_LIMIT_EXCEEDED',
          key + ' needs more than ' + normalized.limits.maxEvents + ' timeline events (idle periods, runs and ' +
          'context-switch markers all count). Use a larger quantum, fewer processes, or raise limits.maxEvents.',
          { algorithm: key })]);
      }
      return failure([makeError('INTERNAL_ERROR', String(err && err.message ? err.message : err), { algorithm: key })]);
    }
    var result = buildResult(key, normalized.processes, core, normalized.quantum);
    var problems = verifyResult(result);
    if (problems.length > 0) {
      return failure([makeError('INTERNAL_CONSISTENCY_ERROR',
        key + ' failed its self-check: ' + problems.join(' '), { algorithm: key, problems: problems })]);
    }
    return result;
  }

  /**
   * Main entry point.
   *
   * @param {object} request
   *   processes  : [{id, arrivalTime, burstTime}]            (required)
   *   algorithms : ["FCFS","SJN","RR"] or one string          (default: all three)
   *   quantum    : integer >= 1                               (required if RR selected)
   *   limits     : partial override of DEFAULT_LIMITS         (optional)
   * @returns {object}
   *   success: {ok:true, warnings, input:{processes,quantum}, results:[...], byAlgorithm:{FCFS,SJN,RR}}
   *   failure: {ok:false, errors:[{code,message,...}], warnings}
   * Never throws for invalid user input. All-or-nothing: if any requested
   * algorithm cannot be completed, no results are returned.
   */
  function runSimulation(request) {
    var v = validateInput(request);
    if (!v.ok) return failure(v.errors, v.warnings);

    var results = [];
    var byAlgorithm = {};
    for (var i = 0; i < v.normalized.algorithms.length; i++) {
      var key = v.normalized.algorithms[i];
      var r = executeAlgorithm(key, v.normalized);
      if (!r.ok) return failure(r.errors, v.warnings);
      results.push(r);
      byAlgorithm[key] = r;
    }
    return {
      ok: true,
      warnings: v.warnings,
      input: { processes: v.normalized.processes, quantum: v.normalized.quantum },
      results: results,
      byAlgorithm: byAlgorithm
    };
  }

  function runSingle(key, processes, quantum, options) {
    var request = { processes: processes, algorithms: [key], quantum: quantum };
    if (options && options.limits !== undefined) request.limits = options.limits;
    var out = runSimulation(request);
    return out.ok ? out.results[0] : failure(out.errors, out.warnings);
  }

  /** @returns a result object ({ok:true, ...}) or {ok:false, errors} */
  function runFCFS(processes, options) { return runSingle('FCFS', processes, undefined, options); }
  function runSJN(processes, options) { return runSingle('SJN', processes, undefined, options); }
  function runRoundRobin(processes, quantum, options) { return runSingle('RR', processes, quantum, options); }

  return {
    runSimulation: runSimulation,
    runFCFS: runFCFS,
    runSJN: runSJN,
    runRoundRobin: runRoundRobin,
    validateInput: validateInput,
    verifyResult: verifyResult,
    ALGORITHMS: ALGORITHMS,
    DEFAULT_LIMITS: DEFAULT_LIMITS,
    C_LIMITS: C_LIMITS,
    IDLE_LABEL: IDLE_LABEL
  };
});
