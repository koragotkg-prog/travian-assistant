/**
 * UI Client - Shared communication logic for Dashboard and Popup
 * Handles messaging with the background Service Worker.
 */

const UIClient = {
  // ---------------------------------------------------------------------------
  // Core Status & Control
  // ---------------------------------------------------------------------------

  /**
   * Get list of all known servers
   * @returns {Promise<object>} { instances: [], registry: {} }
   */
  async getServers() {
    return this._sendMessage({ type: 'GET_SERVERS' });
  },

  /**
   * Get full bot status from background
   * @param {string} [serverKey] - Optional server key
   * @returns {Promise<object>} Status object
   */
  async getStatus(serverKey) {
    return this._sendMessage({ type: 'GET_STATUS', serverKey });
  },

  /**
   * Start the bot
   * @param {string} serverKey - The server key to start
   */
  async start(serverKey) {
    return this._sendMessage({ type: 'START_BOT', serverKey });
  },

  /**
   * Stop the bot
   * @param {string} serverKey
   */
  async stop(serverKey) {
    return this._sendMessage({ type: 'STOP_BOT', serverKey });
  },

  /**
   * Toggle Pause/Resume
   * @param {string} serverKey
   */
  async togglePause(serverKey) {
    return this._sendMessage({ type: 'PAUSE_BOT', serverKey });
  },

  /**
   * Emergency Stop
   * @param {string} serverKey
   * @param {string} reason
   */
  async emergencyStop(serverKey, reason) {
    return this._sendMessage({ type: 'EMERGENCY_STOP', serverKey, data: { reason } });
  },

  /**
   * Update bot configuration
   * @param {string} serverKey
   * @param {object} newConfig - Partial or full config object
   */
  async updateConfig(serverKey, newConfig) {
    return this._sendMessage({ type: 'SAVE_CONFIG', serverKey, config: newConfig });
  },

  /**
   * Get system logs
   * @returns {Promise<object>}
   */
  async getLogs() {
    return this._sendMessage({ type: 'GET_LOGS' });
  },

  // ---------------------------------------------------------------------------
  // Task Queue Management
  // ---------------------------------------------------------------------------

  /**
   * Get current task queue
   * @param {string} serverKey
   */
  async getQueue(serverKey) {
    return this._sendMessage({ type: 'GET_QUEUE', serverKey });
  },

  /**
   * Add a new task manually
   * @param {string} serverKey
   * @param {string} type - Task type
   * @param {object} params - Task parameters
   * @param {number} [priority=5]
   * @param {string} [villageId=null]
   */
  async addTask(serverKey, type, params, priority = 5, villageId = null) {
    return this._sendMessage({
      type: 'ADD_TASK',
      serverKey,
      taskType: type,
      params,
      priority,
      villageId
    });
  },

  /**
   * Remove a task by ID
   * @param {string} serverKey
   * @param {string} taskId
   */
  async removeTask(serverKey, taskId) {
    return this._sendMessage({ type: 'REMOVE_TASK', serverKey, taskId });
  },

  /**
   * Clear all tasks
   * @param {string} serverKey
   */
  async clearQueue(serverKey) {
    return this._sendMessage({ type: 'CLEAR_QUEUE', serverKey });
  },

  // ---------------------------------------------------------------------------
  // Internal Helpers
  // ---------------------------------------------------------------------------

  /**
   * Send message to background script with error handling
   */
  async _sendMessage(message) {
    return new Promise((resolve) => {
      let settled = false;
      const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          console.warn('[UIClient] Messaging TIMEOUT:', message.type);
          resolve({ success: false, error: 'Messaging Timeout' });
      }, 5000);

      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);

          if (chrome.runtime.lastError) {
            console.warn('[UIClient] Messaging error:', chrome.runtime.lastError.message);
            resolve({ success: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(response);
          }
        });
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        console.error('[UIClient] Exception sending message:', err);
        resolve({ success: false, error: err.message });
      }
    });
  }
};

// Export for module systems (if needed) or global scope
if (typeof window !== 'undefined') {
  window.UIClient = UIClient;
}
