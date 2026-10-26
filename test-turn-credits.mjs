// Turn credit ledger tests (rate-based, pure local computation).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TurnCreditLedger } from './lib/turn-credits.mjs'

const root = path.join(os.tmpdir(), 'ledger-' + Date.now())

let pass = 0, fail = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log('  OK   ' + label + ' -> ' + JSON.stringify(actual)) }
  else { fail++; console.log('  FAIL ' + label + ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)) }
}

console.log('=== case 1: a turn settles immediately from tokens ===')
{
  const led = new TurnCreditLedger({ home: path.join(root, 'a'), log: () => {} })
  const r = await led.onTurnEnd({ turn: 1, byModel: { 'GLM-5.3': { hit: 0, miss: 7000, out: 3 } } })
  check('settles at once (no async wait)', r !== undefined, true)
  check('credits = 7000 * miss rate', r && r.credits, 1.12)
  check('source is tokens', r && r.source, 'tokens')
  check('seq advanced', led.seq, 1)
}

console.log('\n=== case 2: replay the six measured samples ===')
{
  const truth = [
    [{ hit: 0, miss: 7023, out: 3 }, 1.13],
    [{ hit: 0, miss: 4467, out: 4 }, 0.72],
    [{ hit: 1088, miss: 49, out: 3 }, 0.05],
    [{ hit: 0, miss: 1137, out: 3 }, 0.18],
    [{ hit: 0, miss: 6688, out: 3 }, 1.07],
    [{ hit: 0, miss: 38, out: 4 }, 0.01],
  ]
  const led = new TurnCreditLedger({ home: path.join(root, 'b'), log: () => {} })
  for (let i = 0; i < truth.length; i++) {
    const u = truth[i][0]
    const want = truth[i][1]
    const r = await led.onTurnEnd({ turn: i + 1, byModel: { 'GLM-5.3': u } })
    const ok = r && Math.abs(r.credits - want) < 0.011
    if (ok) pass++; else fail++
    console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' sample ' + (i + 1) + ': ' + (r ? r.credits : 'undefined') + ' vs ' + want)
  }
}

console.log('\n=== case 3: cache hits are cheaper ===')
{
  const led = new TurnCreditLedger({ home: path.join(root, 'c'), log: () => {} })
  const missTurn = await led.onTurnEnd({ turn: 1, byModel: { 'M': { hit: 0, miss: 7000, out: 0 } } })
  const hitTurn = await led.onTurnEnd({ turn: 2, byModel: { 'M': { hit: 7000, miss: 0, out: 0 } } })
  check('hit turn cheaper than miss turn', hitTurn.credits < missTurn.credits, true)
  console.log('     hit=' + hitTurn.credits + ' miss=' + missTurn.credits)
}

console.log('\n=== case 4: multiplier applied ===')
{
  const led = new TurnCreditLedger({ home: path.join(root, 'd'), log: () => {} })
  const a = await led.onTurnEnd({ turn: 1, byModel: { 'GLM-5.3': { hit: 0, miss: 10000, out: 0 } } })
  const b = await led.onTurnEnd({ turn: 2, byModel: { 'GLM-5.3 · x0.79': { hit: 0, miss: 10000, out: 0 } } })
  check('x0.79 scales down', Math.abs(b.credits - Math.round(a.credits * 0.79 * 100) / 100) < 0.02, true)
  console.log('     x1=' + a.credits + ' x0.79=' + b.credits)
}

console.log('\n=== case 5: no usage -> no record ===')
{
  const led = new TurnCreditLedger({ home: path.join(root, 'e'), log: () => {} })
  check('empty byModel', await led.onTurnEnd({ turn: 1, byModel: {} }), undefined)
  check('all-zero usage', await led.onTurnEnd({ turn: 2, byModel: { 'M': { hit: 0, miss: 0, out: 0 } } }), undefined)
  check('no seq consumed', led.seq, 0)
}

console.log('\n=== case 6: persistence across restart ===')
{
  const h = path.join(root, 'f')
  const a = new TurnCreditLedger({ home: h, log: () => {} })
  await a.onTurnEnd({ turn: 1, byModel: { 'M': { hit: 0, miss: 1000, out: 0 } } })
  const seq1 = a.seq
  const b = new TurnCreditLedger({ home: h, log: () => {} })
  check('history loaded', b.turns.length, 1)
  check('seq continues', b.seq, seq1)
  check('latest readable', b.snapshot().latest.credits, 0.16)
}

console.log('\n=== case 7: snapshot shape ===')
{
  const led = new TurnCreditLedger({ home: path.join(root, 'g'), log: () => {} })
  check('empty snapshot latest is null', led.snapshot().latest, null)
  await led.onTurnEnd({ turn: 9, byModel: { 'M': { hit: 0, miss: 2000, out: 0 } } })
  const s = led.snapshot()
  check('latest present', s.latest.credits, 0.32)
  check('turns array', Array.isArray(s.turns), true)
  check('ok flag', s.ok, true)
}

console.log('\n=== case 8: history capped ===')
{
  const led = new TurnCreditLedger({ home: path.join(root, 'h'), log: () => {} })
  for (let i = 0; i < 60; i++) await led.onTurnEnd({ turn: i, byModel: { 'M': { hit: 0, miss: 1000, out: 0 } } })
  check('capped at 50', led.turns.length, 50)
}

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
fs.rmSync(root, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
