// 验证：账本用「真实账单」定稿一轮积分，是否得到正确量级。
import fs from 'node:fs'
import path from 'node:path'
import { TurnCreditLedger } from './lib/turn-credits.mjs'
import { listVaultAccounts } from './lib/index.js'

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE, '.dsh')

let pass = 0, fail = 0
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
}

const accounts = listVaultAccounts(DSH_HOME)
check('读到 vault 账号', accounts.length > 0, accounts.length + ' 个')
const acct = accounts[0]
check('有 accessToken', !!acct.accessToken)
check('有 uid', !!acct.uid)
check('有 domain', !!acct.domain, acct.domain)

const ledger = new TurnCreditLedger({ home: DSH_HOME, log: (m) => console.log('    [ledger] ' + m) })

// 取最近 10 分钟作为"一轮"
const now = Date.now()
const startMs = now - 10 * 60 * 1000

console.log('\n=== 查询最近 10 分钟的真实账单 ===')
const billing = {
  baseUrl: 'https://www.workbuddy.cn',
  token: acct.accessToken,
  domain: acct.domain,
  uid: acct.uid,
}

const t0 = Date.now()
const r = await ledger.queryBillingCredits(billing, startMs, now)
console.log('耗时:', Math.round((Date.now() - t0) / 1000) + ' 秒')
console.log('结果:', JSON.stringify(r))

check('查询成功', r.ok === true, r.error || '')
if (r.ok) {
  check('有请求数', r.requests > 0, r.requests)
  check('积分量级合理（0.1~200）', r.credits >= 0 && r.credits < 200, r.credits)
  console.log('\n  真实积分:', r.credits, '（', r.requests, '次请求）')
  console.log('  对比：本地 token 估算同期约 291 —— 高估约', Math.round(291 / Math.max(0.01, r.credits)), '倍')
}

console.log('\n=== 端到端：onTurnEnd 用账单定稿 ===')
{
  const before = ledger.seq
  const rec = await ledger.onTurnEnd({
    turn: 999,
    sessionId: 'test-session',
    byModel: { 'deepseek-v4-flash': { hit: 5000000, miss: 100000, out: 10000 } },
    startMs,
    endMs: now,
    billing,
  })
  check('返回记录', !!rec)
  if (rec) {
    check('source 是 billing', rec.source === 'billing', rec.source)
    check('credits 用真值（不是估算的几百）', rec.credits < 200, rec.credits)
    check('带 billing 明细', !!rec.billing, JSON.stringify(rec.billing))
    check('seq 递增', ledger.seq === before + 1, ledger.seq)
    console.log('\n  定稿: credits =', rec.credits, '| note =', rec.note)
    console.log('  如果走估算会是:', (5000000 * 3.8725e-5 + 100000 * 1.6057e-4).toFixed(2))
  }
}

console.log('\n=== 兜底：无 billing 时退回估算 ===')
{
  const rec = await ledger.onTurnEnd({
    turn: 998,
    sessionId: 'test-session',
    byModel: { 'GLM-5.3 · x0.79': { hit: 1000, miss: 100, out: 10 } },
  })
  check('仍能定稿', !!rec)
  if (rec) {
    // 2026-10-30 起：没有真值时记 pending，**不再填 token 估算**（那个高估 8~45 倍）
    check('source 是 pending', rec.source === 'pending', rec.source)
    check('credits 是 0 不是估算', rec.credits === 0, rec.credits)
    check('有 pending 标记', rec.pending === true, rec.pending)
  }
}

// 清理测试记录
ledger.turns = ledger.turns.filter((t) => t.turn !== 999 && t.turn !== 998)
ledger.save()

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
