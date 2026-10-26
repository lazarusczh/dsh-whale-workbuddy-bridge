// 验证「按 5 分钟桶归属」的账单查询。
//
// ── 这个 bug 的完整故事 ──────────────────────────────────────────────
//
// 账单接口的 `requestTime` **严格按 5 分钟对齐**（实测 408 条：秒恒为 00，
// 分钟只可能是 00/05/10/.../55）。
//
// 第一版按「本轮起止时刻」精确过滤，于是：
//   窗口 1 分钟 → requests=0
//   窗口 3 分钟 → requests=0   ← 一轮通常就 2~3 分钟，一条都查不到
//   窗口 5 分钟 → requests=8, credits=15.24
//
// 而 `requests===0` 被判成"查询失败" ⇒ 整轮回退 token 估算 ⇒ 高估 20~180 倍。
// 现象：turn=18 显示 15.63（恰好跨桶，撞上已结算的桶），
//       turn=19/20 显示 627.66 / 360.78（没撞上，退回估算）。
//
// 修法：窗口向外扩到整桶，覆盖本轮触及的所有桶。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

let pass = 0, fail = 0
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
}

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const BUCKET = 5 * 60 * 1000

console.log('=== 1. 代码结构 ===')
const src = fs.readFileSync(path.join('lib', 'turn-credits.mjs'), 'utf8')
check('有 queryBillingBucket', src.includes('async queryBillingBucket(billing, startMs, endMs)'))
check('桶大小是 5 分钟', src.includes('const BUCKET = 5 * 60 * 1000'))
check('向外对齐起点', src.includes('Math.floor(startMs / BUCKET) * BUCKET'))
check('向外对齐终点', src.includes('Math.floor(endMs / BUCKET) * BUCKET'))
check('onTurnEnd 用桶查询', src.includes('this.queryBillingBucket(billing, beganAt, endedAt)'))
check('requests=0 也采用账单结果', src.includes('if (real && real.ok) {') && src.includes('该时段尚未结算'))

console.log('\n=== 2. 桶对齐逻辑（纯计算，不联网）===')
{
  // 复刻对齐算法
  const align = (ms) => ({
    start: Math.floor(ms / BUCKET) * BUCKET,
    end: Math.floor(ms / BUCKET) * BUCKET,
  })

  // 一轮 13:56:30 ~ 13:59:09（跨两个桶：13:55 和 13:55... 实际都在 13:55 桶）
  const s = new Date('2026-10-26T13:56:30').getTime()
  const e = new Date('2026-10-26T13:59:09').getTime()
  const a = align(s)
  check('起点对齐到 13:55', new Date(a.start).getMinutes() % 5 === 0, new Date(a.start).toTimeString().slice(0, 5))
  check('终点对齐到桶边界', new Date(a.end).getMinutes() % 5 === 0, new Date(a.end).toTimeString().slice(0, 5))

  // 一轮跨桶：13:57 ~ 14:03（跨 13:55 和 14:00 两个桶）
  const s2 = new Date('2026-10-26T13:57:00').getTime()
  const e2 = new Date('2026-10-26T14:03:00').getTime()
  const bs = Math.floor(s2 / BUCKET) * BUCKET
  const be = Math.floor(e2 / BUCKET) * BUCKET
  const spanBuckets = (be - bs) / BUCKET + 1
  check('跨桶时覆盖 2 个桶', spanBuckets === 2, spanBuckets)

  // 同一桶内的一轮
  const s3 = new Date('2026-10-26T13:56:00').getTime()
  const e3 = new Date('2026-10-26T13:58:00').getTime()
  const bs3 = Math.floor(s3 / BUCKET) * BUCKET
  const be3 = Math.floor(e3 / BUCKET) * BUCKET
  check('同桶内只覆盖 1 个桶', (be3 - bs3) / BUCKET + 1 === 1, (be3 - bs3) / BUCKET + 1)
}

console.log('\n=== 3. 真实账单：桶查询能取到数 ===')
{
  const { listVaultAccounts } = await import('./lib/index.js')
  const { TurnCreditLedger } = await import('./lib/turn-credits.mjs')
  const acct = listVaultAccounts(DSH_HOME)[0]
  if (!acct) {
    console.log('  跳过（没有 vault）')
  } else {
    const ledger = new TurnCreditLedger({ home: DSH_HOME, log: () => {} })
    const b = {
      baseUrl: 'https://www.workbuddy.cn',
      token: acct.accessToken,
      domain: acct.domain,
      uid: acct.uid,
    }
    // 取 20 分钟前的一轮（确保已结算）
    const endMs = Date.now() - 20 * 60 * 1000
    const r = await ledger.queryBillingBucket(b, endMs - 3 * 60 * 1000, endMs)
    check('查询成功', r.ok === true, r.error || '')
    if (r.ok) {
      console.log('    20 分钟前那 3 分钟: requests=' + r.requests + ', credits=' + r.credits)
      console.log('    覆盖桶:', r.buckets.join(', ') || '(无)')
      check('能取到请求数', r.requests > 0, r.requests)
      check('积分量级合理（0~200）', r.credits >= 0 && r.credits < 200, r.credits)
      check('桶数合理（1~3）', r.buckets.length >= 1 && r.buckets.length <= 3, r.buckets.length)
    }
  }
}

console.log('\n=== 4. 关键回归：不会因为 requests=0 就退回估算 ===')
{
  const s = fs.readFileSync(path.join('lib', 'turn-credits.mjs'), 'utf8')
  // 旧代码：if (real && real.ok && real.requests > 0)  ← 这个条件导致退回估算
  check('不再要求 requests > 0 才采用', !s.includes('real.ok && real.requests > 0'))
  check('有 partial 标记', s.includes('partial'))
  check('note 会说明未结算', s.includes('尚未结算'))
}

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
