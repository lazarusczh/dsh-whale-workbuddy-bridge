// 给 dsh-whale-widget 打「每轮积分」补丁 —— 由桥接插件在启动时自动调用。
//
// 为什么补丁必须存在（而不是全放进桥接插件）：
//
//   · 宿主侧：`finalizeTurn` 的准入条件是 `agg.cost > 0`，而 WorkBuddy 这一路
//     dsh-connect-workbuddy 报的是 `cost: NO_COST`（恒 0），所以整个分支根本不进，
//     气泡永远不弹。**这个判断在 whale-widget 自己的闭包里**，外部无法影响。
//   · 前端侧：`whale-widget.js` 是一个 `(function(){ ... })()` 的 IIFE，
//     只往 window 上挂了一个防重复的 `__dshWhaleWidget` 布尔值，
//     没有任何导出/钩子 ⇒ 运行时 monkey-patch 不可能。
//
// 所以只能改文件。但**不必让用户手工跑脚本**：桥接插件启动时自动打，幂等，
// 且每次 tick 检查 mtime —— whale-widget 被重装/升级覆盖后会自动重打。
//
// 幂等判据用**内容特征**而不是标记注释：最早这补丁是手工打的（没有标记），
// 只认标记会在已打好的机器上误报「未打」并重复插入。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const PKG_CANDIDATES = [
  path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget'),
  path.join(DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-whale-widget'),
]

const MARK = {
  rates: '// >>> whale-workbuddy-bridge: credit rates >>>',
  ratesEnd: '// <<< whale-workbuddy-bridge: credit rates <<<',
  usage: '// >>> whale-workbuddy-bridge: byModelUsage >>>',
  usageEnd: '// <<< whale-workbuddy-bridge: byModelUsage <<<',
  fill: '// >>> whale-workbuddy-bridge: credits placeholder >>>',
  fillEnd: '// <<< whale-workbuddy-bridge: credits placeholder <<<',
}

/** 找到已安装的 whale-widget 目录。 */
export function findWhaleWidget() {
  for (const p of PKG_CANDIDATES) {
    if (fs.existsSync(path.join(p, 'lib', 'index.js'))) return p
  }
  return undefined
}

/** 补丁是否已打（内容特征）。 */
export function patchState(pkg) {
  const host = path.join(pkg, 'lib', 'index.js')
  const client = path.join(pkg, 'assets', 'whale-widget.js')
  let hostText = ''
  let clientText = ''
  try { hostText = fs.readFileSync(host, 'utf8') } catch { return { host: false, client: false } }
  try { clientText = fs.readFileSync(client, 'utf8') } catch {}
  return {
    host: hostText.includes('const CREDIT_MISS_RATE')
      && hostText.includes('function creditsOfAgg')
      && hostText.includes('credits: lastTurn.credits === undefined ? null : lastTurn.credits'),
    client: clientText.includes('function usageFillText(txt, below, amount, cost, session, credits)')
      && clientText.includes('bubbleRenderCostMods(item.amount, item.credits)'),
  }
}

// ── 宿主补丁 ────────────────────────────────────────────────────────────────

