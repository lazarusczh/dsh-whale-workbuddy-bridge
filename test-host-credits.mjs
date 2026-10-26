// Verify the credit conversion added to the whale-widget host, by extracting
// the real constants/functions from the installed plugin (not a local copy).
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const HOST = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'lib/index.js')
const CLI = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'assets/whale-widget.js')
const src = readFileSync(HOST, 'utf8')
const cli = readFileSync(CLI, 'utf8')

const missRate = Number(/const CREDIT_MISS_RATE = ([0-9.e-]+)/.exec(src)[1])
const hitRate = Number(/const CREDIT_HIT_RATE = ([0-9.e-]+)/.exec(src)[1])
const outRate = Number(/const CREDIT_OUT_RATE = ([0-9.e-]+)/.exec(src)[1])

console.log('=== rates read from host source ===')
console.log('  MISS:', missRate, '| HIT:', hitRate, '| OUT:', outRate)

const multSrc = /function creditMultiplierOf\(modelName\) \{[\s\S]*?\n    \}/.exec(src)[0]
const creditMultiplierOf = new Function(multSrc + '; return creditMultiplierOf')()

let pass = 0
let fail = 0
function check(label, actual, expected, tol = 0.011) {
  const ok = Math.abs(actual - expected) < tol
  if (ok) { pass++; console.log('  OK   ' + label + ' -> ' + actual) }
  else { fail++; console.log('  FAIL ' + label + ' -> got ' + actual + ', want ' + expected) }
}

function credits(hit, miss, out, model) {
  return Math.round((hit * hitRate + miss * missRate + out * outRate) * creditMultiplierOf(model) * 100) / 100
}

console.log('\n=== replay the six measured samples ===')
const samples = [
  ['A', 0, 7023, 3, 1.13],
  ['B', 0, 4467, 4, 0.72],
  ['C', 1088, 49, 3, 0.05],
  ['D', 0, 1137, 3, 0.18],
  ['E', 0, 6688, 3, 1.07],
  ['F', 0, 38, 4, 0.01],
]
for (const [id, hit, miss, out, truth] of samples) {
  const got = credits(hit, miss, out, 'GLM-5.3')
  const err = Math.abs(got - truth) / truth
  const ok = err < 0.05
  if (ok) pass++; else fail++
  console.log('  ' + (ok ? 'OK   ' : 'FAIL ') + 'sample ' + id + ': computed ' + got + ' vs actual ' + truth + ' -> error ' + (err * 100).toFixed(1) + '%')
}

console.log('\n=== multiplier parsing ===')
check('x1 (no multiplier)', creditMultiplierOf('GLM-5.3'), 1)
check('x0.79', creditMultiplierOf('GLM-5.3 . x0.79'), 0.79)
check('x2.5', creditMultiplierOf('Some-Model . x2.5'), 2.5)
check('spaced x 0.5', creditMultiplierOf('M . x 0.5'), 0.5)

console.log('\n=== multiplier applied ===')
check('10000 miss @ x0.79', credits(0, 10000, 0, 'GLM-5.3 . x0.79'), 1.27)
check('10000 miss @ x1', credits(0, 10000, 0, 'GLM-5.3'), 1.61)

console.log('\n=== cache hit is cheaper ===')
const pureMiss = credits(0, 1000, 0, 'M')
const pureHit = credits(1000, 0, 0, 'M')
console.log('  1000 miss = ' + pureMiss + ' ; 1000 hit = ' + pureHit)
console.log('  ratio: ' + (pureMiss / pureHit).toFixed(1) + 'x (measured about 4.1x)')
check('hit is about 4.1x cheaper', Math.round(pureMiss / pureHit * 10) / 10, 4.1, 0.15)

console.log('\n=== host patch presence ===')
const hostChecks = [
  ['CREDIT_MISS_RATE defined', src.includes('const CREDIT_MISS_RATE')],
  ['creditMultiplierOf defined', src.includes('function creditMultiplierOf')],
  ['isCreditModel defined', src.includes('function isCreditModel')],
  ['creditsOfAgg defined', src.includes('function creditsOfAgg')],
  ['finalizeTurn credit gate', src.includes('agg.cost > 0 || credits > 0')],
  ['lastTurn carries credits', src.includes('...credits > 0 ? { credits } : {}')],
  ['aggregate has byModelUsage', src.includes('byModelUsage: {}')],
  ['last-turn.json returns credits', src.includes('credits: lastTurn.credits === undefined ? null : lastTurn.credits')],
]
for (const [label, ok] of hostChecks) {
  if (ok) { pass++; console.log('  OK   ' + label) } else { fail++; console.log('  FAIL ' + label) }
}

console.log('\n=== client patch presence ===')
const cliChecks = [
  ['usageFillText takes credits', cli.includes('function usageFillText(txt, below, amount, cost, session, credits)')],
  ['{credits} placeholder replaced', cli.includes('.replace(/\\{credits\\}/g')],
  ['usageAlertModsResolved passes it', cli.includes('function usageAlertModsResolved(mods, below, amount, cost, session, credits)')],
  ['bubbleRenderCostMods takes credits', cli.includes('function bubbleRenderCostMods(amount, credits)')],
  ['showCostBubble takes credits', cli.includes('function showCostBubble(amount, credits)')],
  ['queue item carries credits', cli.includes("kind: 'cost', amount: amount, credits: credits")],
  ['render passes item.credits', cli.includes('bubbleRenderCostMods(item.amount, item.credits)')],
  ['poll reads d.credits', cli.includes("var cr = (typeof d.credits === 'number') ? d.credits : undefined")],
]
for (const [label, ok] of cliChecks) {
  if (ok) { pass++; console.log('  OK   ' + label) } else { fail++; console.log('  FAIL ' + label) }
}

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
