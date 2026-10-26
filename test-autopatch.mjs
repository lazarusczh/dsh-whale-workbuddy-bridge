// 验证桥接插件启动时会**自动**给 whale-widget 打补丁（不需要手工跑脚本）。
//
// 策略说明：不用"从已安装文件反向还原出原版"那套脆弱做法 ——
// 每加一个补丁就要在测试里同步维护还原正则，且开发期手工改的代码没有标记块，
// 正则猜不准（踩过两次）。这里改用**最小原版替身**：只包含补丁锚点附近的结构，
// 足以验证「插件启动 → 检测到未打 → 自动打上 → 产物合法」这条链路。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from './lib/index.js'
import { patchState } from './lib/patch-whale.mjs'

let pass = 0, fail = 0
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
}

const realHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

// ── 沙盒 home：复制 vault（让取数能成功）+ 放一份最小原版 whale-widget ──────
const home = path.join(os.tmpdir(), 'autopatch-' + Date.now())
fs.mkdirSync(path.join(home, 'workbuddy-vault', 'cn'), { recursive: true })
const realVault = path.join(realHome, 'workbuddy-vault', 'cn')
for (const f of fs.readdirSync(realVault)) {
  if (f.endsWith('.json')) fs.copyFileSync(path.join(realVault, f), path.join(home, 'workbuddy-vault', 'cn', f))
}

const sandboxPkg = path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget')
fs.mkdirSync(path.join(sandboxPkg, 'lib'), { recursive: true })
fs.mkdirSync(path.join(sandboxPkg, 'assets'), { recursive: true })

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
fs.writeFileSync(path.join(sandboxPkg, 'lib', 'index.js'), hostOriginal, 'utf8')
fs.writeFileSync(path.join(sandboxPkg, 'assets', 'whale-widget.js'), clientOriginal, 'utf8')

console.log('=== 沙盒起始状态：未打补丁 ===')
const stBefore = patchState(sandboxPkg)
check('未打补丁', stBefore.host === false && stBefore.client === false, JSON.stringify(stBefore))

// ── 启动插件（不手工跑任何补丁脚本）─────────────────────────────────────
const routes = []
const makeCtx = () => ({
  effect: (fn) => { fn() },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
})
const root = {
  effect: (fn) => { fn() },
  get: (n) => (n === 'credentials' ? { set: async () => {} } : undefined),
  inject: (d, cb) => cb(makeCtx()),
  on: () => () => {},
}

apply(root, { dshHome: home, intervalMs: 60_000, region: 'cn' })
// 等第一轮 tick（含取数）
await new Promise((r) => setTimeout(r, 8000))

console.log('\n=== 插件启动后：应已自动打上补丁 ===')
const stAfter = patchState(sandboxPkg)
check('宿主自动打上', stAfter.host === true, String(stAfter.host))
check('前端自动打上', stAfter.client === true, String(stAfter.client))

console.log('\n=== 产物语法合法 ===')
const { execFileSync } = await import('node:child_process')
let syntaxOk = true
try {
  execFileSync(process.execPath, ['--check', path.join(sandboxPkg, 'lib', 'index.js')], { stdio: 'pipe' })
  execFileSync(process.execPath, ['--check', path.join(sandboxPkg, 'assets', 'whale-widget.js')], { stdio: 'pipe' })
} catch (e) {
  syntaxOk = false
  console.log('     ' + String(e.message).slice(0, 200))
}
check('产物可解析', syntaxOk)

console.log('\n=== 插件主功能不受影响 ===')
check('注册表已写', fs.existsSync(path.join(home, '.dshw-api.json')))
check('积分快照已写', fs.existsSync(path.join(home, '.workbuddy-credits.json')))
check('路由已注册', routes.some((r) => r.path.endsWith('last-turn.json')), routes.map((r) => r.path).join(', '))

console.log('\n=== 二次启动：应无改动（幂等）===')
{
  const before = fs.readFileSync(path.join(sandboxPkg, 'lib', 'index.js'), 'utf8')
  const beforeC = fs.readFileSync(path.join(sandboxPkg, 'assets', 'whale-widget.js'), 'utf8')
  const root2 = {
    effect: (fn) => { fn() },
    get: (n) => (n === 'credentials' ? { set: async () => {} } : undefined),
    inject: (d, cb) => cb(makeCtx()),
    on: () => () => {},
  }
  apply(root2, { dshHome: home, intervalMs: 60_000, region: 'cn' })
  await new Promise((r) => setTimeout(r, 3000))
  check('宿主文件未变', before === fs.readFileSync(path.join(sandboxPkg, 'lib', 'index.js'), 'utf8'))
  check('前端文件未变', beforeC === fs.readFileSync(path.join(sandboxPkg, 'assets', 'whale-widget.js'), 'utf8'))
}

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
fs.rmSync(home, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
