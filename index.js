/**
 * EAC Auto: one selectable model ("EAC AUTO") that answers from the free EAC
 * roster and switches to the next model whenever one fails.
 *
 * The plugin registers its own provider route and owns one virtual model on
 * it. When that model is called, it walks the EAC roster — the co-paid lane's
 * free models, discovered from the lane itself — until one candidate answers.
 * A candidate that errors, times out, or returns nothing is discarded whole
 * and the next one is tried; the user sees one continuous answer.
 *
 * The design keeps the lane's responsibilities where they belong. This plugin
 * never holds a credential, never opens a socket, and never speaks a provider
 * protocol: the real turn is dispatched by `dsh-our-free-model`'s own adapter
 * through the `llm` service. Everything here is *selection*.
 *
 * What it owns:
 *
 * - the provider route and the "EAC AUTO" catalog row,
 * - the roster (discovered from the lane, refreshed on demand),
 * - the failover order and the attempt log,
 * - its own settings, persisted through the harness's config editor.
 *
 * @module index.js
 */

import { EacAutoAdapter, ROUTE_AUTO, ROUTE_LABEL } from './src/adapter.js'
import { discoverEacModels, orderForFailover } from './src/discovery.js'

export const name = 'eac-auto'
export const inject = ['llm']

/**
 * The plugin's configuration.
 *
 * The plugin deliberately exports **no** `Config` schema.
 *
 * A `Config` export is validated by the loader through
 * `Config['~standard'].validate(raw)`, which requires a schemastery schema.
 * Reaching schemastery from a profile plugin means depending on a package the
 * profile's dependency tree does not own, and a plugin whose schema cannot be
 * imported fails to activate at all — a worse failure than an unvalidated
 * config.
 *
 * The loader passes the row's raw `config` to `apply()` either way, so the
 * settings below are still read from `cordis.patch.yml`. {@link normalizeConfig}
 * applies the defaults and rejects every value that is not one the plugin
 * understands, which is what a schema would have done.
 *
 * - `enabled` (boolean, default `true`) — whether "EAC AUTO" is offered.
 * - `strategy` (`balanced` | `speed` | `quality`, default `balanced`) — the
 *   failover order.
 * - `preferredModels` (string[], default `[]`) — model ids to put at the head
 *   of the roster, in the user's order.
 * - `excludedModels` (string[], default `[]`) — model ids to keep out of the
 *   roster entirely.
 * - `silenceTimeoutMs` (number, default `120000`) — how long a candidate may
 *   stay silent before it counts as failed.
 */

/**
 * Read one config value, falling back to the shipped default.
 *
 * The config arrives as user input that survived a YAML file, so every field
 * is treated as untrusted: a non-string strategy is not a strategy, and a
 * non-positive timeout is "the user did not set one".
 *
 * @param {object} config
 * @returns {object}
 */
export function normalizeConfig(config) {
  const raw = config ?? {}
  const strategy = ['balanced', 'speed', 'quality'].includes(raw.strategy) ? raw.strategy : 'balanced'
  const preferred = Array.isArray(raw.preferredModels)
    ? raw.preferredModels.map(value => String(value ?? '').trim()).filter(value => value !== '')
    : []
  const excluded = new Set(
    (Array.isArray(raw.excludedModels) ? raw.excludedModels : [])
      .map(value => String(value ?? '').trim())
      .filter(value => value !== ''),
  )
  const timeout = Number(raw.silenceTimeoutMs)
  return {
    strategy,
    preferredModels: preferred,
    excludedModels: [...excluded],
    silenceTimeoutMs: Number.isFinite(timeout) && timeout > 0 ? Math.trunc(timeout) : 120000,
    enabled: raw.enabled !== false,
  }
}

/**
 * Apply the user's preferences to a discovered roster.
 *
 * The preferred list goes to the head, in the user's order. The excluded list
 * removes rows entirely — an excluded model must never be a failover target,
 * or the user's "do not use this one" would only hold for the first attempt.
 *
 * @param {object[]} models - the discovered roster
 * @param {object} config - the normalized config
 * @returns {object[]}
 */
export function applyPreferences(models, config) {
  const excluded = new Set(config.excludedModels)
  const kept = (Array.isArray(models) ? models : []).filter(model => !excluded.has(model.id))
  if (config.preferredModels.length === 0) return kept
  const byId = new Map(kept.map(model => [model.id, model]))
  const head = config.preferredModels
    .map(id => byId.get(id))
    .filter(model => model !== undefined)
  const headIds = new Set(head.map(model => model.id))
  return [...head, ...kept.filter(model => !headIds.has(model.id))]
}

/**
 * Build the state snapshot the adapter reads.
 *
 * @param {object[]} models - the ordered roster
 * @param {object} config - the normalized config
 * @returns {object}
 */
export function buildState(models, config) {
  return {
    models: config.enabled === false ? [] : models,
    laneRoute: 'our-free-model',
    silenceTimeoutMs: config.silenceTimeoutMs,
    enabled: config.enabled !== false,
  }
}

