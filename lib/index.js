// dsh-whale-workbuddy-bridge —— 把 WorkBuddy / CodeBuddy 积分接进 dsh-whale-widget
//
// 设计目标：**不改 whale-widget 的任何代码**。它已经有三样东西够用：
//   ① `$DSH_HOME/.dshw-api.json` 模型注册表（普通 JSON，谁都能写）
//   ② 「自定义 HTTP」模板支持 POST + 自定义 body + 分号分隔请求头 + `a.b[0].c` 路径
//   ③ DSH 凭据服务（`ctx.credentials`），注册表里只存凭据**名**
//
// 于是本插件只做三件事，全部围绕「让 whale-widget 能自己取到数」：
//   1. **维护 token**：从 dsh-connect-workbuddy 的 vault 读 accessToken，写进 DSH 凭据。
//      token 会过期，但 connect 插件会续期并回写 vault —— 我们只需**跟着读**，
//      所以这是「单写者」关系：vault 归 connect 管，凭据归我们管，互不覆盖。
//   2. **维护注册表**：确保 `.dshw-api.json` 里有且只有一条指向计费网关的模型条目。
//      写入是「读-改-写」并保留 `usage`，因为 whale-widget 也会写这个文件（余额差账本）。
//   3. **落快照 + 开只读路由**：`.workbuddy-credits.json` 与
//      `/dsh-workbuddy-bridge/credits.json`，让**任何**记账插件都能读，不必依赖本插件内部。
//
// 为什么不自己续期 token：vault 里的 refreshToken 在续期后会**轮换**，两个写者会让
// connect 插件手里的那份失效。宁可只读、过期就报错并提示「打开一次 WorkBuddy 卡片」。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { TurnCreditLedger } from './turn-credits.mjs'
import { applyTurnCreditsPatch, patchFingerprint, patchState } from './patch-whale.mjs'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

/** 国内区计费网关（与 dsh-connect-workbuddy 的 CN_BILLING_BASE 一致）。 */
const CN_BILLING_BASE = 'https://www.codebuddy.cn'
/** 国际区缺省网关。 */
const GLOBAL_BILLING_BASE = 'https://www.workbuddy.ai'
/** 计费接口路径。 */
const CREDITS_PATH = '/v2/billing/meter/get-user-resource'
/** 上游读取超时。 */
const TIMEOUT_MS = 15000
/**
 * 「即将过期」窗口 = **3 天**。
 *
 * 这个数字不是随手定的：dsh-connect-workbuddy 里写的是 `const SOON_MS = 2592e5`，
 * 即 259,200,000 ms = 3 天。插件卡片上「即将过期 X」按 3 天算，这里必须同口径，
 * 否则两个界面上的数会互相矛盾（按 30 天算会得到 2920，按 3 天是 200）。
 */
const SOON_MS = 3 * 24 * 3600 * 1000
/** 默认轮询间隔：与 whale-widget 的 `REFRESH_MS = 60000` 对齐，稍慢一点避免抢跑。 */
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000

/** whale-widget 的注册表文件名（与插件里 API_FILE_CANDIDATES 的第一项一致）。 */
const REGISTRY_FILENAME = '.dshw-api.json'
/** 快照文件名：给其它记账插件读的公开产物。 */
const SNAPSHOT_FILENAME = '.workbuddy-credits.json'
/** 注册表里本插件管理的模型 id —— 固定值，便于幂等更新。 */
const MODEL_ID = 'api_workbuddy_credits'
/** 自定义模式下 token 存放的凭据名。 */
const CREDENTIAL_REF = 'WORKBUDDY_ACCESS_TOKEN'

// ── 小工具 ───────────────────────────────────────────────────────────────────

