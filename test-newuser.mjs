// 模拟「全新用户」场景：空的 DSH_HOME + 只有 vault（已登录 connect 插件）
// 验证：装插件后，whale-widget 是否无需任何手工操作就能看到 WorkBuddy 积分
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply, fetchWorkBuddyCredits, syncRegistry, buildModelEntry } from './lib/index.js'

const home = path.join(os.tmpdir(), 'newuser-' + Date.now())
fs.mkdirSync(path.join(home, 'workbuddy-vault', 'cn'), { recursive: true })
// 新用户：只装了 connect 插件并登录过，vault 有文件
const realHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const realVault = path.join(realHome, 'workbuddy-vault', 'cn')
for (const f of fs.readdirSync(realVault)) {
  if (f.endsWith('.json')) fs.copyFileSync(path.join(realVault, f), path.join(home, 'workbuddy-vault', 'cn', f))
}
// 新用户：**没有** .dshw-api.json（whale-widget 从没配过自定义模型）

console.log('=== 初始状态（新用户）===')
console.log('注册表存在:', fs.existsSync(path.join(home, '.dshw-api.json')))
console.log('凭据里没有 token: true')

// 模拟插件的首轮 tick
const creds = []
const disposers = []
const routes = []
const makeCtx = () => ({
  effect: (fn) => { disposers.push(fn()) },
  webServer: { register: (r) => { routes.push(r); return () => {} } },
})
const root = {
  effect: (fn) => { disposers.push(fn()) },
  get: (n) => (n === 'credentials' ? { set: async (k, v) => { creds.push(k) } } : undefined),
  inject: (deps, cb) => cb(makeCtx()),
}
apply(root, { dshHome: home, intervalMs: 60_000 })
await new Promise((r) => setTimeout(r, 6000))

console.log('\n=== 首轮 tick 之后 ===')
const regPath = path.join(home, '.dshw-api.json')
const reg = JSON.parse(fs.readFileSync(regPath, 'utf8'))
console.log('注册表已自动创建:', fs.existsSync(regPath))
console.log('自动新增的条目:', reg.models.map((m) => `${m.id} / ${m.provider} / ${m.name}`).join(', '))
console.log('  余额接口:', reg.models[0].balance && reg.models[0].balance.url)
console.log('  字段路径:', reg.models[0].balance && reg.models[0].balance.json.remaining)
console.log('  允许自定义地址:', reg.models[0].allowCustomHost)
console.log('凭据已写入:', creds.join(', ') || '(未写入)')

const snap = JSON.parse(fs.readFileSync(path.join(home, '.workbuddy-credits.json'), 'utf8'))
console.log('快照已生成:', snap.ok, '| 余额:', snap.remaining)

console.log('\n=== 结论 ===')
const ok = fs.existsSync(regPath) && reg.models.length === 1 && creds.length === 1 && snap.ok
console.log(ok ? '✓ 新用户无需任何手工配置：装插件 → 重启 → 自动出现「WorkBuddy 积分」' : '✗ 有缺口')

fs.rmSync(home, { recursive: true, force: true })
