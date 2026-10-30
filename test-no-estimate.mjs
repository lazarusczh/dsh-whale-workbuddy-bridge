// 验证：彻底停用 token 估算，改为「余额差 → 账单 → 待结算」三级取值。
//
// ── 这个决定的事实依据（2026-10-30 实测）──────────────────────────
//
// ① 账单结算延迟 **约 20 分钟**：09:24 查询，最新桶只到 09:05。
// ② token 估算**模型不成立**：4 组「账单真值 + 本地 token」配对反解后
//    单因子相关性 hit=-0.19 / miss=-0.41 / out=0.64，credit/miss 比值波动 5 倍。
//    旧费率回代高估 8.2~44.9 倍 —— 气泡上的"数百"就是这么来的。
// ③ 但账单**数值本身是准的**：credit/req = 0.36~1.26（中位约 0.5），
//    与真实单请求积分（P25 0.42 / 中位 0.61 / P75 0.87）吻合。
//
// 结论：能拿真值就用真值；拿不到就显示"结算中"，绝不填估算。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let pass = 0, fail = 0
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
}

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const HOST = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'lib', 'index.js')
const CLIENT = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'assets', 'whale-widget.js')
const hostSrc = fs.readFileSync(HOST, 'utf8')
const clientSrc = fs.readFileSync(CLIENT, 'utf8')
const ledgerSrc = fs.readFileSync(path.join('lib', 'turn-credits.mjs'), 'utf8')

console.log('=== 1. 账本：三级取值 ===')
check('有余额差路径', ledgerSrc.includes("source = 'balance'"))
check('有账单路径', ledgerSrc.includes("source = 'billing'"))
check('有 pending 路径', ledgerSrc.includes("source = 'pending'"))
check('不再调用 creditsForTurn 填数', !ledgerSrc.includes('credits = creditsForTurn('))
check('有补账方法', ledgerSrc.includes('async reconcilePending('))

console.log('\n=== 2. 宿主：不再用估算 ===')
check('usedEstimate 恒为 false', hostSrc.includes('const usedEstimate = false'))
check('接受 balance 来源', hostSrc.includes("latest.source !== 'billing' && latest.source !== 'balance'"))
check('有 pending 标记', hostSrc.includes('creditsPending'))
check('有 isWorkbuddySession', hostSrc.includes('function isWorkbuddySession('))

console.log('\n=== 3. 前端：显示"结算中" ===')
check('state.creditPending 已初始化', clientSrc.includes('creditPending: false,'))
check('轮询读取 pending', clientSrc.includes('state.creditPending = true'))
check('渲染"结算中"', clientSrc.includes("crText = '结算中'"))

console.log('\n=== 4. 行为验证：余额差优先 ===')
{
  const { TurnCreditLedger } = await import('./lib/turn-credits.mjs')
  const tmp = path.join(os.tmpdir(), 'no-est-' + Date.now())
  const led = new TurnCreditLedger({ home: tmp, log: () => {} })

  // 余额差可用 → 用它，不查账单
  const r1 = await led.onTurnEnd({
    turn: 1,
    sessionId: 's1',
    byModel: { 'GLM-5.3': { hit: 5000000, miss: 100000, out: 10000 } },
    balanceStart: 3300.5,
    balanceEnd: 3282.0,
  })
  check('用余额差', r1 && r1.source === 'balance', r1 && r1.source)
  check('数值 = 余额差', r1 && Math.abs(r1.credits - 18.5) < 0.01, r1 && r1.credits)
  check('没有被估算污染', r1 && r1.credits < 100, r1 && r1.credits)

  // 无余额差、无账单 → pending，不填估算
  const r2 = await led.onTurnEnd({
    turn: 2,
    sessionId: 's1',
    byModel: { 'GLM-5.3': { hit: 5000000, miss: 100000, out: 10000 } },
  })
  check('记 pending', r2 && r2.source === 'pending', r2 && r2.source)
  check('credits 是 0 不是估算', r2 && r2.credits === 0, r2 && r2.credits)
  check('有 pending 标记', r2 && r2.pending === true, r2 && r2.pending)
  console.log('    （同样 token 旧估算会给', (5000000*3.8725e-5 + 100000*1.6057e-4).toFixed(0), '积分 —— 假数字）')

  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n=== 5. 历史证据留档（README 引用）===')
{
  const doc = JSON.parse(fs.readFileSync(path.join(DSH_HOME, '.workbuddy-turn-credits.json'), 'utf8'))
  const bad = doc.turns.filter((t) => t.source === 'tokens')
  console.log('  账本里还有 ' + bad.length + ' 条旧估算记录（高估 8~45 倍），新逻辑不会再产生')
  const withBilling = doc.turns.filter((t) => t.source === 'billing' && t.credits > 0 && t.billing)
  console.log('  有 ' + withBilling.length + ' 条可核对：')
  for (const t of withBilling.slice(0, 4)) {
    const r = t.credits / (t.billing.requests || 1)
    console.log('    turn=' + t.turn + ' credits=' + t.credits + ' req=' + t.billing.requests + ' → credit/req=' + r.toFixed(2))
  }
  check('credit/req 落在真实区间（0.2~2）', withBilling.every((t) => {
    const r = t.credits / (t.billing.requests || 1)
    return r > 0.2 && r < 2
  }), '说明账单窗口归属是对的')
}

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
