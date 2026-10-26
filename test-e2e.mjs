// 端到端：用假的 cordis root 跑一遍 apply()，确认注册表同步 / 快照写入 / 路由注册
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from './lib/index.js'

const home = path.join(os.tmpdir(), 'bridge-e2e-' + Date.now())
fs.mkdirSync(path.join(home, 'workbuddy-vault', 'cn'), { recursive: true })
const realHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const realVault = path.join(realHome, 'workbuddy-vault', 'cn')
for (const f of fs.readdirSync(realVault)) {
  if (f.endsWith('.json')) fs.copyFileSync(path.join(realVault, f), path.join(home, 'workbuddy-vault', 'cn', f))
}

const disposers = []
const routes = []
const credentialsSet = []
/**
 * 假 ctx：`effect(fn)` 必须**真的执行** fn 并保存返回的 disposer ——
 * 真实 cordis 就是这样（fn 立即跑，返回值是清理函数）。
 * 第一版测试替身只把 fn 存起来不执行，于是路由永远没注册，误报成 bug。
 */
const makeCtx = (extra = {}) => ({
  effect: (fn) => {
    const d = fn()
    disposers.push(d)
    return d
  },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
  ...extra,
})
const root = {
  effect: (fn) => { disposers.push(fn()); },
  get: (n) => (n === 'credentials' ? { set: async (k, v) => { credentialsSet.push({ key: k, len: v.length }) } } : undefined),
  inject: (deps, cb) => cb(makeCtx()),
}

apply(root, { dshHome: home, intervalMs: 60_000, region: 'cn' })
await new Promise((r) => setTimeout(r, 6000))

console.log('--- 注册表 ---')
const regPath = path.join(home, '.dshw-api.json')
const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'))
console.log('models:', reg.models.map((m) => m.id + ' / ' + m.provider).join(', '))
console.log('usage 段保留:', typeof reg.usage === 'object')

console.log('--- 快照 ---')
const s = JSON.parse(fs.readFileSync(path.join(home, '.workbuddy-credits.json'), 'utf8'))
console.log('ok=' + s.ok, 'remaining=' + s.remaining, 'mode=' + s.mode, 'expiringSoon=' + s.expiringSoon)
console.log('不含 token:', !JSON.stringify(s).includes('eyJ'), '| 不含 uin:', !JSON.stringify(s).includes('"uin"'))

console.log('--- 路由 ---')
console.log('已注册:', routes.map((r) => r.path).join(', ') || '(无)')

// 真的调一次 handler，看返回内容
if (routes.length) {
  let captured
  const fakeRes = {
    writeHead: (code, h) => { captured = { code, headers: h } },
    end: (body) => { captured.body = body },
  }
  await routes[0].handler({ method: 'GET', headers: {} }, fakeRes)
  const parsed = JSON.parse(captured.body)
  console.log('HTTP', captured.code, '| 字段:', Object.keys(parsed).join(','))
  console.log('  remaining=' + parsed.remaining, '| 泄露 token:', JSON.stringify(parsed).includes('eyJ'), '| 泄露 accountId:', 'accountId' in parsed)
}

console.log('--- 凭据 ---')
console.log('写入次数:', credentialsSet.length, credentialsSet.length ? '(key=' + credentialsSet[0].key + ', len=' + credentialsSet[0].len + ')' : '')

// 幂等：再跑一次 sync，内容不变不应重写
console.log('--- 幂等 ---')
const before = fs.readFileSync(regPath, 'utf8')
const { syncRegistry } = await import('./lib/index.js')
const r2 = syncRegistry(home, 'custom')
const after = fs.readFileSync(regPath, 'utf8')
console.log('二次 sync changed=' + r2.changed, '(期望 false) | 文件未变:', before === after)

fs.rmSync(home, { recursive: true, force: true })
