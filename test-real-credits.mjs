// 验证：whale-widget 的每轮积分改用官方账单真值。
//
// 核心断言：读账本拿到的真值远小于 token 估算，且只在 source==='billing' 时采用。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let pass = 0, fail = 0
function check(label, cond, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
  else { fail++; console.log('  FAIL ' + label + (detail !== undefined ? ' -> ' + detail : '')) }
}

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const HOST = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'lib', 'index.js')
const src = fs.readFileSync(HOST, 'utf8')

console.log('=== 1. 函数已就位 ===')
const fnSrc = /    function readWorkbuddyRealCredits\(sessionId\) \{[\s\S]*?\n    \}/.exec(src)
check('找到 readWorkbuddyRealCredits', !!fnSrc, fnSrc ? fnSrc[0].length + ' 字节' : '')
check('finalizeTurn 里优先用它', src.includes('const realCredits = readWorkbuddyRealCredits(sessionId)'))
check('不再用估算兜底', src.includes('const usedEstimate = false'))
check('接受 balance 来源', src.includes("latest.source !== 'billing' && latest.source !== 'balance'"))

console.log('\n=== 2. 用真实账本验证取值 ===')
if (fnSrc) {
  const fn = new Function('path', 'fs', 'DSH_HOME', fnSrc[0] + '; return readWorkbuddyRealCredits')(path, fs, DSH_HOME)
  const real = fn(undefined)
  console.log('  账本最新一条的 credits:', real)
  const turnFile = path.join(DSH_HOME, '.workbuddy-turn-credits.json')
  const doc = JSON.parse(fs.readFileSync(turnFile, 'utf8'))
  const latest = doc.turns[0]
  console.log('  账本 source:', latest.source, '| note:', latest.note, '| at:', new Date(latest.atMs).toLocaleTimeString())

  if (latest.source === 'billing' && Date.now() - latest.atMs < 5 * 60 * 1000) {
    check('读到真值', real !== undefined, real)
    check('真值量级正确（个位到几十）', real !== undefined && real < 200, real)
    console.log('\n  对比：若走 token 估算会是', Object.values(latest.models || {})[0]
      ? (Object.values(latest.models)[0].hit * 3.8725e-5 + Object.values(latest.models)[0].miss * 1.6057e-4).toFixed(2)
      : '?')
  } else {
    console.log('  （最新记录不是 billing 口径或已过期，跳过真值断言）')
  }
}

console.log('\n=== 3. 只有 source==="billing" 才采用 ===')
if (fnSrc) {
  const tmpHome = path.join(os.tmpdir(), 'ledger-test-' + Date.now())
  fs.mkdirSync(tmpHome, { recursive: true })
  const fn = new Function('path', 'fs', 'DSH_HOME', fnSrc[0] + '; return readWorkbuddyRealCredits')(path, fs, tmpHome)

  // a) 估算口径 → 不采用
  fs.writeFileSync(path.join(tmpHome, '.workbuddy-turn-credits.json'), JSON.stringify({
    seq: 1,
    turns: [{ seq: 1, turn: 1, sessionId: 's1', atMs: Date.now(), credits: 999, source: 'tokens', note: '估算' }],
  }))
  check('估算记录不被当真值', fn(undefined) === undefined, String(fn(undefined)))

  // b) 账单口径 → 采用
  fs.writeFileSync(path.join(tmpHome, '.workbuddy-turn-credits.json'), JSON.stringify({
    seq: 2,
    turns: [{ seq: 2, turn: 2, sessionId: 's1', atMs: Date.now(), credits: 10.06, source: 'billing', note: '官方账单' }],
  }))
  check('账单记录被采用', fn(undefined) === 10.06, fn(undefined))

  // c) 过期记录 → 不采用
  fs.writeFileSync(path.join(tmpHome, '.workbuddy-turn-credits.json'), JSON.stringify({
    seq: 3,
    turns: [{ seq: 3, turn: 3, sessionId: 's1', atMs: Date.now() - 10 * 60 * 1000, credits: 5, source: 'billing' }],
  }))
  check('超过 5 分钟的记录不用', fn(undefined) === undefined, String(fn(undefined)))

  // d) sessionId 不匹配 → 不采用
  fs.writeFileSync(path.join(tmpHome, '.workbuddy-turn-credits.json'), JSON.stringify({
    seq: 4,
    turns: [{ seq: 4, turn: 4, sessionId: 'other', atMs: Date.now(), credits: 7, source: 'billing' }],
  }))
  check('sessionId 不匹配时不用', fn('my-session') === undefined, String(fn('my-session')))
  check('sessionId 匹配时采用', fn('other') === 7, fn('other'))

  fs.rmSync(tmpHome, { recursive: true, force: true })
}

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
