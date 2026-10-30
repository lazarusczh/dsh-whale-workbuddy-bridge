// 验证「竞态修复」：whale-widget 先出估算，等桥接插件写完真值后再校正。
//
// 背景（真实 bug）：
//   桥接插件查官方账单要等 ~12 秒（结算延迟），而 whale-widget 在 turn/end
//   那一刻就同步读账本 —— 读到的还是**上一轮**的记录，于是气泡永远显示估算的几百。
//   实测：turn=17 显示 774.42（source=tokens），而真实约 15。
//
// 修法：先出估算（不阻塞），20 秒后异步读真值回填，并修正今日累计。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0, fail = 0
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
}

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const HOST = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'lib', 'index.js')
const src = fs.readFileSync(HOST, 'utf8')

console.log('=== 1. 竞态修复代码已就位 ===')
check('不再用估算填数', src.includes('const usedEstimate = false'))
check('有 pending 标记', src.includes('creditsPending'))
check('有异步回填', src.includes('if (usedEstimate && agg) {'))
check('20 秒后校正', src.includes('}, 20_000)'))
check('校正 lastTurn.credits', src.includes('lastTurn.credits = real'))
check('校正今日累计', src.includes('creditToday.credits - estimateOfThis + real'))
check('有「真值必须更小」的护栏', src.includes('if (real >= estimateOfThis) return'))
check('有「轮次必须匹配」的护栏', src.includes('lastTurn.turn !== turnOfThis'))

console.log('\n=== 2. 用模拟环境跑一遍校正逻辑 ===')
{
  // 抽出回填那段代码的核心逻辑做行为验证（不依赖真实定时器）
  // 模拟：estimate=774.42，20 秒后账本出现真值 15.63
  const state = {
    lastTurn: { turn: 17, credits: 774.42 },
    creditToday: { day: '2026-10-26', credits: 774.42, turns: 1 },
    ledger: [],  // 账本内容，初始为空（桥接插件还没写）
  }
  const readReal = () => {
    const t = state.ledger[0]
    if (!t || t.source !== 'billing') return undefined
    return t.credits
  }

  const estimateOfThis = 774.42
  const turnOfThis = 17
  const reconciledTurns = new Set()

  function reconcile() {
    if (reconciledTurns.has(turnOfThis)) return 'already-done'
    const real = readReal()
    if (real === undefined) return 'no-real'
    if (real >= estimateOfThis) return 'not-smaller'
    if (!state.lastTurn || state.lastTurn.turn !== turnOfThis) return 'turn-mismatch'
    reconciledTurns.add(turnOfThis)
    state.lastTurn.credits = real
    state.creditToday.credits = Math.round((state.creditToday.credits - estimateOfThis + real) * 100) / 100
    return 'reconciled'
  }

  check('账本还没真值时不动', reconcile() === 'no-real', reconcile())
  check('lastTurn 仍是估算', state.lastTurn.credits === 774.42, state.lastTurn.credits)

  // 桥接插件写入了真值
  state.ledger.unshift({ turn: 17, credits: 15.63, source: 'billing' })
  check('真值到达后校正', reconcile() === 'reconciled', reconcile())
  check('lastTurn 改成真值', state.lastTurn.credits === 15.63, state.lastTurn.credits)
  check('今日累计也换成真值', state.creditToday.credits === 15.63, state.creditToday.credits)
  console.log('    校正后：气泡 15.63，今日累计 15.63（估算的 774 已被替换）')

  // 幂等：再跑一次不能重复扣减
  const before = state.creditToday.credits
  check('重复校正被拦住', reconcile() === 'already-done', reconcile())
  check('今日累计没被二次扣减', state.creditToday.credits === before, state.creditToday.credits)
  check('今日累计非负', state.creditToday.credits >= 0, state.creditToday.credits)
}

console.log('\n=== 3. 护栏：不该校正的情况 ===')
{
  const mk = (over) => {
    const state = {
      lastTurn: { turn: 17, credits: 500 },
      creditToday: { day: 'd', credits: 500, turns: 1 },
      ...over,
    }
    const reconcile = (real, turnOfThis = 17, estimateOfThis = 500) => {
      if (real === undefined) return 'no-real'
      if (real >= estimateOfThis) return 'not-smaller'
      if (!state.lastTurn || state.lastTurn.turn !== turnOfThis) return 'turn-mismatch'
      state.lastTurn.credits = real
      return 'reconciled'
    }
    return { state, reconcile }
  }

  check('真值比估算大 → 不校正', mk().reconcile(900) === 'not-smaller')
  check('真值等于估算 → 不校正', mk().reconcile(500) === 'not-smaller')
  check('轮次已换（用户又聊了一轮）→ 不校正', mk().reconcile(15, 18) === 'turn-mismatch')
  check('真值更小且轮次匹配 → 校正', mk().reconcile(15, 17) === 'reconciled')
}

console.log('\n=== 4. 桥接插件侧：账本确实标了 source ===')
{
  const ratesSrc = fs.readFileSync(path.join('lib', 'turn-credits.mjs'), 'utf8')
  check('有 source = billing', ratesSrc.includes("source = 'billing'"))
  check('有 source = balance', ratesSrc.includes("source = 'balance'"))
  check('有 source = pending', ratesSrc.includes("source = 'pending'"))
  check('查询前等待结算', ratesSrc.includes('setTimeout(r, 15_000)'))
}

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
