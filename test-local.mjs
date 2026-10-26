// 桥接插件核心函数的本地验证（不启动 DSH，直接跑模块）
import { listVaultAccounts, fetchWorkBuddyCredits, summarizeAccounts, buildModelEntry, resolveRegistryPath, syncRegistry, writeSnapshot } from './lib/index.js'

const accts = listVaultAccounts()
console.log('vault 账号数:', accts.length)
for (const a of accts) {
  console.log('  region=' + a.region, 'id=' + a.accountId.slice(0, 8) + '…', 'nick=' + a.nickname, 'tokenExp=' + new Date(a.expiresAtMs).toISOString().slice(0, 10))
}

const r = await fetchWorkBuddyCredits()
if (!r.ok) {
  console.log('取数失败:', r.code, r.error)
} else {
  console.log('取数成功: remaining=' + r.remaining, 'precise=' + r.preciseTotal, 'expiringSoon=' + r.expiringSoon, 'pkgs=' + r.packages.length, 'region=' + r.region)
}

console.log('注册表路径:', resolveRegistryPath())
console.log('native 条目:', JSON.stringify(buildModelEntry('native')))
const custom = buildModelEntry('custom')
console.log('custom 条目: provider=' + custom.provider, 'keyRef=' + custom.keyRef, 'allowCustomHost=' + custom.allowCustomHost)
console.log('  url=' + custom.balance.url)
console.log('  json.remaining=' + custom.balance.json.remaining)

// summarizeAccounts 的边界：过期包应被剔除
const fake = [
  { CapacityType: 1, CapacityRemain: 100, CapacityRemainPrecise: '100.5', ExpiredTime: '2020-01-01 00:00:00', PackageName: 'expired' },
  { CapacityType: 1, CapacityRemain: 50, CapacityRemainPrecise: '50.25', ExpiredTime: '2099-01-01 00:00:00', PackageName: 'valid' },
  { CapacityType: 4, CycleCapacityRemain: 500, CycleCapacitySize: 500, CycleEndTime: '2099-12-31 23:59:59', PackageName: 'monthly' },
]
const s = summarizeAccounts(fake, Date.parse('2026-10-23T00:00:00+08:00'))
console.log('summarizeAccounts 边界测试: preciseTotal=' + s.preciseTotal, '(期望 550.25, 过期包已剔除) pkgs=' + s.packages.length, '(期望 2)')
