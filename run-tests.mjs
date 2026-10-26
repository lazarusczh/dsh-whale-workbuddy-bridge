#!/usr/bin/env node
// 一把跑完所有测试。
//
// 分两类：
//   · **离线测试** —— 不碰网络、不需要登录态，任何环境都能跑
//   · **在线测试** —— 需要本机有 workbuddy-vault（登录过 WorkBuddy）+ 已安装 whale-widget
//
// 在线测试在缺条件时会**跳过并说明原因**，不算失败 —— 这样别人 clone 下来
// 也能先跑离线部分验证代码没坏。
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const OFFLINE = [
  'test-balance-sum.mjs',      // 逐包求和口径
  'test-turn-credits.mjs',     // 账本逻辑（不联网时走估算路径）
  'test-currency-label.mjs',   // Cr. 显示
  'test-patch-module.mjs',     // 补丁模块幂等
  'test-all-placeholders.mjs', // 从原版打补丁
  'test-autopatch.mjs',        // 插件启动自动打补丁
  'test-credits-today.mjs',    // {credits_today} 链路
]

const ONLINE = [
  'test-local.mjs',              // 真实取数
  'test-host-credits.mjs',       // 需要已安装 whale-widget
  'test-integration.mjs',        // 需要已安装 whale-widget
  'test-provider-recognition.mjs',// 需要已安装 whale-widget + 注册表
  'test-e2e-turn.mjs',           // 需要已安装 whale-widget
  'test-native-branch.mjs',      // 需要 vault
  'test-balance-display.mjs',    // 需要 vault
  'test-billing-source.mjs',     // 需要 vault + 网络
  'test-real-credits.mjs',       // 需要已安装 whale-widget
]

function hasVault() {
  try {
    const d = path.join(DSH_HOME, 'workbuddy-vault')
    for (const region of fs.readdirSync(d)) {
      const sub = path.join(d, region)
      if (fs.statSync(sub).isDirectory() && fs.readdirSync(sub).some((f) => f.endsWith('.json'))) return true
    }
  } catch {}
  return false
}

function hasWhaleWidget() {
  return fs.existsSync(path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'lib', 'index.js'))
}

const canOnline = hasVault() && hasWhaleWidget()

function run(file) {
  const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 300_000 })
  const out = (r.stdout || '') + (r.stderr || '')
  const m = /(\d+) passed, (\d+) failed/.exec(out)
  return {
    file,
    code: r.status,
    passed: m ? Number(m[1]) : 0,
    failed: m ? Number(m[2]) : 0,
    out,
  }
}

console.log('=== 离线测试（不需要网络 / 登录态）===')
let totalPass = 0
let totalFail = 0
const failures = []
for (const f of OFFLINE) {
  if (!fs.existsSync(f)) { console.log('  -  ' + f + '（不存在，跳过）'); continue }
  const r = run(f)
  totalPass += r.passed
  totalFail += r.failed
  const mark = r.failed === 0 && r.code === 0 ? 'OK  ' : 'FAIL'
  console.log('  ' + mark + ' ' + f.padEnd(30) + r.passed + ' passed, ' + r.failed + ' failed')
  if (r.failed > 0 || r.code !== 0) failures.push(r)
}

console.log('\n=== 在线测试（需要 WorkBuddy 登录态 + whale-widget）===')
if (!canOnline) {
  const why = []
  if (!hasVault()) why.push('没有 workbuddy-vault（先打开一次 WorkBuddy 完成登录）')
  if (!hasWhaleWidget()) why.push('没安装 dsh-whale-widget')
  console.log('  跳过：' + why.join('；'))
  console.log('  （这些测试验证真实取数与补丁效果，需要上面两个前提）')
} else {
  for (const f of ONLINE) {
    if (!fs.existsSync(f)) { console.log('  -  ' + f + '（不存在，跳过）'); continue }
    const r = run(f)
    totalPass += r.passed
    totalFail += r.failed
    const mark = r.failed === 0 && r.code === 0 ? 'OK  ' : 'FAIL'
    console.log('  ' + mark + ' ' + f.padEnd(30) + r.passed + ' passed, ' + r.failed + ' failed')
    if (r.failed > 0 || r.code !== 0) failures.push(r)
  }
}

console.log('\n=== 合计: ' + totalPass + ' passed, ' + totalFail + ' failed ===')
if (failures.length) {
  console.log('\n失败详情:')
  for (const r of failures) {
    console.log('\n--- ' + r.file + ' ---')
    console.log(r.out.split('\n').filter((l) => /FAIL|Error|错误/.test(l)).slice(0, 8).join('\n'))
  }
}
process.exit(totalFail > 0 ? 1 : 0)
