/**
 * The failover engine behind "EAC AUTO".
 *
 * The rule the whole plugin exists for: **a model that errors must not end the
 * turn — the next available EAC model answers instead.**
 *
 * Two facts about the harness's chunk protocol shape this engine:
 *
 * 1. A failing model does not *throw*. The `llm` service turns every adapter
 *    failure into a terminal `finish` chunk whose reason is `error` (or
 *    `aborted`). So the engine has to read the finish chunk, not catch an
 *    exception, to know that a candidate failed.
 * 2. A candidate is only *committed* once it has produced an answer-bearing
 *    delta. Until then its chunks are held in a buffer and thrown away
 *    wholesale when it fails, so the caller never sees a byte of a discarded
 *    attempt and switching models is invisible.
 *
 * Reasoning deltas are deliberately *not* a commit. "Thought for a minute, then
 * hit a quota wall" is the single most valuable case to fail over, and the
 * held thinking is dropped with the rest of the discarded attempt.
 *
 * Two failure classes are treated differently:
 *
 * - **Retryable** — a transport error, a timeout, a 5xx, a rate limit, an
 *   empty answer. The next candidate is tried immediately.
 * - **Fatal** — the caller aborted, or the harness's own configuration is off.
 *   Neither is a candidate's fault, so the turn ends with the real error
 *   rather than pretending another model could have saved it.
 *
 * @module src/failover.js
 */

/** How long a candidate may stay silent before it counts as failed. */
export const SILENCE_TIMEOUT_MS = 120_000

/**
 * Failure codes that mean "try the next model" rather than "end the turn".
 */
export const RETRYABLE_CODES = new Set([
  'EMPTY_RESPONSE',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'RATE_LIMIT',
  'QUOTA',
  'EAC_UPSTREAM_FAILED',
  'NO_PROGRESS',
  'EAC_ALL_FAILED',
  'EAC_NO_MODELS',
])

/**
 * Failure codes that mean "this turn is over; no other model can help".
 */
export const FATAL_CODES = new Set([
  'ABORTED',
  'CONFIG_DISABLED',
  'INVALID_PREPARED_CALL',
  'UNSUPPORTED_REASONING_EFFORT',
])

/**
 * Is this chunk an answer-bearing delta — one that commits a candidate?
 *
 * Text with visible content commits. A tool-call delta commits: a tool call is
 * the model committing to an action, and replaying it against a different model
 * would produce a mismatched transcript. Reasoning does not commit.
 *
 * @param {object} chunk
 * @returns {boolean}
 */
export function commitsAnswer(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== ''
  if (chunk.type === 'tool-call-delta') return true
  if (chunk.type !== 'block-end') return false
  if (chunk.block?.type === 'reasoning') return false
  if (chunk.block?.type === 'text') return typeof chunk.block.text === 'string' && chunk.block.text.trim() !== ''
  return true
}

/**
 * Classify one terminal failure.
 *
 * @param {object} failure - the failure a finish chunk carried
 * @returns {'retry'|'fatal'}
 */
export function classifyFailure(failure) {
  const code = typeof failure?.code === 'string' ? failure.code : ''
  if (FATAL_CODES.has(code)) return 'fatal'
  if (RETRYABLE_CODES.has(code)) return 'retry'
  // An unknown code is treated as retryable: the alternative is one unfamiliar
  // upstream status ending the turn, which is exactly the failure this plugin
  // exists to prevent. The next candidate is a different vendor, so a refusal
  // the first model met is not automatically one the next will meet.
  return 'retry'
}

/**
 * The failure carried by a terminal chunk, or undefined when the chunk ends
 * the turn successfully.
 *
 * @param {object} chunk
 * @returns {{message: string, code: string}|undefined}
 */
export function failureOfFinish(chunk) {
  if (chunk?.type !== 'finish') return undefined
  const reason = chunk.reason
  if (reason === null || typeof reason !== 'object') return undefined
  if (reason.kind !== 'error' && reason.kind !== 'aborted') return undefined
  const failure = reason.failure
  if (failure === null || typeof failure !== 'object') {
    return { message: `the model turn ended with "${reason.kind}"`, code: reason.kind === 'aborted' ? 'ABORTED' : 'SERVER' }
  }
  return {
    message: typeof failure.message === 'string' ? failure.message : String(reason.kind),
    code: typeof failure.code === 'string' ? failure.code : (reason.kind === 'aborted' ? 'ABORTED' : 'SERVER'),
    ...(failure.status === undefined ? {} : { status: failure.status }),
  }
}

/**
 * Normalize a thrown error into the harness's failure shape.
 * @param {unknown} error
 * @returns {{message: string, code: string}}
 */
export function normalizeError(error) {
  if (error === null || typeof error !== 'object') {
    return { message: String(error ?? 'unknown error'), code: 'TRANSPORT' }
  }
  const failure = error.failure
  if (failure !== null && typeof failure === 'object') {
    return {
      message: typeof failure.message === 'string' ? failure.message : String(error.message ?? 'failed'),
      code: typeof failure.code === 'string' ? failure.code : 'SERVER',
      ...(failure.status === undefined ? {} : { status: failure.status }),
    }
  }
  return {
    message: typeof error.message === 'string' ? error.message : String(error),
    code: typeof error.code === 'string' ? error.code : 'SERVER',
  }
}

/**
 * Walk the candidate chain until one candidate produces an answer.
 *
 * The generator yields the committed candidate's chunks verbatim. A candidate
 * that failed before committing yields nothing at all — the discarded attempt
 * is invisible to the caller.
 *
 * @param {object} options
 * @param {Array<{open: () => Promise<object>, chunks: (signal: AbortSignal) => AsyncIterable<object>}>} options.candidates
 * @param {AbortSignal} [options.signal] - the caller's cancellation
 * @param {number} [options.silenceTimeoutMs] - how long a candidate may stay silent
 * @param {(event: object) => void} [options.onEvent] - observer for the attempt log
 * @returns {AsyncGenerator<object, object>}
 */