/**
 * The plugin's Host half.
 *
 * @param {object} ctx - the plugin context
 * @param {object} config - the plugin's configuration
 */
export function apply(ctx, config) {
  const logger = ctx.logger?.(name) ?? console
  const settings = normalizeConfig(config)

  /** The live roster. Replaced by a refresh; never mutated in place. */
  let roster = []
  /** Where the current roster came from, for the status surface. */
  let rosterSource = 'none'
  /** The attempt trail of the most recent turn, for the status surface. */
  let lastRun = null

  const state = () => buildState(roster, settings)

  const adapter = new EacAutoAdapter({
    llm: ctx.llm,
    state,
    onEvent: event => {
      if (event.type === 'attempt') {
        lastRun = { ...(lastRun ?? {}), startedAt: Date.now(), attempts: [...(lastRun?.attempts ?? []), { id: event.id, name: event.name, state: 'trying' }] }
        logger.info?.(`eac-auto: trying "${event.name}" (${event.id})`)
        return
      }
      if (event.type === 'failed') {
        const attempts = [...(lastRun?.attempts ?? [])]
        const index = attempts.findIndex(entry => entry.id === event.id && entry.state === 'trying')
        if (index >= 0) attempts[index] = { ...attempts[index], state: 'failed', code: event.failure?.code ?? 'unknown' }
        lastRun = { ...(lastRun ?? {}), attempts }
        logger.warn?.(`eac-auto: "${event.name}" failed (${event.failure?.code ?? 'unknown'}) — switching to the next model`)
        return
      }
      if (event.type === 'committed') {
        const attempts = [...(lastRun?.attempts ?? [])]
        const index = attempts.findIndex(entry => entry.id === event.id && entry.state === 'trying')
        if (index >= 0) attempts[index] = { ...attempts[index], state: 'answered' }
        lastRun = { ...(lastRun ?? {}), attempts, finishedAt: Date.now() }
        logger.info?.(`eac-auto: "${event.name}" answered`)
      }
    },
  })

  const registration = ctx.llm.registerAdapter([ROUTE_AUTO], adapter)

  /**
   * Refresh the roster from the lane.
   *
   * The lane's own adapter is the authority. When it is not mounted yet — the
   * lane installs after this plugin, or is absent — the lane's persisted
   * catalog answers instead, so the roster is never empty for long.
   */
  const refresh = async () => {
    const found = await discoverEacModels({ llm: ctx.llm })
    const ordered = applyPreferences(orderForFailover(found.models, settings.strategy), settings)
    const changed = ordered.length !== roster.length || ordered.some((model, index) => model.id !== roster[index]?.id)
    roster = ordered
    rosterSource = found.source
    if (changed) {
      logger.info?.(`eac-auto: roster holds ${roster.length} EAC model(s) from the ${found.source}`)
      // The picker reads the catalog on demand, but the harness caches it per
      // Host generation; announcing the change is what makes the new roster
      // visible without a restart.
      try {
        ctx.llm?.emitAdaptersUpdated?.()
      } catch {
        // A composition without the notification method keeps the old roster
        // until the next refresh; that is not a failure.
      }
    }
    return roster
  }

  ctx.effect(() => {
    // The first refresh waits a beat: the lane may still be mounting, and a
    // refresh that ran too early would find no adapter and no catalog yet.
    const timer = setTimeout(() => {
      void refresh().catch(error => {
        logger.warn?.(`eac-auto: roster refresh failed (${error?.message ?? error})`)
      })
    }, 1500)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'eac-auto: initial roster refresh')

  // The lane announces its own catalog changes; the roster follows.
  ctx.on?.('llm/adapters-updated', () => {
    void refresh().catch(() => { /* a failed refresh keeps the previous roster */ })
  })

  ctx.effect(() => () => registration(), 'eac-auto: adapter registration')

  // A tiny status surface, so the roster can be inspected without a UI build.
  //
  // The web server is optional, so it is read through `ctx.inject` rather than
  // declared in this plugin's `inject` list: a composition without a web
  // server still serves "EAC AUTO", it just has no status route.
  ctx.inject(['webServer'], scoped => {
    scoped.effect(() => scoped.webServer.register({
      kind: 'prefix',
      path: '/api/eac-auto',
      handler: async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const route = url.pathname.slice('/api/eac-auto'.length).replace(/\/+$/, '')
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(body))
        }
        try {
          if (route === '/refresh' && (req.method ?? 'GET').toUpperCase() === 'POST') {
            await refresh()
            send(200, { ok: true, models: roster, source: rosterSource })
            return
          }
          if (route === '/status' || route === '') {
            send(200, {
              ok: true,
              enabled: settings.enabled,
              strategy: settings.strategy,
              source: rosterSource,
              models: roster.map(model => ({ id: model.id, name: model.name })),
              lastRun,
            })
            return
          }
          send(404, { error: 'not found' })
        } catch (error) {
          send(500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'eac-auto: status route')
  })
}

export { ROUTE_AUTO, ROUTE_LABEL }
