/**
 * Offline checks for the failover engine and the discovery helpers.
 *
 * These run against the plugin's own modules with no harness and no network,
 * so the rules that matter — a failed candidate is discarded whole, the next
 * one answers, a committed answer is never restarted — are pinned here rather
 * than only in a live turn.
 *
 * Run: node scripts/test.mjs
 */

import assert from 'node:assert/strict'

import {
  classifyFailure,
  commitsAnswer,
  failureOfFinish,
  runFailover,
} from '../src/failover.js'
import {
  applyPreferences,
  normalizeConfig,
} from '../index.js'
import {
  acceptsEffort,
  commonEfforts,
  hasEacTag,
  isSealedId,
  normalizeModel,
  orderForFailover,
  stripEacTag,
} from '../src/discovery.js'

/** Build an async iterable of chunks. */
async function* chunks(list) {
  for (const chunk of list) yield chunk
}

/** A candidate whose stream is a fixed list of chunks. */
function candidate(id, list, { throwAt = -1 } = {}) {
  return {
    open: async () => ({ id, name: id }),
    chunks: async function* () {
      let index = 0
      for (const chunk of list) {
        if (index === throwAt) throw Object.assign(new Error(`boom ${id}`), { failure: { message: `boom ${id}`, code: 'SERVER' } })
        yield chunk
        index += 1
      }
    },
  }
}

/** A candidate that reports a terminal failure the way the harness does. */
function failingCandidate(id, code, message = `failed ${id}`) {
  return {
    open: async () => ({ id, name: id }),
    chunks: async function* () {
      yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
    },
  }
}

/** Collect a generator's output and its return value. */
async function drain(generator) {
  const out = []
  while (true) {
    const row = await generator.next()
    if (row.done) return { out, result: row.value }
    out.push(row.value)
  }
}

const text = value => ({ type: 'text-delta', text: value })
const finish = kind => ({ type: 'finish', reason: { kind } })

// ── the commit rule ──────────────────────────────────────────────────────────

assert.equal(commitsAnswer(text('hello')), true)
assert.equal(commitsAnswer(text('   ')), false, 'whitespace is not an answer')
assert.equal(commitsAnswer({ type: 'reasoning-delta', text: 'thinking' }), false, 'reasoning does not commit')
assert.equal(commitsAnswer({ type: 'tool-call-delta', id: 't1', name: 'x', argumentsDelta: '{}' }), true)
assert.equal(commitsAnswer({ type: 'block-end', block: { type: 'reasoning', text: 'x' } }), false)
assert.equal(commitsAnswer({ type: 'block-end', block: { type: 'text', text: 'x' } }), true)
assert.equal(commitsAnswer(null), false)

// ── failure classification ───────────────────────────────────────────────────

assert.equal(classifyFailure({ code: 'SERVER' }), 'retry')
assert.equal(classifyFailure({ code: 'TIMEOUT' }), 'retry')
assert.equal(classifyFailure({ code: 'RATE_LIMIT' }), 'retry')
assert.equal(classifyFailure({ code: 'ABORTED' }), 'fatal')
assert.equal(classifyFailure({ code: 'CONFIG_DISABLED' }), 'fatal')
assert.equal(classifyFailure({ code: 'SOMETHING_NEW' }), 'retry', 'an unknown code must not end the turn')

assert.deepEqual(
  failureOfFinish({ type: 'finish', reason: { kind: 'error', failure: { message: 'm', code: 'C' } } }),
  { message: 'm', code: 'C' },
)
assert.equal(failureOfFinish({ type: 'finish', reason: { kind: 'stop' } }), undefined, 'a clean finish is not a failure')

// ── the failover itself ─────────────────────────────────────────────────────

{
  // A failing candidate is discarded whole; the next one answers.
  const events = []
  const { out, result } = await drain(runFailover({
    candidates: [
      failingCandidate('bad', 'SERVER', 'upstream exploded'),
      candidate('good', [text('the answer'), finish('stop')]),
    ],
    onEvent: event => events.push(event),
  }))
  assert.equal(result.committed, true)
  assert.equal(result.candidate.id, 'good')
  assert.deepEqual(out.map(chunk => chunk.text ?? chunk.type), ['the answer', 'finish'])
  assert.equal(events.filter(event => event.type === 'failed').length, 1)
  assert.equal(events.filter(event => event.type === 'committed').length, 1)
}