/** 时间字段统一成毫秒（上游有数字秒 / 数字毫秒 / "YYYY-MM-DD HH:MM:SS" 三种形态）。 */
function toMs(value) {
  if (typeof value === 'string') {
    const s = value.trim()
    if (s === '') return 0
    const parsed = Date.parse(s.replace(' ', 'T'))
    return Number.isFinite(parsed) ? parsed : 0
  }
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n > 1e11 ? n : n * 1000
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 区域 → 计费网关（凭据域是 codebuddy.ai 时国际站要换 host）。 */
function billingBaseOf(region, domain) {
  if (region === 'cn') return CN_BILLING_BASE
  const d = String(domain || '').trim().toLowerCase()
  if (d === 'codebuddy.ai' || d.endsWith('.codebuddy.ai')) return 'https://www.codebuddy.ai'
  return GLOBAL_BILLING_BASE
}

/** 原子写：先写 tmp 再 rename，避免读到半截 JSON。 */
function writeFileAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp'
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

// ── vault 读取（只读！） ──────────────────────────────────────────────────────

/**
 * 列出本机 vault 里的全部 WorkBuddy 账号。
 *
 * 目录结构：`$DSH_HOME/workbuddy-vault/<region>/<accountId>.json`，
 * 文档形如 `{auth:{accessToken,refreshToken,expiresAt,domain},account:{uid,nickname,uin}}`。
 * 解析失败的文件直接跳过 —— vault 里可能同时有旧格式与迁移残片。
 */
export function listVaultAccounts(home = DSH_HOME) {
  const root = path.join(home, 'workbuddy-vault')
  const out = []
  let regions
  try {
    regions = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return out
  }
  for (const region of regions) {
    const dir = path.join(root, region)
    let files
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      continue
    }
    for (const file of files) {
      const doc = readJson(path.join(dir, file))
      const auth = doc && typeof doc.auth === 'object' && doc.auth ? doc.auth : undefined
      if (!auth) continue
      const accessToken = typeof auth.accessToken === 'string' ? auth.accessToken : ''
      if (!accessToken) continue
      const account = doc.account && typeof doc.account === 'object' ? doc.account : {}
      out.push({
        region,
        accountId: String(doc.accountId || file.replace(/\.json$/, '')),
        accessToken,
        uid: typeof account.uid === 'string' ? account.uid : '',
        nickname: typeof account.nickname === 'string' ? account.nickname : '',
        domain: typeof auth.domain === 'string' ? auth.domain : '',
        expiresAtMs: toMs(auth.expiresAt),
        refreshedAtMs: Number(doc.refreshedAtMs) || 0,
      })
    }
  }
  return out
}

/** 选账号：优先指定区域，其次最近刷新过的。 */
function pickAccount(accounts, preferRegion) {
  if (!accounts.length) return undefined
  const want = preferRegion || 'cn'
  return accounts.slice().sort((a, b) => {
    const ra = a.region === want ? 1 : 0
    const rb = b.region === want ? 1 : 0
    if (ra !== rb) return rb - ra
    return (b.refreshedAtMs || 0) - (a.refreshedAtMs || 0)
  })[0]
}

// ── 上游读数 ─────────────────────────────────────────────────────────────────

/**
 * 把上游 `Accounts[]` 归一成「余额 + 分包明细」。
 *
 * 口径对齐 dsh-connect-workbuddy 的 fetchCredits：
 *   · `CapacityType === 4` 是月度套餐包（看 `CycleEndTime`，下个周期刷新）
 *   · 其余是一次性/活动包（看 `ExpiredTime`；已过期或余量为 0 的不计入）
 *   · 优先用 `*Precise` 字段（字符串、带小数）
 */
export function summarizeAccounts(accounts, nowMs = Date.now()) {
  const packages = []
  let preciseTotal = 0
  let expiringSoon = 0
  let nearestExpiryMs
  for (const raw of Array.isArray(accounts) ? accounts : []) {
    if (!raw || typeof raw !== 'object') continue
    const monthly = num(raw.CapacityType) === 4
    // ── 余额口径：**优先 CycleCapacityRemain，回退 CapacityRemain** ─────────
    //
    // ⚠️ 这里踩过两次坑，别再来第三次。用真实月度包（CodeBuddy个人体验版）说明：
    //
    //   CapacityType        = 4          ← 月度包
    //   CapacitySize        = 500        ← 额度总量
    //   CapacityRemain      = 500        ← ⚠️ 也是 500，**不是剩余！**
    //   CycleCapacitySize   = 500        ← 本周期额度
    //   CycleCapacityRemain = 225.82     ← ✅ 本周期真实剩余
    //
    // 也就是说，月度包的 `CapacityRemain` **不会随消耗下降**，它一直是额度总量。
    // 真正反映"还能用多少"的是 `CycleCapacityRemain`。
    //
    // 上游 `TotalDosage` 也**不可信**：它把月度包的 `CapacityRemain`(500) 直接
    // 加进总数，于是显示 3070，而 WorkBuddy 本体里实际只剩 2796 —— 差 274
    // 正是本周期已消耗的部分。所以**不能拿 TotalDosage 当基准**去校准。
    //
    // 实测三种口径 vs 真值 2796：
    //   B. 月度用 CycleCapacityRemain   → 2795.82   ✅ 差 0.18
    //   A. 全部用 CapacityRemain        → 3070      ❌ 差 274
    //   TotalDosage                     → 3070      ❌ 差 274
    //
    // 一次性包（CapacityType=1）两个字段通常相等，所以优先 Cycle 也无副作用；
    // 若某些包缺 Cycle 字段，回退到 Capacity 保证不丢数。
    const hasCycle = raw.CycleCapacityRemain !== undefined || raw.CycleCapacityRemainPrecise !== undefined
    const remain = hasCycle
      ? (raw.CycleCapacityRemainPrecise !== undefined && raw.CycleCapacityRemainPrecise !== ''
        ? num(raw.CycleCapacityRemainPrecise)
        : num(raw.CycleCapacityRemain))
      : (raw.CapacityRemainPrecise !== undefined && raw.CapacityRemainPrecise !== ''
        ? num(raw.CapacityRemainPrecise)
        : num(raw.CapacityRemain))
    const capped = remain < 0 ? 0 : remain
    const cycleEndMs = toMs(raw.CycleEndTime)
    const expiresAtMs = monthly ? undefined : (toMs(raw.ExpiredTime) || cycleEndMs || undefined)
    if (!monthly && (capped <= 0 || (expiresAtMs !== undefined && expiresAtMs <= nowMs))) continue
    preciseTotal += capped
    if (expiresAtMs !== undefined) {
      if (nearestExpiryMs === undefined || expiresAtMs < nearestExpiryMs) nearestExpiryMs = expiresAtMs
      if (expiresAtMs - nowMs <= SOON_MS) expiringSoon += capped
    }
    packages.push({
      packageName: typeof raw.PackageName === 'string' ? raw.PackageName : '(unnamed)',
      remain: Math.round(capped * 100) / 100,
      monthly,
      // 月度包把"额度总量"也带上，便于界面解释「为什么和 TotalDosage 不一样」
      ...monthly ? { totalCapacity: Math.round(num(raw.CapacityRemainPrecise !== '' ? raw.CapacityRemainPrecise : raw.CapacityRemain) * 100) / 100 } : {},
      ...expiresAtMs === undefined ? {} : { expiresAtMs },
    })
  }
  return {
    preciseTotal: Math.round(preciseTotal * 100) / 100,
    expiringSoon: Math.round(expiringSoon * 100) / 100,
    ...nearestExpiryMs === undefined ? {} : { nearestExpiryMs },
    packages,
  }
}