const RATES_BLOCK = `${MARK.rates}
    // 积分费率：从 6 组真机样本反解（样本表见 whale-workbuddy-bridge 的 README）。
    // 要点是 cache_hit 便宜约 4.1 倍，必须和 cache_miss 分开算 ——
    // 第一版把 1088 个 cache_hit 按 miss 价算，得 0.18 而真值 0.05，错了 3.6 倍。
    const CREDIT_MISS_RATE = 1.6057e-4
    const CREDIT_HIT_RATE = 3.8725e-5
    const CREDIT_OUT_RATE = 0
    /** 模型名尾部的 \`· x0.79\` 是上游积分倍率；费率在 x1 上标定，要乘上去。 */
    function creditMultiplierOf(modelName) {
      const m = /x\\s*([0-9]*\\.?[0-9]+)\\s*$/i.exec(String(modelName || ''))
      if (!m) return 1
      const v = Number(m[1])
      return Number.isFinite(v) && v > 0 ? v : 1
    }
    /**
     * 这个模型是否「按积分计费」（WorkBuddy / CodeBuddy）。
     * 首选 source.provider（DSH 权威字段，见 dsh-agent-loop 的 source:{provider,model}），
     * 模型名只作兜底 —— WorkBuddy 的真实模型名是 \`GLM-5.3 · x0.79\`，不含厂商字样。
     */
    function isCreditModel(modelName, provider) {
      try {
        const pv = String(provider || '').toLowerCase()
        if (pv === 'workbuddy' || pv === 'codebuddy') return true
        if (pv && pv !== 'custom') return false
        const name = String(modelName || '').toLowerCase()
        if (!name) return false
        if (name.indexOf('workbuddy') >= 0 || name.indexOf('codebuddy') >= 0) return true
        if (/\\s[·・]\\s*x\\s*[0-9]*\\.?[0-9]+\\s*$/.test(name)) return true
        const reg = readApiRegistry()
        for (const m of reg.models) {
          if (!m || !m.id) continue
          if (m.provider !== 'workbuddy' && m.id !== 'api_workbuddy_credits') continue
          const ids = Array.isArray(m.matchIds) && m.matchIds.length ? m.matchIds : [m.name, m.id]
          for (const s of ids) {
            const k = String(s || '').toLowerCase().trim()
            if (k && name.indexOf(k) >= 0) return true
          }
        }
      } catch (err) {}
      return false
    }
    /** 把一轮的 token 用量换算成积分。 */
    function creditsOfAgg(agg) {
      try {
        const usage = agg && agg.byModelUsage
        if (!usage || typeof usage !== 'object') return 0
        let total = 0
        for (const name of Object.keys(usage)) {
          const u = usage[name] || {}
          if (!isCreditModel(name, u.provider)) continue
          total += ((Number(u.hit) || 0) * CREDIT_HIT_RATE
            + (Number(u.miss) || 0) * CREDIT_MISS_RATE
            + (Number(u.out) || 0) * CREDIT_OUT_RATE) * creditMultiplierOf(name)
        }
        return Math.round(total * 100) / 100
      } catch (err) { return 0 }
    }
${MARK.ratesEnd}`

const USAGE_BLOCK = `${MARK.usage}
          // 积分换算用的三元组：DSH 的 inputTokens 不含缓存命中，命中数在 cacheReadTokens
          const u = agg.byModelUsage[model] || { hit: 0, miss: 0, out: 0, provider: '' }
          u.hit += cache
          u.miss += input
          u.out += outputBilled
          if (provider) u.provider = provider
          agg.byModelUsage[model] = u
${MARK.usageEnd}`

