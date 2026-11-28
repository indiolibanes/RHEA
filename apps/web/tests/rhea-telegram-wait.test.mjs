import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatWait, telegramPause } from '../src/rhea/library/telegram-wait.mjs';

function fakeClock() {
  let time = 1_000_000;
  const timers = new Map();
  let id = 0;
  return {
    now: () => time,
    setTimer: (fn, ms) => { timers.set(++id, { fn, at: time + ms }); return id; },
    clearTimer: key => { timers.delete(key); },
    // Advances the clock and fires due timers in order, like a real event loop.
    advance(ms) {
      const end = time + ms;
      for (;;) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        timers.delete(next[0]);
        time = next[1].at;
        next[1].fn();
      }
      time = end;
    },
    jump(ms) { time += ms; },
    pending: () => timers.size,
  };
}

test('formats the remaining time as mm:ss', () => {
  assert.equal(formatWait(12), '00:12');
  assert.equal(formatWait(75), '01:15');
  assert.equal(formatWait(0.2), '00:01');
});

test('counts down from an absolute deadline and resumes exactly once when it ends', () => {
  const clock = fakeClock();
  const pause = telegramPause(clock);
  pause.record({ state: 'rate_limited', retryAfter: 12 });
  const shown = [];
  let resumes = 0;
  assert.equal(pause.wait('letter', { render: left => shown.push(left), resume: () => resumes++ }), true);
  clock.advance(5_000);
  assert.deepEqual(shown, [12, 11, 10, 9, 8, 7]);
  assert.equal(resumes, 0);
  clock.advance(7_000);
  assert.equal(resumes, 1);
  assert.equal(shown.at(-1), 0);
  clock.advance(30_000);
  assert.equal(resumes, 1);
  assert.equal(clock.pending(), 0);
});

test('after a suspension the display is recalculated from the clock without a second resume', () => {
  const clock = fakeClock();
  const pause = telegramPause(clock);
  pause.record({ state: 'rate_limited', retryAfter: 12 });
  const shown = [];
  let resumes = 0;
  pause.wait('requests', { render: left => shown.push(left), resume: () => resumes++ });
  clock.jump(8_400); // the tab slept; no timer ran
  pause.refresh();
  assert.equal(shown.at(-1), 4);
  clock.jump(10_000);
  pause.refresh();
  pause.refresh();
  clock.advance(5_000);
  assert.equal(resumes, 1);
});

test('an unknown wait never invents seconds and schedules nothing', () => {
  const clock = fakeClock();
  const pause = telegramPause(clock);
  assert.deepEqual(pause.record({ state: 'rate_limited' }), { state: 'rate_limited', retryAfter: undefined });
  assert.equal(pause.wait('letter', { resume() { throw new Error('must not resume'); } }), false);
  assert.equal(clock.pending(), 0);
});

test('a longer legitimate wait extends the deadline; cancelled tasks do not resume', () => {
  const clock = fakeClock();
  const pause = telegramPause(clock);
  pause.record({ state: 'rate_limited', retryAfter: 5 });
  let resumed = [];
  pause.wait('a', { resume: () => resumed.push('a') });
  pause.wait('b', { resume: () => resumed.push('b') });
  pause.cancel('b');
  clock.advance(2_000);
  pause.record({ state: 'rate_limited', retryAfter: 10 });
  assert.equal(pause.remaining(), 10);
  clock.advance(5_000);
  assert.deepEqual(resumed, []);
  clock.advance(5_000);
  assert.deepEqual(resumed, ['a']);
});
