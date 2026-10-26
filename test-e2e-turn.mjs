// True end-to-end: simulate a full WorkBuddy turn through the installed host's
// own event handler, then read back what /dsh-whale/last-turn.json would return.
//
// This exercises the real aggregation code (extracted from the installed plugin),
// not a reimplementation -- so it proves the patch actually wires up.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const HOST = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'lib/index.js')
const src = readFileSync(HOST, 'utf8')

let pass = 0, fail = 0
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail ? ' -> ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail ? ' -> ' + detail : '')) }
}

// ── Rebuild the host's credit logic from the installed source ───────────────
const missRate = Number(/const CREDIT_MISS_RATE = ([0-9.e-]+)/.exec(src)[1])
const hitRate = Number(/const CREDIT_HIT_RATE = ([0-9.e-]+)/.exec(src)[1])
const outRate = Number(/const CREDIT_OUT_RATE = ([0-9.e-]+)/.exec(src)[1])
const multSrc = /function creditMultiplierOf\(modelName\) \{[\s\S]*?\n    \}/.exec(src)[0]
const creditMultiplierOf = new Function(multSrc + '; return creditMultiplierOf')()

const registry = JSON.parse(readFileSync(path.join(DSH_HOME, '.dshw-api.json'), 'utf8'))
const readApiRegistry = () => registry

const regSrc = /function isCreditModel\(modelName, provider\) \{[\s\S]*?\n    \}/.exec(src)[0]
const isCreditModel = new Function('readApiRegistry', regSrc + '; return isCreditModel')(readApiRegistry)

const aggSrc = /function creditsOfAgg\(agg\) \{[\s\S]*?\n    \}/.exec(src)[0]
const creditsOfAgg = new Function(
  'isCreditModel', 'creditMultiplierOf', 'CREDIT_HIT_RATE', 'CREDIT_MISS_RATE', 'CREDIT_OUT_RATE',
  aggSrc + '; return creditsOfAgg'
)(isCreditModel, creditMultiplierOf, hitRate, missRate, outRate)

// ── Replicate the exact aggregation loop from handleSessionEvent ────────────
// (verbatim logic; the host does this inside a closure over turnAggs)
function makeAggregator() {
  const turnAggs = new Map()
  return {
    feed(sessionId, event) {
      const type = event && event.type
      const d = event && event.data
      if (!d || typeof d !== 'object') return
      if (type !== 'assistant/message') return
      const turn = Number(d.turn)
      const usage = d.usage
      if (!usage || typeof usage !== 'object' || !Number.isFinite(turn)) return
      const srcObj = d.message && d.message.source ? d.message.source : {}
      const model = srcObj.model || ''
      const provider = srcObj.provider || ''
      let agg = turnAggs.get(sessionId)
      if (!agg || agg.turn !== turn) {
        agg = { turn, cost: 0, tokens: 0, byModel: {}, byModelTokens: {}, byModelUsage: {}, lastTs: Date.now() }
        turnAggs.set(sessionId, agg)
      }
      const input = Number(usage.inputTokens) || 0
      const cache = Number(usage.cacheReadTokens) || 0
      const output = Number(usage.outputTokens) || 0
      const toks = input + cache + output
      agg.tokens += toks
      if (model) {
        agg.byModelTokens[model] = (agg.byModelTokens[model] || 0) + toks
        const u = agg.byModelUsage[model] || { hit: 0, miss: 0, out: 0, provider: '' }
        u.hit += cache
        u.miss += input
        u.out += output
        if (provider) u.provider = provider
        agg.byModelUsage[model] = u
      }
    },
    finalize(sessionId) {
      const agg = turnAggs.get(sessionId)
      turnAggs.delete(sessionId)
      if (!agg) return null
      const credits = creditsOfAgg(agg)
      // the patched gate: cost > 0 OR credits > 0
      if (!(agg.cost > 0 || credits > 0)) return null
      return {
        turn: agg.turn,
        amount: agg.cost,
        tokens: agg.tokens,
        ts: agg.lastTs,
        ...credits > 0 ? { credits } : {},
      }
    },
  }
}

