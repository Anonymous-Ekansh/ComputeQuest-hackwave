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

    /** @type {((msg: object) => void) | null} */
    this._pipelineCallback = null;

    // ── create the persistent worker ──
    this._spawnWorker();

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
   * Register a callback for pipeline-related worker messages
   * (stage_ready, forward_response, stage_error).
   * @param {(msg: object) => void} fn
   */
  onPipelineMessage(fn) {
    this._pipelineCallback = fn;
  }

  /**
   * Post a pipeline message directly to the worker (stage_assign, forward_request)
   * without going through the chunk queue or affecting busy/idle state.
   * @param {object} payload
   */
  postPipelineMessage(payload) {
    if (this._worker) {
      this._worker.postMessage(payload);
    }
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

  /**
   * Directly send a session clear command to free VRAM for a given pipeline session.
   * Bypasses the standard queue because it's purely a cleanup signal.
   * @param {string} sessionId
   */
  clearSession(sessionId) {
    if (this._worker) {
      this._worker.postMessage({ type: 'clear_session', sessionId });
    }
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

  /** @private Create (or re-create) the worker and wire up handlers. */
  _spawnWorker() {
    this._worker = new Worker(
      new URL('./workers/computeWorker.js', import.meta.url),
      { type: 'module' },
    );
    this._worker.onmessage = this._onMessage.bind(this);
    this._worker.onerror = this._onError.bind(this);
  }

  /** @private Handle a successful result from the worker. */
  _onMessage(e) {
    const data = e.data;
    const pipelineTypes = ['stage_ready', 'forward_response', 'stage_error', 'stage_progress'];

    if (data && data.type && pipelineTypes.includes(data.type)) {
      // Pipeline message — don't touch chunk state
      if (this._pipelineCallback) {
        this._pipelineCallback(data);
      }
      return;
    }

    // MATRIX_MULTIPLY chunk result — original path
    this._state = 'idle';

    if (this._resultCallback) {
      this._resultCallback(data);
    }

    this._drainQueue();
  }

  /** @private Handle a worker error — respawn so the session recovers. */
  _onError(err) {
    console.error('[WorkerManager] Worker crashed, respawning…', err);

    // kill the dead worker
    if (this._worker) {
      this._worker.terminate();
    }

    // respawn a fresh one
    this._spawnWorker();

    this._state = 'idle';
    this._drainQueue();
  }

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