{
  // The discarded candidate's buffered chunks never reach the caller.
  //
  // "partial" only produced reasoning, which is not a commit, so it was still
  // uncommitted when it failed — and everything it produced is thrown away.
  const { out } = await drain(runFailover({
    candidates: [
      candidate('partial', [
        { type: 'reasoning-delta', text: 'thinking...' },
        { type: 'block-end', block: { type: 'reasoning', text: 'thinking...' } },
      ]),
      failingCandidate('bad', 'TIMEOUT'),
      candidate('good', [text('whole answer'), finish('stop')]),
    ],
  }))
  assert.deepEqual(
    out.map(chunk => chunk.text ?? chunk.type),
    ['whole answer', 'finish'],
    'the failed attempt must not leak a single chunk',
  )
}

{
  // A candidate that produced a real answer commits: the answer is the
  // caller's, and a later failure ends the turn rather than restarting it.
  //
  // This mirrors the lane's own chain behaviour: once an answer delta has been
  // handed over, another model must not restart a half-delivered answer.
  //
  // The candidate here ends its stream without a finish chunk — the shape a
  // truncated upstream produces — so the harness reports it as an empty
  // response. The point of the case is that the turn ends here, and the next
  // candidate is never tried.
  const { out, result } = await drain(runFailover({
    candidates: [
      candidate('first', [text('half an answer')]),
      failingCandidate('bad', 'TIMEOUT'),
      candidate('good', [text('whole answer'), finish('stop')]),
    ],
  }))
  assert.equal(result.committed, true, 'the committed answer stands')
  assert.deepEqual(
    out.map(chunk => chunk.text ?? chunk.type),
    ['half an answer', 'finish'],
    'the turn ends with the real failure, not a restart on another model',
  )
  assert.equal(result.tried.length, 1, 'only the committed candidate is recorded as tried')
}

{
  // A candidate that answers and then reports a failure ends the turn with
  // that failure — the answer is the caller's, and nothing is restarted.
  const { out, result } = await drain(runFailover({
    candidates: [
      candidate('first', [
        text('half an answer'),
        { type: 'finish', reason: { kind: 'error', failure: { message: 'stream cut', code: 'STREAM_CUT' } } },
      ]),
      candidate('good', [text('whole answer'), finish('stop')]),
    ],
  }))
  assert.equal(result.committed, true)
  assert.deepEqual(out.map(chunk => chunk.text ?? chunk.type), ['half an answer', 'finish'])
  assert.equal(out[out.length - 1].reason.failure.code, 'STREAM_CUT')
}

{
  // A candidate that produced no answer at all is treated as a failure.
  const { out, result } = await drain(runFailover({
    candidates: [
      candidate('silent', [{ type: 'reasoning-delta', text: 'hmm' }, finish('stop')]),
      candidate('good', [text('answer'), finish('stop')]),
    ],
  }))
  assert.equal(result.committed, true)
  assert.equal(result.tried[0].failure.code, 'EMPTY_RESPONSE')
  assert.deepEqual(out.map(chunk => chunk.text ?? chunk.type), ['answer', 'finish'])
}

{
  // Every candidate failing ends the turn with one honest error.
  const { out, result } = await drain(runFailover({
    candidates: [
      failingCandidate('a', 'SERVER'),
      failingCandidate('b', 'RATE_LIMIT'),
    ],
  }))
  assert.equal(result.committed, false)
  assert.equal(result.tried.length, 2)
  const last = out[out.length - 1]
  assert.equal(last.type, 'finish')
  assert.equal(last.reason.kind, 'error')
  assert.equal(last.reason.failure.code, 'EAC_ALL_FAILED')
  assert.match(last.reason.failure.message, /a \(SERVER\)/)
  assert.match(last.reason.failure.message, /b \(RATE_LIMIT\)/)
}

{
  // An abort is fatal: the turn ends instead of burning the roster.
  const { out, result } = await drain(runFailover({
    candidates: [
      failingCandidate('a', 'ABORTED', 'request aborted'),
      candidate('good', [text('answer'), finish('stop')]),
    ],
  }))
  assert.equal(result.committed, false)
  assert.equal(result.verdict, 'fatal')
  const last = out[out.length - 1]
  assert.equal(last.reason.kind, 'aborted')
}

