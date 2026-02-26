/**
 * Scheduler - Manages timing and recurring cycles for Travian Bot
 * Runs in service worker context (no DOM, no window)
 * Exported via self.TravianScheduler
 */

class Scheduler {
  constructor() {
    /** @type {Map<string, {timerId: number, callback: Function, nextRun: number, type: 'once'}>} */
    this.timers = new Map();

    /** @type {Map<string, {timerId: number, callback: Function, intervalMs: number, jitterMs: number, nextRun: number, type: 'cycle'}>} */
    this.cycles = new Map();

    this.running = false;
  }

  /**
   * Start the scheduler. Enables execution of scheduled items.
   */
  start() {
    if (this.running) return;
    this.running = true;
    console.log('[Scheduler] Started');
  }

  /**
   * Stop the scheduler. Cancels all timers and cycles.
   */
  stop() {
    this.running = false;

    // Clear all one-time timers
    for (const [name, entry] of this.timers) {
      clearTimeout(entry.timerId);
    }
    this.timers.clear();

    // Clear all recurring cycles
    for (const [name, entry] of this.cycles) {
      clearTimeout(entry.timerId);
    }
    this.cycles.clear();

    console.log('[Scheduler] Stopped - all timers and cycles cleared');
  }

  /**
   * Generate a random jitter value in the range [-jitterMs, +jitterMs]
   * @param {number} jitterMs - Maximum jitter magnitude in milliseconds
   * @returns {number} Random value between -jitterMs and +jitterMs
   */
  _randomJitter(jitterMs) {
    if (jitterMs <= 0) return 0;
    return Math.floor(Math.random() * (jitterMs * 2 + 1)) - jitterMs;
  }

  /**
   * Schedule a one-time delayed execution
   * @param {string} name - Unique name for this timer
   * @param {Function} callback - Function to execute
   * @param {number} delayMs - Delay in milliseconds
   */
  scheduleOnce(name, callback, delayMs) {
    if (!this.running) {
      console.warn('[Scheduler] Cannot schedule - scheduler is not running');
      return;
    }

    // Cancel existing timer with the same name
    this.cancelSchedule(name);

    const nextRun = Date.now() + delayMs;

    const timerId = setTimeout(() => {
      this.timers.delete(name);
      try {
        callback();
      } catch (err) {
        console.error(`[Scheduler] Error in one-time timer "${name}":`, err);
      }
    }, delayMs);

    this.timers.set(name, {
      timerId: timerId,
      callback: callback,
      nextRun: nextRun,
      type: 'once'
    });

    console.log(`[Scheduler] Scheduled one-time "${name}" in ${delayMs}ms`);
  }

  /**
   * Schedule a recurring cycle with optional jitter.
   * The jitter is recalculated on each iteration so intervals vary naturally.
   * @param {string} name - Unique name for this cycle
   * @param {Function} callback - Function to execute each cycle
   * @param {number} intervalMs - Base interval in milliseconds
   * @param {number} [jitterMs=0] - Maximum jitter in milliseconds (actual interval = intervalMs + random(-jitterMs, +jitterMs))
   */
  scheduleCycle(name, callback, intervalMs, jitterMs = 0) {
    if (!this.running) {
      console.warn('[Scheduler] Cannot schedule - scheduler is not running');
      return;
    }

    // Cancel existing cycle with the same name
    this.cancelSchedule(name);

    const scheduleNext = () => {
      // Recalculate jitter each iteration for natural variance
      const jitter = this._randomJitter(jitterMs);
      const actualInterval = Math.max(1000, intervalMs + jitter); // Minimum 1 second
      const nextRun = Date.now() + actualInterval;

      const timerId = setTimeout(async () => {
        if (!this.running) return;

        // Update next run time before executing (in case callback is slow)
        const entry = this.cycles.get(name);
        if (!entry) return;

        try {
          const result = callback();
          // If callback returns a Promise (async), await it before scheduling next
          if (result && typeof result.then === 'function') {
            await result;
          }
        } catch (err) {
          console.error(`[Scheduler] Error in cycle "${name}":`, err);
        }

        // Schedule next iteration if still running and cycle still exists
        if (this.running && this.cycles.has(name)) {
          scheduleNext();
        }
      }, actualInterval);

      // Store or update cycle entry
      this.cycles.set(name, {
        timerId: timerId,
        callback: callback,
        intervalMs: intervalMs,
        jitterMs: jitterMs,
        nextRun: nextRun,
        type: 'cycle'
      });
    };

    scheduleNext();
    console.log(`[Scheduler] Started cycle "${name}" every ${intervalMs}ms (jitter: +/-${jitterMs}ms)`);
  }

  /**
   * Cancel a named timer or cycle
   * @param {string} name - The name of the timer/cycle to cancel
   * @returns {boolean} True if something was cancelled
   */
  cancelSchedule(name) {
    let cancelled = false;

    if (this.timers.has(name)) {
      clearTimeout(this.timers.get(name).timerId);
      this.timers.delete(name);
      cancelled = true;
    }

    if (this.cycles.has(name)) {
      clearTimeout(this.cycles.get(name).timerId);
      this.cycles.delete(name);
      cancelled = true;
    }

    if (cancelled) {
      console.log(`[Scheduler] Cancelled "${name}"`);
    }

    return cancelled;
  }

  /**
   * Check if a named timer or cycle is currently active
   * @param {string} name
   * @returns {boolean}
   */
  isScheduled(name) {
    return this.timers.has(name) || this.cycles.has(name);
  }

  /**
   * Get the timestamp of the next execution for a named timer or cycle
   * @param {string} name
   * @returns {number|null} Timestamp of next run, or null if not found
   */
  getNextRun(name) {
    if (this.timers.has(name)) {
      return this.timers.get(name).nextRun;
    }
    if (this.cycles.has(name)) {
      return this.cycles.get(name).nextRun;
    }
    return null;
  }

  /**
   * Change the interval of an existing cycle.
   * The cycle is restarted with the new interval.
   * @param {string} name - Name of the cycle to reschedule
   * @param {number} newIntervalMs - New base interval in milliseconds
   * @returns {boolean} True if the cycle was found and rescheduled
   */
  reschedule(name, newIntervalMs) {
    const entry = this.cycles.get(name);
    if (!entry) return false;

    const { callback, jitterMs } = entry;

    // Cancel the old cycle and start a new one with the updated interval
    this.cancelSchedule(name);
    this.scheduleCycle(name, callback, newIntervalMs, jitterMs);

    console.log(`[Scheduler] Rescheduled "${name}" to new interval ${newIntervalMs}ms`);
    return true;
  }

  /**
   * Get status of all scheduled items
   * @returns {object} Map of name -> { type, nextRun, intervalMs?, jitterMs? }
   */
  getStatus() {
    const status = {};

    for (const [name, entry] of this.timers) {
      status[name] = {
        type: 'once',
        nextRun: entry.nextRun,
        remainingMs: Math.max(0, entry.nextRun - Date.now())
      };
    }

    for (const [name, entry] of this.cycles) {
      status[name] = {
        type: 'cycle',
        nextRun: entry.nextRun,
        remainingMs: Math.max(0, entry.nextRun - Date.now()),
        intervalMs: entry.intervalMs,
        jitterMs: entry.jitterMs
      };
    }

    return status;
  }
}

// Export for service worker context
self.TravianScheduler = Scheduler;
