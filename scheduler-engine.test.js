'use strict';
/**
 * scheduler-engine.test.js
 *
 * Run with:   node --test scheduler-engine.test.js      (Node 18 or newer)
 *
 * No npm packages are needed. The suite has four parts:
 *   1. Hand-calculated workloads with exact expected output for FCFS, SJN, RR.
 *   2. Edge cases and input validation.
 *   3. Randomized invariant checks and a large-workload check.
 *   4. A differential test against the ORIGINAL scheduler.c. It compiles the
 *      untouched scheduler.c with gcc/cc/clang into a temp directory and
 *      compares events and metrics. It is skipped automatically when
 *      scheduler.c or a C compiler is not available.
 */

const test = require('node:test');
const { describe, it, after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const E = require('./scheduler-engine.js');

// ------------------------------------------------------------------- helpers

/** procs([['P1',0,5], ...]) -> [{id, arrivalTime, burstTime}, ...] */
function procs(rows) {
  return rows.map(([id, arrivalTime, burstTime]) => ({ id, arrivalTime, burstTime }));
}

/** Compact Gantt notation: "P1:0-5", "IDLE:5-10". */
function gantt(result) {
  return result.gantt.map((g) => `${g.label}:${g.start}-${g.end}`);
}

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message || 'value'}: expected ${expected}, got ${actual}`);
}

/**
 * Assert a result against an expectation. Only the provided fields are checked.
 * exp = {gantt, completion, turnaround, waiting, response, avgWaiting,
 *        avgTurnaround, avgResponse, util, switches, total}
 */
function expectResult(result, exp) {
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.deepEqual(E.verifyResult(result), [], 'verifyResult must report no problems');
  if (exp.gantt) assert.deepEqual(gantt(result), exp.gantt, 'gantt');
  const col = (key) => result.processes.map((p) => p[key]);
  if (exp.completion) assert.deepEqual(col('completionTime'), exp.completion, 'completion');
  if (exp.turnaround) assert.deepEqual(col('turnaroundTime'), exp.turnaround, 'turnaround');
  if (exp.waiting) assert.deepEqual(col('waitingTime'), exp.waiting, 'waiting');
  if (exp.response) assert.deepEqual(col('responseTime'), exp.response, 'response');
  const s = result.summary;
  if (exp.avgWaiting !== undefined) close(s.averageWaitingTime, exp.avgWaiting, 'avg waiting');
  if (exp.avgTurnaround !== undefined) close(s.averageTurnaroundTime, exp.avgTurnaround, 'avg turnaround');
  if (exp.avgResponse !== undefined) close(s.averageResponseTime, exp.avgResponse, 'avg response');
  if (exp.util !== undefined) close(s.cpuUtilization, exp.util, 'cpu utilization');
  if (exp.switches !== undefined) assert.equal(s.contextSwitches, exp.switches, 'context switches');
  if (exp.total !== undefined) assert.equal(s.totalTime, exp.total, 'total time');
}

function errorCodes(out) {
  assert.equal(out.ok, false, 'expected a failure');
  return out.errors.map((e) => e.code);
}

/** Seeded PRNG (mulberry32) so randomized tests are reproducible. */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const randInt = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1));

function randomWorkload(r, maxN, maxArrival, maxBurst) {
  const n = randInt(r, 1, maxN);
  const rows = [];
  for (let i = 0; i < n; i++) rows.push([`P${i + 1}`, randInt(r, 0, maxArrival), randInt(r, 1, maxBurst)]);
  return procs(rows);
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

// ------------------------------------------------- 1. hand-calculated workloads

describe('Workload A - classic mixed arrivals (P1 0/5, P2 1/3, P3 2/8, P4 3/6)', () => {
  const A = () => procs([['P1', 0, 5], ['P2', 1, 3], ['P3', 2, 8], ['P4', 3, 6]]);

  it('FCFS', () => {
    expectResult(E.runFCFS(A()), {
      gantt: ['P1:0-5', 'P2:5-8', 'P3:8-16', 'P4:16-22'],
      completion: [5, 8, 16, 22],
      turnaround: [5, 7, 14, 19],
      waiting: [0, 4, 6, 13],
      response: [0, 4, 6, 13],
      avgWaiting: 5.75, avgTurnaround: 11.25, avgResponse: 5.75,
      util: 100, switches: 3, total: 22
    });
  });

  it('SJN picks the shortest ready job and never preempts', () => {
    expectResult(E.runSJN(A()), {
      gantt: ['P1:0-5', 'P2:5-8', 'P4:8-14', 'P3:14-22'],
      completion: [5, 8, 22, 14],
      turnaround: [5, 7, 20, 11],
      waiting: [0, 4, 12, 5],
      response: [0, 4, 12, 5],
      avgWaiting: 5.25, avgTurnaround: 10.75, avgResponse: 5.25,
      util: 100, switches: 3, total: 22
    });
  });

  it('Round Robin, quantum 2', () => {
    expectResult(E.runRoundRobin(A(), 2), {
      gantt: ['P1:0-2', 'P2:2-4', 'P3:4-6', 'P1:6-8', 'P4:8-10', 'P2:10-11',
              'P3:11-13', 'P1:13-14', 'P4:14-16', 'P3:16-18', 'P4:18-20', 'P3:20-22'],
      completion: [14, 11, 22, 20],
      turnaround: [14, 10, 20, 17],
      waiting: [9, 7, 12, 11],
      response: [0, 1, 2, 5],
      avgWaiting: 9.75, avgTurnaround: 15.25, avgResponse: 2,
      util: 100, switches: 11, total: 22
    });
  });

  it('Round Robin with a quantum larger than every burst behaves like FCFS', () => {
    const rr = E.runRoundRobin(A(), 100);
    const fcfs = E.runFCFS(A());
    assert.deepEqual(gantt(rr), gantt(fcfs));
    assert.deepEqual(rr.processes, fcfs.processes);
  });
});

describe('Workload B - idle gaps (P1 3/2, P2 10/1, P3 11/4)', () => {
  const B = () => procs([['P1', 3, 2], ['P2', 10, 1], ['P3', 11, 4]]);
  const expected = {
    gantt: ['IDLE:0-3', 'P1:3-5', 'IDLE:5-10', 'P2:10-11', 'P3:11-15'],
    completion: [5, 11, 15],
    turnaround: [2, 1, 4],
    waiting: [0, 0, 0],
    response: [0, 0, 0],
    avgWaiting: 0, avgTurnaround: 7 / 3, avgResponse: 0,
    util: 700 / 15, // 7 busy units out of 15
    switches: 1,    // only P2 -> P3; dispatches after idle are not switches
    total: 15
  };

  it('FCFS', () => expectResult(E.runFCFS(B()), expected));
  it('SJN', () => expectResult(E.runSJN(B()), expected));
  it('Round Robin q=2 (P3 slices merge into one block)', () => expectResult(E.runRoundRobin(B(), 2), expected));

  it('idle events are reported with the idle label, null process and a duration', () => {
    const idle = E.runFCFS(B()).gantt.filter((g) => g.type === 'idle');
    assert.deepEqual(idle, [
      { type: 'idle', process: null, label: 'IDLE', start: 0, end: 3, duration: 3 },
      { type: 'idle', process: null, label: 'IDLE', start: 5, end: 10, duration: 5 }
    ]);
  });
});

describe('Workload C - tied arrival and burst times (P1 0/6, P2 1/3, P3 1/3, P4 2/2)', () => {
  const C = () => procs([['P1', 0, 6], ['P2', 1, 3], ['P3', 1, 3], ['P4', 2, 2]]);

  it('FCFS keeps input order for tied arrivals', () => {
    expectResult(E.runFCFS(C()), {
      gantt: ['P1:0-6', 'P2:6-9', 'P3:9-12', 'P4:12-14'],
      completion: [6, 9, 12, 14],
      turnaround: [6, 8, 11, 12],
      waiting: [0, 5, 8, 10],
      response: [0, 5, 8, 10],
      avgWaiting: 5.75, avgTurnaround: 9.25, avgResponse: 5.75, switches: 3
    });
  });

  it('SJN: shortest first, then tied jobs by input order', () => {
    expectResult(E.runSJN(C()), {
      gantt: ['P1:0-6', 'P4:6-8', 'P2:8-11', 'P3:11-14'],
      completion: [6, 11, 14, 8],
      turnaround: [6, 10, 13, 6],
      waiting: [0, 7, 10, 4],
      response: [0, 7, 10, 4],
      avgWaiting: 5.25, avgTurnaround: 8.75, avgResponse: 5.25, switches: 3
    });
  });

  it('Round Robin q=3: simultaneous arrivals are queued before the preempted process', () => {
    expectResult(E.runRoundRobin(C(), 3), {
      gantt: ['P1:0-3', 'P2:3-6', 'P3:6-9', 'P4:9-11', 'P1:11-14'],
      completion: [14, 6, 9, 11],
      turnaround: [14, 5, 8, 9],
      waiting: [8, 2, 5, 7],
      response: [0, 2, 5, 7],
      avgWaiting: 5.5, avgTurnaround: 9, avgResponse: 3.5, switches: 4
    });
  });
});

describe('Workload D - every process arrives at time 0 with equal bursts (3 x burst 3)', () => {
  const D = () => procs([['P1', 0, 3], ['P2', 0, 3], ['P3', 0, 3]]);

  it('FCFS and SJN both run P1, P2, P3', () => {
    const exp = {
      gantt: ['P1:0-3', 'P2:3-6', 'P3:6-9'],
      completion: [3, 6, 9], waiting: [0, 3, 6], response: [0, 3, 6], switches: 2, util: 100
    };
    expectResult(E.runFCFS(D()), exp);
    expectResult(E.runSJN(D()), exp);
  });

  it('Round Robin q=2 cycles P1, P2, P3 in input order', () => {
    expectResult(E.runRoundRobin(D(), 2), {
      gantt: ['P1:0-2', 'P2:2-4', 'P3:4-6', 'P1:6-7', 'P2:7-8', 'P3:8-9'],
      completion: [7, 8, 9], turnaround: [7, 8, 9], waiting: [4, 5, 6], response: [0, 2, 4],
      switches: 5, util: 100
    });
  });
});

// --------------------------------------------------- 2. algorithm-specific rules

describe('SJN selection rules', () => {
  it('is non-preemptive: a shorter job arriving later waits', () => {
    expectResult(E.runSJN(procs([['P1', 0, 8], ['P2', 1, 1]])), {
      gantt: ['P1:0-8', 'P2:8-9'], waiting: [0, 7], response: [0, 7]
    });
  });

  it('ties on burst go to the EARLIER ARRIVAL, even with a higher input index', () => {
    expectResult(E.runSJN(procs([['P1', 0, 5], ['P2', 3, 2], ['P3', 1, 2]])), {
      gantt: ['P1:0-5', 'P3:5-7', 'P2:7-9'], completion: [5, 9, 7]
    });
  });

  it('remaining ties go to the lower INPUT POSITION (not the id text)', () => {
    expectResult(E.runSJN(procs([['P1', 0, 4], ['P2', 1, 2], ['P3', 1, 2]])), {
      gantt: ['P1:0-4', 'P2:4-6', 'P3:6-8']
    });
    expectResult(E.runSJN(procs([['P1', 0, 4], ['P3', 1, 2], ['P2', 1, 2]])), {
      gantt: ['P1:0-4', 'P3:4-6', 'P2:6-8']
    });
  });

  it('leading idle time, then the shortest ready job (P1 5/3, P2 5/1)', () => {
    const w = () => procs([['P1', 5, 3], ['P2', 5, 1]]);
    expectResult(E.runSJN(w()), {
      gantt: ['IDLE:0-5', 'P2:5-6', 'P1:6-9'],
      completion: [9, 6], turnaround: [4, 1], waiting: [1, 0], response: [1, 0],
      util: 400 / 9, switches: 1, total: 9
    });
    expectResult(E.runFCFS(w()), {
      gantt: ['IDLE:0-5', 'P1:5-8', 'P2:8-9'],
      completion: [8, 9], turnaround: [3, 4], waiting: [0, 3], response: [0, 3],
      util: 400 / 9, switches: 1, total: 9
    });
  });
});

describe('FCFS ordering', () => {
  it('schedules by arrival time but reports processes in INPUT order', () => {
    const r = E.runFCFS(procs([['P1', 5, 2], ['P2', 0, 3]]));
    expectResult(r, {
      gantt: ['P2:0-3', 'IDLE:3-5', 'P1:5-7'],
      completion: [7, 3], turnaround: [2, 3], waiting: [0, 0], response: [0, 0],
      util: 500 / 7, switches: 0, total: 7
    });
    assert.deepEqual(r.processes.map((p) => p.id), ['P1', 'P2']);
  });
});

describe('Round Robin queue behaviour', () => {
  it('a process arriving exactly when a slice ends is queued BEFORE the preempted process', () => {
    // P1 0/4, P2 2/4, P3 4/2, q=2. At t=4 P3 arrives as P2 is preempted: P3 must run first.
    expectResult(E.runRoundRobin(procs([['P1', 0, 4], ['P2', 2, 4], ['P3', 4, 2]]), 2), {
      gantt: ['P1:0-2', 'P2:2-4', 'P1:4-6', 'P3:6-8', 'P2:8-10'],
      completion: [6, 10, 8], turnaround: [6, 8, 4], waiting: [2, 4, 2], response: [0, 0, 2],
      avgWaiting: 8 / 3, avgTurnaround: 6, avgResponse: 2 / 3, switches: 4
    });
  });

  it('a process arriving mid-slice is queued ahead of the preempted process', () => {
    expectResult(E.runRoundRobin(procs([['P1', 0, 5], ['P2', 1, 2]]), 3), {
      gantt: ['P1:0-3', 'P2:3-5', 'P1:5-7'],
      completion: [7, 5], turnaround: [7, 4], waiting: [2, 2], response: [0, 2], switches: 2
    });
  });

  it('merges consecutive slices of the same process into one Gantt block', () => {
    const r = E.runRoundRobin(procs([['P1', 0, 6], ['P2', 0, 2]]), 2);
    expectResult(r, {
      gantt: ['P1:0-2', 'P2:2-4', 'P1:4-8'],
      completion: [8, 4], waiting: [2, 2], response: [0, 2], switches: 2
    });
    const p1Last = r.gantt[2];
    assert.equal(p1Last.duration, 4);
  });

  it('quantum 1 with two equal jobs alternates every unit', () => {
    expectResult(E.runRoundRobin(procs([['P1', 0, 2], ['P2', 0, 2]]), 1), {
      gantt: ['P1:0-1', 'P2:1-2', 'P1:2-3', 'P2:3-4'], switches: 3, completion: [3, 4]
    });
  });

  it('a dispatch after an idle gap is not a context switch', () => {
    expectResult(E.runRoundRobin(procs([['P1', 0, 2], ['P2', 6, 2]]), 3), {
      gantt: ['P1:0-2', 'IDLE:2-6', 'P2:6-8'], switches: 0, util: 50, total: 8
    });
  });

  it('context-switch markers appear in `events` but not in `gantt`', () => {
    const r = E.runRoundRobin(procs([['P1', 0, 2], ['P2', 0, 2]]), 1);
    const markers = r.events.filter((e) => e.type === 'context_switch');
    assert.equal(markers.length, 3);
    assert.deepEqual(markers[0], {
      type: 'context_switch', process: 'P2', from: 'P1', to: 'P2', label: 'P1 -> P2', start: 1, end: 1, duration: 0
    });
    assert.ok(r.gantt.every((g) => g.type !== 'context_switch'));
    assert.equal(r.events.length, r.gantt.length + markers.length);
  });
});

describe('Single-process workloads', () => {
  it('arrival 0: one block, no switches, 100% utilization (all algorithms)', () => {
    const w = () => procs([['P1', 0, 7]]);
    const exp = {
      gantt: ['P1:0-7'], completion: [7], turnaround: [7], waiting: [0], response: [0],
      avgWaiting: 0, avgTurnaround: 7, avgResponse: 0, util: 100, switches: 0, total: 7
    };
    expectResult(E.runFCFS(w()), exp);
    expectResult(E.runSJN(w()), exp);
    expectResult(E.runRoundRobin(w(), 3), exp);
    expectResult(E.runRoundRobin(w(), 1), exp);
  });

  it('late arrival: leading idle lowers utilization (all algorithms)', () => {
    const w = () => procs([['P1', 4, 7]]);
    const exp = {
      gantt: ['IDLE:0-4', 'P1:4-11'], completion: [11], turnaround: [7], waiting: [0], response: [0],
      util: 700 / 11, switches: 0, total: 11
    };
    expectResult(E.runFCFS(w()), exp);
    expectResult(E.runSJN(w()), exp);
    expectResult(E.runRoundRobin(w(), 2), exp);
  });
});

describe('runSimulation output shape and multi-algorithm behaviour', () => {
  const W = () => procs([['P1', 0, 5], ['P2', 1, 3], ['P3', 2, 8], ['P4', 3, 6]]);

  it('runs all three algorithms by default and returns them in canonical order', () => {
    const out = E.runSimulation({ processes: W(), quantum: 2 });
    assert.equal(out.ok, true);
    assert.deepEqual(out.results.map((r) => r.algorithm), ['FCFS', 'SJN', 'RR']);
    assert.deepEqual(Object.keys(out.byAlgorithm).sort(), ['FCFS', 'RR', 'SJN']);
    assert.equal(out.byAlgorithm.RR, out.results[2]);
    assert.deepEqual(out.input.processes, W());
    assert.equal(out.input.quantum, 2);
  });

  it('honours the requested algorithms and their order, and does not need a quantum without RR', () => {
    const out = E.runSimulation({ processes: W(), algorithms: ['SJN', 'FCFS'] });
    assert.equal(out.ok, true);
    assert.deepEqual(out.results.map((r) => r.algorithm), ['SJN', 'FCFS']);
    assert.equal(out.results[0].quantum, null);
  });

  it('accepts friendly algorithm spellings and warns about duplicates', () => {
    const out = E.runSimulation({
      processes: W(), quantum: 2, algorithms: ['fcfs', 'Shortest Job Next', 'round_robin', 'FCFS']
    });
    assert.equal(out.ok, true);
    assert.deepEqual(out.results.map((r) => r.algorithm), ['FCFS', 'SJN', 'RR']);
    assert.deepEqual(out.warnings.map((w) => w.code), ['DUPLICATE_ALGORITHM']);
    assert.equal(E.runSimulation({ processes: W(), algorithms: 'sjn' }).results[0].algorithm, 'SJN');
  });

  it('result objects have the documented fields', () => {
    const r = E.runSimulation({ processes: W(), quantum: 2 }).byAlgorithm.RR;
    assert.deepEqual(Object.keys(r).sort(),
      ['algorithm', 'events', 'gantt', 'name', 'ok', 'processes', 'quantum', 'summary'].sort());
    assert.equal(r.name, 'Round Robin');
    assert.equal(r.quantum, 2);
    assert.deepEqual(Object.keys(r.gantt[0]).sort(), ['duration', 'end', 'label', 'process', 'start', 'type']);
    assert.deepEqual(Object.keys(r.processes[0]).sort(), [
      'arrivalTime', 'burstTime', 'completionTime', 'firstStartTime', 'id',
      'responseTime', 'turnaroundTime', 'waitingTime'].sort());
    assert.deepEqual(Object.keys(r.summary).sort(), [
      'averageResponseTime', 'averageTurnaroundTime', 'averageWaitingTime', 'busyTime',
      'contextSwitches', 'cpuUtilization', 'idleTime', 'totalTime'].sort());
    assert.equal(E.ALGORITHMS.FCFS.name, 'First Come First Served');
  });

  it('every gantt event satisfies duration === end - start', () => {
    const out = E.runSimulation({ processes: W(), quantum: 3 });
    for (const r of out.results) for (const g of r.gantt) assert.equal(g.duration, g.end - g.start);
  });

  it('single-algorithm helpers equal the matching runSimulation result', () => {
    const all = E.runSimulation({ processes: W(), quantum: 3 });
    assert.deepEqual(E.runFCFS(W()), all.byAlgorithm.FCFS);
    assert.deepEqual(E.runSJN(W()), all.byAlgorithm.SJN);
    assert.deepEqual(E.runRoundRobin(W(), 3), all.byAlgorithm.RR);
  });

  it('is deterministic and does not modify its input', () => {
    const input = deepFreeze({ processes: W(), quantum: 2, algorithms: ['FCFS', 'SJN', 'RR'] });
    const before = JSON.stringify(input);
    const a = E.runSimulation(input);
    const b = E.runSimulation(input);
    assert.equal(a.ok, true);
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(input), before);
  });

  it('gantt and events are independent copies', () => {
    const r = E.runFCFS(W());
    r.gantt[0].start = 999;
    assert.equal(r.events[0].start, 0);
    assert.notEqual(r.gantt[0], r.events[0]);
  });

  it('accepts numeric strings (values read from form fields) and numeric ids', () => {
    const out = E.runFCFS([{ id: 7, arrivalTime: '0', burstTime: ' 4 ' }, { id: ' B ', arrivalTime: '2', burstTime: '+3' }]);
    assert.equal(out.ok, true);
    assert.deepEqual(out.processes.map((p) => [p.id, p.arrivalTime, p.burstTime]), [['7', 0, 4], ['B', 2, 3]]);
  });
});

// ------------------------------------------------------------ 3. invalid input

describe('Input validation', () => {
  const ok1 = () => ({ id: 'P1', arrivalTime: 0, burstTime: 3 });
  const run = (processes, extra) => E.runSimulation({ processes, quantum: 2, ...extra });

  it('rejects a non-object request or a missing process list', () => {
    for (const bad of [undefined, null, 5, 'x', [], () => 1]) {
      assert.deepEqual(errorCodes(E.runSimulation(bad)), ['INVALID_INPUT']);
    }
    assert.deepEqual(errorCodes(E.runSimulation({ quantum: 2 })), ['PROCESSES_NOT_ARRAY']);
    assert.deepEqual(errorCodes(E.runSimulation({ processes: 'abc', quantum: 2 })), ['PROCESSES_NOT_ARRAY']);
    assert.deepEqual(errorCodes(E.runSimulation({ processes: {}, quantum: 2 })), ['PROCESSES_NOT_ARRAY']);
  });

  it('rejects an empty process list', () => {
    assert.deepEqual(errorCodes(run([])), ['NO_PROCESSES']);
  });

  it('rejects entries that are not process objects', () => {
    for (const bad of [null, undefined, 5, 'P1', [1, 2, 3]]) {
      assert.deepEqual(errorCodes(run([bad])), ['INVALID_PROCESS']);
    }
  });

  it('rejects missing, empty, reserved and duplicate ids', () => {
    for (const id of [undefined, null, '', '   ', {}, [], true, NaN, Infinity]) {
      assert.deepEqual(errorCodes(run([{ ...ok1(), id }])), ['INVALID_ID'], `id=${String(id)}`);
    }
    assert.deepEqual(errorCodes(run([{ ...ok1(), id: 'idle' }])), ['RESERVED_ID']);
    assert.deepEqual(errorCodes(run([{ ...ok1(), id: ' IDLE ' }])), ['RESERVED_ID']);
    assert.deepEqual(errorCodes(run([ok1(), ok1()])), ['DUPLICATE_ID']);
    assert.deepEqual(errorCodes(run([ok1(), { ...ok1(), id: ' P1 ' }])), ['DUPLICATE_ID']);
  });

  it('rejects negative arrival times and accepts zero', () => {
    assert.deepEqual(errorCodes(run([{ ...ok1(), arrivalTime: -1 }])), ['ARRIVAL_TIME_TOO_SMALL']);
    assert.deepEqual(errorCodes(run([{ ...ok1(), arrivalTime: -0.5 }])), ['INVALID_ARRIVAL_TIME']);
    assert.equal(run([{ ...ok1(), arrivalTime: 0 }]).ok, true);
    assert.equal(run([{ ...ok1(), arrivalTime: -0 }]).ok, true);
  });

  it('rejects zero and negative burst times', () => {
    assert.deepEqual(errorCodes(run([{ ...ok1(), burstTime: 0 }])), ['BURST_TIME_TOO_SMALL']);
    assert.deepEqual(errorCodes(run([{ ...ok1(), burstTime: -4 }])), ['BURST_TIME_TOO_SMALL']);
  });

  it('rejects non-integer, non-finite, non-numeric and missing times', () => {
    const bad = [1.5, NaN, Infinity, -Infinity, null, undefined, true, '', ' ', 'abc', '5x', '1e3', '0x10', '1.5', [], {}, 2 ** 60];
    for (const v of bad) {
      assert.deepEqual(errorCodes(run([{ ...ok1(), arrivalTime: v }])), ['INVALID_ARRIVAL_TIME'], `arrival=${String(v)}`);
      assert.deepEqual(errorCodes(run([{ ...ok1(), burstTime: v }])), ['INVALID_BURST_TIME'], `burst=${String(v)}`);
    }
  });

  it('validates the Round Robin quantum only when RR is requested', () => {
    for (const q of [0, -1, 1.5, NaN, Infinity, undefined, null, '', '2x']) {
      const codes = errorCodes(E.runSimulation({ processes: [ok1()], quantum: q }));
      assert.equal(codes.length, 1, `quantum=${String(q)}`);
      assert.match(codes[0], /^(INVALID_QUANTUM|QUANTUM_TOO_SMALL)$/);
    }
    assert.deepEqual(errorCodes(E.runSimulation({ processes: [ok1()], quantum: 0 })), ['QUANTUM_TOO_SMALL']);
    assert.deepEqual(errorCodes(E.runRoundRobin([ok1()])), ['INVALID_QUANTUM']);
    // Garbage quantum is ignored when RR is not selected.
    assert.equal(E.runSimulation({ processes: [ok1()], algorithms: ['FCFS', 'SJN'], quantum: -5 }).ok, true);
    assert.equal(E.runFCFS([ok1()]).ok, true);
  });

  it('rejects empty, unknown and malformed algorithm selections', () => {
    assert.deepEqual(errorCodes(run([ok1()], { algorithms: [] })), ['INVALID_ALGORITHMS']);
    assert.deepEqual(errorCodes(run([ok1()], { algorithms: 42 })), ['INVALID_ALGORITHMS']);
    assert.deepEqual(errorCodes(run([ok1()], { algorithms: ['XYZ'] })), ['UNKNOWN_ALGORITHM']);
    assert.deepEqual(errorCodes(run([ok1()], { algorithms: ['FCFS', 7] })), ['UNKNOWN_ALGORITHM']);
  });

  it('collects every problem in one pass, with index and field details', () => {
    const out = E.runSimulation({
      processes: [{ id: 'A', arrivalTime: -1, burstTime: 0 }, { id: 'B', arrivalTime: 'x', burstTime: 2.5 }],
      quantum: 0
    });
    assert.deepEqual(out.errors.map((e) => e.code), [
      'QUANTUM_TOO_SMALL', 'ARRIVAL_TIME_TOO_SMALL', 'BURST_TIME_TOO_SMALL', 'INVALID_ARRIVAL_TIME', 'INVALID_BURST_TIME'
    ]);
    assert.deepEqual(out.errors.slice(1).map((e) => [e.index, e.field]),
      [[0, 'arrivalTime'], [0, 'burstTime'], [1, 'arrivalTime'], [1, 'burstTime']]);
    assert.ok(out.errors.every((e) => typeof e.message === 'string' && e.message.length > 0));
    assert.ok(!('results' in out));
  });

  it('caps the number of reported errors for hopeless input', () => {
    const many = Array.from({ length: 500 }, () => ({}));
    const out = E.runSimulation({ processes: many, quantum: 2 });
    assert.equal(out.ok, false);
    assert.ok(out.errors.length <= 110);
    assert.equal(out.errors[out.errors.length - 1].code, 'TOO_MANY_ERRORS');
  });

  it('enforces the limits, and C_LIMITS reproduces the original C limits', () => {
    const lim = { limits: E.C_LIMITS };
    const many = Array.from({ length: 21 }, (_, i) => ({ id: `P${i + 1}`, arrivalTime: 0, burstTime: 1 }));
    assert.deepEqual(errorCodes(run(many, lim)), ['TOO_MANY_PROCESSES']);
    assert.equal(run(many.slice(0, 20), lim).ok, true);
    assert.deepEqual(errorCodes(run([{ ...ok1(), arrivalTime: 1001 }], lim)), ['ARRIVAL_TIME_TOO_LARGE']);
    assert.equal(run([{ ...ok1(), arrivalTime: 1000 }], lim).ok, true);
    assert.deepEqual(errorCodes(run([{ ...ok1(), burstTime: 101 }], lim)), ['BURST_TIME_TOO_LARGE']);
    assert.equal(run([{ ...ok1(), burstTime: 100 }], lim).ok, true);
    assert.deepEqual(errorCodes(E.runSimulation({ processes: [ok1()], quantum: 101, limits: E.C_LIMITS })), ['QUANTUM_TOO_LARGE']);
    // Without C_LIMITS the same values are fine.
    assert.equal(run([{ ...ok1(), arrivalTime: 1001, burstTime: 101 }]).ok, true);
    assert.equal(run(many).ok, true);
  });

  it('rejects bad limit overrides', () => {
    for (const limits of [5, 'x', [], { maxProcesses: 0 }, { maxProcesses: 1.5 }, { nope: 1 }]) {
      assert.deepEqual(errorCodes(run([ok1()], { limits })), ['INVALID_LIMITS'], JSON.stringify(limits));
    }
    assert.equal(run([ok1()], { limits: { maxProcesses: 1 } }).ok, true);
    assert.deepEqual(errorCodes(run([ok1(), { ...ok1(), id: 'P2' }], { limits: { maxProcesses: 1 } })), ['TOO_MANY_PROCESSES']);
  });

  it('never throws on arbitrary garbage', () => {
    const garbage = [undefined, null, 0, 'text', [], [[]], {}, { processes: null }, { processes: [null] },
      { processes: [{}], algorithms: {} }, Symbol('s'), () => 1];
    for (const g of garbage) {
      assert.doesNotThrow(() => E.runSimulation(g));
      assert.doesNotThrow(() => E.validateInput(g));
      assert.doesNotThrow(() => E.runFCFS(g));
      assert.doesNotThrow(() => E.runSJN(g));
      assert.doesNotThrow(() => E.runRoundRobin(g, g));
      assert.equal(E.runSimulation(g).ok, false);
    }
  });

  it('validateInput returns the normalized request', () => {
    const v = E.validateInput({ processes: [{ id: ' A ', arrivalTime: '1', burstTime: '2' }], quantum: '3', algorithms: 'rr' });
    assert.equal(v.ok, true);
    assert.deepEqual(v.normalized.processes, [{ id: 'A', arrivalTime: 1, burstTime: 2 }]);
    assert.equal(v.normalized.quantum, 3);
    assert.deepEqual(v.normalized.algorithms, ['RR']);
    assert.deepEqual(v.normalized.limits, E.DEFAULT_LIMITS);
  });
});

// --------------------------------------------- 4. invariants, scale, portability

describe('Randomized invariants', () => {
  /** Independent check: SJN never starts a job while a strictly better one is ready. */
  function assertSjnChoicesValid(workload, result) {
    const byId = new Map(workload.map((p, i) => [p.id, { ...p, index: i }]));
    const done = new Set();
    for (const g of result.gantt) {
      if (g.type !== 'run') continue;
      const chosen = byId.get(g.process);
      for (const other of byId.values()) {
        if (done.has(other.id) || other.id === chosen.id || other.arrivalTime > g.start) continue;
        const better = other.burstTime < chosen.burstTime ||
          (other.burstTime === chosen.burstTime && other.arrivalTime < chosen.arrivalTime) ||
          (other.burstTime === chosen.burstTime && other.arrivalTime === chosen.arrivalTime && other.index < chosen.index);
        assert.ok(!better, `${chosen.id} started at ${g.start} although ${other.id} was a better choice`);
      }
      done.add(chosen.id);
    }
  }

  it('300 random workloads: all algorithms satisfy the scheduling invariants', () => {
    const r = rng(20240601);
    for (let iter = 0; iter < 300; iter++) {
      const shape = iter % 3;
      const w = shape === 0 ? randomWorkload(r, 8, 10, 10)
        : shape === 1 ? randomWorkload(r, 12, 60, 8)
        : randomWorkload(r, 30, 25, 25);
      const q = randInt(r, 1, 9);
      const out = E.runSimulation({ processes: w, quantum: q });
      assert.equal(out.ok, true, JSON.stringify(out.errors));

      for (const res of out.results) {
        assert.deepEqual(E.verifyResult(res), []);
        // Independent re-derivation of the basic invariants.
        let t = 0;
        const ran = new Map();
        for (const g of res.gantt) {
          assert.equal(g.start, t, `${res.algorithm}: gap or overlap at ${t}`);
          assert.ok(g.end > g.start);
          t = g.end;
          if (g.type === 'run') {
            const p = w.find((x) => x.id === g.process);
            assert.ok(g.start >= p.arrivalTime, 'ran before arrival');
            ran.set(g.process, (ran.get(g.process) || 0) + g.duration);
          }
        }
        assert.equal(t, res.summary.totalTime);
        for (const p of w) assert.equal(ran.get(p.id), p.burstTime);
        const sumBurst = w.reduce((s, p) => s + p.burstTime, 0);
        assert.equal(res.summary.busyTime, sumBurst);
        close(res.summary.cpuUtilization, (100 * sumBurst) / res.summary.totalTime, 'utilization');
        for (const p of res.processes) {
          assert.equal(p.turnaroundTime, p.waitingTime + p.burstTime);
          assert.ok(p.responseTime >= 0 && p.responseTime <= p.waitingTime);
        }
      }

      // Non-preemptive algorithms give each process exactly one block.
      for (const key of ['FCFS', 'SJN']) {
        const runs = out.byAlgorithm[key].gantt.filter((g) => g.type === 'run');
        assert.equal(runs.length, w.length);
      }
      // All algorithms are work-conserving, so they finish at the same time
      // (the instant the last unit of work is done).
      assert.equal(out.byAlgorithm.FCFS.summary.totalTime, out.byAlgorithm.SJN.summary.totalTime);
      assert.equal(out.byAlgorithm.FCFS.summary.totalTime, out.byAlgorithm.RR.summary.totalTime);
      assertSjnChoicesValid(w, out.byAlgorithm.SJN);
    }
  });

  it('SJN average waiting time <= FCFS when every process arrives at time 0', () => {
    const r = rng(7);
    for (let iter = 0; iter < 100; iter++) {
      const n = randInt(r, 1, 15);
      const w = procs(Array.from({ length: n }, (_, i) => [`P${i + 1}`, 0, randInt(r, 1, 30)]));
      const out = E.runSimulation({ processes: w, algorithms: ['FCFS', 'SJN'] });
      assert.ok(out.byAlgorithm.SJN.summary.averageWaitingTime <= out.byAlgorithm.FCFS.summary.averageWaitingTime + 1e-9);
    }
  });

  it('verifyResult detects tampered results', () => {
    const good = E.runRoundRobin(procs([['P1', 0, 4], ['P2', 1, 3]]), 2);
    assert.deepEqual(E.verifyResult(good), []);

    const gap = JSON.parse(JSON.stringify(good));
    gap.events[1].start += 1;
    assert.ok(E.verifyResult(gap).length > 0);

    const wrongMetric = JSON.parse(JSON.stringify(good));
    wrongMetric.processes[0].waitingTime += 1;
    assert.ok(E.verifyResult(wrongMetric).length > 0);

    const wrongSwitches = JSON.parse(JSON.stringify(good));
    wrongSwitches.summary.contextSwitches += 1;
    assert.ok(E.verifyResult(wrongSwitches).length > 0);

    assert.ok(E.verifyResult(null).length > 0);
    assert.ok(E.verifyResult({}).length > 0);
  });
});

describe('Large workloads and limits', () => {
  it('handles 2000 processes in all three algorithms quickly and correctly', () => {
    const r = rng(99);
    const w = procs(Array.from({ length: 2000 }, (_, i) => [`P${i + 1}`, randInt(r, 0, 3000), randInt(r, 1, 30)]));
    const started = Date.now();
    const out = E.runSimulation({ processes: w, quantum: 5 });
    const elapsed = Date.now() - started;
    assert.equal(out.ok, true, JSON.stringify(out.errors));
    for (const res of out.results) assert.deepEqual(E.verifyResult(res), []);
    assert.ok(elapsed < 5000, `took ${elapsed} ms`);
  });

  it('rejects more processes than the default limit', () => {
    const w = procs(Array.from({ length: E.DEFAULT_LIMITS.maxProcesses + 1 }, (_, i) => [`P${i}`, 0, 1]));
    assert.deepEqual(errorCodes(E.runSimulation({ processes: w, quantum: 1 })), ['TOO_MANY_PROCESSES']);
  });

  it('one long process with quantum 1 collapses to a single Gantt block', () => {
    const r = E.runRoundRobin(procs([['P1', 0, 500000]]), 1);
    assert.equal(r.ok, true);
    assert.deepEqual(gantt(r), ['P1:0-500000']);
    assert.equal(r.summary.contextSwitches, 0);
  });

  it('stops with EVENT_LIMIT_EXCEEDED instead of exhausting memory', () => {
    const w = procs([['P1', 0, 1000000], ['P2', 0, 1000000]]);
    const out = E.runRoundRobin(w, 1);
    assert.deepEqual(errorCodes(out), ['EVENT_LIMIT_EXCEEDED']);
    assert.equal(out.errors[0].algorithm, 'RR');
    // FCFS/SJN of the same workload are fine, but the simulation is all-or-nothing.
    assert.equal(E.runFCFS(w).ok, true);
    assert.equal(E.runSimulation({ processes: w, quantum: 1 }).ok, false);
    // A larger quantum fits.
    assert.equal(E.runRoundRobin(w, 100000).ok, true);
  });

  it('maxEvents counts idle events and context-switch markers like the C MAX_EVENTS', () => {
    // FCFS of 3 back-to-back processes = 3 runs + 2 switch markers = 5 events.
    const w = procs([['P1', 0, 1], ['P2', 0, 1], ['P3', 0, 1]]);
    assert.equal(E.runFCFS(w, { limits: { maxEvents: 5 } }).ok, true);
    assert.deepEqual(errorCodes(E.runFCFS(w, { limits: { maxEvents: 4 } })), ['EVENT_LIMIT_EXCEEDED']);
  });
});

describe('Portability', () => {
  it('runs in a bare JavaScript context with no DOM, window, document or require', () => {
    const src = fs.readFileSync(path.join(__dirname, 'scheduler-engine.js'), 'utf8');
    const sandbox = {};
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox);
    assert.equal(typeof sandbox.SchedulerEngine.runSimulation, 'function');
    const out = vm.runInContext(
      `JSON.stringify(SchedulerEngine.runFCFS([{id:'A',arrivalTime:0,burstTime:2}]).gantt)`, sandbox);
    assert.equal(out, JSON.stringify([{ type: 'run', process: 'A', label: 'A', start: 0, end: 2, duration: 2 }]));
  });

  it('exports the documented API', () => {
    for (const fn of ['runSimulation', 'runFCFS', 'runSJN', 'runRoundRobin', 'validateInput', 'verifyResult']) {
      assert.equal(typeof E[fn], 'function', fn);
    }
    assert.equal(E.IDLE_LABEL, 'IDLE');
    assert.ok(Object.isFrozen(E.DEFAULT_LIMITS) && Object.isFrozen(E.C_LIMITS));
  });
});

// ------------------------------------------- 5. differential test vs scheduler.c

const C_HARNESS_SOURCE = (cPath) => `
#define main scheduler_c_main
#include ${JSON.stringify(cPath.replace(/\\/g, '/'))}
#undef main
int main(void) {
  int n, q, i, rc;
  int a[64], b[64];
  if (scanf("%d", &n) != 1 || n < 0 || n > 64) return 90;
  for (i = 0; i < n; i++) if (scanf("%d %d", &a[i], &b[i]) != 2) return 91;
  if (scanf("%d", &q) != 1) return 92;
  rc = simulate_from_web(n, a, b, q);
  return rc == 0 ? 0 : (rc == -1 ? 10 : 11);
}
`;

function setupCReference() {
  const cPath = path.join(__dirname, 'scheduler.c');
  if (!fs.existsSync(cPath)) return { reason: 'scheduler.c not found next to the test file' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'race-arena-c-'));
  const harness = path.join(dir, 'harness.c');
  const exe = path.join(dir, process.platform === 'win32' ? 'harness.exe' : 'harness');
  fs.writeFileSync(harness, C_HARNESS_SOURCE(cPath));
  for (const cc of ['gcc', 'cc', 'clang']) {
    const r = spawnSync(cc, ['-O1', '-o', exe, harness], { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(exe)) return { dir, exe };
  }
  return { reason: 'no C compiler (gcc, cc or clang) found on PATH' };
}

const C_REF = setupCReference();
after(() => {
  if (C_REF.dir) fs.rmSync(C_REF.dir, { recursive: true, force: true });
});

/** Runs the original scheduler.c. Returns {rc, json}; rc 0 = success, 10 = rejected input, 11 = self-check failed. */
function runOriginalC(workload, quantum) {
  const jsonPath = path.join(C_REF.dir, 'timeline-web.json');
  fs.rmSync(jsonPath, { force: true });
  const input = [workload.length, ...workload.map((p) => `${p.arrivalTime} ${p.burstTime}`), quantum].join('\n') + '\n';
  const r = spawnSync(C_REF.exe, [], { cwd: C_REF.dir, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  assert.equal(r.error, undefined, String(r.error));
  const rc = r.status;
  return { rc, json: rc === 0 ? JSON.parse(fs.readFileSync(jsonPath, 'utf8')) : null };
}

function compareWithC(label, workload, quantum) {
  const c = runOriginalC(workload, quantum);
  assert.equal(c.rc, 0, `${label}: original C failed with code ${c.rc}`);
  const js = E.runSimulation({ processes: workload, quantum });
  assert.equal(js.ok, true, `${label}: ${JSON.stringify(js.errors)}`);

  for (const key of ['FCFS', 'SJN', 'RR']) {
    const cAlg = c.json.algorithms[key];
    const jsAlg = js.byAlgorithm[key];
    const tag = `${label} / ${key}`;

    const cEvents = cAlg.events.map((e) => [e.type, e.process, e.from ?? null, e.to ?? null, e.start, e.end]);
    const jsEvents = jsAlg.events.map((e) => [e.type, e.process, e.from ?? null, e.to ?? null, e.start, e.end]);
    assert.deepEqual(jsEvents, cEvents, `${tag}: events differ`);

    assert.equal(jsAlg.processes.length, cAlg.process_metrics.length, tag);
    jsAlg.processes.forEach((p, i) => {
      const m = cAlg.process_metrics[i];
      assert.deepEqual(
        [p.id, p.arrivalTime, p.burstTime, p.completionTime, p.turnaroundTime, p.waitingTime, p.responseTime],
        [m.id, m.arrival, m.burst, m.completion_time, m.turnaround_time, m.waiting_time, m.response_time],
        `${tag}: metrics of ${p.id} differ`);
    });

    const s = jsAlg.summary;
    const near = (x, y, what) => assert.ok(Math.abs(x - y) <= 5.1e-5, `${tag}: ${what} ${x} vs C ${y}`); // C prints %.4f
    near(s.averageWaitingTime, cAlg.average_waiting_time, 'average waiting');
    near(s.averageTurnaroundTime, cAlg.average_turnaround_time, 'average turnaround');
    near(s.averageResponseTime, cAlg.average_response_time, 'average response');
    near(s.cpuUtilization, cAlg.cpu_utilization, 'cpu utilization');
    assert.equal(s.contextSwitches, cAlg.context_switches, `${tag}: context switches`);
    assert.equal(s.totalTime, cAlg.total_time, `${tag}: total time`);
  }
}

describe('Differential test against the original scheduler.c', { skip: C_REF.reason }, () => {
  it('matches the C output for the sample workloads', () => {
    compareWithC('A q=2', procs([['P1', 0, 5], ['P2', 1, 3], ['P3', 2, 8], ['P4', 3, 6]]), 2);
    compareWithC('B q=2', procs([['P1', 3, 2], ['P2', 10, 1], ['P3', 11, 4]]), 2);
    compareWithC('C q=3', procs([['P1', 0, 6], ['P2', 1, 3], ['P3', 1, 3], ['P4', 2, 2]]), 3);
    compareWithC('RR ordering', procs([['P1', 0, 4], ['P2', 2, 4], ['P3', 4, 2]]), 2);
    compareWithC('single', procs([['P1', 4, 7]]), 3);
  });

  it('matches the C output on 250 random workloads (events, metrics, switches, utilization)', () => {
    const r = rng(424242);
    for (let i = 0; i < 250; i++) {
      const shape = i % 5;
      let w;
      if (shape === 0) w = randomWorkload(r, 8, 10, 10);          // dense
      else if (shape === 1) w = randomWorkload(r, 8, 80, 8);      // sparse, idle gaps
      else if (shape === 2) w = randomWorkload(r, 20, 40, 40);    // up to the C process limit
      else if (shape === 3) w = randomWorkload(r, 10, 0, 12);     // everyone arrives at 0
      else w = procs(Array.from({ length: randInt(r, 1, 10) }, (_, k) => [`P${k + 1}`, randInt(r, 0, 12), 4])); // equal bursts
      const q = randInt(r, 1, shape === 2 ? 12 : 6);
      compareWithC(`random #${i} (q=${q})`, w, q);
    }
  });

  it('documents a C limitation: MAX_EVENTS makes some valid workloads fail in C', () => {
    // 20 processes x burst 100 at quantum 1 needs ~4000 timeline events; C stores 3000.
    const w = procs(Array.from({ length: 20 }, (_, i) => [`P${i + 1}`, 0, 100]));
    assert.equal(runOriginalC(w, 1).rc, 11, 'original C is expected to fail its self-check here');
    // The JS engine with the default limits completes it ...
    const ok = E.runSimulation({ processes: w, quantum: 1 });
    assert.equal(ok.ok, true);
    assert.ok(ok.byAlgorithm.RR.events.length > E.C_LIMITS.maxEvents);
    // ... and with C_LIMITS it fails the same way the C program does.
    const strict = E.runSimulation({ processes: w, quantum: 1, limits: E.C_LIMITS });
    assert.deepEqual(errorCodes(strict), ['EVENT_LIMIT_EXCEEDED']);
    // One step up in quantum works in both.
    assert.equal(runOriginalC(w, 2).rc, 0);
    assert.equal(E.runSimulation({ processes: w, quantum: 2, limits: E.C_LIMITS }).ok, true);
  });
});
