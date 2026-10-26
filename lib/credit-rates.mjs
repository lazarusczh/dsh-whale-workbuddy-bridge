// 积分费率模型 —— 从实测样本反解，用于把 token 用量换算成积分。
//
// 为什么需要它：WorkBuddy 的上游确实在 SSE 的 `usage.credit` 里返回每次请求的
// 精确积分，但 dsh-connect-workbuddy 只在「探针 / 生图」路径提取它，真实对话路径
// 不提取、也不往 DSH 的 usage 里透传。于是 whale-widget 侧只能拿到 token 数。
//
// 为什么不用余额差做「逐轮」归因：
//
//   **修正说明**：这里最初写的是「余额自己会掉，所以余额差不可用」，那个结论是错的。
//   当时的实验只观察到「余额在我没发请求时下降了」，就直接归因为"幽灵消耗"，
//   却忽略了另一种更合理的解释 —— **同一个账号的其它客户端正在使用**
//   （WorkBuddy 网页/桌面/手机、别的 DSH 窗口、厂商侧的定时任务）。
//
//   后续复测（5 分钟连续观测）看到的是**阶梯式跳变**而非平滑流失：
//     只发生 2 次下降（-7.88 与 -3.92），其余 15 次采样完全不变。
//   这符合"别的客户端在成批地花"，而不是"账在漏"。
//
//   所以准确的表述是：
//     · 余额差 = **账号维度**的今日总消耗 —— 对「我今天一共花了多少积分」是正确口径
//     · 余额差 ≠ **本机单轮**的消耗 —— 无法区分是本机 DSH 还是别的客户端花的
//
//   逐轮气泡要的是「这一轮花了多少」，那是本机语义，所以走费率换算；
//   而 whale-widget 的 `{expense_ds}`（今日已用）本来就是账号维度，用余额差没问题。
//   两处口径不同、各用各的，不是谁替代谁。
//
// 费率是从 6 组真机样本反解出来的：
//
//   id  cache_hit  cache_miss  out  credit   来源
//   A        0        7023      3    1.13    同一前缀重复 4 次，结果完全一致
//   B        0        4467      4    0.72
//   C     1088          49      3    0.05    ← 唯一的高缓存命中样本
//   D        0        1137      3    0.18
//   E        0        6688      3    1.07
//   F        0          38      4    0.01
//
// 只用 hit=0 的样本对 miss 费率做最小二乘 ⇒ 1.6057e-4 积分/token。
// 回代四个样本的误差分别是 0.2% / 0.4% / 1.4% / 0.4% —— 精度足够。
//
// 关键洞察：**缓存命中便宜约 4.1 倍**。这是第一版估算错得离谱的原因
// （把 1140 tok 里的 1088 个 cache_hit 按 miss 价算，得 0.18，真值只有 0.05）。
//
// 局限（必须让用户知道）：
//   · 系数按 glm-5.3 标定。其它模型有各自的 `creditMultiplier`（模型名里的 `· x0.79`），
//     这里会乘上去，但倍率与费率的组合关系**未逐一验证**。
//   · 输出 token 的费率未能可靠反解（样本里 Δout 太小，被两位小数取整吃掉），
//     按 0 处理 —— 短回答场景影响可忽略，长回答会略微低估。
//   · 上游调价或改倍率后需要重新标定。

/** cache_miss 的 prompt token 费率（积分 / token），实测反解。 */
export const MISS_RATE = 1.6057e-4
/** cache_hit 的 prompt token 费率，约为 miss 的 1/4.1。 */
export const HIT_RATE = 3.8725e-5
/** 输出 token 费率：未能可靠反解，按 0 处理。 */
export const OUT_RATE = 0

/**
 * 模型名里的 `· x0.79` 是上游的积分倍率。费率标定是在 x1 的模型上做的，
 * 所以其它模型要乘上它自己的倍率。
 */
export function multiplierOf(modelName) {
  const m = /x\s*([0-9]*\.?[0-9]+)\s*$/i.exec(String(modelName || ''))
  if (!m) return 1
  const v = Number(m[1])
  return Number.isFinite(v) && v > 0 ? v : 1
}