/** 读一次剩余积分。**不抛异常**，失败返回 `{ok:false, code, error}`。 */
export async function fetchWorkBuddyCredits(options = {}) {
  const home = options.home || DSH_HOME
  const account = pickAccount(options.accounts || listVaultAccounts(home), options.region)
  if (!account) {
    return { ok: false, code: 'NO_VAULT', error: '本机没有 WorkBuddy 登录态（先打开一次 WorkBuddy / dsh-connect-workbuddy 卡片完成登录）' }
  }
  const base = billingBaseOf(account.region, account.domain)
  const headers = {
    Authorization: 'Bearer ' + account.accessToken,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  if (account.uid) headers['X-User-Id'] = account.uid
  if (account.domain) headers['X-Domain'] = account.domain
  let response
  try {
    response = await fetch(base + CREDITS_PATH, {
      method: 'POST',
      headers,
      // body 必须带：空 body 会被网关拒成 400 / code=10001
      body: JSON.stringify({ PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3] }),
      signal: AbortSignal.timeout(options.timeoutMs || TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, code: 'NETWORK', error: '积分接口请求失败: ' + String((error && error.message) || error).slice(0, 160) }
  }
  const text = await response.text()
  if (response.status === 401 || response.status === 403) {
    // 上游 401 返回的是 openresty 的 HTML，不是 JSON —— 别试图解析
    return { ok: false, code: 'TOKEN_EXPIRED', error: 'WorkBuddy 登录态已过期（打开一次 WorkBuddy 卡片让它自动续期后重试）' }
  }
  if (!response.ok) {
    return { ok: false, code: 'HTTP', error: '积分接口 HTTP ' + response.status + ': ' + text.slice(0, 120) }
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    return { ok: false, code: 'PARSE', error: '积分接口返回不是合法 JSON' }
  }
  if (!payload || payload.code !== 0) {
    return { ok: false, code: 'BIZ', error: '积分接口业务错误: code=' + String(payload && payload.code) + ' ' + String((payload && payload.msg) || '').slice(0, 100) }
  }
  const wrapper = payload.data && typeof payload.data === 'object' ? payload.data : {}
  const inner = wrapper.Response && typeof wrapper.Response === 'object' ? wrapper.Response : {}
  const data = inner.Data && typeof inner.Data === 'object' ? inner.Data : {}
  const accounts = Array.isArray(data.Accounts) ? data.Accounts : []
  const summary = summarizeAccounts(accounts, options.nowMs)
  return {
    ok: true,
    // ⚠️ 不要用 `data.TotalDosage` —— 它把月度包的「额度总量」当剩余相加，会偏大。
    //    实测 2026-10-26：TotalDosage=3070，而 WorkBuddy 本体显示 279x。
    //    正确值就是逐包求和（月度包取 CycleCapacityRemain），见 summarizeAccounts。
    remaining: summary.preciseTotal,
    preciseTotal: summary.preciseTotal,
    // 上游那个（偏大的）汇总值单独留着，便于排查"为什么和网页不一样"
    totalDosageRaw: num(data.TotalDosage),
    expiringSoon: summary.expiringSoon,
    ...summary.nearestExpiryMs === undefined ? {} : { nearestExpiryMs: summary.nearestExpiryMs },
    packages: summary.packages,
    packageCount: accounts.length,
    accountId: account.accountId,
    accountName: account.nickname,
    region: account.region,
    tokenExpiresAtMs: account.expiresAtMs,
    readAtMs: Date.now(),
  }
}

// ── 与 whale-widget 的对接 ───────────────────────────────────────────────────

/** 候选注册表路径：与 whale-widget 的 API_FILE_CANDIDATES 同序。 */
function registryCandidates(home = DSH_HOME) {
  return [
    path.join(home, REGISTRY_FILENAME),
    path.join(home, 'profiles', 'web', REGISTRY_FILENAME),
  ]
}

/** 找到实际使用的注册表路径（优先已存在的；都没有就用 $DSH_HOME 那份）。 */
function resolveRegistryPath(home = DSH_HOME) {
  for (const p of registryCandidates(home)) {
    if (fs.existsSync(p)) return p
  }
  return registryCandidates(home)[0]
}

/** 找到 whale-widget 的安装目录（用于判断它是否已带原生 workbuddy 模板）。 */
function findWhaleWidget(home = DSH_HOME) {
  const bases = [
    path.join(home, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget'),
    path.join(home, 'profiles', 'web', 'node_modules', 'dsh-whale-widget'),
  ]
  for (const dir of bases) {
    if (fs.existsSync(path.join(dir, 'lib', 'index.js'))) return dir
  }
  return undefined
}

/**
 * whale-widget 是否已带原生 `workbuddy` 模板。
 *
 * 有原生模板时用它更干净：不需要凭据、不需要 allowCustomHost、还能显示「即将过期」。
 * 没有时退回「自定义 HTTP」模式（token 由本插件写进 DSH 凭据）。
 * 判定方式是读源码文本找 `kind: 'workbuddy'` —— 粗但有效，且插件升级/打补丁后自动跟随。
 */
function hasNativeTemplate(pkgDir) {
  if (!pkgDir) return false
  try {
    const text = fs.readFileSync(path.join(pkgDir, 'lib', 'index.js'), 'utf8')
    return text.includes("kind: 'workbuddy'")
  } catch {
    return false
  }
}

/**
 * 生成要写进注册表的模型条目。
 *
 * 两种模式：
 *   · `native` —— whale-widget 有原生模板，条目极简（provider: 'workbuddy'）
 *   · `custom` —— 退回自定义 HTTP 模板：POST + body + `data.Response.Data.TotalDosage`
 */
function buildModelEntry(mode, id = MODEL_ID) {
  const base = {
    id,
    name: 'WorkBuddy 积分',
    currency: 'CREDITS',
    matchIds: [],
  }
  if (mode === 'native') {
    // ⚠️ keyRef 必须指向**真实存在**的 DSH 凭据。
    //
    // 踩过的坑：这里曾写成 `'WORKBUDDY_VAULT'`（一个不存在、也无法写入的名字，
    // 只是为了绕过 host 对 keyRef 格式的校验）。后果是 whale-widget 的
    // `ctx.credentials.resolve('WORKBUDDY_VAULT')` 永远返回空 ⇒ `hasKey = false`
    // ⇒ 侧栏余额显示「—」（一条横线），但错误提示又是空的，很难查。
    //
    // 正确做法：复用本插件自己写入的 `WORKBUDDY_ACCESS_TOKEN`（见 apply() 里
    // ctx.credentials.set），token 由插件从 workbuddy-vault 读出来同步进去。
    return { ...base, provider: 'workbuddy', keyRef: CREDENTIAL_REF }
  }
  return {
    ...base,
    provider: 'custom',
    keyRef: CREDENTIAL_REF,
    // 计费网关不在 custom 模板的内置端点里，必须显式放行，否则凭据会被白名单拦下
    allowCustomHost: true,
    balance: {
      url: CN_BILLING_BASE + CREDITS_PATH,
      auth: 'Authorization:Bearer {key}',
      method: 'POST',
      body: JSON.stringify({ PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3] }),
      json: { remaining: 'data.Response.Data.TotalDosage' },
    },
  }
}

/**
 * 幂等地把模型条目写进注册表。
 *
 * **必须保留 `usage` 与其它模型**：whale-widget 的余额差账本（今日已用）就存在这个文件的
 * `usage` 段里，整份覆盖会把它清空。所以这里是「读-改-写」，且只在内容真的变了时才落盘，
 * 把与 whale-widget 并发写的机会压到最小。
 */
export function syncRegistry(home = DSH_HOME, mode = 'custom', log = () => {}) {
  const file = resolveRegistryPath(home)
  const current = readJson(file) || { version: 1, models: [], usage: {} }
  if (!Array.isArray(current.models)) current.models = []
  if (!current.usage || typeof current.usage !== 'object') current.usage = {}

  // **有就接管，没有就新增**（两条路径都要，缺一不可）：
  //
  //   · 新用户（绝大多数）：注册表里没有任何 WorkBuddy 条目 → `index === -1` → 新增一条。
  //     这是插件的主要价值：装完重启，「WorkBuddy 积分」直接出现在挂件里，接口/字段路径/
  //     凭据/allowCustomHost 全自动配好，用户不需要知道计费网关长什么样。
  //   · 老用户（已手工建过）：实测就发生过 —— 面板生成的 `api_xxxxxxxx_xxxxx`，
  //     账本已经记了几十积分。此时若再插一条固定 id 的条目，界面上会冒出两个
  //     「WorkBuddy 积分」，且旧那条的 `usage` 账本成为孤儿（今日已用归零）。
  //     所以先按「provider 属于本插件管辖」认领，认领到就原地更新、保留 id 与账本。
  //
  // 认领判据从宽到窄：固定 id → provider === 'workbuddy' → balance.url 指向计费网关
  // （用户可能手工配过一模一样的 custom 条目）。
  const isOurs = (m) => {
    if (!m || typeof m !== 'object') return false
    if (m.id === MODEL_ID) return true
    if (m.provider === 'workbuddy') return true
    // custom 模式下认领「指向计费网关」的条目（用户可能手工配过一模一样的）
    const url = m.balance && typeof m.balance.url === 'string' ? m.balance.url : ''
    return url.includes('/v2/billing/meter/get-user-resource')
  }
  const index = current.models.findIndex(isOurs)
  const existing = index === -1 ? undefined : current.models[index]
  const id = existing && existing.id ? existing.id : MODEL_ID
  // createdAt 必须**两次都取到同一个值**，否则每轮 tick 都会"变化"一次、把文件重写一遍
  // （第一次实现踩过：新增时没写 createdAt，第二次却补了一个 ⇒ 幂等测试恒为 false）。
  const createdAt = existing && existing.createdAt ? existing.createdAt : Date.now()
  const wanted = { ...buildModelEntry(mode, id), createdAt }
  if (index === -1) {
    current.models.push(wanted)
  } else {
    // 保留原 id 与 createdAt，其余按当前模式重写（模板/模式可能变过）
    current.models[index] = wanted
  }
  const next = JSON.stringify(current, null, 2)
  const prevText = (() => {
    try { return fs.readFileSync(file, 'utf8') } catch { return '' }
  })()
  if (prevText === next) return { changed: false, file, mode, id }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    writeFileAtomic(file, next)
    log(`注册表已更新（${mode} 模式，条目 ${id}）：${file}`)
    return { changed: true, file, mode, id }
  } catch (error) {
    return { changed: false, file, mode, id, error: String((error && error.message) || error) }
  }
}

/** 写公开快照，供其它记账插件读取。 */
export function writeSnapshot(home = DSH_HOME, payload) {
  const file = path.join(home, SNAPSHOT_FILENAME)
  try {
    writeFileAtomic(file, JSON.stringify(payload, null, 2))
    return { ok: true, file }
  } catch (error) {
    return { ok: false, file, error: String((error && error.message) || error) }
  }
}

// ── 插件本体 ─────────────────────────────────────────────────────────────────

const name = 'dsh-whale-workbuddy-bridge'

/**
 * cordis 插件入口。
 *
 * 刻意**不用对象级 `inject`**：文件类工作（维护注册表、写快照）不依赖任何服务，
 * 早一点跑完就早一点让 whale-widget 取到数；只有写凭据和开路由需要等 `credentials`
 * / `webServer`，那部分放进局部 `inject`。
 */
function apply(root, config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const enabled = cfg.enabled !== false
  if (!enabled) return
  const home = cfg.dshHome || DSH_HOME
  const preferRegion = cfg.region === 'global' ? 'global' : 'cn'
  const intervalMs = Number(cfg.intervalMs) > 0 ? Number(cfg.intervalMs) : DEFAULT_INTERVAL_MS
  const log = (msg) => {
    try { console.log('[whale-workbuddy-bridge] ' + msg) } catch {}
  }

  /** 最近一次成功读数，供 HTTP 路由与凭据同步共用。 */
  let latest = undefined
  let lastToken = ''
  let timer
  /** 只打印一次「首次安装」自述，避免每轮 tick 刷屏。 */
  let announced = false
  /** 每轮积分账本（cfg.turnCredits === false 时关闭）。 */
  const ledger = cfg.turnCredits === false
    ? undefined
    : new TurnCreditLedger({ home, log })
  /** 上次见到的 whale-widget 文件指纹；变了就说明被重装/升级覆盖，需要重打补丁。 */
  let lastPatchFingerprint = ''

  /**
   * 首次安装时在日志里讲清楚「刚发生了什么」。
   *
   * 新用户装完插件、重启，挂件里会**凭空多出一个「WorkBuddy 积分」模型**——
   * 如果没人告诉他这是本插件写的，很容易以为是挂件出了 bug、或者去面板里又手工加一条
   * （那就真的重复了）。所以第一次同步成功时把三件事说明白：条目 id、数据来源、怎么删。
   */
  const announceOnce = (sync, mode) => {
    if (announced) return
    announced = true
    log('已就绪：' + (sync.changed ? '已写入' : '已确认') + '模型条目「WorkBuddy 积分」（id=' + sync.id + '）到 ' + sync.file)
    log('  数据来源：' + (mode === 'native'
      ? 'whale-widget 原生 workbuddy 模板（自己读 vault）'
      : 'custom 模板 + 计费网关，token 存在 DSH 凭据 ' + CREDENTIAL_REF))
    log('  挂件里看到的是自动生成的条目，**不需要再手工添加**；想停用它请移除本插件或设 enabled: false')
  }

  /** 一轮：读 vault → 打上游 → 写快照 → 同步凭据。 */
  const tick = async () => {
    const whale = findWhaleWidget(home)
    const mode = hasNativeTemplate(whale) ? 'native' : 'custom'
    // 注册表：每次 tick 都 sync 一次，幂等且成本极低（内容没变就不落盘）
    try {
      const sync = syncRegistry(home, mode, log)
      announceOnce(sync, mode)
    } catch (error) {
      log('注册表同步失败: ' + String((error && error.message) || error))
    }

    // ── 自动维护 whale-widget 的 {credits} 补丁 ───────────────────────────
    // whale-widget 重装/升级会把补丁覆盖掉，而它的宿主与前端都在自己的闭包里、
    // 外部无法 monkey-patch（见 patch-whale.mjs 顶部说明）。所以这里做两件事：
    //   ① 首次启动时打一次
    //   ② 每次 tick 比对文件 mtime 指纹 —— 变了就说明被覆盖过，自动重打
    // 只做「读 mtime」这个极轻的检查，补丁已就位时零写入。
    if (cfg.turnCredits !== false) {
      try {
        const whalePkg = whale
        if (whalePkg) {
          const fp = patchFingerprint(whalePkg)
          if (fp !== lastPatchFingerprint) {
            lastPatchFingerprint = fp
            const st = patchState(whalePkg)
            if (!st.host || !st.client) {
              const r = applyTurnCreditsPatch({ pkg: whalePkg, log })
              if (r.ok && r.changed) {
                log(r.needsRestart
                  ? '已自动补上 whale-widget 的 {credits} 补丁 —— 需要重启 DSH 生效'
                  : '已自动补上 whale-widget 的 {credits} 前端补丁 —— 刷新页面即可')
              } else if (!r.ok) {
                log('自动打补丁失败（不影响余额显示）: ' + r.error)
              }
            }
          }
        }
      } catch (error) {
        // 补丁是附加能力，失败绝不影响余额
        log('补丁维护出错（不影响余额显示）: ' + String((error && error.message) || error))
      }
    }

    const result = await fetchWorkBuddyCredits({ home, region: preferRegion })
    latest = { ...result, mode, checkedAtMs: Date.now() }

    writeSnapshot(home, {
      version: 1,
      source: 'dsh-whale-workbuddy-bridge',
      mode,
      ...result,
    })

    // 每轮积分由 turn/end 事件**同步**定稿（按 token 费率换算），不在这里对账。
    //
    // 为什么不用余额差做逐轮归因：余额差是**账号维度**的今日总消耗，
    // 会把同一账号其它客户端（WorkBuddy 本体、别的 DSH 窗口、厂商定时任务）
    // 的消耗一并算进来，回答不了「本机这一轮花了多少」。
    // （注意：这不代表余额差"不可用" —— 对"今日一共花了多少"它反而是正确口径，
    //   whale-widget 的 {expense_ds} 就沿用它。）

    // custom 模式才需要把 token 塞进凭据（native 模式由 whale-widget 自己读 vault）
    if (mode === 'custom' && result.ok) {
      const accounts = listVaultAccounts(home)
      const account = pickAccount(accounts, preferRegion)
      if (account && account.accessToken && account.accessToken !== lastToken) {
        lastToken = account.accessToken
        try {
          const credentials = root.get ? root.get('credentials') : undefined
          if (credentials && typeof credentials.set === 'function') {
            await credentials.set(CREDENTIAL_REF, account.accessToken)
            log('已把 WorkBuddy token 写入 DSH 凭据 ' + CREDENTIAL_REF)
          }
        } catch (error) {
          log('写凭据失败: ' + String((error && error.message) || error))
        }
      }
    }
  }

  /**
   * 这次请求是否「按积分计费」（WorkBuddy / CodeBuddy）。
   *
   * 首选 `source.provider`（DSH 的权威字段），它比模型名可靠：
   * WorkBuddy 的模型名是 `GLM-5.3 · x0.79` 这种，不含厂商字样。
   * provider 缺失时退回模型名启发式，判不出来就算「不是」——
   * 宁可漏算，也不要把 DeepSeek 直连的 token 当积分算进去。
   */
  const isCreditProvider = (provider, model) => {
    const pv = String(provider || '').toLowerCase()
    if (pv === 'workbuddy' || pv === 'codebuddy') return true
    // 明确是别的厂商 ⇒ 直接否掉，别让名字启发式捞回来
    if (pv && pv !== 'custom') return false
    const m = String(model || '').toLowerCase()
    if (!m) return false
    if (m.indexOf('workbuddy') !== -1 || m.indexOf('codebuddy') !== -1) return true
    // WorkBuddy 选择器的 `· x0.79` 倍率后缀
    if (/\s[·・]\s*x\s*[0-9]*\.?[0-9]+\s*$/.test(m)) return true
    // 注册表里显式登记的 matchIds
    try {
      const reg = readJson(resolveRegistryPath(home))
      const entry = reg && Array.isArray(reg.models)
        ? reg.models.find((x) => x && (x.provider === 'workbuddy' || x.id === MODEL_ID))
        : undefined
      const ids = entry && Array.isArray(entry.matchIds) ? entry.matchIds : []
      return ids.some((id) => id && m.indexOf(String(id).toLowerCase()) !== -1)
    } catch { return false }
  }

  // 启动即跑一轮，然后按间隔轮询
  tick().catch((error) => log('首轮失败: ' + String((error && error.message) || error)))
  timer = setInterval(() => {
    tick().catch((error) => log('轮询失败: ' + String((error && error.message) || error)))
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  root.effect(() => () => {
    try { clearInterval(timer) } catch {}
  })

  /**
   * 订阅会话事件，按轮累计 WorkBuddy 的 token 用量并换算成积分。
   *
   * 判据用 `source.provider`（DSH 的权威字段，见 dsh-agent-loop：
   * `source: { provider: request.provider, model: request.model }`），
   * 而 dsh-connect-workbuddy 把 provider 恒定为 `workbuddy`。
   * **不能只靠模型名** —— WorkBuddy 的真实模型名是 `GLM-5.3 · x0.79` 这种，
   * 压根不含 workbuddy 字样。
   *
   * 其它厂商（DeepSeek 直连等）不消耗积分，必须排除，否则「本轮积分」会虚高。
   */
  if (ledger) {
    // 防御：老宿主 / 测试替身可能没有 `on`。没有事件源时整块功能静默跳过，
    // 绝不能让「每轮积分」这个附加能力把整个插件（余额显示）带崩。
    if (typeof root.on !== 'function') {
      log('宿主没有 root.on，跳过每轮积分跟踪（余额显示不受影响）')
    } else {
      const turnAggs = new Map()
      const dispose = root.on('session/event', (session, event) => {
        try {
          const type = event && event.type
          const d = event && event.data
          if (!d || typeof d !== 'object') return
          const sid = session && session.id ? session.id : 'default'

          if (type === 'turn/end') {
            const agg = turnAggs.get(sid)
            turnAggs.delete(sid)
            if (!agg) return
            // 把本轮的时间窗口和账单凭据交给账本 —— 账本会去查**官方逐请求账单**
            // 拿真实积分（比 token 估算准几个数量级）。查不到才退回估算。
            const acct = listVaultAccounts(home)
            const picked = pickAccount(acct, preferRegion)
            ledger.onTurnEnd({
              turn: agg.turn,
              sessionId: sid,
              byModel: agg.byModel,
              startMs: agg.startMs,
              endMs: Date.now(),
              billing: picked && picked.accessToken
                ? {
                    baseUrl: picked.region === 'global' ? GLOBAL_BILLING_BASE : CN_BILLING_BASE,
                    token: picked.accessToken,
                    domain: picked.domain,
                    uid: picked.uid,
                  }
                : undefined,
            }).catch((err) => log('每轮积分定稿失败: ' + String((err && err.message) || err)))
            return
          }

          if (type !== 'assistant/message') return
          const turn = Number(d.turn)
          const usage = d.usage
          if (!usage || typeof usage !== 'object' || !Number.isFinite(turn)) return
          const src = d.message && d.message.source ? d.message.source : {}
          if (!isCreditProvider(src.provider, src.model)) return

          let agg = turnAggs.get(sid)
          if (!agg || agg.turn !== turn) {
            agg = { turn, byModel: {}, startMs: Date.now() }
            turnAggs.set(sid, agg)
          }
          const key = src.model || '(unknown)'
          const u = agg.byModel[key] || { hit: 0, miss: 0, out: 0 }
          u.hit += Number(usage.cacheReadTokens) || 0
          u.miss += Number(usage.inputTokens) || 0
          u.out += Number(usage.outputTokens) || 0
          agg.byModel[key] = u
        } catch (error) {
          log('会话事件处理失败: ' + String((error && error.message) || error))
        }
      })
      root.effect(() => () => {
        try { dispose() } catch {}
      })
    }
  }

  // 只读路由：给其它记账插件/调试用
  root.inject(['webServer'], (ctx) => {
    const json = (res, code, body) => {
      try {
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify(body))
      } catch {}
    }
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-workbuddy-bridge/credits.json',
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (!latest) return json(res, 503, { error: 'not ready' })
        // 不返回 token/uid/uin —— 只给读数
        const { accountId, ...safe } = latest
        return json(res, 200, safe)
      },
    }))

    /**
     * 每轮积分消耗路由 —— 补上 whale-widget 在 WorkBuddy 上算不出来的那个数。
     *
     * whale-widget 自己的 `/dsh-whale/last-turn.json` 对 WorkBuddy 永远是
     * `amount: 0`（因为 connect 插件给 DSH 报的 cost 是 NO_COST），所以它的
     * 「本轮消耗」气泡不会弹。这个路由给出同一语义的**积分版**：
     * 单位是积分、不是人民币，并且带 `source` 说明是精确余额差还是 token 估算。
     */
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-workbuddy-bridge/last-turn.json',
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        if (!ledger) return json(res, 200, { ok: false, disabled: true, error: 'turnCredits 已关闭' })
        return json(res, 200, ledger.snapshot())
      },
    }))

    /**
     * 自检路由：把「插件看到了什么」讲清楚，方便用户排查「为什么侧栏没数」。
     *
     * 三类常见故障在这里能一眼分辨，而不用去翻日志：
     *   · 没装 / 没登录 connect 插件 → vault 为空
     *   · token 过期 → vault 有账号但上游 401
     *   · whale-widget 没装 / 没读到注册表 → registry.found === false
     */
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: '/dsh-workbuddy-bridge/status.json',
      handler: (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        const vault = listVaultAccounts(home)
        const whale = findWhaleWidget(home)
        const registryFile = resolveRegistryPath(home)
        const registry = readJson(registryFile)
        const entry = registry && Array.isArray(registry.models)
          ? registry.models.find((m) => m && (m.id === MODEL_ID || m.provider === 'workbuddy'))
          : undefined
        return json(res, 200, {
          plugin: { name, mode: latest && latest.mode ? latest.mode : undefined, intervalMs },
          vault: {
            // 只报数量与区域，不报 token / uin / 昵称
            accountCount: vault.length,
            regions: [...new Set(vault.map((a) => a.region))],
            nearestTokenExpiryMs: vault.length ? Math.min(...vault.map((a) => a.expiresAtMs || Infinity)) : undefined,
          },
          upstream: latest
            ? {
                ok: latest.ok,
                ...latest.ok ? {} : { code: latest.code, error: latest.error },
                checkedAtMs: latest.checkedAtMs,
              }
            : { ok: false, error: '尚未完成首轮读取' },
          whaleWidget: {
            installed: !!whale,
            nativeTemplate: hasNativeTemplate(whale),
          },
          registry: {
            file: registryFile,
            exists: fs.existsSync(registryFile),
            found: !!entry,
            entryId: entry && entry.id,
            provider: entry && entry.provider,
          },
          hints: [
            vault.length === 0 ? '本机没有 WorkBuddy 登录态：装好 dsh-connect-workbuddy 并在卡片里登录一次' : null,
            latest && !latest.ok && latest.code === 'TOKEN_EXPIRED' ? 'token 已过期：打开一次 WorkBuddy 卡片让它自动续期' : null,
            !whale ? '没找到 dsh-whale-widget：本插件只负责喂数据，需要它来显示' : null,
            entry && entry.provider === 'custom' ? '当前是 custom 模式（whale-widget 无原生模板），token 存在 DSH 凭据 ' + CREDENTIAL_REF : null,
          ].filter(Boolean),
        })
      },
    }))
  })
}

export { apply, name, buildModelEntry, resolveRegistryPath }
export default { apply, name }