export async function* runFailover({ candidates, signal, silenceTimeoutMs = SILENCE_TIMEOUT_MS, onEvent }) {
  const tried = []

  for (const candidate of candidates) {
    if (signal?.aborted === true) {
      const failure = { message: 'request aborted', code: 'ABORTED' }
      yield { type: 'finish', reason: { kind: 'aborted', failure } }
      return { committed: false, verdict: 'fatal', tried, failure }
    }

    const meta = await candidate.open()
    const attempt = { id: meta.id, name: meta.name, index: tried.length }
    onEvent?.({ type: 'attempt', ...attempt })

    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })

    /** Chunks held until the candidate commits. */
    const held = []
    let committed = false
    let failure
    let cleanFinish

    try {
      for await (const chunk of withSilence(candidate.chunks(controller.signal), silenceTimeoutMs, controller)) {
        if (chunk?.type === 'finish') {
          const reported = failureOfFinish(chunk)
          if (reported === undefined) {
            // A clean ending: the turn is complete.
            cleanFinish = chunk
            break
          }
          failure = reported
          break
        }
        if (!committed) {
          held.push(chunk)
          if (commitsAnswer(chunk)) {
            committed = true
            for (const buffered of held) yield buffered
            held.length = 0
          }
          continue
        }
        yield chunk
      }
    } catch (error) {
      failure = normalizeError(error)
    } finally {
      signal?.removeEventListener('abort', onAbort)
    }

    if (failure === undefined && cleanFinish !== undefined) {
      // The candidate answered and ended the turn cleanly.
      if (!committed) {
        // A turn that ends cleanly without a single answer-bearing delta is an
        // empty response, which is as unusable as one that threw.
        failure = {
          message: `model "${meta.id}" finished without producing an answer`,
          code: 'EMPTY_RESPONSE',
        }
      } else {
        yield cleanFinish
        onEvent?.({ type: 'committed', ...attempt })
        return { committed: true, verdict: null, tried, candidate: meta }
      }
    }

    if (failure === undefined) {
      // The candidate's stream ended with neither a finish chunk nor an error.
      failure = {
        message: `model "${meta.id}" ended its stream without a result`,
        code: 'EMPTY_RESPONSE',
      }
    }

    if (committed) {
      // The answer was already handed over, so this failure ends the turn. A
      // second model must not restart a half-delivered answer.
      onEvent?.({ type: 'failed', ...attempt, failure, committed: true })
      tried.push({ id: meta.id, name: meta.name, failure })
      yield { type: 'finish', reason: { kind: 'error', failure } }
      return { committed: true, verdict: 'fatal', tried, failure }
    }

    // Nothing of this candidate reached the caller. Drop the buffer and try
    // the next one.
    held.length = 0
    onEvent?.({ type: 'failed', ...attempt, failure })
    tried.push({ id: meta.id, name: meta.name, failure })

    if (classifyFailure(failure) === 'fatal') {
      yield { type: 'finish', reason: { kind: failure.code === 'ABORTED' ? 'aborted' : 'error', failure } }
      return { committed: false, verdict: 'fatal', tried, failure }
    }
  }

  // Every candidate failed.
  const detail = tried
    .map(entry => `${entry.name ?? entry.id} (${entry.failure?.code ?? 'failed'})`)
    .join('; ')
  const failure = {
    message: tried.length === 0
      ? 'no EAC model is available on this host'
      : `every EAC model failed: ${detail}`,
    code: 'EAC_ALL_FAILED',
  }
  yield { type: 'finish', reason: { kind: 'error', failure } }
  return { committed: false, verdict: 'retry', tried, failure }
}

/** Sentinel for the idle deadline. */
const TIMEOUT = Symbol('timeout')

/**
 * Wrap an async iterable so a candidate that stops producing chunks for too
 * long is failed rather than hanging the turn.
 *
 * The deadline is an *idle* deadline, not a total budget: a slow model that
 * keeps producing chunks is never cut off, which is what makes a long reasoning
 * turn survivable. When it fires, the candidate's own controller is aborted so
 * the upstream request is released rather than left running.
 *
 * @param {AsyncIterable<object>} source
 * @param {number} timeoutMs
 * @param {AbortController} controller - the candidate's controller
 * @returns {AsyncGenerator<object>}
 */
export async function* withSilence(source, timeoutMs, controller) {
  const iterator = source[Symbol.asyncIterator]()
  try {
    while (true) {
      const row = await raceWithTimeout(iterator.next(), timeoutMs)
      if (row === TIMEOUT) {
        const seconds = Math.round(timeoutMs / 1000)
        controller?.abort(new Error(`the model produced nothing for ${seconds}s`))
        throw Object.assign(new Error(`the model produced nothing for ${seconds}s`), {
          failure: { message: `the model produced nothing for ${seconds}s`, code: 'TIMEOUT' },
        })
      }
      if (row.done) return
      yield row.value
    }
  } finally {
    // Closing the source releases the upstream request even when the deadline
    // fired: an abandoned turn must not leave a socket open.
    try {
      await iterator.return?.()
    } catch {
      // The original error wins; a failed cleanup is not a new failure.
    }
  }
}

/**
 * Race one promise against a timer.
 * @param {Promise<object>} promise
 * @param {number} timeoutMs
 * @returns {Promise<object|symbol>}
 */
function raceWithTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(TIMEOUT), timeoutMs)
    timer.unref?.()
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}
