#!/usr/bin/env node
// 手工维护 whale-widget 的 {credits} 补丁。
//
// ⚠️ 正常情况下**你不需要跑这个脚本** —— 桥接插件启动时会自动打补丁，
//    并且每次 tick 比对文件 mtime，whale-widget 被重装/升级覆盖后会自动重打。
//    这个脚本只是给「想手工确认 / 强制修复 / 彻底撤销」的场景留的入口。
//
// 实现上它是 lib/patch-whale.mjs 的薄封装 —— 补丁逻辑只有一份，
// 免得脚本和插件各写一套、日后漂移。
//
// 用法：
//   node apply-turn-credits-patch.mjs            # 打补丁（幂等）
//   node apply-turn-credits-patch.mjs --check    # 只看状态
//   node apply-turn-credits-patch.mjs --revert   # 撤销
import { findWhaleWidget, patchState, applyTurnCreditsPatch, revertTurnCreditsPatch } from './lib/patch-whale.mjs'

const args = process.argv.slice(2)
const mode = args.includes('--revert') ? 'revert' : args.includes('--check') ? 'check' : 'apply'

const pkg = findWhaleWidget()
if (!pkg) {
  console.error('✗ 没找到 dsh-whale-widget')
  process.exit(1)
}
console.log('插件目录: ' + pkg)

if (mode === 'check') {
  const st = patchState(pkg)
  console.log('宿主补丁: ' + (st.host ? '已打' : '未打'))
  console.log('前端补丁: ' + (st.client ? '已打' : '未打'))
  if (!st.host || !st.client) {
    console.log('\n提示：桥接插件下次启动会自动补上；也可以现在跑 `node apply-turn-credits-patch.mjs` 立即修复。')
  }
  process.exit(st.host && st.client ? 0 : 1)
}

if (mode === 'revert') {
  const r = revertTurnCreditsPatch({ pkg })
  if (!r.ok) {
    console.error('✗ 撤销失败: ' + r.error)
    process.exit(1)
  }
  console.log('✓ 已撤销补丁。建议重装 whale-widget 确保完全干净；')
  console.log('  另外把桥接插件的 turnCredits 设为 false，否则它下次启动会重新打上。')
  process.exit(0)
}

const r = applyTurnCreditsPatch({ pkg, log: (m) => console.log('· ' + m) })
if (!r.ok) {
  console.error('✗ 打补丁失败: ' + r.error)
  process.exit(1)
}
console.log(r.changed ? '✓ 补丁已写入' : '· 补丁已是最新，无需改动')
if (r.changed) {
  console.log(r.needsRestart
    ? '\n需要重启 DSH 生效。然后在 whale-widget 面板的「每轮消耗提示」里写 {credits}。'
    : '\n刷新页面即可生效。')
} else {
  console.log('\n如果气泡还是没显示积分，检查面板「每轮消耗提示」的文案里有没有写 {credits}。')
}
