// 每轮积分消耗账本。
//
// ── 数据源演进（这段历史很重要，别再走回头路）───────────────────────────
//
// ① 上游 `usage.credit` —— 最精确，是本次真实扣费。
//   但 dsh-connect-workbuddy 只在「探针 / 生图」路径提取它，真实对话路径
//   不提取、也不透传给 DSH ⇒ whale-widget 与本插件都拿不到。
//
// ② token 费率估算 —— **已证伪，严重高估**。
//   费率是从 6 组单请求样本反解的（miss 1.6057e-4、hit 3.8725e-5）。
//   单请求粒度上它是对的（样本 C 真值 0.05，算得 0.0500）。
//   但**整轮**会放大成灾：一轮里有几十次 LLM 调用，每次重读完整上下文，
//   `cacheReadTokens` 累加到几百万～两千万 token，线性累加后
//   一轮算出 200~1400 积分，而真实只有几到几十。
//   实测对比（2026-10-26）：
//     turn=15  估算 1453.36  真实账单   7.92   ← 高估 183 倍
//     turn=16  估算  291.46  真实账单  ~7      ← 高估 40 倍
//
// ③ **逐请求账单接口** —— 本模块现在采用。
//   `POST https://www.workbuddy.cn/billing/meter/get-user-request-usage`
//   body `{ startTime, endTime, pageNum, pageSize }`
//   → `data.data[] = { requestId, credit, model, requestTime, ... }`
//   每条带**真实积分**（实测单请求中位数 0.61，P95 1.52）。
//   这是官方账单，就是扣费真值，不需要任何估算。
//
// ── 归属方式 ────────────────────────────────────────────────────────────
//
// 账单的 `requestTime` 只精确到**分钟**，所以无法按 requestId 精确匹配到某一轮
// （DSH 侧的 requestId 与账单里的不是同一套）。因此按**时间窗口**归属：
//
//   一轮开始时记 startMs，结束时记 endMs，取该窗口内的账单求和。
//
// 已知局限（诚实记录）：
//   · 若同一账号同时在 WorkBuddy 本体上使用，其请求会落在同一时间窗口里，
//     被一并计入。缓解办法：窗口收窄到「本轮实际耗时 + 少量余量」，
//     并把账单里 `appType`/`client` 不属于本客户端的请求尽量排除（字段常为空，尽力而为）。
//   · 一轮跨分钟边界时会多算/少算相邻分钟的请求，误差量级是"单请求 ~0.6 积分"。
//   · 账单有结算延迟（实测约 11 秒），所以查询要留重试余量。
//
// 这些局限都比"高估 40~180 倍"好得多。
import fs from 'node:fs'
import path from 'node:path'
import { creditsForTurn } from './credit-rates.mjs'

export const TURN_LOG_FILENAME = '.workbuddy-turn-credits.json'
const TURN_LOG_MAX = 50

/** 账单接口（与 buddyToken 项目使用的一致，已实测可用）。 */
export const BILLING_BASE = 'https://www.workbuddy.cn'
export const BILLING_PATH = '/billing/meter/get-user-request-usage'

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function writeFileAtomic(file, text) {
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
}

