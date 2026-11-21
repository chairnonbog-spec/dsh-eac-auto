/**
 * EAC model discovery: find every free EAC model the co-paid lane offers.
 *
 * The EAC (co-paid) lane belongs to the `dsh-our-free-model` plugin. That
 * plugin owns the credential, the listing round and the wire, and publishes its
 * models under the `our-free-model` provider route with ids that carry a
 * vendor prefix (`amd/…`, `opencode/…`, `z-ai/…`).
 *
 * This plugin does not re-implement any of that. It reads the *same* catalog
 * the lane itself routes on, so "EAC AUTO" can never promise a model the lane
 * would refuse.
 *
 * Two discovery seams exist, in descending order of authority:
 *
 * 1. **The lane's own adapter.** `ctx.llm.listModels('our-free-model')` returns
 *    the rows the picker advertises, and each row's *name* carries the lane's
 *    channel tag ("EAC DeepSeek V4.1 Flash"). That tag is the only marker that
 *    distinguishes a co-paid row from a free-lane row, a Kilo row or an
 *    aggregate row, because the ids themselves do not: `opencode/deepseek-v4.1-
 *    flash-free` is EAC, while `deepseek-v4.1-flash-free` on the free lane is a
 *    different model on a different wire.
 * 2. **The lane's persisted catalog.** `~/.dsh/our-free-model/catalog.json`
 *    holds `sealIds` — the ids the lane's own listing round produced — plus the
 *    full `kiloRows` and free-lane `entries`. This survives a restart, so the
 *    roster is not empty before the first refresh lands.
 *
 * Every source is optional: this plugin must stay usable when the lane is
 * absent, and must report "no EAC models" rather than invent a roster.
 *
 * @module src/discovery.js
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** The provider route the co-paid lane publishes its models under. */
export const OFM_ROUTE = 'our-free-model'

/** The channel tag the lane prefixes onto every co-paid row's display name. */
export const EAC_TAG = 'EAC'

/** The lane's own data directory name under the harness home. */
const OFM_DATA_DIR = 'our-free-model'

/** The lane's persisted catalog file. */
const OFM_CATALOG_FILE = 'catalog.json'

/**
 * Does this display name carry the lane's EAC channel tag?
 *
 * The tag is the lane's own prefix, e.g. "EAC DeepSeek V4.1 Flash". A row
 * whose name is "Kilo Beam" or "DeepSeek V4.1 Flash" (the free lane) is not
 * on the co-paid lane, however similar its id looks.
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function hasEacTag(name) {
  return typeof name === 'string' && name.trim().startsWith(`${EAC_TAG} `)
}

/**
 * Strip the channel tag off a display name, leaving the model's own name.
 * @param {string} name
 * @returns {string}
 */
export function stripEacTag(name) {
  const text = String(name ?? '').trim()
  return text.startsWith(`${EAC_TAG} `) ? text.slice(EAC_TAG.length + 1).trim() : text
}

/**
 * The harness home: `$DSH_HOME` when set, else `~/.dsh`.
 * @returns {string}
 */
export function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

/**
 * The lane's persisted catalog path.
 * @returns {string}
 */
export function ofmCatalogPath() {
  return path.join(resolveDshHome(), OFM_DATA_DIR, OFM_CATALOG_FILE)
}

/**
 * Read the lane's persisted catalog.
 *
 * A missing or damaged file is not an error: the lane owns that file, and this
 * plugin only reads it opportunistically. The caller gets `null` and falls
 * back to another seam.
 *
 * @returns {{sealIds?: string[], entries?: string[], kiloRows?: object[]}|null}
 */
