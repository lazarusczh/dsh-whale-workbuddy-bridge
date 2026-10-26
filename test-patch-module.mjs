// 验证补丁模块的核心性质。
//
// 策略说明（重要）：**不**从"已打补丁的文件"反向还原出"原版"。
// 那个方向很脆弱 —— 每加一个补丁就要在测试里同步维护一条还原正则，
// 而且开发期手工改的代码没有标记块，正则根本猜不准（踩过两次）。
//
// 改为验证真正要保证的性质：
//   ① 对当前安装状态，patchState 报得准、apply 幂等（不写盘）
//   ② 从一份**构造出来的最小原版**打补丁，能正确产出所有标记与函数
//      （这份原版只含锚点附近的结构，不依赖真实文件反推）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findWhaleWidget, patchState, applyTurnCreditsPatch, patchFingerprint, restoreClientInline } from './lib/patch-whale.mjs'

let pass = 0, fail = 0
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
}

const realPkg = findWhaleWidget()
console.log('=== 1. 找到已安装的 whale-widget ===')
check('found', !!realPkg, realPkg)

console.log('\n=== 2. 当前安装状态报得准 ===')
const st = patchState(realPkg)
check('host patched', st.host === true, String(st.host))
check('client patched', st.client === true, String(st.client))

console.log('\n=== 3. apply 幂等：已打补丁时不写盘 ===')
{
  const before = patchFingerprint(realPkg)
  const hostBefore = fs.readFileSync(path.join(realPkg, 'lib', 'index.js'), 'utf8')
  const clientBefore = fs.readFileSync(path.join(realPkg, 'assets', 'whale-widget.js'), 'utf8')
  const r = applyTurnCreditsPatch({ pkg: realPkg, log: () => {} })
  check('returns ok', r.ok === true)
  check('reports no change', r.changed === false, 'changed=' + r.changed)
  check('host file unchanged', hostBefore === fs.readFileSync(path.join(realPkg, 'lib', 'index.js'), 'utf8'))
  check('client file unchanged', clientBefore === fs.readFileSync(path.join(realPkg, 'assets', 'whale-widget.js'), 'utf8'))
  check('fingerprint stable', patchFingerprint(realPkg) === before)
}

