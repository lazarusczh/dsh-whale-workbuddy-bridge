// 端到端验证 {credits_today} 链路：
//   宿主 last-turn.json 返回 today 字段
//   → 前端轮询存入 state.creditToday
//   → bubbleContentTokenMap 映射成 {credits_today}
//
// 用真实代码（从已安装文件抽取），不是复制品。
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
}

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE, '.dsh')
const HOST = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'lib', 'index.js')
const CLIENT = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'assets', 'whale-widget.js')
const hostSrc = fs.readFileSync(HOST, 'utf8')
const clientSrc = fs.readFileSync(CLIENT, 'utf8')

console.log('=== 1. 宿主侧：today 累计机制存在 ===')
check('creditToday 变量', hostSrc.includes('let creditToday = {'))
check('creditDayKey 函数', hostSrc.includes('function creditDayKey('))
check('creditTodayAdd 函数', hostSrc.includes('function creditTodayAdd('))
check('finalizeTurn 里累加', hostSrc.includes('if (credits > 0) creditTodayAdd(credits)'))
check('last-turn 下发 today', /today: \{ day: creditToday\.day/.test(hostSrc))

console.log('\n=== 2. 宿主侧：today 实际逻辑可运行 ===')
// 抽出 creditDayKey / creditTodayAdd 的行为
const dayKeyFn = /function creditDayKey\(ms\) \{[\s\S]*?\n    \}/.exec(hostSrc)
check('能抽出 creditDayKey', !!dayKeyFn)
if (dayKeyFn) {
  const fn = new Function(dayKeyFn[0] + '; return creditDayKey')()
  const d = fn(Date.parse('2026-10-26T23:30:00+08:00'))
  check('本地日期切分（不是 UTC）', d === '2026-10-26', d)
  const d2 = fn(Date.parse('2026-10-26T00:30:00+08:00'))
  check('凌晨仍算当天', d2 === '2026-10-26', d2)
}

console.log('\n=== 3. 前端侧：state 初始化 ===')
check('creditToday 初始为 null', /creditToday: null,/.test(clientSrc))
check('轮询里赋值', clientSrc.includes('state.creditToday = d.today.credits'))

console.log('\n=== 4. 前端侧：占位符映射 ===')
check('map[credits_today]', clientSrc.includes("map['credits_today']"))
check('用 apiFmtMoney 格式化', /map\['credits_today'\][\s\S]{0,80}apiFmtMoney\(state\.creditToday/.test(clientSrc))
check('面板帮助有说明', clientSrc.includes("add('credits_today'"))

console.log('\n=== 5. 模拟渲染：有值时 / 无值时 ===')
const mapSrc = /function bubbleContentTokenMap\(m\) \{[\s\S]*?\n\}/.exec(clientSrc)
check('能抽出 bubbleContentTokenMap', !!mapSrc)
if (mapSrc) {
  const fakeState = { creditToday: 12.34, creditTodayTurns: 3, todayUsage: 100 }
  const fakeModel = { id: 'x', name: 'WorkBuddy 积分', balance: 2700, todayUsage: 100, currency: 'CREDITS', todayCurrency: 'CREDITS', balanceMode: 'api', usageSource: 'balance' }
  const helpers = `
    var state = ${JSON.stringify(fakeState)};
    var CURRENCY_LABELS = { CREDITS: 'Cr.' };
    function apiCurrencyLabel(c) { return CURRENCY_LABELS[String(c||'')] || String(c||'') }
    function apiFmtMoney(v, cur) {
      var n = Number(v); if (!isFinite(n)) return '--';
      var c = String(cur || '');
      if (c === 'USD') return '$ ' + n.toFixed(2);
      if (c === 'CNY') return '¥ ' + n.toFixed(2);
      return n.toFixed(2) + (c ? ' ' + apiCurrencyLabel(c) : '')
    }
    function bubbleIsModelMod(m) { return !!(m && m.modelId && m.modelId !== 'deepseek') }
    function apiModelBalanceText() { return '2700.00 Cr.' }
    function apiModelTodayText() { return '100.00 Cr.' }
    function apiModelTodaySourceText() { return '余额差记账' }
    function apiQuotaPctText() { return '--' }
    function apiQuotaUsedText() { return '--' }
    function apiQuotaLeftText() { return '--' }
    function apiQuotaTotalText() { return '--' }
    function apiQuotaResetText() { return '--' }
    function bubblePlanWinOf() { return null }
    function apiPlanUsedText() { return '--' }
    function apiPlanLeftText() { return '--' }
    function apiPlanResetText() { return '--' }
  `
  const fn = new Function(helpers + mapSrc[0] + '; return bubbleContentTokenMap')()
  const map = fn({ type: 'today', modelId: 'm1' })
  check('有值时返回数字', map.credits_today !== '--', map.credits_today)
  check('格式为 Cr.', String(map.credits_today).includes('Cr.'), map.credits_today)
  check('12.34 正确渲染', map.credits_today === '12.34 Cr.', map.credits_today)

  // 无值时
  const fn2 = new Function(helpers.replace('"creditToday":12.34', '"creditToday":null') + mapSrc[0] + '; return bubbleContentTokenMap')()
  const map2 = fn2({ type: 'today', modelId: 'm1' })
  check('无值显示 --', map2.credits_today === '--', map2.credits_today)
}

console.log('\n=== 5b. **未绑定模型**的模块也要能替换（真实踩过的坑）===')
//
// 现象：气泡上直接显示 `{credits_today}` 这几个字。
// 原因：credits_today 原先只加在「绑定了模型」的分支里，
// 未绑定模型走全局分支 ⇒ map 里没这个 key ⇒ 替换循环跳过它。
{
  const mapSrc = /function bubbleContentTokenMap\(m\) \{[\s\S]*?\n\}/.exec(clientSrc)
  const helpers = `
    var state = { creditToday: 7.89, creditTodayTurns: 2, todayUsage: 100 };
    var CURRENCY_LABELS = { CREDITS: 'Cr.' };
    function apiCurrencyLabel(c) { return CURRENCY_LABELS[String(c||'')] || String(c||'') }
    function apiFmtMoney(v, cur) {
      var n = Number(v); if (!isFinite(n)) return '--';
      var c = String(cur || '');
      if (c === 'USD') return '$ ' + n.toFixed(2);
      if (c === 'CNY') return '¥ ' + n.toFixed(2);
      return n.toFixed(2) + (c ? ' ' + apiCurrencyLabel(c) : '')
    }
    function bubbleIsModelMod(m) { return !!(m && m.modelId && m.modelId !== 'deepseek') }
    function apiModelBalanceText() { return '--' }
    function apiModelTodayText() { return '--' }
    function apiModelTodaySourceText() { return '' }
    function apiQuotaPctText() { return '--' }
    function apiQuotaUsedText() { return '--' }
    function apiQuotaLeftText() { return '--' }
    function apiQuotaTotalText() { return '--' }
    function apiQuotaResetText() { return '--' }
    function bubblePlanWinOf() { return null }
    function apiPlanUsedText() { return '--' }
    function apiPlanLeftText() { return '--' }
    function apiPlanResetText() { return '--' }
    function bubbleAmountText() { return '--' }
    function bubbleBonusText() { return '--' }
    function bubbleRechargeText() { return '--' }
    function bubbleSessionText() { return '--' }
    function bubbleCountdownText() { return '--' }
    function bubblePeakText() { return '--' }
    function bubbleIsPeakCount() { return false }
    function fmt() { return '--' }
  `
  const fn = new Function(helpers + mapSrc[0] + '; return bubbleContentTokenMap')()
  // 没有 modelId 的模块 = 未绑定模型
  const map = fn({ type: 'balance' })
  check('未绑定模型时 map 里有 credits_today', map.credits_today !== undefined, JSON.stringify(map.credits_today))
  check('值正确', map.credits_today === '7.89 Cr.', map.credits_today)
  check('未绑定模型时也有 expense_src', map.expense_src !== undefined, JSON.stringify(map.expense_src))

  // 再验证一次「绑定模型」的情况没被全局补丁覆盖
  const mapBound = fn({ type: 'today', modelId: 'm1' })
  check('绑定模型时仍是正确值', mapBound.credits_today === '7.89 Cr.', mapBound.credits_today)
}

console.log('\n=== 6. 压缩系数已撤销 ===')
check('宿主无 CREDIT_HIT_EFFECTIVE', !hostSrc.includes('CREDIT_HIT_EFFECTIVE'))
check('前端无 0.236', !clientSrc.includes('0.236'))
const ratesSrc = fs.readFileSync(path.join('lib', 'credit-rates.mjs'), 'utf8')
check('credit-rates 无 HIT_EFFECTIVE_FACTOR', !ratesSrc.includes('HIT_EFFECTIVE_FACTOR'))

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