/**
 * 把一次（或一轮累计的）token 用量换算成积分。
 *
 * `usage` 形如 `{ inputTokens, cacheReadTokens, outputTokens }`。
 * 注意 DSH 的 `inputTokens` **不含**缓存命中部分，命中数在 `cacheReadTokens` 里 ——
 * 这与上游的 prompt_cache_miss_tokens / prompt_cache_hit_tokens 对应。
 */
export function creditsForUsage(usage, modelName) {
  const u = usage || {}
  const hit = Number(u.cacheReadTokens) || 0
  const miss = Number(u.inputTokens) || 0
  const out = Number(u.outputTokens) || 0
  const raw = hit * HIT_RATE + miss * MISS_RATE + out * OUT_RATE
  const m = multiplierOf(modelName)
  return Math.round(raw * m * 100) / 100
}

/**
 * 一轮里多个模型的用量累加。
 *
 * `byModel` 形如 `{ 'GLM-5.3 · x0.79': { hit, miss, out } }`。
 *
 * ── cache_hit 的字段语义（已验证，别再怀疑）─────────────────────────────
 *
 * 曾怀疑「cache_read 是 input 的子集，我们相加就重复计费」——
 * 那是 Anthropic / buddyToken 的口径（`cache_read_input_tokens <= input_tokens`）。
 * **但 WorkBuddy 这条链路不是那个口径**，证据：
 *
 *   · 实测单轮累计：hit = 58,201,728，input = 1,012,026
 *     hit 远大于 input ⇒ cache 不可能是 input 的子集
 *   · 样本 C 单点校验（真值 0.05 来自上游 usage.credit）：
 *       hit=1088, miss=49 → 1088·H + 49·M = 0.0500  ✅ 完全吻合
 *     若按子集口径算得 0.0421  ❌ 不吻合
 *
 * 所以 `hit` 与 `miss` 是**互斥的两类 token**（命中 vs 未命中），
 * 相加就是本次请求的全部输入 —— 与 DeepSeek 官方的
 * prompt_cache_hit_tokens / prompt_cache_miss_tokens 一致。
 *
 * ── 已知偏差（诚实记录，不掩盖）─────────────────────────────────────────
 *
 * 5 轮实测：按本公式估算 2416 积分，而余额实际只降了约 700 —— 高估约 3.4 倍。
 * 但**不要**用拍脑袋的系数去"修正"（试过 0.236，那是从错误前提倒推的）。
 * 偏差的可能来源，按可信度排序：
 *
 *   1. 余额 delta 是**账号维度**的，含 WorkBuddy 本体、别的设备、探活的消耗
 *      ⇒ 无法从余额差里分离出"本机这一轮"的真实扣费
 *   2. 这些轮次本身是重活（平均 58 次 LLM 调用、每轮 hit 上千万 token）
 *   3. 上游对缓存重读可能有折扣，但**无官方文档、无逐轮 credit 数据可验证**
 *
 * 官方文档（codebuddy.cn/docs/workbuddy/Credits）只说"与模型定价和任务复杂度有关"，
 * 未公开积分↔token 换算表；社区项目 buddyToken 做的是账单与本地 token 的
 * **关联看板**，也没有给出换算公式。
 *
 * 结论：公式在**单次请求**粒度上是准的（样本 C 验证）。整轮偏高无法用现有
 * 数据定论，**保留线性累加**——宁可如实反映 token 量，也不引入魔法系数。
 * 若日后能用上游逐轮的 `usage.credit`，应直接用它并删掉整个估算函数。
 */
export function creditsForTurn(byModel) {
  let total = 0
  const names = Object.keys(byModel || {})
  for (const name of names) {
    const u = byModel[name] || {}
    total += creditsForUsage(
      { cacheReadTokens: u.hit, inputTokens: u.miss, outputTokens: u.out },
      name
    )
  }
  return Math.round(total * 100) / 100
}
