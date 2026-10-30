// 逐轮账本的行为测试。
//
// ── 重要历史（2026-10-30 重写）────────────────────────────────────
//
// 这个文件原先验证的是「token 费率估算」：
//   credit = hit*3.8725e-5 + miss*1.6057e-4 + out*0
// 它曾经在**单请求**粒度上拟合得很好（6 组样本回代误差 0.2~1.4%）。
//
// 但整轮会放大成灾：一轮几十次调用、cacheReadTokens 累加到几百万 token，
// 线性累加后算出几百甚至上千积分。用 4 组「账单真值 + 本地 token」配对反解：
//   单因子相关性 hit=-0.19 / miss=-0.41 / out=0.64（都很弱）
//   credit/miss 比值波动 5 倍（5e-5 ~ 2.4e-4）
//   → **本地 token 与积分之间没有稳定映射**，不是参数没调好，是模型错了
//   旧费率回代高估 8.2~44.9 倍
//
// 所以现在账本**不再用估算填数**，改为三级取值：
//   ① 余额差（即时、准确）  ② 官方账单（延迟 20 分钟、精确）  ③ pending（等补账）
//
// 本文件验证的是这套新行为。
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

console.log('=== case 1: 余额差优先，且不等异步 ===')
{
  const led = new TurnCreditLedger({ home: path.join(root, 'a'), log: () => {} })
  const r = await led.onTurnEnd({
    turn: 1,
    sessionId: 's1',
    byModel: { 'GLM-5.3': { hit: 0, miss: 7000, out: 3 } },
    balanceStart: 3300.0,
    balanceEnd: 3298.88,
  })
  check('立刻定稿', r !== undefined, true)
  check('credits = 余额差', r && r.credits, 1.12)
  check('source = balance', r && r.source, 'balance')
  check('seq 前进', led.seq, 1)
}

console.log('\n=== case 2: 余额差 > 账单 > pending 的优先级 ===')
{
  const led = new TurnCreditLedger({ home: path.join(root, 'b'), log: () => {} })

  // ① 余额差 + 无账单凭据 → balance
  const r1 = await led.onTurnEnd({
    turn: 1, sessionId: 's1', byModel: { M: { hit: 100, miss: 100, out: 10 } },
    balanceStart: 1000, balanceEnd: 990,
  })
  check('有余额差时用 balance', r1 && r1.source, 'balance')
  check('数值是差值', r1 && r1.credits, 10)

  // ② 无余额差、无凭据 → pending（不是估算！）
  const r2 = await led.onTurnEnd({ turn: 2, sessionId: 's1', byModel: { M: { hit: 5000000, miss: 100000, out: 10000 } } })
  check('无真值时记 pending', r2 && r2.source, 'pending')
  check('credits 是 0（不是估算）', r2 && r2.credits, 0)
  check('有 pending 标记', r2 && r2.pending, true)
  console.log('    （同样 token 旧估算会给 ' + (5000000*3.8725e-5 + 100000*1.6057e-4).toFixed(0) + ' 积分 —— 假数字）')

  // ③ 余额没变（差值 0）→ 不当作有效读数，走 pending
  const r3 = await led.onTurnEnd({
    turn: 3, sessionId: 's1', byModel: { M: { hit: 100, miss: 100, out: 10 } },
    balanceStart: 1000, balanceEnd: 1000,
  })
  check('余额差为 0 时不算有效值', r3 && r3.source, 'pending')
}

console.log('\n=== case 3: 余额反增（充值）时不产生负数 ===')
{
  const led = new TurnCreditLedger({ home: path.join(root, 'c'), log: () => {} })
  const r = await led.onTurnEnd({
    turn: 1, sessionId: 's1', byModel: { M: { hit: 100, miss: 100, out: 10 } },
    balanceStart: 1000, balanceEnd: 2000,
  })
  check('充值场景不记负数', r && r.credits >= 0, true)
  check('退回 pending', r && r.source, 'pending')
}

console.log('\n=== case 4: 空 usage 不记账 ===')
{
  const led = new TurnCreditLedger({ home: path.join(root, 'd'), log: () => {} })
  const r1 = await led.onTurnEnd({ turn: 1, byModel: {} })
  check('空 byModel 返回 undefined', r1, undefined)
  const r2 = await led.onTurnEnd({ turn: 2, byModel: { M: { hit: 0, miss: 0, out: 0 } } })
  check('全零 usage 返回 undefined', r2, undefined)
}

console.log('\n=== case 5: 落盘与重载 ===')
{
  const home = path.join(root, 'e')
  const a = new TurnCreditLedger({ home, log: () => {} })
  await a.onTurnEnd({
    turn: 1, sessionId: 's1', byModel: { M: { hit: 100, miss: 100, out: 10 } },
    balanceStart: 500, balanceEnd: 495.5,
  })
  const b = new TurnCreditLedger({ home, log: () => {} })
  check('重载后 seq 一致', b.seq, a.seq)
  check('重载后记录数一致', b.turns.length, 1)
  check('重载后数值一致', b.turns[0] && b.turns[0].credits, 4.5)
}

console.log('\n=== case 6: 账本上限 ===')
{
  const led = new TurnCreditLedger({ home: path.join(root, 'f'), log: () => {} })
  for (let i = 0; i < 60; i++) {
    await led.onTurnEnd({
      turn: i, sessionId: 's1', byModel: { M: { hit: 10, miss: 10, out: 1 } },
      balanceStart: 1000 - i, balanceEnd: 999 - i,
    })
  }
  check('上限 50 条', led.turns.length, 50)
  check('最新的在最前', led.turns[0] && led.turns[0].turn, 59)
}

console.log('\n=== case 7: todaySummary 按本地日期切分 ===')
{
  const led = new TurnCreditLedger({ home: path.join(root, 'g'), log: () => {} })
  const now = Date.now()
  await led.onTurnEnd({
    turn: 1, sessionId: 's1', byModel: { M: { hit: 10, miss: 10, out: 1 } },
    balanceStart: 100, balanceEnd: 90, endMs: now,
  })
  const s = led.todaySummary(now)
  check('今日累计含本轮', s.credits, 10)
  check('今日轮次数', s.turns, 1)
  // 明天再看应为 0
  const tomorrow = led.todaySummary(now + 24 * 3600 * 1000)
  check('跨日后归零', tomorrow.credits, 0)
}

console.log('\n=== case 8: 估算函数仍存在但不再被账本使用 ===')
{
  const src = fs.readFileSync(path.join('lib', 'turn-credits.mjs'), 'utf8')
  check('账本不调用 creditsForTurn 填数', src.includes('credits = creditsForTurn('), false)
  check('保留了 pending 路径', src.includes("source = 'pending'"), true)
  check('保留了补账方法', src.includes('async reconcilePending('), true)
}

fs.rmSync(root, { recursive: true, force: true })
console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
