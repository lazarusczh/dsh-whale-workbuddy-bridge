// 验证：从**原版** whale-widget 打补丁后，所有占位符功能都能产出。
//
// 为什么这个测试重要：whale-widget 是 npm/GitHub 装的，重装会覆盖补丁。
// 桥接插件会自动重打，但必须保证「从零打」也能得到完整功能 —— 否则
// 用户重装一次就悄悄少一个占位符。
//
// 策略：用最小原版替身（只含锚点结构），不依赖从已安装文件反向还原 ——
// 那套做法每加一个补丁就要同步维护一条还原正则，极易失效（踩过两次）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { applyTurnCreditsPatch, patchState } from './lib/patch-whale.mjs'

let pass = 0, fail = 0
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
}

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
const clientOriginal = `var state = {
  balance: null,
  todayUsage: null,
  todayUsageCurrency: 'CNY',
  usageLabel: '本地估算',
}
function usageFillText(txt, below, amount, cost, session) {
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
  if (m.type === 'balance') {
    map['balance_ds'] = 'x'
  } else if (m.type === 'today') {
    map['expense_ds'] = 'x'
  } else {
    map['status'] = 'x'
  }
  return map
}
function bubbleTplHelpItems(m) {
  if (m.type === 'recharge') add('recharge_ds', 'x')
  else if (m.type === 'today') add('expense_ds', '今日已用金额')
  return arr
}
function pollCost() {
  fetch(LAST_TURN_URL, { cache: 'no-store' })
    .then(function (r) { return r.json() })
    .then(function (d) {
        if (!d || !d.ok || typeof d.seq !== 'number') return
        var cr = (typeof d.credits === 'number') ? d.credits : undefined
        if (d.seq > lastCostSeq) {
          lastCostSeq = d.seq
        }
    })
}
`

const tmp = path.join(os.tmpdir(), 'allph-' + Date.now())
fs.mkdirSync(path.join(tmp, 'lib'), { recursive: true })
fs.mkdirSync(path.join(tmp, 'assets'), { recursive: true })
fs.writeFileSync(path.join(tmp, 'lib', 'index.js'), hostOriginal, 'utf8')
fs.writeFileSync(path.join(tmp, 'assets', 'whale-widget.js'), clientOriginal, 'utf8')

console.log('=== 原版状态 ===')
const st0 = patchState(tmp)
check('报未打补丁', st0.host === false && st0.client === false, JSON.stringify(st0))

console.log('\n=== 打补丁 ===')
const r = applyTurnCreditsPatch({ pkg: tmp, log: () => {} })
check('apply 成功', r.ok === true, r.error || '')
check('有改动', r.changed === true)

const h = fs.readFileSync(path.join(tmp, 'lib', 'index.js'), 'utf8')
const c = fs.readFileSync(path.join(tmp, 'assets', 'whale-widget.js'), 'utf8')

console.log('\n=== 宿主侧产物 ===')
check('费率常量', h.includes('const CREDIT_MISS_RATE'))
check('creditsOfAgg', h.includes('function creditsOfAgg'))
check('准入条件已修', h.includes('agg.cost > 0 || credits > 0'))
check('byModelUsage 聚合', h.includes('agg.byModelUsage[model] = u'))
check('payload 带 credits', h.includes('credits: lastTurn.credits'))

console.log('\n=== 前端侧三个占位符 ===')
check('{credits} 替换', c.includes('.replace(/\\{credits\\}/g'))
check('{expense_src} 映射', c.includes("map['expense_src']"))
check('{credits_today} 映射', c.includes("map['credits_today']"))
check('apiModelTodaySourceText', c.includes('function apiModelTodaySourceText'))
check('state.creditToday 初始化', /creditToday: null,/.test(c))
check('state.creditToday 赋值', c.includes('state.creditToday = d.today.credits'))
check('面板帮助 expense_src', c.includes("add('expense_src'"))
check('面板帮助 credits_today', c.includes("add('credits_today'"))

console.log('\n=== Cr. 单位别名 ===')
check('CURRENCY_LABELS 定义', c.includes("CURRENCY_LABELS = { CREDITS: 'Cr.' }"))
check('apiFmtMoney 用别名', c.includes('apiCurrencyLabel(c)'))
check('全局 fmt 用别名', c.includes('apiCurrencyLabel(currency)'))

console.log('\n=== 产物语法合法 ===')
const { execFileSync } = await import('node:child_process')
let ok = true
try {
  execFileSync(process.execPath, ['--check', path.join(tmp, 'lib', 'index.js')], { stdio: 'pipe' })
  execFileSync(process.execPath, ['--check', path.join(tmp, 'assets', 'whale-widget.js')], { stdio: 'pipe' })
} catch (e) {
  ok = false
  console.log('     ' + String(e.message).slice(0, 300))
}
check('parses', ok)

console.log('\n=== 幂等 ===')
const r2 = applyTurnCreditsPatch({ pkg: tmp, log: () => {} })
check('二次 apply 无操作', r2.changed === false)

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
