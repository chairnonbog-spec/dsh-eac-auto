/**
 * The adapter behind the "EAC AUTO" model.
 *
 * "EAC AUTO" is not a model of its own. It is a *virtual* model whose answer
 * comes from the first EAC model in the roster that answers at all — and when
 * one fails, the next one is tried.
 *
 * How the delegation works:
 *
 * The harness routes a request by `(provider, model)`. `provider` selects the
 * adapter, `model` selects the row inside it. "EAC AUTO" therefore gets its
 * own provider route, and this adapter owns that route alone. When it needs a
 * real EAC model, it re-enters the `llm` service with the *lane's* provider
 * route (`our-free-model`) and the real model's id — so the real turn is
 * dispatched by the lane's own adapter, with the lane's own credential, wire
 * and recovery. This plugin never touches the credential or the network.
 *
 * That re-entry goes through `llm.stream()`, which is the waterfall-intercepted
 * public entry point. Two consequences are worth stating:
 *
 * - The nested call is a *nested* model request, not a second agent turn. The
 *   harness's own waterfall listeners see it as a normal request; the agent
 *   loop never sees it, so the session log records one turn, not two.
 * - The nested request carries a distinct `provider`, so the harness's replay
 *   bookkeeping does not confuse the two routes.
 *
 * @module src/adapter.js
 */

import { runFailover } from './failover.js'
import { acceptsEffort, commonEfforts } from './discovery.js'

/** This plugin's own provider route — the one "EAC AUTO" is selected under. */
export const ROUTE_AUTO = 'eac-auto'

/** The route label the picker shows as the group heading. */
export const ROUTE_LABEL = 'EAC Auto'

/** The virtual model id the user picks. */
export const AUTO_MODEL_ID = 'EAC AUTO'

/**
 * The display name of one thinking level.
 *
 * The levels are the upstream gateways' own ids (`disabled`, `low`, `high`,
 * `max`, …), so the label is the id with its first letter capitalized — the
 * spelling the picker uses for every other provider's menu.
 *
 * @param {string} id
 * @returns {string}
 */
