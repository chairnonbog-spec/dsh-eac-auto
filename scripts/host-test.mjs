/**
 * Offline check of the plugin's Host half.
 *
 * This drives `apply()` against a stub context that mimics the harness's own
 * `llm` service and the lane's advertised catalog, so the wiring — the route
 * registration, the roster discovery, the failover order and the user's
 * preferences — is exercised without a harness and without a network.
 *
 * Run: node scripts/host-test.mjs
 */

import assert from 'node:assert/strict'

import { apply, buildState, normalizeConfig } from '../index.js'
import { ROUTE_AUTO } from '../src/adapter.js'

/** The rows the lane's adapter advertises, with the channel tag on the names. */
const LANE_ROWS = [
  { provider: 'our-free-model', id: 'opencode/deepseek-v4.1-flash-free', name: 'EAC DeepSeek V4 Flash' },
  { provider: 'our-free-model', id: 'opencode/glm-5.3-flash-free', name: 'EAC GLM 5.3 Flash' },
  { provider: 'our-free-model', id: 'z-ai/glm-5.3-flash', name: 'EAC GLM 5.3 Flash' },
  { provider: 'our-free-model', id: 'deepseek-ai/deepseek-v4.1-flash', name: 'EAC DeepSeek V4.1 Flash' },
  // A free-lane row: same shape, no channel tag. It must never enter the roster.
  { provider: 'our-free-model', id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash' },
  // A Kilo row: also not EAC.
  { provider: 'our-free-model', id: 'kilo-auto/free', name: 'Kilo Auto Free' },
]

const infoOf = (provider, id) => ({
  provider,
  id,
  name: id,
  context: { contextWindow: 1048576 },
  defaultMaxTokens: 32768,
  reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
})

/** A stub harness context. */
function makeContext({ laneRows = LANE_ROWS } = {}) {
  const registered = []
  const effects = []
  const listeners = []
  const routes = []
  const adapters = new Map()

  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    llm: {
      registerAdapter(providers, adapter) {
        registered.push(...providers)
        adapters.set(providers[0], adapter)
        return () => { adapters.delete(providers[0]) }
      },
      async listModels(provider) {
        return laneRows.filter(row => row.provider === provider)
      },
      async resolveModelInfo(provider, id) {
        return infoOf(provider, id)
      },
      emitAdaptersUpdated() {},
    },
    on(event, listener) { listeners.push([event, listener]) },
    // The harness runs an effect's body immediately and keeps its disposer.
    // The stub does the same, so the deferred refresh is really scheduled.
    effect(fn) { effects.push(fn); return fn() },
    inject(deps, fn) { fn(ctx) },
    webServer: {
      register(route) { routes.push(route); return () => {} },
    },
  }
  return { ctx, registered, effects, listeners, routes, adapters }
}

/** Run the deferred roster refresh the plugin schedules on boot. */
async function settle() {
  await new Promise(resolve => setTimeout(resolve, 1700))
}

// ── the plugin applies cleanly ───────────────────────────────────────────────

{
  const { ctx, registered } = makeContext()
  apply(ctx, normalizeConfig({}))
  assert.deepEqual(registered, [ROUTE_AUTO], 'the plugin owns exactly one provider route')
}

// ── the roster holds only the lane's EAC rows ────────────────────────────────

{
  const { ctx, adapters } = makeContext()
  apply(ctx, normalizeConfig({}))
  await settle()

  const adapter = adapters.get(ROUTE_AUTO)
  const models = await adapter.listModels(ROUTE_AUTO)
  assert.equal(models.length, 1, 'exactly one model is offered')
  assert.equal(models[0].id, 'EAC AUTO')
  assert.match(models[0].description, /4 EAC models/, 'the description names the roster size')

  // The roster itself, read through the status surface's model list.
  const resolved = await adapter.resolveModel(ROUTE_AUTO, 'EAC AUTO')
  assert.equal(resolved.id, 'EAC AUTO')
  assert.match(resolved.description, /DeepSeek V4 Flash/)
  assert.doesNotMatch(resolved.description, /Kilo/, 'a Kilo row must never appear')
  assert.doesNotMatch(resolved.description, /DeepSeek V4\.1 Flash(?!$)/, 'the free-lane row is excluded')
}

// ── the user's preferences shape the roster ──────────────────────────────────

{
  const { ctx, adapters } = makeContext()
  apply(ctx, normalizeConfig({ preferredModels: ['z-ai/glm-5.3-flash'], excludedModels: ['opencode/glm-5.3-flash-free'] }))
  await settle()
  const adapter = adapters.get(ROUTE_AUTO)
  const resolved = await adapter.resolveModel(ROUTE_AUTO, 'EAC AUTO')
  // The preferred model leads; the excluded one is gone entirely.
  assert.match(resolved.description, /^auto-selects among 3 EAC models · GLM 5\.3 Flash/)
  assert.doesNotMatch(resolved.description, /GLM 5\.3 Flash,.*GLM 5\.3 Flash/)
}

// ── the disabled switch empties the roster ───────────────────────────────────

{
  const { ctx, adapters } = makeContext()
  apply(ctx, normalizeConfig({ enabled: false }))
  await settle()
  const adapter = adapters.get(ROUTE_AUTO)
  const models = await adapter.listModels(ROUTE_AUTO)
  assert.match(models[0].description, /switched off/, 'a disabled plugin says so')
}

// ── the state snapshot ───────────────────────────────────────────────────────

{
  const state = buildState([{ id: 'a' }], normalizeConfig({ enabled: false }))
  assert.deepEqual(state.models, [], 'a disabled plugin offers no model to fail over to')
  assert.equal(state.enabled, false)
  assert.equal(state.laneRoute, 'our-free-model')
}

// ── the status route ─────────────────────────────────────────────────────────

{
  const { ctx, routes } = makeContext()
  apply(ctx, normalizeConfig({}))
  await settle()

  const route = routes.find(entry => entry.path === '/api/eac-auto')
  assert.ok(route, 'the status route is registered')
  assert.equal(route.kind, 'prefix')

  // Drive the handler the way the web server would.
  const chunks = []
  const res = {
    writeHead(status) { chunks.push({ status }) },
    end(body) { chunks.push({ body: JSON.parse(body) }) },
  }
  await route.handler({ url: '/api/eac-auto/status', method: 'GET' }, res)
  const payload = chunks.find(entry => entry.body !== undefined).body
  assert.equal(payload.ok, true)
  assert.equal(payload.source, 'adapter')
  assert.equal(payload.models.length, 4, 'the status route reports the roster')
  assert.equal(payload.lastRun, null, 'no turn has run yet')
}

console.log('eac-auto: host half checks passed')