const pad = (n) => String(n).padStart(2, '0')
/** 账单接口要的格式：`YYYY-MM-DD HH:mm:ss`（本地时区）。 */
export function billingTime(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export class TurnCreditLedger {
  constructor(options = {}) {
    this.home = options.home
    this.log = options.log || (() => {})
    this.turns = []
    this.seq = 0
    this.load()
  }

  file() {
    return path.join(this.home, TURN_LOG_FILENAME)
  }

  load() {
    const doc = readJson(this.file())
    if (!doc || typeof doc !== 'object') return
    if (Array.isArray(doc.turns)) this.turns = doc.turns.slice(0, TURN_LOG_MAX)
    if (Number.isFinite(doc.seq) && doc.seq >= 0) this.seq = doc.seq
  }

  save() {
    try {
      fs.mkdirSync(this.home, { recursive: true })
      writeFileAtomic(this.file(), JSON.stringify({ seq: this.seq, turns: this.turns.slice(0, TURN_LOG_MAX) }, null, 2))
    } catch (error) {
      this.log('轮次账本落盘失败: ' + String((error && error.message) || error))
    }
  }

  /**
   * 一轮结束：定稿本轮积分。
   *
   * 优先用**真实账单**（billing 参数给了就查接口）；查不到时退回 token 估算，
   * 并把 `source` 标成 `'tokens'`，让调用方/用户知道这个数是估的。
   *
   * @param {object} input
   * @param {number} input.turn
   * @param {string} input.sessionId
   * @param {object} input.byModel       `{ modelName: { hit, miss, out } }`
   * @param {number} [input.startMs]     本轮开始时刻（用于账单窗口）
   * @param {number} [input.endMs]       本轮结束时刻，默认 now
   * @param {object} [input.billing]     `{ baseUrl, token, domain, uid }` —— 给了才查真实账单
   * @param {(ms:number)=>Promise<void>} [input.wait]
   */
  async onTurnEnd(input) {
    const { turn, sessionId, byModel, startMs, endMs, billing } = input || {}
    const names = Object.keys(byModel || {})
    const hasUsage = names.some((n) => {
      const u = byModel[n] || {}
      return (Number(u.hit) || 0) + (Number(u.miss) || 0) + (Number(u.out) || 0) > 0
    })

    const endedAt = Number.isFinite(endMs) ? endMs : Date.now()
    const beganAt = Number.isFinite(startMs) ? startMs : endedAt

    // ── ① 优先：真实账单 ────────────────────────────────────────────────
    let credits
    let source = 'tokens'
    let note = '按 token 费率换算（估算）'
    let billingDetail
    if (billing && billing.token) {
      try {
        const real = await this.queryBillingCredits(billing, beganAt, endedAt)
        if (real && real.ok && real.requests > 0) {
          credits = real.credits
          source = 'billing'
          note = '官方账单（' + real.requests + ' 次请求）'
          billingDetail = { requests: real.requests, windowStartMs: beganAt, windowEndMs: endedAt }
        }
      } catch (error) {
        this.log('查真实账单失败，退回估算: ' + String((error && error.message) || error))
      }
    }

    // ── ② 兜底：token 估算 ──────────────────────────────────────────────
    if (credits === undefined) {
      if (!hasUsage) return undefined
      credits = creditsForTurn(byModel)
      if (!(credits > 0)) return undefined
    }

    this.seq++
    const record = {
      seq: this.seq,
      turn: Number.isFinite(Number(turn)) ? Number(turn) : null,
      sessionId: sessionId || 'default',
      atMs: endedAt,
      credits,
      source,
      note,
      ...billingDetail ? { billing: billingDetail } : {},
      // 明细留档：账单口径下 token 明细仅供参考
      models: Object.fromEntries(names.map((n) => [n, { ...byModel[n] }])),
    }
    this.turns.unshift(record)
    if (this.turns.length > TURN_LOG_MAX) this.turns.length = TURN_LOG_MAX
    this.save()
    this.log('本轮消耗 ' + credits + ' 积分（' + note + '）')
    return record
  }

  /**
   * 查时间窗口内的真实积分。
   *
   * 账单有结算延迟（实测约 11 秒），所以先等一小会儿再查；
   * 若窗口内没有请求（可能还没结算完），再等一次重查。
   */
  async queryBillingCredits(billing, startMs, endMs) {
    const base = String(billing.baseUrl || BILLING_BASE).replace(/\/+$/, '')
    const url = base + BILLING_PATH
    // 窗口两端各放宽 1 分钟：账单时间戳只到分钟，边界请求会落在相邻桶
    const qStart = startMs - 60_000
    const qEnd = endMs + 60_000

    const attempt = async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + billing.token,
          'Content-Type': 'application/json',
          ...billing.domain ? { 'X-Domain': String(billing.domain) } : {},
          ...billing.uid ? { 'X-User-Id': String(billing.uid) } : {},
        },
        body: JSON.stringify({
          startTime: billingTime(qStart),
          endTime: billingTime(qEnd),
          pageNum: 1,
          pageSize: 3000,
        }),
        signal: AbortSignal.timeout(20_000),
      })
      const json = await res.json()
      if (!json || json.code !== 0) {
        return { ok: false, error: 'billing code=' + String(json && json.code) + ' ' + String((json && json.msg) || '') }
      }
      const rows = (json.data && json.data.data) || []
      // 精确过滤到窗口内（服务端按分钟返回，可能略超出）
      const inWindow = rows.filter((r) => {
        const t = r && r.requestTime
        if (!t) return false
        const ms = Date.parse(String(t).replace(' ', 'T'))
        return Number.isFinite(ms) && ms >= qStart && ms <= qEnd
      })
      let credits = 0
      for (const r of inWindow) credits += Number(r.credit) || 0
      return { ok: true, credits: Math.round(credits * 100) / 100, requests: inWindow.length }
    }

    // 首次：稍等让账单结算
    await new Promise((r) => setTimeout(r, 12_000))
    let result = await attempt()
    if (result.ok && result.requests === 0) {
      // 可能还没结算完，再等 10 秒重查一次
      await new Promise((r) => setTimeout(r, 10_000))
      const retry = await attempt()
      if (retry.ok && retry.requests > 0) result = retry
    }
    return result
  }

  /** 给前端/路由用的快照。 */
  snapshot() {
    return {
      ok: true,
      seq: this.seq,
      latest: this.turns[0] || null,
      turns: this.turns.slice(0, 10),
      // 本机维度的今日累计 —— 与 whale-widget 的 {expense_ds} 互补：
      //   {expense_ds}   = 账号维度（含 WorkBuddy 本体、别的设备）
      //   {credits_today}= 本机维度（只算本 DSH 里发生的对话）
      today: this.todaySummary(),
    }
  }

  /**
   * 本机今日累计（按本地日期切分）。
   *
   * 用本地时区而不是 UTC：用户看的是「今天」，跨时区切分会让晚上 8 点后
   * 的数跳到"明天"。
   */
  todaySummary(nowMs = Date.now()) {
    const dayKeyOf = (ms) => {
      const d = new Date(ms)
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    }
    const today = dayKeyOf(nowMs)
    let credits = 0
    let turns = 0
    for (const t of this.turns) {
      if (!t || !Number.isFinite(t.atMs)) continue
      if (dayKeyOf(t.atMs) !== today) continue
      credits += Number(t.credits) || 0
      turns++
    }
    return {
      day: today,
      credits: Math.round(credits * 100) / 100,
      turns,
    }
  }
}