function effortLabel(id) {
  if (id === 'disabled') return 'Off'
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/**
 * A conservative default roster, used when the lane is not installed yet.
 *
 * These are the lane's own ids as of the last reading. An empty roster is
 * better than a wrong one — the adapter reports "no EAC model available"
 * rather than dispatching to an id the lane would refuse.
 */
export const FALLBACK_MODEL_IDS = [
  'opencode/deepseek-v4.1-flash-free',
  'opencode/glm-5.3-flash-free',
  'deepseek-ai/deepseek-v4.1-flash',
  'z-ai/glm-5.3-flash',
]

/**
 * The adapter that serves the "EAC AUTO" model.
 */
export class EacAutoAdapter {
  /**
   * @param {object} dependencies
   * @param {() => object} dependencies.state - the live snapshot getter
   */
  constructor(dependencies) {
    this.deps = dependencies
  }

  providerInfo(provider) {
    return { id: provider, name: ROUTE_LABEL }
  }

  /**
   * Retry policy for this route.
   *
   * The failover inside the adapter already walks the whole roster, so the
   * harness must not *also* retry the same request — that would spend the
   * roster twice. The policy therefore declares no retryable codes: a failure
   * that reaches the harness has already exhausted every candidate.
   */
  providerRetryPolicy() {
    return {
      mode: 'normal',
      maxRetries: 0,
      retryableCodes: [],
      initialDelayMs: 500,
      maxDelayMs: 10_000,
      jitterRatio: 0.1,
    }
  }

  /**
   * The models this route advertises: exactly one, "EAC AUTO".
   *
   * @param {string} provider
   * @returns {Promise<readonly object[]>}
   */
  async listModels(provider) {
    const snapshot = this.deps.state()
    const count = snapshot.models.length
    if (snapshot.enabled === false) {
      return [{
        provider,
        id: AUTO_MODEL_ID,
        name: AUTO_MODEL_ID,
        description: 'switched off in the EAC Auto plugin configuration',
        inputModalities: ['text'],
      }]
    }
    return [{
      provider,
      id: AUTO_MODEL_ID,
      name: AUTO_MODEL_ID,
      description: count === 0
        ? 'automatically picks an available EAC model; no EAC model is available yet'
        : `automatically picks one of ${count} EAC models and switches to the next one when a model fails`,
      inputModalities: ['text'],
    }]
  }

  /**
   * Resolve the virtual model's metadata.
   *
   * The capacities are the *intersection* of the roster's, not the union: a
   * chain that advertises a 1M window because its head has one hands a
   * fallback a prompt it cannot hold. The honest numbers are the ones every
   * candidate can honour.
   *
   * The thinking menu is the intersection of the candidates' menus for the
   * same reason: a level only one candidate understands would be rejected by
   * the harness before the request is even sent. When the candidates disagree
   * about their levels, the route declares no menu — the harness sends no
   * level, and each candidate applies its own default.
   *
   * @param {string} provider
   * @param {string} model
   * @returns {Promise<object>}
   */
  async resolveModel(provider, model) {
    const snapshot = this.deps.state()
    const models = snapshot.models
    const contextWindow = models.length === 0
      ? 131072
      : Math.min(...models.map(entry => entry.contextWindow ?? 131072))
    const defaultMaxTokens = models.length === 0
      ? 32768
      : Math.min(...models.map(entry => entry.maxOutput ?? 32768))
    const menu = commonEfforts(models)
    return {
      provider,
      id: AUTO_MODEL_ID,
      name: AUTO_MODEL_ID,
      description: models.length === 0
        ? 'no EAC model is available yet'
        : `auto-selects among ${models.length} EAC models · ${models.map(entry => entry.name).join(', ')}`,
      inputModalities: ['text'],
      context: { contextWindow },
      defaultMaxTokens,
      ...menu === undefined ? {} : {
        reasoning: {
          efforts: menu.efforts.map(id => ({ id, name: effortLabel(id) })),
          defaultEffort: menu.defaultEffort,
        },
      },
    }
  }

  /**
   * Bind the model metadata and the dispatch closure to one state snapshot.
   *
   * @param {string} provider
   * @param {string} model
   * @returns {Promise<{model: object, stream: Function}>}
   */
  async prepareCall(provider, model) {
    const snapshot = this.deps.state()
    return {
      model: await this.resolveModel(provider, model),
      stream: options => this.stream(options, snapshot),
    }
  }

  /**
   * One turn: walk the EAC roster until one model answers.
   *
   * @param {object} options - the harness's `GenerateOptions`
   * @param {object} snapshot - the state generation frozen by `prepareCall`
   */
  stream(options, snapshot = this.deps.state()) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })

    const iterator = this.runStream({ ...options, signal: controller.signal }, snapshot)
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
    const step = async (method, value) => {
      try {
        const row = await iterator[method](value)
        if (row.done) cleanup()
        return row
      } catch (error) {
        cleanup()
        throw error
      }
    }
    return {
      [Symbol.asyncIterator]() { return this },
      next: value => step('next', value),
      return: value => { controller.abort(); cleanup(); return step('return', value) },
      throw: error => { controller.abort(error); cleanup(); return step('throw', error) },
    }
  }

  /**
   * The turn itself.
   *
   * @param {object} options
   * @param {object} snapshot
   */
  async * runStream(options, snapshot) {
    const roster = snapshot.models
    if (roster.length === 0) {
      yield {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: snapshot.enabled === false
              ? 'EAC AUTO is switched off in its plugin configuration'
              : 'no EAC model is available: install and sign in to dsh-our-free-model, then refresh',
            code: snapshot.enabled === false ? 'CONFIG_DISABLED' : 'EAC_NO_MODELS',
          },
        },
      }
      return
    }

    const candidates = roster.map(model => ({
      open: async () => ({ id: model.id, name: model.name }),
      chunks: signal => this.dispatchTo(model, options, snapshot, signal),
    }))

    const outcome = yield * runFailover({
      candidates,
      signal: options.signal,
      silenceTimeoutMs: snapshot.silenceTimeoutMs,
      onEvent: event => this.deps.onEvent?.(event),
    })

    this.deps.recordTurn?.({
      at: Date.now(),
      model: AUTO_MODEL_ID,
      ok: outcome.committed,
      recovered: outcome.committed && outcome.tried.length > 0,
      attempts: outcome.tried.length + (outcome.committed ? 1 : 0),
      origin: 'harness',
    })
  }

  /**
   * Dispatch one turn to one real EAC model.
   *
   * The nested call carries the *lane's* provider route, so the lane's own
   * adapter performs the real request — with the lane's credential, wire and
   * recovery.
   *
   * The thinking level is forwarded only when this candidate declares it. The
   * roster's models have different menus, so a level the candidate does not
   * know would be rejected by the harness before the request is even sent;
   * dropping it lets the candidate apply its own default instead.
   *
   * @param {object} model - one EAC roster row
   * @param {object} options - the harness's request
   * @param {object} snapshot
   * @param {AbortSignal} signal - the candidate's own controller signal
   * @returns {AsyncIterable<object>}
   */
  dispatchTo(model, options, snapshot, signal) {
    const llm = this.deps.llm
    const nested = {
      ...options,
      provider: snapshot.laneRoute,
      model: model.id,
      signal,
    }
    if (!acceptsEffort(model, nested.reasoningEffort)) delete nested.reasoningEffort
    return llm.stream(nested)
  }
}