console.log('\n=== 4. 关键函数都已就位 ===')
{
  const host = fs.readFileSync(path.join(realPkg, 'lib', 'index.js'), 'utf8')
  const client = fs.readFileSync(path.join(realPkg, 'assets', 'whale-widget.js'), 'utf8')
  check('宿主：费率常量', host.includes('const CREDIT_MISS_RATE'))
  check('宿主：creditsOfAgg', host.includes('function creditsOfAgg'))
  check('宿主：isCreditModel', host.includes('function isCreditModel'))
  check('宿主：creditMultiplierOf', host.includes('function creditMultiplierOf'))
  check('宿主：creditToday 累计', host.includes('creditTodayAdd'))
  check('宿主：last-turn 带 today', /today: \{ day: creditToday\.day/.test(host))
  check('宿主：无压缩系数', !host.includes('CREDIT_HIT_EFFECTIVE'))
  check('前端：{credits} 替换', client.includes('.replace(/\\{credits\\}/g'))
  check('前端：credits_today 映射', client.includes("map['credits_today']"))
  check('前端：expense_src 映射', client.includes("map['expense_src']"))
  check('前端：Cr. 别名', client.includes("CURRENCY_LABELS = { CREDITS: 'Cr.' }"))
  check('前端：state.creditToday 初始化', /creditToday: null,/.test(client))
}

console.log('\n=== 5. restoreClientInline 能把前端还原干净 ===')
{
  const client = fs.readFileSync(path.join(realPkg, 'assets', 'whale-widget.js'), 'utf8')
  const restored = restoreClientInline(client)
  check('无 creditToday', !restored.includes('creditToday'))
  check('无 credits_today', !restored.includes('credits_today'))
  check('无 expense_src', !restored.includes('expense_src'))
  check('无 CURRENCY_LABELS', !restored.includes('CURRENCY_LABELS'))
  check('无 apiCurrencyLabel', !restored.includes('apiCurrencyLabel'))
  check('apiFmtMoney 回到原样', restored.includes("return n.toFixed(2) + (c ? ' ' + c : '')"))
  check('fmt 回到原样', restored.includes("fixed + ' ' + currency"))
  let parses = false
  const tmpJs = path.join(os.tmpdir(), 'restored-' + Date.now() + '.js')
  fs.writeFileSync(tmpJs, restored, 'utf8')
  try {
    const { execFileSync } = await import('node:child_process')
    execFileSync(process.execPath, ['--check', tmpJs], { stdio: 'pipe' })
    parses = true
  } catch (e) {
    console.log('     ' + String(e.message).slice(0, 200))
  }
  fs.rmSync(tmpJs, { force: true })
  check('还原后仍是合法 JS', parses)
}

console.log('\n=== 6. 从最小原版打补丁：标记与函数都能产出 ===')
{
  const tmp = path.join(os.tmpdir(), 'minimal-whale-' + Date.now())
  fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true })
  fs.mkdirSync(path.join(tmp, 'assets'), { recursive: true })

  const hostOriginal = `import fs from 'node:fs'
const turnAggs = new Map()
let lastTurn = null
let lastTurnSeq = 0
lastTurnSeq = readTurnSeq()
    function handleSessionEvent(sessionId, event) {
      const d = event.data
      const usage = d.usage
      const input = Number(usage.inputTokens) || 0
      const cache = Number(usage.cacheReadTokens) || 0
      const output = Number(usage.outputTokens) || 0
      if (!agg || agg.turn !== turn) {
        agg = { turn, cost: 0, tokens: 0, byModel: {}, byModelTokens: {}, lastTs: Date.now() }
        turnAggs.set(sessionId, agg)
      }
      const model = d.message && d.message.source ? d.message.source.model : ''
      if (model) {
          agg.byModelTokens[model] = (agg.byModelTokens[model] || 0) + toks
      }
    }
    function finalizeTurn(sessionId) {
      const agg = turnAggs.get(sessionId)
      if (agg && agg.cost > 0) {
        lastTurn = { turn: agg.turn, amount: agg.cost, tokens: agg.tokens, ts: agg.lastTs }
      }
    }
    function route(req, res) {
      const payload = lastTurn
          ? { ok: true, seq: lastTurnSeq, turn: lastTurn.turn, amount: lastTurn.amount, tokens: lastTurn.tokens, ts: lastTurn.ts }
          : { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null }
      res.end(JSON.stringify(payload))
    }
`
  const clientOriginal = `function usageFillText(txt, below, amount, cost, session) {
  return String(txt || '')
    .replace(/\\{below\\}/g, below != null ? String(below) : '')
    .replace(/\\{amount\\}/g, amount != null ? String(amount) : '')
    .replace(/\\{cost\\}/g, cost != null ? String(cost) : '')
}
function usageAlertModsResolved(mods, below, amount, cost, session) {
  return mods
}
function bubbleRenderCostMods(amount) {
  bubbleRenderModules(usageAlertModsResolved(usageTurnCostLines(), null, null, usageCostValue(amount)))
}
function showCostBubble(amount) {
  whaleSysPush({ kind: 'cost', amount: amount, frameId: sysFrameIdOf('cost'), rank: 3 })
}
function openCost(item) {
  sceneOpen('cost', function () { bubbleRenderCostMods(item.amount) }, turnCostCloseMs > 0 ? turnCostCloseMs : 0)
}
function apiFmtMoney(v, cur) {
  var n = Number(v)
  if (!isFinite(n)) return '--'
  var c = String(cur || '')
  if (c === 'USD') return '$ ' + n.toFixed(2)
  if (c === 'CNY') return '¥ ' + n.toFixed(2)
  return n.toFixed(2) + (c ? ' ' + c : '')
}
function fmt(balance, currency) {
  var num = Number(balance)
  var fixed = isFinite(num) ? num.toFixed(2) : '--'
  return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency
}
function apiModelTodayText(modelId) { return '--' }
function bubbleContentTokenMap(m) {
  var map = {}
  if (bubbleIsModelMod(m)) {
    map['balance'] = 'x'
    map['today'] = 'x'
    map['expense_ds'] = map['today']
    return map
  }
  return map
}
function bubbleTplHelpItems(m) {
  if (m.type === 'recharge') add('recharge_ds', 'x')
  else if (m.type === 'today') add('expense_ds', '今日已用金额')
  return arr
}
`
  fs.writeFileSync(path.join(tmp, 'lib', 'index.js'), hostOriginal, 'utf8')
  fs.writeFileSync(path.join(tmp, 'assets', 'whale-widget.js'), clientOriginal, 'utf8')

  const stFresh = patchState(tmp)
  check('原版报未打补丁', stFresh.host === false && stFresh.client === false, JSON.stringify(stFresh))

  const r = applyTurnCreditsPatch({ pkg: tmp, log: () => {} })
  check('apply 成功', r.ok === true, r.error || '')
  check('报告有改动', r.changed === true)
  check('需要重启（宿主改了）', r.needsRestart === true)

  const stAfter = patchState(tmp)
  check('打后报已打补丁', stAfter.host === true && stAfter.client === true, JSON.stringify(stAfter))

  const h2 = fs.readFileSync(path.join(tmp, 'lib', 'index.js'), 'utf8')
  const c2 = fs.readFileSync(path.join(tmp, 'assets', 'whale-widget.js'), 'utf8')
  check('宿主有费率', h2.includes('const CREDIT_MISS_RATE'))
  check('宿主准入条件已修', h2.includes('agg.cost > 0 || credits > 0'))
  check('宿主 payload 带 credits', h2.includes('credits: lastTurn.credits'))
  check('前端有 {credits} 替换', c2.includes('.replace(/\\{credits\\}/g'))
  check('前端有 Cr. 别名', c2.includes("CURRENCY_LABELS = { CREDITS: 'Cr.' }"))
  check('前端有 credits_today', c2.includes("map['credits_today']"))

  const { execFileSync } = await import('node:child_process')
  let parses = true
  try {
    execFileSync(process.execPath, ['--check', path.join(tmp, 'lib', 'index.js')], { stdio: 'pipe' })
    execFileSync(process.execPath, ['--check', path.join(tmp, 'assets', 'whale-widget.js')], { stdio: 'pipe' })
  } catch (e) {
    parses = false
    console.log('     ' + String(e.message).slice(0, 300))
  }
  check('产物语法合法', parses)

  const r2 = applyTurnCreditsPatch({ pkg: tmp, log: () => {} })
  check('二次 apply 无操作', r2.changed === false)

  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
