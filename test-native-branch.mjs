// 验证 whale-widget 新增的 workbuddy 原生取数分支算出的值是否与
// connect-workbuddy / WorkBuddy 本体一致。
//
// 直接从已安装的 whale-widget 里抽出 fetchWorkBuddyCreditsBalance 的实现来跑，
// 不重写算法 —— 测的是产品代码本身。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const HOST = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'lib', 'index.js')
const src = readFileSync(HOST, 'utf8')

// 抽出函数体
const fnSrc = /    async function fetchWorkBuddyCreditsBalance\(model, tpl, b\) \{[\s\S]*?\n    \}/.exec(src)
if (!fnSrc) {
  console.log('✗ 没找到 fetchWorkBuddyCreditsBalance —— 补丁没打上')
  process.exit(1)
}
console.log('✓ 找到 fetchWorkBuddyCreditsBalance（' + fnSrc[0].length + ' 字节）')

// 依赖注入：apiFetchJson / keyForDestination
const vaultDir = path.join(DSH_HOME, 'workbuddy-vault', 'cn')
const fs = await import('node:fs')
const files = fs.readdirSync(vaultDir).filter((f) => f.endsWith('.json'))
const doc = JSON.parse(fs.readFileSync(path.join(vaultDir, files[0]), 'utf8'))
const token = doc.auth.accessToken

async function apiFetchJson(url, auth, key, opts) {
  const headers = { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }
  const res = await fetch(url, {
    method: (opts && opts.method) || 'GET',
    headers,
    body: opts && opts.body,
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return await res.json()
}
async function keyForDestination() {
  return { key: token }
}

const fetchWorkBuddyCreditsBalance = new Function(
  'apiFetchJson', 'keyForDestination',
  fnSrc[0] + '; return fetchWorkBuddyCreditsBalance'
)(apiFetchJson, keyForDestination)

const model = {
  provider: 'workbuddy',
  baseUrl: '',
  currency: 'CREDITS',
  params: null,
}
const tpl = { currency: 'CREDITS' }
const b = {
  url: 'https://www.codebuddy.cn/v2/billing/meter/get-user-resource',
  auth: 'Authorization:Bearer {key}',
  method: 'POST',
  body: '{"PageNumber":1,"PageSize":100,"ProductCode":"p_tcaca","Status":[0,3]}',
}

const r = await fetchWorkBuddyCreditsBalance(model, tpl, b)
console.log('\n=== 原生分支结果 ===')
console.log(JSON.stringify(r, null, 2))

// 不用写死的绝对值（余额每天在变），改用**结构性判据**：
//   ① 取数成功、remaining 是正数
//   ② remaining 与 total（=TotalDosage 口径）不同，且**更小**
//      —— 这正是修复的核心：月度包的 CapacityRemain 是额度总量，不该当剩余加
//   ③ used = total - remaining，且为正
console.log('\n=== 判据（结构性，不依赖当天余额）===')
if (!r.ok) {
  console.log('✗ 取数失败:', r.error || r.code)
  process.exit(1)
}

let pass = 0, fail = 0
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
}

check('remaining 是正数', r.remaining > 0, r.remaining)
check('total 是正数', r.total > 0, r.total)
check('remaining 与 total 不同（说明没走 TotalDosage 口径）', r.remaining !== r.total, r.remaining + ' vs ' + r.total)
check('remaining 小于 total（月度包已用部分被扣掉了）', r.remaining < r.total, r.remaining + ' < ' + r.total)
check('used = total - remaining', Math.abs(r.used - (r.total - r.remaining)) < 0.02, r.used)
check('used 为正', r.used > 0, r.used)

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