function patchHost(text) {
  let out = text

  // ① 费率与换算函数
  if (!out.includes('const CREDIT_MISS_RATE')) {
    const anchor = 'lastTurnSeq = readTurnSeq()\n'
    if (!out.includes(anchor)) throw new Error('找不到锚点 lastTurnSeq = readTurnSeq()')
    out = out.replace(anchor, anchor + '\n' + RATES_BLOCK + '\n')
  }

  // ② finalizeTurn 的准入：cost > 0 → (cost > 0 || credits > 0)
  //
  // 判据用「准入条件已放宽」这个**结果**，而不是某一行的具体写法 ——
  // 后续把 `const credits = ...` 改成带 realCredits 的版本后，原来那行就不在了。
  if (!out.includes('agg.cost > 0 || credits > 0')) {
    const re = /(    function finalizeTurn\(sessionId\) \{\n      const agg = turnAggs\.get\(sessionId\)\n)((?:      \/\/[^\n]*\n)*)(      if \(agg && agg\.cost > 0\) \{\n)/
    if (!re.test(out)) throw new Error('找不到 finalizeTurn 准入锚点')
    out = out.replace(re, (m, head, comments, tail) =>
      head
      + comments
      + '      // WorkBuddy 的 cost 恒为 0（connect 插件报 NO_COST），原条件 cost > 0 会让\n'
      + '      // 整个分支不进、气泡永不弹。这里补一条「按积分算出来 > 0」的准入。\n'
      + '      const credits = agg ? creditsOfAgg(agg) : 0\n'
      + '      if (agg && (agg.cost > 0 || credits > 0)) {\n')
  }

  // ③ 聚合里记录 byModelUsage（含 provider）
  if (!out.includes('agg.byModelUsage[model] = u')) {
    const anchor = '          agg.byModelTokens[model] = (agg.byModelTokens[model] || 0) + toks\n'
    if (!out.includes(anchor)) throw new Error('找不到 byModelTokens 锚点')
    out = out.replace(anchor, anchor + USAGE_BLOCK + '\n')
    out = out.replace(
      'agg = { turn, cost: 0, tokens: 0, byModel: {}, byModelTokens: {}, lastTs: Date.now() }',
      'agg = { turn, cost: 0, tokens: 0, byModel: {}, byModelTokens: {}, byModelUsage: {}, lastTs: Date.now() }')
    out = out.replace(
      "        const model = d.message && d.message.source ? d.message.source.model : ''\n",
      "        const src = d.message && d.message.source ? d.message.source : {}\n        const model = src.model || ''\n        const provider = src.provider || ''\n")
  }

  // ④ last-turn.json 带上 credits
  if (!out.includes('credits: lastTurn.credits === undefined ? null : lastTurn.credits')) {
    const anchor = 'const payload = lastTurn\n          ? { ok: true, seq: lastTurnSeq, turn: lastTurn.turn, amount: lastTurn.amount, tokens: lastTurn.tokens, ts: lastTurn.ts }'
    if (!out.includes(anchor)) throw new Error('找不到 last-turn payload 锚点')
    out = out.replace(anchor,
      'const payload = lastTurn\n          ? { ok: true, seq: lastTurnSeq, turn: lastTurn.turn, amount: lastTurn.amount, tokens: lastTurn.tokens, ts: lastTurn.ts, credits: lastTurn.credits === undefined ? null : lastTurn.credits }')
    out = out.replace(
      ': { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null }',
      ': { ok: true, seq: 0, turn: null, amount: null, tokens: null, ts: null, credits: null }')
    out = out.replace(
      'lastTurn = { turn: agg.turn, amount: agg.cost, tokens: agg.tokens, ts: agg.lastTs }',
      'lastTurn = { turn: agg.turn, amount: agg.cost, tokens: agg.tokens, ts: agg.lastTs, ...credits > 0 ? { credits } : {} }')
  }

  return out
}

// ── 前端补丁 ────────────────────────────────────────────────────────────────

function patchClient(text) {
  let out = text

  /** 只在「旧串还在、新串还没出现」时替换，保证幂等。 */
  const swap = (oldStr, newStr) => {
    if (out.includes(newStr)) return
    if (!out.includes(oldStr)) return
    out = out.replace(oldStr, newStr)
  }

  // ① usageFillText 增加 credits 参数与 {credits} 替换
  if (!out.includes('function usageFillText(txt, below, amount, cost, session, credits)')) {
    const old = `function usageFillText(txt, below, amount, cost, session) {
  return String(txt || '')
    .replace(/\\{below\\}/g, below != null ? String(below) : '')
    .replace(/\\{amount\\}/g, amount != null ? String(amount) : '')
    .replace(/\\{cost\\}/g, cost != null ? String(cost) : '')`
    if (!out.includes(old)) throw new Error('找不到 usageFillText 锚点')
    out = out.replace(old, `${MARK.fill}
function usageFillText(txt, below, amount, cost, session, credits) {
  return String(txt || '')
    .replace(/\\{below\\}/g, below != null ? String(below) : '')
    .replace(/\\{amount\\}/g, amount != null ? String(amount) : '')
    .replace(/\\{cost\\}/g, cost != null ? String(cost) : '')
    .replace(/\\{credits\\}/g, credits != null ? String(credits) : '')
${MARK.fillEnd}`)
  }

  // ② 逐层透传 credits
  swap('function usageAlertModsResolved(mods, below, amount, cost, session) {',
    'function usageAlertModsResolved(mods, below, amount, cost, session, credits) {')
  swap('cp.text = raw.length ? usageFillText(raw, below, amount, cost, session) : raw',
    'cp.text = raw.length ? usageFillText(raw, below, amount, cost, session, credits) : raw')
  swap(`function bubbleRenderCostMods(amount) {
  bubbleRenderModules(usageAlertModsResolved(usageTurnCostLines(), null, null, usageCostValue(amount)))
}`,
    `function bubbleRenderCostMods(amount, credits) {
  bubbleRenderModules(usageAlertModsResolved(
    usageTurnCostLines(), null, null,
    usageCostValue(amount),
    null,
    credits == null ? null : usageCostValue(credits)
  ))
}`)
  swap('function showCostBubble(amount) {', 'function showCostBubble(amount, credits) {')
  swap("whaleSysPush({ kind: 'cost', amount: amount, frameId: sysFrameIdOf('cost'), rank: 3 })",
    "whaleSysPush({ kind: 'cost', amount: amount, credits: credits, frameId: sysFrameIdOf('cost'), rank: 3 })")
  swap("sceneOpen('cost', function () { bubbleRenderCostMods(item.amount) }, turnCostCloseMs > 0 ? turnCostCloseMs : 0)",
    "sceneOpen('cost', function () { bubbleRenderCostMods(item.amount, item.credits) }, turnCostCloseMs > 0 ? turnCostCloseMs : 0)")

  // ③ 轮询读取 d.credits，并允许「amount 为 0 但积分 > 0」的轮次也弹
  if (!out.includes('var cr = (typeof d.credits')) {
    swap("        if (!d || !d.ok || typeof d.seq !== 'number') return\n",
      "        if (!d || !d.ok || typeof d.seq !== 'number') return\n        var cr = (typeof d.credits === 'number') ? d.credits : undefined\n")
  }
  swap('if (d.turn !== null && d.amount !== null) {\n              showCostBubble(Number(d.amount))\n            }',
    'if (d.turn !== null && (d.amount !== null || cr !== undefined)) {\n              showCostBubble(Number(d.amount), cr)\n            }')
  swap('if (d.turn !== null && d.amount !== null) {\n            showCostBubble(Number(d.amount))\n          }',
    'if (d.turn !== null && (d.amount !== null || cr !== undefined)) {\n            showCostBubble(Number(d.amount), cr)\n          }')

  // ④ 面板提示里说明 {credits}（只加一次）
  if (!out.includes('{credits} = 本轮消耗的')) {
    swap(
      "? '<div style=\"margin-top:4px\">{cost} 在触发时替换为本轮消耗金额(默认内容请保持 {cost})</div>'",
      "? '<div style=\"margin-top:4px\">{cost} 在触发时替换为本轮消耗金额(默认内容请保持 {cost})</div>'"
      + " + '<div style=\"margin-top:4px;opacity:.85\">{credits} = 本轮消耗的<b>积分</b>（WorkBuddy / CodeBuddy 这类按积分计费的模型）；想显示积分就写 <code>本轮 {credits} 积分</code>。非积分模型的轮次里它替换成空串</div>'")
  }

  // ⑤ 今日已用的两个补充占位符（只加一次）
  //
  //   {expense_src}   = 今日已用的来源标注（余额差记账 / 本地估算）
  //   {credits_today} = **本机维度**的今日积分累计
  //
  // 为什么需要 {credits_today}：whale-widget 的 {expense_ds} 走余额差账本，
  // 那是**账号维度**的今日总消耗 —— 会含 WorkBuddy 本体、别的设备、探活的消耗。
  // 用户看到「今日已用 364」但只在本机聊了几轮时会以为记账坏了。
  // 给出本机维度的数，两者一对比就知道差额花在别处了。
  if (!out.includes('state.creditToday = d.today.credits')) {
    // 5a. 轮询里保存宿主给出的本机今日累计。
    //     锚点只用 `var cr = ...` 这一行本身，不假设它紧邻哪一行 ——
    //     真实文件里它下面还跟着注释，拼多行锚点会匹配不上（踩过）。
    // 5a. 轮询里保存宿主给出的本机今日累计。
    //     锚点只用 `var cr = ...` 这一行本身，不假设它紧邻哪一行 ——
    //     真实文件里它下面还跟着注释，拼多行锚点会匹配不上（踩过）。
    //     若目标文件里还没有 `var cr`（更老的原版），退回到 `typeof d.seq` 那行。
    if (!out.includes('state.creditToday = d.today.credits')) {
      const CREDIT_TODAY_READ = "        // 本机维度的今日累计（宿主逐轮账本给出），供 {credits_today} 使用\n"
        + "        if (d.today && typeof d.today.credits === 'number') {\n"
        + "          state.creditToday = d.today.credits\n"
        + "          state.creditTodayTurns = Number(d.today.turns) || 0\n"
        + "        }\n"
      if (out.includes("        var cr = (typeof d.credits === 'number') ? d.credits : undefined\n")) {
        swap("        var cr = (typeof d.credits === 'number') ? d.credits : undefined\n",
          "        var cr = (typeof d.credits === 'number') ? d.credits : undefined\n" + CREDIT_TODAY_READ)
      } else {
        swap("        if (!d || !d.ok || typeof d.seq !== 'number') return\n",
          "        if (!d || !d.ok || typeof d.seq !== 'number') return\n" + CREDIT_TODAY_READ)
      }
    }

    // 5a2. state 里加初始值（否则首次渲染拿到 undefined，会显示 '--'）
    if (!out.includes('creditToday: null')) {
      swap("  todayUsage: null,\n  todayUsageCurrency: 'CNY',",
        "  todayUsage: null,\n  todayUsageCurrency: 'CNY',\n"
        + '  // 本机维度的今日积分累计（{credits_today}），由宿主 last-turn.json 下发\n'
        + '  creditToday: null,\n'
        + '  creditTodayTurns: 0,')
    }

    // 5b. 占位符映射
    swap("    map['expense_ds'] = map['today']\n",
      "    map['expense_ds'] = map['today']\n"
      + "    // {expense_src} 标注今日已用的来源；{credits_today} 是本机维度累计\n"
      + "    map['expense_src'] = apiModelTodaySourceText(m.modelId)\n"
      + "    map['credits_today'] = (state.creditToday !== null && state.creditToday !== undefined)\n"
      + "      ? apiFmtMoney(state.creditToday, 'CREDITS')\n"
      + "      : '--'\n")

    // 5c. 来源标注函数
    swap("function apiModelTodayText(modelId) {",
      "// 今日已用的来源标注（{expense_src}）：余额差口径是账号维度的，标出来避免误会\n"
      + "function apiModelTodaySourceText(modelId) {\n"
      + "  var m = apiModelById(modelId)\n"
      + "  if (!m) return ''\n"
      + "  return apiUsageSourceLabel(m.usageSource) || ''\n"
      + "}\n"
      + "function apiModelTodayText(modelId) {")

    // 5c2. **全局分支**也要能替换 {credits_today}。
    //
    // 为什么必须有这一步：上面的 5b 只把 credits_today 加进「绑定了模型」的分支。
    // 未绑定模型的模块（走全局/DeepSeek 默认那条）map 里没有这个 key，
    // 而 bubbleContentText 只替换 map 中存在的 key ⇒ 占位符**原样显示**。
    swap(`  } else {
    v = bubblePeakText(m)
    map['status'] = v
  }
  return map
}`,
      `  } else {
    v = bubblePeakText(m)
    map['status'] = v
  }
  // 这两个占位符与模块类型无关，全局分支也补一份（模型分支已算过则不覆盖）
  if (map['credits_today'] === undefined) {
    map['credits_today'] = (state.creditToday !== null && state.creditToday !== undefined)
      ? apiFmtMoney(state.creditToday, 'CREDITS')
      : '--'
  }
  if (map['expense_src'] === undefined) map['expense_src'] = ''
  return map
}`)

    // 5d. 面板帮助
    swap("  else if (m.type === 'today') add('expense_ds', '今日已用金额')",
      "  else if (m.type === 'today') {\n"
      + "    add('expense_ds', '今日已用金额')\n"
      + "    add('expense_src', '今日已用的数据来源（余额差 / 本地估算）。余额差是账号维度的，会含别的设备与探活的消耗')\n"
      + "    add('credits_today', '本机今日积分累计（只算这台机器上发生的对话）。与 {expense_ds} 的差额就是今天在别处花的')\n"
      + "  }")
  }

  // ⑥ 积分单位显示为 Cr.
  //
  // `2763.48 CREDITS` 太长，气泡/侧栏宽度有限。`Cr.` 是 credit 的通行缩写。
  // 只改**显示**：数据层的 currency 仍是 'CREDITS'（注册表、apiTodayCur 的币种
  // 判断都依赖它），所以这里加一层别名映射而不是改数据。
  //
  // 拆成三个独立步骤，各自幂等 —— 因为 whale-widget 升级后可能只有某一处被覆盖，
  // 整块匹配会一荣俱荣、一损俱损。
  if (!out.includes('CURRENCY_LABELS')) {
    swap('function apiFmtMoney(v, cur) {',
      '// 币种代码 → 界面短标签（只影响显示，数据层仍用 CREDITS）\n'
      + "var CURRENCY_LABELS = { CREDITS: 'Cr.' }\n"
      + 'function apiCurrencyLabel(cur) {\n'
      + "  var c = String(cur || '')\n"
      + '  return CURRENCY_LABELS[c] || c\n'
      + '}\n'
      + 'function apiFmtMoney(v, cur) {')
  }
  if (!out.includes("' ' + apiCurrencyLabel(c) : ''")) {
    swap("  return n.toFixed(2) + (c ? ' ' + c : '')",
      "  return n.toFixed(2) + (c ? ' ' + apiCurrencyLabel(c) : '')")
  }
  if (!out.includes('apiCurrencyLabel(currency)')) {
    swap("  return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency",
      "  return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + apiCurrencyLabel(currency)")
  }

  return out
}

// ── 对外接口 ────────────────────────────────────────────────────────────────

/**
 * 打补丁。幂等：已打过就什么都不写。
 *
 * 返回 `{ ok, changed, pkg, host, client, needsRestart, error? }`。
 * 从不抛异常 —— 这是桥接插件的附加能力，不能把余额显示带崩。
 */
export function applyTurnCreditsPatch(options = {}) {
  const log = options.log || (() => {})
  const pkg = options.pkg || findWhaleWidget()
  if (!pkg) return { ok: false, changed: false, error: '没找到 dsh-whale-widget' }

  const hostPath = path.join(pkg, 'lib', 'index.js')
  const clientPath = path.join(pkg, 'assets', 'whale-widget.js')
  const result = { ok: true, changed: false, pkg, host: false, client: false, needsRestart: false }

  let hostText
  try {
    hostText = fs.readFileSync(hostPath, 'utf8')
  } catch (error) {
    return { ok: false, changed: false, pkg, error: '读不到宿主文件: ' + String((error && error.message) || error) }
  }

  // 宿主
  try {
    const next = patchHost(hostText)
    if (next !== hostText) {
      fs.writeFileSync(hostPath, next, 'utf8')
      result.changed = true
      // 宿主代码已经在本进程里加载过了 ⇒ 必须重启才生效
      result.needsRestart = true
      log('whale-widget 宿主补丁已写入（需重启 DSH 生效）')
    }
    result.host = true
  } catch (error) {
    return { ok: false, changed: result.changed, pkg, host: false, client: false, error: '宿主补丁失败: ' + String((error && error.message) || error) }
  }

  // 前端（widget.js 每次请求都读盘，刷新页面即可生效，不用重启）
  try {
    const clientText = fs.readFileSync(clientPath, 'utf8')
    const next = patchClient(clientText)
    if (next !== clientText) {
      fs.writeFileSync(clientPath, next, 'utf8')
      result.changed = true
      log('whale-widget 前端补丁已写入（刷新页面即可生效）')
    }
    result.client = true
  } catch (error) {
    return { ok: false, changed: result.changed, pkg, host: result.host, client: false, error: '前端补丁失败: ' + String((error && error.message) || error) }
  }

  return result
}

/** 撤销补丁（标记块整体剥离）。 */
export function revertTurnCreditsPatch(options = {}) {
  const pkg = options.pkg || findWhaleWidget()
  if (!pkg) return { ok: false, error: '没找到 dsh-whale-widget' }
  const stripBlocks = (text, startMark, endMark) => {
    const out = []
    let i = 0
    while (i < text.length) {
      const s = text.indexOf(startMark, i)
      if (s < 0) { out.push(text.slice(i)); break }
      out.push(text.slice(i, s))
      const e = text.indexOf(endMark, s)
      if (e < 0) { out.push(text.slice(s)); break }
      i = e + endMark.length
      if (text[i] === '\n') i++
    }
    return out.join('')
  }
  const hostPath = path.join(pkg, 'lib', 'index.js')
  const clientPath = path.join(pkg, 'assets', 'whale-widget.js')
  try {
    let h = fs.readFileSync(hostPath, 'utf8')
    for (const [s, e] of [[MARK.rates, MARK.ratesEnd], [MARK.usage, MARK.usageEnd]]) h = stripBlocks(h, s, e)
    // 行内改动（没有标记块包着）也要还原，否则 --revert 之后文件里仍留着
    // creditToday 之类的孤儿代码，patchState 还会误判成"已打补丁"。
    h = restoreHostInline(h)
    fs.writeFileSync(hostPath, h, 'utf8')
    let c = fs.readFileSync(clientPath, 'utf8')
    c = stripBlocks(c, MARK.fill, MARK.fillEnd)
    c = restoreClientInline(c)
    fs.writeFileSync(clientPath, c, 'utf8')
    return { ok: true, pkg }
  } catch (error) {
    return { ok: false, pkg, error: String((error && error.message) || error) }
  }
}

/**
 * 还原宿主里那些**没有标记块**的行内改动。
 *
 * 导出给测试用（测试需要一份"原版"文件来验证补丁能从零打上），也被 revert 复用。
 *
 * 注意：这里**只做安全的、不破坏锚点**的还原。开发期手工改上去的代码
 * （没有标记块那种）不强行剥 —— 那需要知道原始文本，正则猜不准，
 * 硬猜会把 finalizeTurn 的准入锚点一起弄坏（踩过）。
 * 测试要一份"原版"应该用 git 里的上游副本，而不是从已打补丁的文件反推。
 */
export function restoreHostInline(text) {
  let h = text
  // ① 每轮结算处的 today 累计
  h = h.replace(/\n        \/\/ 本机今日累计：只累加真正产生了积分的轮次\n        if \(credits > 0\) creditTodayAdd\(credits\)\n/, '\n')
  // ② creditToday 状态与辅助函数
  h = h.replace(
    /\n    \/\/ ── 本机维度的今日积分累计（供 \{credits_today\}）[\s\S]*?\n    function creditTodayAdd\(credits\) \{[\s\S]*?\n    \}\n/,
    '\n')
  // ③ last-turn 下发的 today 字段（多行形式与单行形式都试）
  h = h.replace(
    /\n              \/\/ 本机维度的今日积分累计（与 \{expense_ds\} 的账号维度互补）\n              today: \{ day: creditToday\.day, credits: creditToday\.credits, turns: creditToday\.turns \},/,
    '')
  h = h.replace(
    /\n              today: \{ day: creditToday\.day, credits: creditToday\.credits, turns: creditToday\.turns \},/,
    '')
  return h
}

/** 还原前端里没有标记块的行内改动。 */
export function restoreClientInline(text) {
  let c = text
  // ① state 初始化
  c = c.replace(
    /\n  \/\/ v901：本机维度的今日积分累计（\{credits_today\}）。\n  \/\/ 由宿主 \/dsh-whale\/last-turn\.json 的 `today` 字段下发；null = 还没拿到，\n  \/\/ 渲染时显示 `--`。与 todayUsage（账号维度）是两个不同口径，别混。\n  creditToday: null,\n  creditTodayTurns: 0,/,
    '')
  // ② 轮询赋值
  c = c.replace(
    /\n        \/\/ v901：本机维度的今日累计（宿主逐轮账本给出），供 \{credits_today\} 使用。\n        \/\/ 与 \{expense_ds\}（账号维度、含 WorkBuddy 本体等别处消耗）互补，不是替代关系。\n        if \(d\.today && typeof d\.today\.credits === 'number'\) \{\n          state\.creditToday = d\.today\.credits\n          state\.creditTodayTurns = Number\(d\.today\.turns\) \|\| 0\n        \}/,
    '')
  // ③ 占位符映射（expense_src + credits_today，模型分支）
  c = c.replace(
    /\n    \/\/ v901：`\{expense_src\}` = 今日已用的来源标注[\s\S]*?map\['credits_today'\][\s\S]*?: '--'/,
    '')
  // ③b 全局分支的兜底补丁
  c = c.replace(
    /\n  \/\/ 这两个占位符与模块类型无关，全局分支也补一份（模型分支已算过则不覆盖）\n  if \(map\['credits_today'\] === undefined\) \{\n[\s\S]*?\n  \}\n  if \(map\['expense_src'\] === undefined\) map\['expense_src'\] = ''/,
    '')
  // ③c 手工改的版本（注释措辞不同）
  c = c.replace(
    /\n  \/\/ v901：这两个占位符\*\*与模块类型无关\*\*，所以在全局分支里也补一份。[\s\S]*?if \(map\['expense_src'\] === undefined\) map\['expense_src'\] = ''/,
    '')
  // ④ 来源标注函数
  c = c.replace(/\n\/\/ v901：今日已用的\*\*来源标注\*\*[\s\S]*?return apiUsageSourceLabel\(m\.usageSource\) \|\| ''\n\}/, '')
  // ⑤ 面板帮助（today 多行块 → 原来的单行）
  c = c.replace(
    /  else if \(m\.type === 'today'\) \{\n    add\('expense_ds', '今日已用金额'\)\n    add\('expense_src'[^\n]*\n    add\('credits_today'[^\n]*\n  \}/,
    "  else if (m.type === 'today') add('expense_ds', '今日已用金额')")
  // ⑥ 币种短标签（连同它上面那段 6 行注释一起剥掉）
  c = c.replace(
    /\/\/ 币种代码 → 界面显示用的短标签。[\s\S]*?var CURRENCY_LABELS = \{[^}]*\}\nfunction apiCurrencyLabel\(cur\) \{[\s\S]*?\n\}\n/,
    '')
  // 兜底：万一注释被改过，至少把代码本体去掉
  c = c.replace(/var CURRENCY_LABELS = \{[^}]*\}\nfunction apiCurrencyLabel\(cur\) \{[\s\S]*?\n\}\n/, '')
  c = c.replace("  return n.toFixed(2) + (c ? ' ' + apiCurrencyLabel(c) : '')", "  return n.toFixed(2) + (c ? ' ' + c : '')")
  c = c.replace("  return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + apiCurrencyLabel(currency)", "  return currency === 'CNY' ? '¥ ' + fixed : fixed + ' ' + currency")
  return c
}

/** 文件 mtime 指纹，用于「被重装覆盖后自动重打」的判断。 */
export function patchFingerprint(pkg) {
  try {
    const a = fs.statSync(path.join(pkg, 'lib', 'index.js')).mtimeMs
    const b = fs.statSync(path.join(pkg, 'assets', 'whale-widget.js')).mtimeMs
    return a + ':' + b
  } catch {
    return ''
  }
}