export function readPersistedCatalog() {
  try {
    const raw = fs.readFileSync(ofmCatalogPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Is this id one the lane published on its co-paid (sealed) listing?
 *
 * @param {string} id
 * @param {{sealIds?: string[]}|null} persisted
 * @returns {boolean}
 */
export function isSealedId(id, persisted) {
  const ids = persisted?.sealIds
  if (!Array.isArray(ids)) return false
  return ids.includes(String(id ?? '').trim())
}

/**
 * Normalize one discovered EAC model row.
 *
 * Capacities that the lane does not publish fall back to conservative
 * defaults: the *smallest* plausible window, so a fallback model is never
 * handed a context larger than it can honour.
 *
 * @param {object} raw - one row, from any discovery seam
 * @returns {object|null}
 */
export function normalizeModel(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '') return null
  const name = stripEacTag(typeof raw.name === 'string' ? raw.name : id)
  const efforts = Array.isArray(raw.efforts)
    ? raw.efforts.filter(level => typeof level === 'string' && level !== '')
    : undefined
  return {
    id,
    name: name === '' ? id : name,
    contextWindow: positive(raw.contextWindow) ?? 131072,
    maxOutput: positive(raw.maxOutput) ?? 32768,
    vision: raw.vision === true,
    reasoning: raw.reasoning !== false,
    ...efforts === undefined ? {} : { efforts },
    ...typeof raw.effortDefault === 'string' && raw.effortDefault !== ''
      ? { effortDefault: raw.effortDefault }
      : {},
  }
}

/**
 * A positive finite integer, or undefined.
 * @param {unknown} value
 * @returns {number|undefined}
 */
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

/**
 * Every EAC model the lane currently advertises.
 *
 * The lane's adapter is the authority: `listModels` returns exactly the rows
 * the picker would offer, so a model that cannot be routed never enters the
 * roster. Its rows are recognised by the channel tag the lane puts on the
 * display name.
 *
 * The persisted catalog is the fallback for the window before the lane's first
 * listing round lands (and after a restart, before the refresh completes). It
 * carries ids only, so those rows get default capacities.
 *
 * @param {object} deps
 * @param {object} deps.llm - the `llm` service
 * @returns {Promise<{models: object[], source: 'adapter'|'persisted'|'none'}>}
 */
export async function discoverEacModels({ llm }) {
  const fromAdapter = await discoverFromAdapter(llm)
  if (fromAdapter.length > 0) return { models: fromAdapter, source: 'adapter' }

  const persisted = readPersistedCatalog()
  const fromPersisted = discoverFromPersisted(persisted)
  if (fromPersisted.length > 0) return { models: fromPersisted, source: 'persisted' }

  return { models: [], source: 'none' }
}

/**
 * The EAC rows the lane's own adapter advertises.
 *
 * Rows are matched by the channel tag on the display name. A row that carries
 * a *different* lane's channel is skipped even when its name looks similar:
 * the id alone cannot separate the lanes.
 *
 * @param {object} llm
 * @returns {Promise<object[]>}
 */
async function discoverFromAdapter(llm) {
  if (typeof llm?.listModels !== 'function') return []
  let rows
  try {
    rows = await llm.listModels(OFM_ROUTE)
  } catch {
    return []
  }
  const candidates = []
  const seen = new Set()
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row === null || typeof row !== 'object') continue
    if (!hasEacTag(row.name)) continue
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    candidates.push(row)
  }
  if (candidates.length === 0) return []

  // The lane's exact-model resolution carries the real capacities and the
  // model's own thinking menu. Those are what the router must reason about:
  // the roster's window is the *minimum* over the candidates, and the effort
  // level can only be forwarded to a model that declares it.
  const models = []
  for (const row of candidates) {
    const info = await resolveModelInfo(llm, row.id)
    const model = normalizeModel({
      id: row.id,
      name: row.name,
      contextWindow: info?.context?.contextWindow,
      maxOutput: info?.defaultMaxTokens,
      inputModalities: info?.inputModalities,
      vision: Array.isArray(info?.inputModalities) && info.inputModalities.includes('image'),
      reasoning: info?.reasoning !== undefined,
      efforts: info?.reasoning?.efforts?.map(effort => effort.id),
      effortDefault: info?.reasoning?.defaultEffort,
    })
    if (model !== null) models.push(model)
  }
  return models
}

/**
 * One exact-model resolution, or undefined when the lane cannot answer.
 * @param {object} llm
 * @param {string} id
 * @returns {Promise<object|undefined>}
 */
