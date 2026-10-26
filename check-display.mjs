// 显示值核对表：重启 DSH 后跑这个，确认界面应该显示什么。
//
// 这个脚本不依赖 DSH 进程状态，直接复刻 whale-widget 的取数路径，
// 所以它给出的数字就是重启后侧栏应该显示的数字。
import fs from 'node:fs'
import path from 'node:path'
import { fetchWorkBuddyCredits } from './lib/index.js'

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE, '.dsh')

console.log('=== 重启后侧栏应显示的数字 ===\n')

const r = await fetchWorkBuddyCredits()
if (!r.ok) {
  console.log('取数失败:', r.code, r.error)
  process.exit(1)
}

console.log('余额        : ' + r.remaining + ' CREDITS   <- 侧栏「余额」显示这个')
console.log('今日已用    : 由 whale-widget 账本给出（见下）')
console.log('包数        : ' + r.packages.length)
console.log('即将过期    : ' + r.expiringSoon + ' 积分（3 天窗口）')

const monthly = r.packages.filter((p) => p.monthly)
if (monthly.length) {
  console.log('\n月度包明细（remain 是本周期剩余，totalCapacity 是额度总量）：')
  for (const p of monthly) {
    console.log('  ' + p.packageName + ': 本周期剩 ' + p.remain + ' / 额度总量 ' + p.totalCapacity)
  }
}

console.log('\n=== 今日已用（whale-widget 余额差账本）===')
const reg = JSON.parse(fs.readFileSync(path.join(DSH_HOME, '.dshw-api.json'), 'utf8'))
const entry = reg.models[0]
const u = reg.usage && reg.usage[entry.id]
if (u) {
  console.log('dayStart    :', u.dayStart)
  console.log('lastBalance :', u.lastBalance)
  console.log('delta       :', u.delta, '（账号维度今日总消耗）')
} else {
  console.log('（今天还没有账本记录）')
}

console.log('\n=== 与错误口径对照 ===')
console.log('TotalDosage（错，偏大）: ' + (r.totalDosageRaw !== undefined ? r.totalDosageRaw : '?'))
console.log('逐包求和（对，本值）  : ' + r.preciseTotal)
console.log('差额                  : ' + (r.totalDosageRaw !== undefined ? Math.round((r.totalDosageRaw - r.preciseTotal) * 100) / 100 : '?'))
console.log('  ↑ 差额就是月度包本周期已用的部分（TotalDosage 把它算成了剩余）')
console.log('')
console.log('如果重启后侧栏仍显示 TotalDosage 那个数，说明 DSH 还没重启，或者')
console.log('whale-widget 的余额缓存（25 秒）还没过期 —— 等一分钟再看。')
