// One Telegram read pause shared by every read-only panel of the Telegram tab.
// The deadline is absolute: it is derived once from retryAfter when the answer arrives, and the remaining time is
// always computed from the clock, so a tab that slept or ran in the background shows the right value on return.
// The adapter stays authoritative; this only avoids asking it again before the deadline.

export const formatWait = seconds => {
  const total = Math.max(0, Math.ceil(seconds));
  return String(Math.floor(total / 60)).padStart(2, '0') + ':' + String(total % 60).padStart(2, '0');
};

const validRetryAfter = value => Number.isInteger(value) && value > 0 && value <= 2_147_483_647;

export function telegramPause({ now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let until = 0;
  let timer;
  // key -> { render(secondsLeft), resume() }. A task resumes at most once per wait.
  const tasks = new Map();
  const remaining = () => Math.max(0, Math.ceil((until - now()) / 1000));

  function schedule() {
    clearTimer(timer);
    timer = undefined;
    if (!tasks.size) return;
    const left = until - now();
    // Wake on each second boundary of the deadline: the display changes exactly when the number does.
    timer = setTimer(tick, left > 0 ? (left % 1000) || 1000 : 0);
  }

  function tick() {
    timer = undefined;
    const left = remaining();
    if (left > 0) {
      for (const task of tasks.values()) task.render?.(left);
      schedule();
      return;
    }
    const due = [...tasks.values()];
    tasks.clear();
    for (const task of due) {
      task.render?.(0);
      task.resume?.();
    }
  }

  return {
    remaining,
    deadline: () => (until > now() ? until : undefined),
    // Records a rate limit answer. Without a valid retryAfter the wait is unknown: no seconds are invented.
    record(data) {
      if (data?.state === 'rate_limited' && validRetryAfter(data.retryAfter)) {
        until = Math.max(until, now() + data.retryAfter * 1000);
      }
      return { state: 'rate_limited', retryAfter: remaining() || undefined };
    },
    // Registers (or replaces) the task paused under `key`. Returns false when there is no known deadline.
    wait(key, task) {
      if (!remaining()) return false;
      tasks.set(key, task);
      task.render?.(remaining());
      schedule();
      return true;
    },
    cancel(key) {
      tasks.delete(key);
      if (!tasks.size) schedule();
    },
    waiting: key => tasks.has(key),
    // Called when the page becomes visible again: redraws from the clock and never adds a second resume.
    refresh() {
      if (!tasks.size) return;
      clearTimer(timer);
      tick();
    },
  };
}

export const sharedTelegramPause = telegramPause();
