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
  }

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
          (t.params.fieldId === targetKey || t.params.slot === targetKey)
        );
        if (isDuplicate) {
          TravianLogger.log('DEBUG', `[TaskQueue] Skipped duplicate ${type} for target ${targetKey}`);
          return null;
        }
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
    return true;
  }

  /**
   * Get the highest priority ready task and mark it as running.
   * A task is ready if it is pending and its scheduledFor time has passed (or is null).
   * Tasks are sorted by priority (ascending) then createdAt (ascending).
   * @returns {object|null} The next task, or null if none ready
   */
  getNext() {
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
    for (const key of Object.keys(updates)) {
      if (allowedFields.includes(key)) {
        task[key] = updates[key];
      }
    }
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
    } else {
      // Put back to pending for retry
      task.status = 'pending';
    }
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
  }

  /**
   * Remove all completed tasks from the queue
   * @returns {number} Number of tasks removed
   */
  clearCompleted() {
    const before = this.queue.length;
    this.queue = this.queue.filter(t => t.status !== 'completed');
    return before - this.queue.length;
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
}

// Export for service worker context
self.TravianTaskQueue = TaskQueue;
