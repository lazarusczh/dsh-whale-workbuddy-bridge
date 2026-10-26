// 验证自检路由在三种故障场景下都能给出可执行的提示
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from './lib/index.js'

async function scenario(label, setup) {
  const home = path.join(os.tmpdir(), 'diag-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6))
  fs.mkdirSync(home, { recursive: true })
  setup(home)
  const routes = []
  const disposers = []
  const makeCtx = () => ({ effect: (fn) => { disposers.push(fn()) }, webServer: { register: (r) => { routes.push(r); return () => {} } } })
  const root = {
    effect: (fn) => { disposers.push(fn()) },
    get: (n) => (n === 'credentials' ? { set: async () => {} } : undefined),
    inject: (d, cb) => cb(makeCtx()),
  }
  apply(root, { dshHome: home, intervalMs: 60_000 })
  await new Promise((r) => setTimeout(r, 5000))

  const statusRoute = routes.find((r) => r.path.endsWith('status.json'))
  let captured
  await statusRoute.handler({ method: 'GET', headers: {} }, {
    writeHead: (c, h) => { captured = { code: c } },
    end: (b) => { captured.body = JSON.parse(b) },
  })
  console.log('\n【' + label + '】')
  const s = captured.body
  console.log('  vault:', s.vault.accountCount, '个账号 | upstream.ok:', s.upstream.ok, s.upstream.code ? '(' + s.upstream.code + ')' : '')
  console.log('  whaleWidget:', s.whaleWidget.installed ? '已装' : '未装', '| registry.found:', s.registry.found)
  console.log('  提示:', s.hints.length ? s.hints.join(' / ') : '(无)')
  fs.rmSync(home, { recursive: true, force: true })
  return s
}

// 场景 A：完全没登录（空 vault）
await scenario('没装/没登录 connect 插件', () => {})

// 场景 B：有 vault 但 token 已过期（伪造一个过期 token）
await scenario('token 已过期', (home) => {
  fs.mkdirSync(path.join(home, 'workbuddy-vault', 'cn'), { recursive: true })
  fs.writeFileSync(path.join(home, 'workbuddy-vault', 'cn', 'deadbeef.json'), JSON.stringify({
    version: 1, accountId: 'deadbeef', refreshedAtMs: Date.now(),
    auth: { accessToken: 'expired.token.value', domain: 'www.workbuddy.cn', expiresAt: Math.floor(Date.now() / 1000) - 3600 },
    account: { uid: 'x', nickname: 'test', uin: '1' },
  }), 'utf8')
})

// 场景 C：正常（真实 vault）
await scenario('一切正常', (home) => {
  const realHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const realVault = path.join(realHome, 'workbuddy-vault', 'cn')
  fs.mkdirSync(path.join(home, 'workbuddy-vault', 'cn'), { recursive: true })
  for (const f of fs.readdirSync(realVault)) {
    if (f.endsWith('.json')) fs.copyFileSync(path.join(realVault, f), path.join(home, 'workbuddy-vault', 'cn', f))
  }
})