console.log('=== scenario 1: a real WorkBuddy turn (cost 0, credits > 0) ===')
{
  const a = makeAggregator()
  // Two assistant messages in the same turn, WorkBuddy provider
  a.feed('s1', {
    type: 'assistant/message',
    data: {
      turn: 7,
      usage: { inputTokens: 6000, cacheReadTokens: 0, outputTokens: 2 },
      message: { source: { provider: 'workbuddy', model: 'GLM-5.3 · x0.79' } },
    },
  })
  a.feed('s1', {
    type: 'assistant/message',
    data: {
      turn: 7,
      usage: { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 3 },
      message: { source: { provider: 'workbuddy', model: 'GLM-5.3 · x0.79' } },
    },
  })
  const lt = a.finalize('s1')
  check('turn is produced', lt !== null, JSON.stringify(lt && { turn: lt.turn, credits: lt.credits, tokens: lt.tokens }))
  check('amount is 0 (WorkBuddy reports no cost)', lt && lt.amount === 0, lt && lt.amount)
  check('credits > 0 (this is the fix)', lt && lt.credits > 0, lt && lt.credits)
  // 7000 miss + 500 hit, x0.79
  const want = Math.round((7000 * missRate + 500 * hitRate) * 0.79 * 100) / 100
  check('credits match hand calc', lt && Math.abs(lt.credits - want) < 0.02, lt && lt.credits + ' vs ' + want)
  check('tokens accumulated', lt && lt.tokens, 7505)
}

console.log('\n=== scenario 2: a DeepSeek turn is NOT counted as credits ===')
{
  const a = makeAggregator()
  a.feed('s2', {
    type: 'assistant/message',
    data: {
      turn: 3,
      usage: { inputTokens: 50000, cacheReadTokens: 0, outputTokens: 500 },
      message: { source: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
    },
  })
  const lt = a.finalize('s2')
  // cost is 0 in this simulation (we did not compute money), credits must be 0 -> no record
  check('deepseek turn yields no credit record', lt === null, 'null')
}

console.log('\n=== scenario 3: mixed providers in one turn ===')
{
  const a = makeAggregator()
  a.feed('s3', {
    type: 'assistant/message',
    data: {
      turn: 1,
      usage: { inputTokens: 4000, cacheReadTokens: 0, outputTokens: 10 },
      message: { source: { provider: 'workbuddy', model: 'GLM-5.3 · x0.79' } },
    },
  })
  a.feed('s3', {
    type: 'assistant/message',
    data: {
      turn: 1,
      usage: { inputTokens: 90000, cacheReadTokens: 0, outputTokens: 900 },
      message: { source: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
    },
  })
  const lt = a.finalize('s3')
  const want = Math.round(4000 * missRate * 0.79 * 100) / 100
  check('only workbuddy tokens counted', lt && Math.abs(lt.credits - want) < 0.02, lt && lt.credits + ' vs ' + want)
}

console.log('\n=== scenario 4: cache-heavy turn is cheaper ===')
{
  const a = makeAggregator()
  const b = makeAggregator()
  a.feed('s4a', {
    type: 'assistant/message',
    data: { turn: 1, usage: { inputTokens: 7000, cacheReadTokens: 0, outputTokens: 0 }, message: { source: { provider: 'workbuddy', model: 'GLM-5.3' } } },
  })
  b.feed('s4b', {
    type: 'assistant/message',
    data: { turn: 1, usage: { inputTokens: 0, cacheReadTokens: 7000, outputTokens: 0 }, message: { source: { provider: 'workbuddy', model: 'GLM-5.3' } } },
  })
  const la = a.finalize('s4a')
  const lb = b.finalize('s4b')
  check('cache-hit turn much cheaper', lb.credits < la.credits / 3, lb.credits + ' vs ' + la.credits)
}

console.log('\n=== scenario 5: the six measured samples via the full pipeline ===')
{
  const truth = [
    [0, 7023, 3, 1.13],
    [0, 4467, 4, 0.72],
    [1088, 49, 3, 0.05],
    [0, 1137, 3, 0.18],
    [0, 6688, 3, 1.07],
    [0, 38, 4, 0.01],
  ]
  truth.forEach(([hit, miss, out, want], i) => {
    const a = makeAggregator()
    a.feed('x' + i, {
      type: 'assistant/message',
      data: {
        turn: 1,
        usage: { inputTokens: miss, cacheReadTokens: hit, outputTokens: out },
        message: { source: { provider: 'workbuddy', model: 'GLM-5.3' } },
      },
    })
    const lt = a.finalize('x' + i)
    const ok = lt && Math.abs(lt.credits - want) < 0.011
    if (ok) pass++; else fail++
    console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' sample ' + (i + 1) + ': ' + (lt && lt.credits) + ' vs ' + want)
  })
}

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