async function resolveModelInfo(llm, id) {
  if (typeof llm?.resolveModelInfo !== 'function') return undefined
  try {
    return await llm.resolveModelInfo(OFM_ROUTE, id)
  } catch {
    return undefined
  }
}

/**
 * The EAC ids the lane's persisted catalog names.
 *
 * The catalog's `sealIds` is the lane's own record of what its co-paid listing
 * returned. Ids that also appear in the free lane's `entries` or in the
 * Kilo channel's `kiloRows` are not EAC rows, and are dropped.
 *
 * @param {object|null} persisted
 * @returns {object[]}
 */
function discoverFromPersisted(persisted) {
  if (persisted === null) return []
  const sealIds = Array.isArray(persisted.sealIds) ? persisted.sealIds : []
  const freeIds = new Set(Array.isArray(persisted.entries) ? persisted.entries : [])
  const kiloIds = new Set(
    (Array.isArray(persisted.kiloRows) ? persisted.kiloRows : [])
      .map(row => (typeof row?.id === 'string' ? row.id.trim() : ''))
      .filter(id => id !== ''),
  )
  const models = []
  const seen = new Set()
  for (const raw of sealIds) {
    const id = typeof raw === 'string' ? raw.trim() : ''
    if (id === '' || seen.has(id)) continue
    if (freeIds.has(id) || kiloIds.has(id)) continue
    seen.add(id)
    const model = normalizeModel({ id })
    if (model !== null) models.push(model)
  }
  return models
}

/**
 * Order the roster for failover.
 *
 * The order is the user's policy, expressed as a small readable list:
 *
 * - `balanced` (default) — the lane's own listing order.
 * - `speed` — the models with the largest output ceiling first; on this lane a
 *   big ceiling marks the larger, faster model.
 * - `quality` — the models with the largest context window first.
 *
 * @param {object[]} models
 * @param {string} strategy
 * @returns {object[]}
 */
export function orderForFailover(models, strategy) {
  const rows = Array.isArray(models) ? models.filter(Boolean) : []
  if (strategy !== 'speed' && strategy !== 'quality') return rows
  const scored = rows.map((row, index) => ({ row, index, score: strategyScore(row, strategy) }))
  return scored
    .sort((left, right) => (right.score - left.score) || (left.index - right.index))
    .map(entry => entry.row)
}

/**
 * A comparable "fastness" or "quality" figure for one model.
 *
 * @param {object} row
 * @param {string} strategy
 * @returns {number}
 */
function strategyScore(row, strategy) {
  if (strategy === 'speed') return typeof row.maxOutput === 'number' ? row.maxOutput : 0
  return typeof row.contextWindow === 'number' ? row.contextWindow : 0
}

/**
 * The thinking levels every candidate in the roster accepts.
 *
 * A router can only forward a level that every candidate understands, so the
 * route's own menu is the *intersection* of the candidates' menus. An empty
 * intersection means the candidates disagree about their levels, and the route
 * then declares no menu at all — the harness sends no level, and each candidate
 * uses its own default.
 *
 * @param {object[]} models
 * @returns {{efforts: string[], defaultEffort: string}|undefined}
 */
export function commonEfforts(models) {
  const menus = (Array.isArray(models) ? models : [])
    .map(model => model?.efforts)
    .filter(menu => Array.isArray(menu) && menu.length > 0)
  if (menus.length === 0) return undefined
  const [first, ...rest] = menus
  const common = first.filter(level => rest.every(menu => menu.includes(level)))
  if (common.length === 0) return undefined
  const defaults = menus
    .map((menu, index) => (models[index]?.effortDefault !== undefined ? models[index].effortDefault : menu[0]))
    .filter(level => common.includes(level))
  return {
    efforts: [...common],
    defaultEffort: defaults[0] ?? common[0],
  }
}

/**
 * Does this candidate accept the given thinking level?
 *
 * @param {object} model
 * @param {string|undefined} level
 * @returns {boolean}
 */
export function acceptsEffort(model, level) {
  if (level === undefined || level === '') return true
  const menu = model?.efforts
  if (!Array.isArray(menu) || menu.length === 0) return false
  return menu.includes(level)
}
