// 端到端验证：模拟 whale-widget 的 apiModelsPayload 对 WorkBuddy 条目的处理，
// 确认 {balance} 能取到数字而不是「—」。
//
// 复刻的关键判定（lib/index.js apiModelsPayload）：
//   const tplM = apiTemplateOf(m.provider) || {}
//   const balDesc = Object.assign({}, tplM.balance || {}, m.balance || {})
//   const hasBalanceApi = !!String(balDesc.url || '').trim()
//   const hasKey = !!(await ctx.credentials.resolve(m.keyRef || '')).value
//   entry.balanceMode = hasBalanceApi ? 'api' : 'events'
//   if (hasBalanceApi && hasKey) { ... entry.balance = r.remaining ... }
//
// 以及前端 apiModelBalanceText：balance 为 null/undefined ⇒ 返回 '—'
import fs from 'node:fs'
import path from 'node:path'

let pass = 0, fail = 0
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
}

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE, '.dsh')
const HOST = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'lib', 'index.js')

console.log('=== 1. 注册表条目 ===')
const reg = JSON.parse(fs.readFileSync(path.join(DSH_HOME, '.dshw-api.json'), 'utf8'))
const m = reg.models[0]
check('provider', m.provider === 'workbuddy', m.provider)
check('keyRef 非空', !!m.keyRef, m.keyRef)
check('keyRef 指向真实凭据', m.keyRef === 'WORKBUDDY_ACCESS_TOKEN', m.keyRef)

console.log('\n=== 2. 凭据里确实有这个 key ===')
const credText = fs.readFileSync(path.join(DSH_HOME, '.credentials.yaml'), 'utf8')
check('WORKBUDDY_ACCESS_TOKEN 存在', credText.includes('WORKBUDDY_ACCESS_TOKEN'))

console.log('\n=== 3. whale-widget 模板存在 ===')
const hostSrc = fs.readFileSync(HOST, 'utf8')
check('workbuddy 模板', hostSrc.includes('workbuddy: {'))
check('kind: workbuddy', hostSrc.includes("kind: 'workbuddy'"))
check('原生取数函数', hostSrc.includes('function fetchWorkBuddyCreditsBalance'))

console.log('\n=== 4. hasBalanceApi 判定 ===')
// 模板的 balance（从源码里提取 url 字段即可，确认非空）
const tplHasUrl = /workbuddy: \{[\s\S]*?balance: \{[\s\S]*?url: '([^']+)'/.exec(hostSrc)
check('模板 balance.url 非空', !!(tplHasUrl && tplHasUrl[1]), tplHasUrl ? tplHasUrl[1] : '未找到')

console.log('\n=== 5. 前端 apiModelBalanceText 行为 ===')
const CLIENT = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'assets', 'whale-widget.js')
const clientSrc = fs.readFileSync(CLIENT, 'utf8')
const fnSrc = /function apiModelBalanceText\(modelId\) \{[\s\S]*?\n\}/.exec(clientSrc)
check('找到 apiModelBalanceText', !!fnSrc)
if (fnSrc) {
  // 用假的 apiModelBalanceInfo 跑它，验证 balance 有值时返回数字
  const fakeInfo = { name: 'WorkBuddy 积分', balance: 2763.48, today: 364, currency: 'CREDITS', todayCurrency: 'CREDITS', mode: 'api' }
  const apiModelBalanceInfo = () => fakeInfo
  // 用**真实的** apiFmtMoney（从同一文件抽出），这样币种标签也会走真实逻辑
  const moneySrc = /var CURRENCY_LABELS = \{[^}]*\}\nfunction apiCurrencyLabel\(cur\) \{[\s\S]*?\n\}\nfunction apiFmtMoney\(v, cur\) \{[\s\S]*?\n\}/.exec(clientSrc)
  let apiFmtMoney
  if (moneySrc) {
    apiFmtMoney = new Function(moneySrc[0] + '; return apiFmtMoney')()
  } else {
    // 回退：说明补丁没打全，用简版并标记
    apiFmtMoney = (v, c) => {
      const n = Number(v)
      if (!isFinite(n)) return '--'
      if (c === 'USD') return '$ ' + n.toFixed(2)
      if (c === 'CNY') return '¥ ' + n.toFixed(2)
      return n.toFixed(2) + (c ? ' ' + c : '')
    }
  }
  check('用的是真实 apiFmtMoney', !!moneySrc, moneySrc ? 'yes' : 'fallback')
  const fn = new Function('apiModelBalanceInfo', 'apiFmtMoney', fnSrc[0] + '; return apiModelBalanceText')(apiModelBalanceInfo, apiFmtMoney)
  const out = fn('x')
  check('有值时返回数字', out !== '—' && out !== '--', out)
  check('单位显示为 Cr.', out.includes('Cr.'), out)

  // balance 为 null 时应返回 '—'
  const fnNull = new Function('apiModelBalanceInfo', 'apiFmtMoney', fnSrc[0] + '; return apiModelBalanceText')(
    () => ({ ...fakeInfo, balance: null }), apiFmtMoney)
  check('null 时返回横线（用户看到的现象）', fnNull('x') === '—', fnNull('x'))
}

console.log('\n=== 6. 实际能取到值吗 ===')
const { fetchWorkBuddyCredits } = await import('./lib/index.js')
const r = await fetchWorkBuddyCredits()
check('取数成功', r.ok === true, r.error || '')
if (r.ok) {
  check('remaining 是数字', typeof r.remaining === 'number' && isFinite(r.remaining), r.remaining)
  check('落在合理区间', r.remaining > 2000 && r.remaining < 3500, r.remaining)
}

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
