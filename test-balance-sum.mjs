// 回归测试：summarizeAccounts 的余额口径。
//
// 这个口径踩过两次坑，测试就是用来防止第三次：
//
// 真实月度包（CodeBuddy个人体验版）的字段：
//   CapacityType        = 4          <- 月度包
//   CapacitySize        = 500        <- 额度总量
//   CapacityRemain      = 500        <- 也是 500，**不随消耗下降**
//   CycleCapacitySize   = 500        <- 本周期额度
//   CycleCapacityRemain = 225.82     <- 本周期真实剩余
//
// 上游 TotalDosage **不可信**：它把月度包的 CapacityRemain(500) 当剩余加进去，
// 于是显示 3070，而 WorkBuddy 本体里实际只剩 279x —— 差 274 正是本周期已用。
//
// 实测三种口径 vs 真值 2796：
//   B. 月度用 CycleCapacityRemain -> 2795.82   差 0.18
//   A. 全部用 CapacityRemain      -> 3070      差 274
//   TotalDosage                   -> 3070      差 274
//
// 结论：月度包必须取 CycleCapacityRemain，且不能拿 TotalDosage 当基准。
// 这与 dsh-connect-workbuddy 的 fetchCredits 一致。
import { summarizeAccounts } from './lib/index.js'

let pass = 0, fail = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) { pass++; console.log('  OK   ' + label + ' -> ' + JSON.stringify(actual)) }
  else { fail++; console.log('  FAIL ' + label + ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)) }
}

const NOW = Date.parse('2026-10-26T12:00:00+08:00')
const future = '2027-01-01 00:00:00'

console.log('=== 月度包必须用 CycleCapacityRemain（不是 CapacityRemain）===')
{
  const accounts = [{
    CapacityType: 4,
    CapacitySize: 500,
    CapacityRemain: 500,
    CapacityRemainPrecise: '500',
    CycleCapacitySize: 500,
    CycleCapacityRemain: 225,
    CycleCapacityRemainPrecise: '225.82',
    CycleStartTime: '2026-10-01 00:00:00',
    CycleEndTime: '2026-10-31 23:59:59',
    PackageName: 'CodeBuddy个人体验版',
  }]
  const s = summarizeAccounts(accounts, NOW)
  check('用 CycleCapacityRemain', s.preciseTotal, 225.82)
  check('额度总量单独保留', s.packages[0].totalCapacity, 500)
  check('两者不同', s.preciseTotal !== 500, true)
}

console.log('\n=== 复现真实账号：一次性包 + 月度包 ===')
{
  const accounts = []
  for (let i = 0; i < 25; i++) {
    accounts.push({ CapacityType: 1, CapacityRemain: 100, CapacityRemainPrecise: '100', CycleCapacityRemain: 100, CycleCapacityRemainPrecise: '100', ExpiredTime: future, PackageName: '裂变包' })
  }
  accounts.push({ CapacityType: 1, CapacityRemain: 10, CapacityRemainPrecise: '10', CycleCapacityRemain: 10, CycleCapacityRemainPrecise: '10', ExpiredTime: future, PackageName: '裂变包' })
  accounts.push({ CapacityType: 1, CapacityRemain: 50, CapacityRemainPrecise: '50', CycleCapacityRemain: 50, CycleCapacityRemainPrecise: '50', ExpiredTime: future, PackageName: '裂变包' })
  accounts.push({ CapacityType: 1, CapacityRemain: 50, CapacityRemainPrecise: '50', CycleCapacityRemain: 50, CycleCapacityRemainPrecise: '50', ExpiredTime: future, PackageName: '裂变包' })
  accounts.push({ CapacityType: 4, CapacityRemain: 500, CapacityRemainPrecise: '500', CycleCapacityRemain: 225, CycleCapacityRemainPrecise: '225.82', CycleEndTime: '2026-10-31 23:59:59', PackageName: '体验版' })
  const s = summarizeAccounts(accounts, NOW)
  // 25*100 + 10 + 50 + 50 + 225.82 = 2835.82
  check('与手算一致', s.preciseTotal, 2835.82)
  // 若误用 CapacityRemain 会得到 3110
  check('不是 CapacityRemain 口径', s.preciseTotal !== 3110, true)
}

console.log('\n=== 一次性包两个字段相等时结果不变 ===')
{
  const accounts = [
    { CapacityType: 1, CapacityRemain: 100, CapacityRemainPrecise: '100', CycleCapacityRemain: 100, CycleCapacityRemainPrecise: '100', ExpiredTime: future, PackageName: 'a' },
    { CapacityType: 1, CapacityRemain: 50, CapacityRemainPrecise: '50', CycleCapacityRemain: 50, CycleCapacityRemainPrecise: '50', ExpiredTime: future, PackageName: 'b' },
  ]
  check('求和', summarizeAccounts(accounts, NOW).preciseTotal, 150)
}

console.log('\n=== 缺 Cycle 字段时回退 Capacity ===')
{
  const accounts = [
    { CapacityType: 1, CapacityRemain: 77, CapacityRemainPrecise: '77', ExpiredTime: future, PackageName: 'no-cycle' },
  ]
  check('回退成功', summarizeAccounts(accounts, NOW).preciseTotal, 77)
}

console.log('\n=== 过期包必须剔除 ===')
{
  const accounts = [
    { CapacityType: 1, CapacityRemain: 100, CapacityRemainPrecise: '100', CycleCapacityRemain: 100, CycleCapacityRemainPrecise: '100', ExpiredTime: '2020-01-01 00:00:00', PackageName: 'expired' },
    { CapacityType: 1, CapacityRemain: 50, CapacityRemainPrecise: '50', CycleCapacityRemain: 50, CycleCapacityRemainPrecise: '50', ExpiredTime: future, PackageName: 'valid' },
  ]
  const s = summarizeAccounts(accounts, NOW)
  check('只算未过期的', s.preciseTotal, 50)
  check('包数', s.packages.length, 1)
}

console.log('\n=== 零余额包剔除 ===')
{
  const accounts = [
    { CapacityType: 1, CapacityRemain: 0, CapacityRemainPrecise: '0', CycleCapacityRemain: 0, CycleCapacityRemainPrecise: '0', ExpiredTime: future, PackageName: 'empty' },
    { CapacityType: 1, CapacityRemain: 50, CapacityRemainPrecise: '50', CycleCapacityRemain: 50, CycleCapacityRemainPrecise: '50', ExpiredTime: future, PackageName: 'valid' },
  ]
  check('零余额不计入', summarizeAccounts(accounts, NOW).preciseTotal, 50)
}

console.log('\n=== 空输入安全 ===')
check('空数组', summarizeAccounts([], NOW).preciseTotal, 0)
check('null', summarizeAccounts(null, NOW).preciseTotal, 0)

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
