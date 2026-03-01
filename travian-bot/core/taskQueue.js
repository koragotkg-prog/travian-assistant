/**
 * TaskQueue - Priority task queue system for Travian Bot
 * Runs in service worker context (no DOM, no window)
 * Exported via self.TravianTaskQueue
 */

class TaskQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.maxRetries = 3;
    this._idCounter = 0;

    // Auto-cleanup: max age for completed/failed tasks (ms)
    this._maxTaskAgeMs = 10 * 60 * 1000; // 10 minutes

    // Stuck task recovery: max time a task can stay in 'running' state (ms)
    // If a task exceeds this, it's assumed the service worker died mid-execution
    // and the task is reset to 'pending' for retry.
    this._maxRunningAgeMs = 2 * 60 * 1000; // 2 minutes

    // FIX-P5: Dirty tracking for persistence.
    // When _dirtyAt > 0, BotEngine's persistence cycle should flush immediately.
    // Prevents lost tasks when SW dies between scheduled 60s persistence cycles.
    this._dirtyAt = 0;

    // FIX-P6: Throttle recoverStuckTasks to avoid O(n) scan every getNext()
    this._lastRecoveryCheck = 0;
    this._recoveryCheckIntervalMs = 30000; // 30 seconds
  }

  /** @returns {number} Timestamp when queue was last mutated, or 0 if clean */
  get dirtyAt() { return this._dirtyAt; }

  /** Mark queue as persisted (clean) */
  markClean() { this._dirtyAt = 0; }

  /**
   * Generate a unique task ID
   * @returns {string}
   */
  _generateId() {
    this._idCounter++;
    return `task_${Date.now()}_${this._idCounter}`;
  }

  /**
   * Add a new task to the queue
   * @param {string} type - Task type (e.g. 'upgrade_resource', 'upgrade_building', 'train_troops', 'send_farm', 'switch_village', 'navigate')
   * @param {object} params - Task-specific parameters
   * @param {number} [priority=5] - Priority level (1=highest, 10=lowest)
   * @param {string|null} [villageId=null] - Target village ID
   * @param {number|null} [scheduledFor=null] - Timestamp for delayed execution
   * @returns {string|null} The generated task ID, or null if duplicate was skipped
   */
  add(type, params = {}, priority = 5, villageId = null, scheduledFor = null) {
    // BUILD QUEUE GUARD: prevent duplicate build tasks for same slot/field
    if (['upgrade_resource', 'upgrade_building', 'build_new'].includes(type)) {
      const targetKey = params.fieldId || params.slot || params.gid || null;
      if (targetKey) {
        const isDuplicate = this.queue.some(t =>
          t.type === type &&
          t.villageId === villageId &&
          t.status !== 'completed' && t.status !== 'failed' &&
          (t.params.fieldId === targetKey || t.params.slot === targetKey || t.params.gid === targetKey)
        );
        if (isDuplicate) {
          TravianLogger.log('DEBUG', `[TaskQueue] Skipped duplicate ${type} for target ${targetKey}`);
          return null;
        }
      }
    }

    // TROOP GUARD: prevent duplicate train_troops for the same buildingType
    // (allows barracks + stable tasks simultaneously, blocks barracks + barracks)
    if (type === 'train_troops') {
      const bldType = params.buildingType || 'barracks';
      const hasPendingTroop = this.queue.some(t =>
        t.type === 'train_troops' &&
        t.villageId === villageId &&
        (t.params.buildingType || 'barracks') === bldType &&
        t.status !== 'completed' && t.status !== 'failed'
      );
      if (hasPendingTroop) {
        TravianLogger.log('DEBUG', `[TaskQueue] Skipped duplicate train_troops for ${bldType}`);
        return null;
      }
    }

    // FARM GUARD: prevent duplicate farm tasks
    if (type === 'send_farm') {
      const hasPendingFarm = this.queue.some(t =>
        t.type === 'send_farm' &&
        t.villageId === villageId &&
        t.status !== 'completed' && t.status !== 'failed'
      );
      if (hasPendingFarm) {
        TravianLogger.log('DEBUG', '[TaskQueue] Skipped duplicate send_farm');
        return null;
      }
    }

    const task = {
      id: this._generateId(),
      type: type,
      priority: Math.max(1, Math.min(10, priority)),
      villageId: villageId,
      params: params,
      status: 'pending',
      retries: 0,
      maxRetries: this.maxRetries,
      createdAt: Date.now(),
      scheduledFor: scheduledFor,
      error: null
    };

    this.queue.push(task);
    this._dirtyAt = Date.now(); // FIX-P5
    return task.id;
  }

  /**
   * Remove a task from the queue by ID
   * @param {string} taskId
   * @returns {boolean} True if task was found and removed
   */
  remove(taskId) {
    const index = this.queue.findIndex(t => t.id === taskId);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    this._dirtyAt = Date.now(); // FIX-P5
    return true;
  }

  /**
   * Get the highest priority ready task and mark it as running.
   * A task is ready if it is pending and its scheduledFor time has passed (or is null).
   * Tasks are sorted by priority (ascending) then createdAt (ascending).
   * @returns {object|null} The next task, or null if none ready
   */
  getNext() {
    // Recover any tasks stuck in 'running' from a previous SW death
    this.recoverStuckTasks();

    const now = Date.now();

    // Filter for tasks that are pending and ready to run
    const readyTasks = this.queue.filter(t =>
      t.status === 'pending' &&
      (t.scheduledFor === null || t.scheduledFor <= now)
    );

    if (readyTasks.length === 0) return null;

    // Sort by priority (lower number = higher priority), then by createdAt (older first)
    readyTasks.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.createdAt - b.createdAt;
    });

    const nextTask = readyTasks[0];
    nextTask.status = 'running';
    nextTask._startedAt = Date.now();
    this._dirtyAt = Date.now(); // FIX: getNext() mutates status — must mark dirty
    return nextTask;
  }

  /**
   * View the next ready task without changing its status
   * @returns {object|null} The next task, or null if none ready
   */
  peek() {
    const now = Date.now();

    const readyTasks = this.queue.filter(t =>
      t.status === 'pending' &&
      (t.scheduledFor === null || t.scheduledFor <= now)
    );

    if (readyTasks.length === 0) return null;

    readyTasks.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.createdAt - b.createdAt;
    });

    return readyTasks[0];
  }

  /**
   * Update fields of an existing task
   * @param {string} taskId
   * @param {object} updates - Key/value pairs to update
   * @returns {boolean} True if task was found and updated
   */
  update(taskId, updates) {
    const task = this.queue.find(t => t.id === taskId);
    if (!task) return false;

    // Only allow updating safe fields
    const allowedFields = ['priority', 'params', 'status', 'scheduledFor', 'villageId', 'error', 'retries', 'maxRetries'];
    let changed = false;
    for (const key of Object.keys(updates)) {
      if (allowedFields.includes(key)) {
        task[key] = updates[key];
        changed = true;
      }
    }
    if (changed) this._dirtyAt = Date.now(); // FIX: update() mutates task — must mark dirty
    return true;
  }

  /**
   * Mark a task as completed
   * @param {string} taskId
   * @returns {boolean} True if task was found
   */
  markCompleted(taskId) {
    const task = this.queue.find(t => t.id === taskId);
    if (!task) return false;
    task.status = 'completed';
    task.error = null;
    this._dirtyAt = Date.now(); // FIX-P5
    this.cleanup(); // Auto-remove stale terminal tasks
    return true;
  }

  /**
   * Mark a task as failed. Increments retry counter.
   * If retries exceed maxRetries, status is set to 'failed'.
   * Otherwise, status is set back to 'pending' for retry.
   * @param {string} taskId
   * @param {string} error - Error description
   * @returns {boolean} True if task was found
   */
  markFailed(taskId, error) {
    const task = this.queue.find(t => t.id === taskId);
    if (!task) return false;

    task.retries++;
    task.error = error;

    if (task.retries >= task.maxRetries) {
      task.status = 'failed';
      this.cleanup(); // Auto-remove stale terminal tasks
    } else {
      // Put back to pending for retry
      task.status = 'pending';
    }
    this._dirtyAt = Date.now(); // FIX-P5
    return true;
  }

  /**
   * Get all tasks in the queue
   * @returns {Array} Copy of all tasks
   */
  getAll() {
    return [...this.queue];
  }

  /**
   * Get tasks filtered by village ID
   * @param {string} villageId
   * @returns {Array} Tasks matching the village ID
   */
  getByVillage(villageId) {
    return this.queue.filter(t => t.villageId === villageId);
  }

  /**
   * Get tasks filtered by type
   * @param {string} type
   * @returns {Array} Tasks matching the type
   */
  getByType(type) {
    return this.queue.filter(t => t.type === type);
  }

  /**
   * Remove all tasks from the queue
   */
  clear() {
    this.queue = [];
    this._dirtyAt = Date.now(); // FIX-P5
  }

  /**
   * Remove all completed tasks from the queue
   * @returns {number} Number of tasks removed
   */
  clearCompleted() {
    const before = this.queue.length;
    this.queue = this.queue.filter(t => t.status !== 'completed');
    const removed = before - this.queue.length;
    if (removed > 0) this._dirtyAt = Date.now(); // FIX: clearCompleted() mutates queue — must mark dirty
    return removed;
  }

  /**
   * Auto-cleanup: remove completed/failed tasks older than _maxTaskAgeMs.
   * Called automatically after markCompleted/markFailed.
   * @returns {number} Number of tasks removed
   */
  cleanup() {
    const now = Date.now();
    const maxAge = this._maxTaskAgeMs;
    const before = this.queue.length;

    this.queue = this.queue.filter(t => {
      if (t.status !== 'completed' && t.status !== 'failed') return true;
      // Keep recent terminal tasks for UI display
      const age = now - (t.createdAt || 0);
      return age < maxAge;
    });

    const removed = before - this.queue.length;
    if (removed > 0) {
      this._dirtyAt = Date.now(); // Ensure cleaned queue is persisted
      TravianLogger.log('DEBUG', `[TaskQueue] Cleanup: removed ${removed} stale tasks (${this.queue.length} remain)`);
    }
    return removed;
  }

  /**
   * Recover tasks stuck in 'running' state longer than _maxRunningAgeMs.
   * This handles the case where the service worker was killed mid-execution.
   * Stuck tasks are reset to 'pending' with an incremented retry counter.
   * @returns {number} Number of tasks recovered
   */
  recoverStuckTasks() {
    const now = Date.now();

    // FIX-P6: Throttle to avoid O(n) scan every getNext() call.
    // Stuck tasks only happen on SW death (rare), so 30s intervals are fine.
    if (now - this._lastRecoveryCheck < this._recoveryCheckIntervalMs) {
      return 0;
    }
    this._lastRecoveryCheck = now;

    let recovered = 0;

    for (const task of this.queue) {
      if (task.status !== 'running') continue;

      const runningFor = now - (task._startedAt || task.createdAt);
      if (runningFor > this._maxRunningAgeMs) {
        task.retries++;
        if (task.retries >= task.maxRetries) {
          task.status = 'failed';
          task.error = 'Stuck in running state for ' + Math.round(runningFor / 1000) + 's (SW likely died)';
          TravianLogger.log('WARN', `[TaskQueue] Task ${task.id} (${task.type}) permanently failed — stuck for ${Math.round(runningFor / 1000)}s, max retries reached`);
        } else {
          task.status = 'pending';
          task._startedAt = null;
          task.error = 'Recovered from stuck running state after ' + Math.round(runningFor / 1000) + 's';
          TravianLogger.log('WARN', `[TaskQueue] Recovered stuck task ${task.id} (${task.type}) — was running for ${Math.round(runningFor / 1000)}s, retry ${task.retries}/${task.maxRetries}`);
        }
        recovered++;
      }
    }

    if (recovered > 0) this._dirtyAt = Date.now(); // FIX: recoverStuckTasks() mutates tasks — must mark dirty
    return recovered;
  }

  /**
   * Count the number of pending tasks
   * @returns {number}
   */
  size() {
    return this.queue.filter(t => t.status === 'pending').length;
  }

  /**
   * Check if a task of the given type already exists for the given village.
   * Useful to prevent duplicate task creation.
   * @param {string} type - Task type to check
   * @param {string|null} [villageId=null] - Village ID to check (null matches tasks with no village)
   * @returns {boolean} True if a matching pending/running task exists
   */
  hasTaskOfType(type, villageId = null) {
    return this.queue.some(t =>
      t.type === type &&
      t.villageId === villageId &&
      (t.status === 'pending' || t.status === 'running')
    );
  }

  /**
   * TQ-1 FIX: Check if ANY pending/running task of the given type exists,
   * regardless of villageId. Prevents dedup mismatches when AI scoring path
   * queues with null but fallback path uses actual villageId (or vice versa).
   * @param {string} type - Task type to check
   * @returns {boolean} True if ANY matching pending/running task exists
   */
  hasAnyTaskOfType(type) {
    return this.queue.some(t =>
      t.type === type &&
      (t.status === 'pending' || t.status === 'running')
    );
  }
}

// Export for service worker context
self.TravianTaskQueue = TaskQueue;
