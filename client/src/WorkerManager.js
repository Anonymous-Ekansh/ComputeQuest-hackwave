/**
 * WorkerManager — singleton that keeps a single computeWorker alive
 * for the entire browser session.
 *
 * • sendChunk(payload)   — posts work to the worker (queues if busy)
 * • onResult(fn)         — registers a callback for completed chunks
 * • terminate()          — kills the worker (call only on tab close)
 * • state                — 'idle' | 'busy'
 * • queueLength          — chunks waiting in line
 */

let instance = null;

export default class WorkerManager {
  /** @returns {WorkerManager} the singleton instance */
  static getInstance() {
    if (!instance) {
      instance = new WorkerManager();
    }
    return instance;
  }

  constructor() {
    if (instance) {
      throw new Error('WorkerManager is a singleton — use WorkerManager.getInstance()');
    }

    /** @type {'idle' | 'busy'} */
    this._state = 'idle';

    /** @type {Array<object>} FIFO queue of chunk payloads */
    this._queue = [];

    /** @type {((result: object) => void) | null} */
    this._resultCallback = null;

    // ── create the persistent worker ──
    this._worker = new Worker(
      new URL('./workers/computeWorker.js', import.meta.url),
      { type: 'module' },
    );

    // listen for results from the worker
    this._worker.onmessage = (e) => {
      this._state = 'idle';

      // forward to registered callback
      if (this._resultCallback) {
        this._resultCallback(e.data);
      }

      // drain the queue
      this._drainQueue();
    };

    this._worker.onerror = (err) => {
      console.error('[WorkerManager] Worker error:', err);
      this._state = 'idle';
      this._drainQueue();
    };

    // terminate only when the tab is being unloaded
    window.addEventListener('beforeunload', () => this.terminate());
  }

  // ── public API ──────────────────────────────────────────────────────────

  /**
   * Register a callback that fires whenever the worker completes a chunk.
   * @param {(result: object) => void} fn
   */
  onResult(fn) {
    this._resultCallback = fn;
  }

  /**
   * Send a chunk payload to the worker.
   * If the worker is busy the chunk is queued and processed in FIFO order.
   * @param {object} payload
   */
  sendChunk(payload) {
    if (this._state === 'busy') {
      this._queue.push(payload);
      return;
    }
    this._dispatch(payload);
  }

  /** Current worker state: 'idle' or 'busy'. */
  get state() {
    return this._state;
  }

  /** Number of chunks waiting in the queue. */
  get queueLength() {
    return this._queue.length;
  }

  /** Kill the worker permanently. */
  terminate() {
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
      this._state = 'idle';
      this._queue = [];
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  /** @private Post a single payload to the worker. */
  _dispatch(payload) {
    this._state = 'busy';
    this._worker.postMessage(payload);
  }

  /** @private Send the next queued chunk, if any. */
  _drainQueue() {
    if (this._queue.length > 0 && this._state === 'idle') {
      const next = this._queue.shift();
      this._dispatch(next);
    }
  }
}
