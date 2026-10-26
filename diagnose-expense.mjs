// 诊断 {expense_ds}（今日已用）的口径。
//
// 结论先说：这个数**是对的**，只是它的语义是「账号维度今日总消耗」，
// 不是「本机 DSH 今日消耗」。两者会不一样，因为同一账号可能同时有：
//   · WorkBuddy 本体（网页 / 桌面 / 手机）
//   · 别的 DSH 窗口 / 别的 profile
//   · 厂商侧的定时任务、探活
//
// 早期我把它误判成「余额会自己掉、账本不可靠」，那是错的 —— 见 README 的修正说明。
import fs from 'node:fs'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE, '.dsh')
const regPath = path.join(DSH_HOME, '.dshw-api.json')
const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'))

console.log('=== 账本现状 ===')
const entry = reg.models[0]
const usage = reg.usage[entry.id]
console.log('模型:', entry.name, '(' + entry.id + ')')
console.log('币种:', entry.currency)
console.log(JSON.stringify(usage, null, 2))

console.log('\n=== {expense_ds} 会显示成什么 ===')
// 前端 apiFmtMoney：CREDITS 走 "数字 CREDITS" 分支
const cur = String(usage.currency || entry.currency || 'CNY').toUpperCase()
const delta = usage.delta || 0
const fmt = (v, c) => {
  const n = Number(v)
  if (!isFinite(n)) return '--'
  if (c === 'USD') return '$ ' + n.toFixed(2)
  if (c === 'CNY') return '¥ ' + n.toFixed(2)
  return n.toFixed(2) + (c ? ' ' + c : '')
}
console.log('今日已用 {expense_ds} =', fmt(delta, cur))

console.log('\n=== 这个数的口径 ===')
console.log('dayStart =', usage.dayStart, '（当天首次观测到的余额）')
console.log('lastBalance =', usage.lastBalance, '（最近一次观测）')
console.log('delta =', usage.delta, '（累加的所有下降额）')
console.log('')
console.log('[正确] 这是**账号维度**的今日总消耗 —— 对「我今天一共花了多少积分」是正确口径。')
console.log('       whale-widget 的余额差账本本来就是这么设计的，不是 bug。')
console.log('')
console.log('[注意] 但它不等于「本机 DSH 花的」。差额来自同一账号的其它客户端：')
console.log('         · WorkBuddy 本体（网页 / 桌面 / 手机）')
console.log('         · 别的 DSH 窗口 / 别的 profile')
console.log('         · 厂商侧定时任务、模型探活')
console.log('')
console.log('       所以「今日已用 364 但只聊了几轮」不是记账坏了，')
console.log('       而是那 364 里有一部分是别处花的。')
console.log('')
console.log('       想在气泡里标出来源，用 {expense_src}（显示「余额差记账」/「本地估算」）。')
console.log('       想看**本机**今日积分，看逐轮账本（下面的对比）。')

console.log('\n=== 账号维度 vs 本机维度 ===')
const turnFile = path.join(DSH_HOME, '.workbuddy-turn-credits.json')
if (fs.existsSync(turnFile)) {
  const t = JSON.parse(fs.readFileSync(turnFile, 'utf8'))
  const today = new Date().toISOString().slice(0, 10)
  const todayTurns = (t.turns || []).filter((x) => new Date(x.atMs).toISOString().slice(0, 10) === today)
  const sum = todayTurns.reduce((s, x) => s + (x.credits || 0), 0)
  console.log('本插件逐轮账本（本机，今天）:', todayTurns.length, '轮，合计', Math.round(sum * 100) / 100, '积分')
  console.log('余额差账本（账号，今天）  :', delta, '积分')
  const diff = Math.round((delta - sum) * 100) / 100
  console.log('差额:', diff, '积分 <- 这段时间在别处（WorkBuddy 本体等）花的')
} else {
  console.log('（还没有逐轮账本文件，需要先跑过带 WorkBuddy 模型的对话）')
}