{
  // A committed answer is never restarted: a later failure ends the turn.
  const { out, result } = await drain(runFailover({
    candidates: [
      candidate('good', [text('answer'), { type: 'finish', reason: { kind: 'error', failure: { message: 'cut', code: 'SERVER' } } }]),
      candidate('next', [text('other'), finish('stop')]),
    ],
  }))
  assert.equal(result.committed, true)
  assert.deepEqual(out.map(chunk => chunk.text ?? chunk.type), ['answer', 'finish'])
}

{
  // An empty roster reports an honest error rather than pretending.
  const { out, result } = await drain(runFailover({ candidates: [] }))
  assert.equal(result.committed, false)
  assert.equal(out[out.length - 1].reason.failure.code, 'EAC_ALL_FAILED')
}

// ── the thinking menu ────────────────────────────────────────────────────────

{
  // A level only one candidate understands cannot be offered.
  const menu = commonEfforts([
    { efforts: ['disabled', 'low', 'high'], effortDefault: 'high' },
    { efforts: ['low', 'high'], effortDefault: 'high' },
  ])
  assert.deepEqual(menu.efforts, ['low', 'high'])
  assert.equal(menu.defaultEffort, 'high')
}

{
  // Candidates that disagree entirely produce no menu at all.
  const menu = commonEfforts([
    { efforts: ['disabled', 'low'], effortDefault: 'low' },
    { efforts: ['max'], effortDefault: 'max' },
  ])
  assert.equal(menu, undefined)
}

{
  // A roster with no declared menus produces no menu either.
  assert.equal(commonEfforts([{ id: 'a' }, { id: 'b' }]), undefined)
}

assert.equal(acceptsEffort({ efforts: ['low', 'high'] }, 'high'), true)
assert.equal(acceptsEffort({ efforts: ['low', 'high'] }, 'max'), false)
assert.equal(acceptsEffort({ id: 'a' }, 'high'), false, 'a model with no menu accepts nothing explicitly')
assert.equal(acceptsEffort({ id: 'a' }, undefined), true, 'no level means no constraint')

// ── discovery helpers ────────────────────────────────────────────────────────

assert.equal(hasEacTag('EAC DeepSeek V4.1 Flash'), true)
assert.equal(hasEacTag('Kilo Beam'), false)
assert.equal(hasEacTag('DeepSeek V4.1 Flash'), false)
assert.equal(hasEacTag(undefined), false)
assert.equal(stripEacTag('EAC DeepSeek V4.1 Flash'), 'DeepSeek V4.1 Flash')
assert.equal(stripEacTag('Kilo Beam'), 'Kilo Beam')

assert.equal(isSealedId('amd/DeepSeek-V4.1-Flash', { sealIds: ['amd/DeepSeek-V4.1-Flash'] }), true)
assert.equal(isSealedId('other', { sealIds: ['amd/DeepSeek-V4.1-Flash'] }), false)
assert.equal(isSealedId('other', null), false)

{
  const model = normalizeModel({ id: 'amd/DeepSeek-V4.1-Flash', name: 'EAC DeepSeek V4.1 Flash (AMD)' })
  assert.equal(model.id, 'amd/DeepSeek-V4.1-Flash')
  assert.equal(model.name, 'DeepSeek V4.1 Flash (AMD)')
  assert.equal(model.contextWindow, 131072, 'an unknown capacity falls back to the conservative default')
}

{
  // The failover order puts the biggest model first under the quality ladder.
  const rows = [
    { id: 'a', name: 'a', contextWindow: 131072, maxOutput: 32768 },
    { id: 'b', name: 'b', contextWindow: 1048576, maxOutput: 32768 },
  ]
  assert.deepEqual(orderForFailover(rows, 'balanced').map(row => row.id), ['a', 'b'])
  assert.deepEqual(orderForFailover(rows, 'quality').map(row => row.id), ['b', 'a'])
}

// ── the user's preferences ───────────────────────────────────────────────────

{
  const config = normalizeConfig({ strategy: 'nonsense', silenceTimeoutMs: -5, preferredModels: [' x ', ''], excludedModels: ['y'] })
  assert.equal(config.strategy, 'balanced', 'an unknown strategy falls back')
  assert.equal(config.silenceTimeoutMs, 120000, 'a non-positive timeout falls back')
  assert.deepEqual(config.preferredModels, ['x'])
  assert.deepEqual(config.excludedModels, ['y'])
}

{
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const config = normalizeConfig({ preferredModels: ['c'], excludedModels: ['a'] })
  assert.deepEqual(applyPreferences(rows, config).map(row => row.id), ['c', 'b'])
}

console.log('eac-auto: all offline checks passed')
