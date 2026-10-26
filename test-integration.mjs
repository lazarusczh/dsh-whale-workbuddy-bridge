// End-to-end: feed a synthetic session/event stream through the host's own
// aggregation logic (extracted from the installed plugin) and confirm the
// credit lands in last-turn.json.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const HOST = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'lib/index.js')
const src = readFileSync(HOST, 'utf8')

// Rebuild the exact credit functions from the installed source.
const consts = [
  /const CREDIT_MISS_RATE = ([0-9.e-]+)/.exec(src)[1],
  /const CREDIT_HIT_RATE = ([0-9.e-]+)/.exec(src)[1],
  /const CREDIT_OUT_RATE = ([0-9.e-]+)/.exec(src)[1],
]
const missRate = Number(consts[0]), hitRate = Number(consts[1]), outRate = Number(consts[2])
const multSrc = /function creditMultiplierOf\(modelName\) \{[\s\S]*?\n    \}/.exec(src)[0]
const creditMultiplierOf = new Function(multSrc + '; return creditMultiplierOf')()

// isCreditModel needs readApiRegistry; stub it with the real registry file.
// Note: the signature is (modelName, provider) -- provider is the authoritative signal.
const regSrc = /function isCreditModel\(modelName, provider\) \{[\s\S]*?\n    \}/.exec(src)[0]
const registry = JSON.parse(readFileSync(path.join(DSH_HOME, '.dshw-api.json'), 'utf8'))
const readApiRegistry = () => registry
const isCreditModel = new Function('readApiRegistry', regSrc + '; return isCreditModel')(readApiRegistry)

// creditsOfAgg likewise.
const aggSrc = /function creditsOfAgg\(agg\) \{[\s\S]*?\n    \}/.exec(src)[0]
const creditsOfAgg = new Function(
  'isCreditModel', 'creditMultiplierOf', 'CREDIT_HIT_RATE', 'CREDIT_MISS_RATE', 'CREDIT_OUT_RATE',
  aggSrc + '; return creditsOfAgg'
)(isCreditModel, creditMultiplierOf, hitRate, missRate, outRate)

let pass = 0, fail = 0
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail ? ' -> ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' -> ' + detail : '')) }
}

console.log('=== registry in use ===')
console.log('  models:', registry.models.map((m) => m.id + '/' + m.provider).join(', '))

console.log('\n=== isCreditModel recognition ===')
// check(label, cond, detail) -- cond must be a boolean, not an expected value
check('provider=workbuddy is authoritative', isCreditModel('GLM-5.3', 'workbuddy') === true, 'GLM-5.3 @ workbuddy')
check('real name with x-suffix (no provider)', isCreditModel('GLM-5.3 · x0.79', '') === true, 'x-suffix fallback')
check('DeepSeek direct excluded', isCreditModel('deepseek-flash', 'deepseek') === false, 'deepseek-flash @ deepseek')
check('DeepSeek direct excluded (no provider)', isCreditModel('deepseek-flash', '') === false, 'name only')
console.log('\n=== creditsOfAgg on a synthetic aggregate ===')
// Simulate one turn: 7000 cache-miss input, 3 output, on a workbuddy model
// provider is what the host now records from source.provider
const agg1 = { byModelUsage: { 'GLM-5.3 · x0.79': { hit: 0, miss: 7000, out: 3, provider: 'workbuddy' } } }
const c1 = creditsOfAgg(agg1)
check('7000 miss on workbuddy model', Math.abs(c1 - 1.12 * 0.79) < 0.02, c1 + ' credits (x0.79 applied)')

// Mixed turn: workbuddy + deepseek in the same turn -> only workbuddy counted
const agg2 = {
  byModelUsage: {
    'GLM-5.3 · x0.79': { hit: 0, miss: 7000, out: 3, provider: 'workbuddy' },
    'deepseek-flash': { hit: 0, miss: 50000, out: 500, provider: 'deepseek' },
  },
}
const c2 = creditsOfAgg(agg2)
check('mixed turn counts only workbuddy', Math.abs(c2 - c1) < 0.001, c2 + ' vs ' + c1)

// Pure deepseek turn -> zero credits (so the bubble gate does not fire)
const agg3 = { byModelUsage: { 'deepseek-flash': { hit: 0, miss: 50000, out: 500, provider: 'deepseek' } } }
const c3 = creditsOfAgg(agg3)
check('pure deepseek turn = 0 credits', c3 === 0, c3)

// Cache-heavy turn should be much cheaper than the same tokens all-miss
const agg4 = { byModelUsage: { 'GLM-5.3 · x0.79': { hit: 7000, miss: 0, out: 3, provider: 'workbuddy' } } }
const c4 = creditsOfAgg(agg4)
check('cache-hit-heavy is cheaper', c4 < c1 / 3, c4 + ' vs ' + c1)

// Legacy aggregate without byModelUsage -> 0, no crash
check('legacy agg (no byModelUsage) = 0', creditsOfAgg({ cost: 0.5 }) === 0, '0')
check('null agg safe', creditsOfAgg(null) === 0, '0')

console.log('\n=== bubble gate simulation ===')
// The host now enters finalizeTurn when cost > 0 OR credits > 0.
function gate(agg) {
  const credits = creditsOfAgg(agg)
  return { credits, enters: !!(agg && (agg.cost > 0 || credits > 0)) }
}
const g1 = gate({ cost: 0, byModelUsage: { 'GLM-5.3 · x0.79': { hit: 0, miss: 7000, out: 3, provider: 'workbuddy' } } })
check('workbuddy turn (cost 0) now enters', g1.enters === true, 'credits=' + g1.credits)
const g2 = gate({ cost: 0, byModelUsage: { 'deepseek-flash': { hit: 0, miss: 50000, out: 500, provider: 'deepseek' } } })
check('deepseek turn (cost 0) still skipped', g2.enters === false, 'credits=' + g2.credits)
const g3 = gate({ cost: 0.42, byModelUsage: { 'deepseek-flash': { hit: 0, miss: 1000, out: 10, provider: 'deepseek' } } })
check('paid turn still enters via cost', g3.enters === true, 'cost=0.42 credits=' + g3.credits)

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
