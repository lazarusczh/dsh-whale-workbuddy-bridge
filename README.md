# dsh-whale-workbuddy-bridge

**一座桥：把 `dsh-connect-workbuddy` 已经拿到的 WorkBuddy 登录态与积分，喂给 `dsh-whale-widget` 记账挂件。**

```
dsh-connect-workbuddy  ──(vault 登录态)──▶  dsh-whale-workbuddy-bridge  ──(模型注册表 + 积分)──▶  dsh-whale-widget
```

> **它不是一个独立的 WorkBuddy 客户端，也不自己登录。**
> 名字里的 `workbuddy` 指的是「WorkBuddy 积分」这个数据，但**数据来源是 connect 插件**；
> `whale` 指 whale-widget（消费侧）；`bridge` 说明它只是**中间那座桥**。
>
> 换个更准确的说法：**`connect-workbuddy` → `whale-widget` 的 bridge**。
> 少了任何一端它都没有意义。

### 两个必需的前置插件

| 插件 | 角色 | 缺了会怎样 |
|---|---|---|
| [`dsh-connect-workbuddy`](https://github.com/dingminhua/dsh-connect-workbuddy) | **数据源**：负责登录 WorkBuddy、维护 token、把积分显示在输入框下方 | 没有 `workbuddy-vault` ⇒ 本插件拿不到 token ⇒ 自检报 `NO_VAULT`，提示「先打开一次 WorkBuddy 卡片」 |
| [`dsh-whale-widget`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) | **消费方**：侧栏余额、今日已用、每轮消耗气泡 | 没有它 ⇒ 积分无处显示，本插件只写快照文件 |

> **所以安装顺序是：先 connect-workbuddy 并登录 → 再装 whale-widget → 最后装本插件。**

### 它不改 whale-widget 的架构

它**不 fork、不替换** whale-widget：余额靠它已有的注册表扩展点接入，零改动。

唯一例外是「每轮积分」气泡 —— 那必须在 whale-widget 内部加一个占位符，
所以由本插件**自动打一个小补丁并持续维护**（重装 whale-widget 后会自动重打，你不用管）。

---

## 它解决什么问题

whale-widget 能记 DeepSeek 等厂商的余额，但 WorkBuddy 积分记不了，原因有三个：

| 卡点 | 说明 |
|---|---|
| **没有公开 API** | 官方 Open API 只有 Auth / UserProfile / LocalAssistant / CloudTask / 兑换码，没有积分端点 |
| **token 在别的插件手里** | `accessToken` 由 `dsh-connect-workbuddy` 维护在 `$DSH_HOME/workbuddy-vault/<region>/<accountId>.json`，约 30 天过期，且会自动轮换 |
| **路由消费不了** | connect 插件有 `/plugins/dsh-connect-workbuddy/account-credits`，但 DSH 桌面端以 `--port 0` 启动，端口每次重启都变 |

本插件的做法：**读 vault 拿 token → 打计费网关 → 维护 whale-widget 的模型注册表**。全程不改 whale-widget 的代码。

---

## 工作原理

```
┌─────────────────────────┐
│ dsh-connect-workbuddy   │  维护登录态（自己续期）
│  workbuddy-vault/cn/*.json │
└───────────┬─────────────┘
            │ 只读 accessToken
            ▼
┌─────────────────────────┐
│ dsh-whale-workbuddy-bridge │  每 5 分钟一轮：
│                           │  ① 读 vault
│                           │  ② POST 计费网关
│                           │  ③ 写注册表 + 快照
│                           │  ④ 维护 whale-widget 的 {credits} 补丁
└───────────┬─────────────┘
            │ 写 .dshw-api.json（保留 usage 段）
            │ + 自动打补丁（mtime 变了就重打）
            ▼
┌─────────────────────────┐
│ dsh-whale-widget        │  按自己的节奏读注册表、画侧栏、弹每轮消耗气泡
└─────────────────────────┘
```

### 两种模式（自动切换）

| 模式 | 触发条件 | 注册表条目 |
|---|---|---|
| `native` | whale-widget **已带** `kind: 'workbuddy'` 模板 | `provider: 'workbuddy'`，极简，走原生逐包求和 |
| `custom` | whale-widget 是**官方原版** | `provider: 'custom'` + POST + 静态 JSON 路径 |

检测方式是读 whale-widget 的源码文本找 `kind: 'workbuddy'`——粗但有效，插件升级或打补丁后会自动跟随。

### ⚠️ 余额为什么不能直接读 `TotalDosage`

这是本项目踩得最深的一个坑，**别再走回头路**。

上游返回里有个汇总字段 `data.Response.Data.TotalDosage`，看起来像"剩余总积分"，
但它实际是**逐包 `CapacityRemain` 的简单相加**，而月度包的 `CapacityRemain`
**是额度总量、不随消耗下降**。于是它把整个月度包算成"还剩满额"，结果偏大。

实测（2026-10-26，一个真实账号）：

| 字段 | 值 | 说明 |
|---|---|---|
| 一次性包合计 | 2570 | 正常 |
| 月度包 `CapacitySize` | 500 | 额度总量 |
| 月度包 `CapacityRemain` | **500** | ⚠️ 也是 500，不随消耗下降 |
| 月度包 `CycleCapacityRemain` | **225.82** | ✅ 本周期真实剩余 |
| `TotalDosage` | **3070** | 2570 + 500（错，偏大 274） |
| 逐包正确求和 | **2795.82** | 与 WorkBuddy 本体显示的 279x 吻合 |

**正确算法**（与 `dsh-connect-workbuddy` 的 `fetchCredits` 完全一致，
它能把同一个数精确显示在指令输入框下方）：

1. 月度包（`CapacityType === 4`）取 `CycleCapacityRemain`
2. 其余包取 `CapacityRemain`
3. `*Precise` 字符串字段优先（带小数），回退整数字段
4. 一次性包：余量 ≤ 0 或已过期（`ExpiredTime`）的剔除；月度包不看 `ExpiredTime`
5. 求和

这条逻辑在两侧都实现了：

- **本插件**：`summarizeAccounts()` —— 写进快照与自检路由
- **whale-widget**：`fetchWorkBuddyCreditsBalance()`（`kind: 'workbuddy'` 分支）—— 侧栏显示用

> 顺带记一个教训：我一度以为"上游的汇总字段一定权威"，把实现改成读 `TotalDosage`，
> 结果界面显示 3070 而真实只剩 2796。**汇总字段不等于正确字段**，要拿可观测的真值校准。

### 三个设计取舍

1. **只读 vault，绝不写**。`refreshToken` 在续期后会**轮换**，两个写者会让 connect 插件手里的那份失效。宁可只读、过期就报错提示「打开一次 WorkBuddy 卡片」。
2. **有就接管，没有就新增**（两条路径缺一不可）：
   - **新用户**（绝大多数）：注册表里没有任何 WorkBuddy 条目 → **自动新增**。装完重启，「WorkBuddy 积分」直接出现在挂件里，接口 / 字段路径 / 凭据 / `allowCustomHost` 全自动配好，用户不需要知道计费网关长什么样。
   - **老用户**（已手工建过）：实测就发生过——面板生成的 `api_xxxxxxxx_xxxxx`，账本已经记了几十积分。此时若再插一条固定 id 的条目，界面上会冒出两个「WorkBuddy 积分」，且旧那条的 `usage` 账本成为孤儿（今日已用归零）。所以先认领、原地更新、保留 id 与账本。
3. **绝不整份覆盖 `.dshw-api.json`**。whale-widget 的**余额差账本（今日已用）就存在这个文件的 `usage` 段里**，整份覆盖会清空它。这里是「读-改-写」，且内容没变就不落盘。

---

## 安装

### ⚠️ 前提条件（先读这个）

**本插件是「connect-workbuddy → whale-widget」的桥，两端都必须在。**

```
① dsh-connect-workbuddy（登录 WorkBuddy）  ──▶ ② dsh-whale-workbuddy-bridge（本插件） ──▶ ③ dsh-whale-widget（显示）
```

| 顺序 | 插件 | 必须先做到什么 | 缺了会怎样 |
|---|---|---|---|
| ① | **dsh-connect-workbuddy** | 已安装，且**打开过一次 WorkBuddy 卡片完成登录** | 本机没有 `workbuddy-vault` ⇒ 拿不到 token ⇒ 自检报 `NO_VAULT`，提示「先打开一次 WorkBuddy 卡片」 |
| ② | **本插件** | —— | —— |
| ③ | **dsh-whale-widget** | 已安装并启用 | 积分无处显示；本插件只写快照文件，侧栏什么都不会变 |
| 运行时 | Node.js >= 20 | DSH 自带，一般无需处理 | 插件加载失败 |

> **为什么必须先登录**：本插件**只读不写** vault（`refreshToken` 会轮换，两个写者会让
> connect 插件手里那份失效）。它拿不到 token 就不会自己去登录——那不是它的职责。
>
> 验证前提是否满足：
> ```powershell
> # 有 vault 文件 = 登录过
> dir "$env:USERPROFILE\.dsh\workbuddy-vault" -Recurse -Filter *.json
>
> # 有 whale-widget = 装好了
> dir "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-whale-widget"
> ```

### 方式一：从源码装（当前推荐）

```powershell
git clone https://github.com/lazarusczh/dsh-whale-workbuddy-bridge.git
cd dsh-whale-workbuddy-bridge

# 1. 链接进 profile 的 node_modules
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-whale-workbuddy-bridge" "$PWD"

# 2. 在 profile 的 package.json 里登记两处：
#    "dsh": { "profile": { "bundles": [ ... , "dsh-whale-workbuddy-bridge" ] } }
#    "dependencies": { ... , "dsh-whale-workbuddy-bridge": "link:<上面的绝对路径>" }
```

然后**重启 DSH**。

> 为什么不用 `dsh plugin --profile desktop add`：CLI 会报
> `profile "desktop" is managed exclusively by the Electron application`。
> 桌面端的 profile 由 Electron 应用独占管理，手工登记等效且安全。

### 方式二：从 npm 装（发布后）

```powershell
dsh plugin --profile desktop add dsh-whale-workbuddy-bridge
```

安装后**重启 DSH**。

### 验证安装

```powershell
# 看补丁状态
node apply-turn-credits-patch.mjs --check

# 跑测试（离线部分任何环境都能跑）
node run-tests.mjs
```

### 安装后会发生什么（不需要任何手工配置）

重启后约 1 秒内，插件会自己做完这些事：

| 步骤 | 结果 |
|---|---|
| 读 `workbuddy-vault/` | 拿到 accessToken（不写回，只读） |
| 打计费网关 | 拿到剩余积分 |
| 写 `.dshw-api.json` | **自动新增**一条「WorkBuddy 积分」模型 |
| 写凭据（custom 模式） | `WORKBUDDY_ACCESS_TOKEN` |
| 写快照 | `.workbuddy-credits.json` |

然后挂件里就多出一个「WorkBuddy 积分」模型，侧栏显示 `余额 xxxx.xx Cr. · 今日已用 xx.xx Cr.`。

> **单位显示**：数据层用的是币种代码 `CREDITS`，界面上映射成更短的 `Cr.`
> （`2763.48 CREDITS` → `2763.48 Cr.`，省 4 个字符，气泡不挤）。
> 想换成别的写法改 `CURRENCY_LABELS` 即可，不影响存储与计算。

> **⚠️ 不要再去面板里手工添加一个**。那是自动生成的；手工再加会变成两条，而且新的那条拿不到 token。想停用请移除本插件，或配置 `enabled: false`。

**前提条件**：必须已装 `dsh-connect-workbuddy` 并登录过（否则本机没有 vault，插件会在自检里提示「先打开一次 WorkBuddy 卡片」）。

### 排查「侧栏没数」

```powershell
# 插件自带自检路由（注意端口是随机的，从 DSH 启动日志里找）
curl http://127.0.0.1:<port>/dsh-workbuddy-bridge/status.json
```

它会直接告诉你卡在哪一环：vault 空 / token 过期 / 没装 whale-widget / 注册表没写入。

---

## 每轮积分消耗（「刚才这轮花了多少积分」）

whale-widget 本来就有「每轮对话结束后弹气泡显示本轮消耗」的功能，但它对 WorkBuddy
**永远不弹**——因为 `dsh-connect-workbuddy` 给 DSH 报的 `cost` 是 `NO_COST`（四项全 0，
注释写明「订阅配额无法按 token 定价」），而气泡的准入条件是 `cost > 0`。

本插件补上了这一块，做法是给 whale-widget 加一个 **`{credits}` 占位符**。

### 三个积分/消耗占位符

| 占位符 | 含义 | 口径 |
|---|---|---|
| `{cost}` | 本轮消耗金额（人民币） | WorkBuddy 恒为 0，其它厂商正常 |
| `{credits}` | **本轮**消耗积分 | 本机这一轮 |
| `{expense_ds}` | **今日**已用（原有） | **账号维度**，含别的设备 |
| `{expense_src}` | `{expense_ds}` 的来源标注 | 显示「余额差记账」/「本地估算」 |
| `{credits_today}` | **今日**积分（本机） | 只算本机 DSH 的对话 |

推荐文案：

```
本轮 {credits} 积分
今日 {credits_today} 积分（账号总 {expense_ds}）
```

这样一眼就能看出「本机花了多少」和「账号一共花了多少」。

### 怎么用

1. 打开 whale-widget 面板 → 「提示与音效设置」→「每轮消耗提示」→ 自定义内容
2. 在文案里写 `{credits}`（和/或 `{credits_today}`）
3. 保存。之后每轮结束，气泡就会显示这一轮消耗的积分

默认文案 `¥ {cost}` 不动，所以非 WorkBuddy 的轮次行为完全不变。

### 为什么「逐轮」不用余额前后差

先纠正一个我最初判断错的地方：我曾以为「余额会自己掉」，因为观察到没发请求余额也降了。
**那个结论是错的** —— 当时的下降其实是你正在用 WorkBuddy 本体（网页/桌面/手机）产生的
**真实消耗**，不是账在漏。

后续复测（连续观测 5 分钟）也印证了这点：只发生 **2 次阶梯式下降**（-7.88 / -3.92），
其余 15 次采样完全不变 —— 这符合"别的客户端在成批地花"，而不是平滑流失。

所以准确的说法是**口径问题，不是可靠性问题**：

| 口径 | 含义 | 适用场景 |
|---|---|---|
| **余额差** | 账号维度今日总消耗（含别的设备/客户端） | 「我今天一共花了多少积分」← `{expense_ds}` 用这个，**没问题** |
| **token 费率** | 本机这一轮消耗 | 「刚才这轮花了多少积分」← `{credits}` 用这个 |

逐轮气泡要的是**本机语义**，余额差区分不出是本机 DSH 还是你在网页版花的，所以走费率换算。
两处口径不同、各用各的，不是谁替代谁。

> 另有一次实测：单轮真值 0.18，余额差算出 5.14 —— 差额就是那段时间别处的消耗。

### 积分是怎么算出来的

**优先用官方逐请求账单 —— 那是扣费真值，不需要估算。**

```
POST https://www.workbuddy.cn/billing/meter/get-user-request-usage
body: { startTime, endTime, pageNum, pageSize }
→ data.data[] = { requestId, credit, model, requestTime, ... }
```

每条带**真实积分**。实测（928 个请求样本）：

| 分位 | 单请求积分 |
|---|---|
| 最小 | 0.01 |
| P25 | 0.42 |
| **中位** | **0.61** |
| P75 | 0.87 |
| P95 | 1.52 |
| 最大 | 25.85 |

一轮对话通常十几到几十次请求 ⇒ 真实消耗是**几到几十积分**。

### 归属方式：按 5 分钟桶（这是最容易踩的坑）

账单的 `requestTime` **严格按 5 分钟对齐** —— 秒恒为 `00`，分钟只可能是
`00/05/10/.../55`（实测 408 条，无一例外）。

所以**不能**按「本轮起止时刻」精确过滤。实测过：

| 查询窗口 | 结果 |
|---|---|
| 1 分钟 | `requests=0` |
| 3 分钟 | `requests=0` ← 一轮通常就 2~3 分钟，一条都查不到 |
| 5 分钟 | `requests=8`, `credits=15.24` |
| 10 分钟 | `requests=20`, `credits=24.78` |

第一版把 `requests===0` 判成「查询失败」，于是整轮回退到 token 估算
（高估 20~180 倍）。表现就是**时准时不准**：

| 轮次 | 显示 | 为什么 |
|---|---|---|
| turn=18 | 15.63 ✅ | 恰好跨过桶边界，撞上已结算的桶 |
| turn=19 | 627.66 ❌ | 落在两个桶之间，`requests=0` → 退回估算 |
| turn=20 | 360.78 ❌ | 同上 |

**修法**：把窗口向外扩到整桶边界，覆盖本轮触及的每一个桶。
实测修正后：

| 轮次 | 旧估算 | 按桶查询 |
|---|---|---|
| turn=19 | 627.66 | **12.30** |
| turn=20 | 360.78 | **16.49** |

代价：同一桶内如果别的客户端也在用，它的请求会被一并计入。桶只有 5 分钟，可接受。

### 结算延迟

账单结算约 10~30 秒。查询前等 **15 秒**；若这一轮完全落在已过去的桶里，那次查询就是准的。

当前桶（还没滚过去）可能只结算了一部分，此时先给偏小的数并标 `partial`，
由 whale-widget 的 20 秒异步校正自然补上 —— **不会**为了等一个完整桶而阻塞 5 分钟。

### 为什么彻底停用 token 估算

**结论：token 与积分之间没有稳定映射，这个模型不成立 —— 不是参数没调好。**

用 4 组「账单真值 + 本地累计 token」配对反解：

| turn | hit | miss | out | 账单真值 | 单因子相关性 |
|---|---|---|---|---|---|
| 3 | 6,910,336 | 111,588 | 64,908 | 26.29 | |
| 1 | 4,003,200 | 215,912 | 14,734 | 10.79 | |
| 21 | 4,489,216 | 143,773 | 13,960 | 23.97 | |
| 18 | 17,843,584 | 65,987 | 16,049 | 15.63 | |

- 单因子相关性：`hit=-0.19`、`miss=-0.41`、`out=0.64` —— **全都很弱**
- `credit/miss` 比值波动 **5 倍**（5e-5 ~ 2.4e-4）
- 旧费率回代：高估 **8.2 ~ 44.9 倍**

> **方法论教训**：最初用 6 个**单请求**样本标定费率（单请求粒度上确实准，
> 样本 C 真值 0.05 算得 0.0500），再拿去算**整轮** —— 样本 token 量级（几千）
> 与整轮（几百万）差 3 个数量级，外推必然失真。
> 更根本的是：整轮的积分不只由 token 决定，还受模型定价、任务类型影响。
> **能用真值就别估算，估不出来就别编。**

### 现在的三级取值

| 优先级 | 来源 | 延迟 | 准确性 | 局限 |
|---|---|---|---|---|
| ① | **余额差** | 即时（614ms） | 精确（小数点后 8 位） | 账号维度，含 WorkBuddy 本体 |
| ② | **官方账单** | **约 20 分钟** | 精确，可分离本机 | 太慢，赶不上即时显示 |
| ③ | **pending（结算中）** | —— | 不填假数字 | 需要稍后补账 |

一轮开始与结束各查一次余额，差值就是本轮扣费 —— 这是**唯一能即时拿到且准确**的口径。

### 账单结算延迟实测：约 20 分钟

这条推翻了我之前「约 11 秒」的假设。实测（2026-10-30）：

```
09:24 查询最近 3 小时 → 161 条
最新桶: 2026-10-30 09:05      ← 差 19 分钟
当前桶 09:20: 0 条
上一桶 09:15: 0 条
```

所以 turn/end 当下**必然**查不到这一轮的请求。之前"时灵时不灵"就是这么来的：

| 轮次 | 显示 | 原因 |
|---|---|---|
| turn=18 | 15.63 ✅ | 恰好撞上已结算的桶 |
| turn=19 | 627.66 ❌ | 没撞上 → 退回估算 |
| turn=20 | 360.78 ❌ | 同上 |

**现在的处理**：查不到就显示「结算中」，等补账（`reconcilePending`，由插件每 5 分钟的 tick 调用）回填真值。
显示「结算中」远比显示一个高估 40 倍的假数字好。

### 已知精度边界

| 情形 | 表现 |
|---|---|
| 正常对话 | 余额差，**准确** |
| 同时在用 WorkBuddy 本体 | 余额差会把它的消耗算进来（账号维度）；账单口径能分离 |
| 余额刚好没变化 | 走 pending，稍后由账单补 |
| 账单结算 | 约 20 分钟；期间显示「结算中」 |
| 没装桥接插件 | whale-widget 不显示积分（不会编数字） |

### 识别哪些轮次算积分

判据用 **`source.provider`**（DSH 的权威字段，来自 `dsh-agent-loop` 的
`source: { provider, model }`），`dsh-connect-workbuddy` 把 provider 恒定为 `workbuddy`。

**不能只靠模型名**——WorkBuddy 的真实模型名是 `GLM-5.3 · x0.79`、
`DeepSeek-V4.1-Flash · x0.30` 这种，压根不含 workbuddy 字样。provider 缺失时才退回
模型名启发式（含 `· x` 后缀 / 注册表 matchIds），判不出来就算「不是」——宁可漏算，
也不把 DeepSeek 直连的 token 当积分算进去。

### 补丁是插件自己维护的，你不用管

`{credits}` 必须改 whale-widget 自己的两个文件（宿主算积分、前端渲染），
**为什么不能全放进本插件**：

- 宿主侧的 `finalizeTurn` 准入条件 `agg.cost > 0` 在 whale-widget 的**私有闭包**里，外部无法影响
- 前端 `whale-widget.js` 是 `(function(){...})()` 的 IIFE，只往 window 挂了个防重复的布尔值，
  没有任何导出/钩子 ⇒ 运行时 monkey-patch 不可能

所以只能改文件。但**不需要你手工操作**：本插件启动时会自动打补丁，并且每次 tick
比对两个文件的 mtime —— whale-widget 被重装/升级覆盖后，**下一轮 tick 会自动重打**。

| 时机 | 行为 |
|---|---|
| 首次启动 | 检测到未打 ⇒ 自动打上，日志提示「需要重启 DSH 生效」 |
| 每次 tick | 只比对 mtime（零写入）；发现被覆盖就自动重打 |
| 补丁已就位 | 完全无操作 |

手工入口仍然保留（排查用）：

```powershell
node apply-turn-credits-patch.mjs            # 强制打补丁（幂等）
node apply-turn-credits-patch.mjs --check    # 只看状态
node apply-turn-credits-patch.mjs --revert   # 撤销
```

> 撤销后记得把 `turnCredits` 设为 `false`，否则插件下次启动会重新打上。

补丁逻辑只有一份（`lib/patch-whale.mjs`），脚本是它的薄封装 —— 免得两处各写一套、日后漂移。
幂等判据用**内容特征**（`CREDIT_MISS_RATE` 常量、`usageFillText` 的第六个参数），
所以反复跑不会重复插入。

---

## 配置

在 profile 的 `cordis.patch.yml` 里可覆盖（都可选）：

```yaml
- id: dsh-whale-workbuddy-bridge
  name: dsh-whale-workbuddy-bridge
  config:
    enabled: true          # false = 完全停用
    region: cn             # cn | global，多账号时优先取哪个区
    intervalMs: 300000     # 轮询间隔，默认 5 分钟
    turnCredits: true      # false = 关闭每轮积分跟踪（只保留余额显示）
```

---

## 产物

| 产物 | 位置 | 用途 |
|---|---|---|
| 模型注册表 | `$DSH_HOME/.dshw-api.json` | whale-widget 读它来取数（保留 `usage` 段） |
| 积分快照 | `$DSH_HOME/.workbuddy-credits.json` | **给任何记账插件读**，不用依赖本插件内部 |
| 每轮积分账本 | `$DSH_HOME/.workbuddy-turn-credits.json` | 最近 50 轮的积分历史（重启后仍可查） |
| 只读路由 | `GET /dsh-workbuddy-bridge/credits.json` | 当前余额读数 |
| 只读路由 | `GET /dsh-workbuddy-bridge/last-turn.json` | 最近一轮的积分消耗 |
| 只读路由 | `GET /dsh-workbuddy-bridge/status.json` | 自检：卡在哪一环 |

> 路由都带随机端口（DSH 以 `--port 0` 启动），不适合做长期契约；要跨插件共享请读快照文件。

快照形状（**不含 token / uid / uin**）：

```json
{
  "version": 1,
  "source": "dsh-whale-workbuddy-bridge",
  "mode": "native",
  "ok": true,
  "remaining": 3531,
  "preciseTotal": 3531.9,
  "expiringSoon": 120.07,
  "nearestExpiryMs": 1792805794000,
  "packages": [{ "packageName": "…", "remain": 100, "monthly": false, "expiresAtMs": 1792900789000 }],
  "packageCount": 35,
  "accountName": "…",
  "region": "cn",
  "tokenExpiresAtMs": 1795141836000,
  "readAtMs": 1792738000000
}
```

---

## 已知限制

1. **依赖 `dsh-connect-workbuddy`**。没装它、或从没登录过 → `NO_VAULT`，提示「先打开一次 WorkBuddy 卡片」。
2. **token 过期不自动续**（本插件只读）。只要 connect 插件还在跑，它会自己续期，本插件跟着读到新的就行。
3. **只取一个账号**（优先 `cn`、其次最近刷新）。多账号只显示一个。
4. **今日已用是估算**。上游没有用量端点，只能靠余额差；受 `TotalDosage` 整数截断影响，**误差 ±1 积分**。
5. **「即将过期」按 3 天窗口**。这个数字来自 connect 插件的 `SOON_MS = 2592e5`（= 3 天，不是 30 天）；按 30 天算会让两个界面的数互相矛盾。

---

## 开发与测试

```bash
node run-tests.mjs
```

分两类：

| 类别 | 需要什么 | 覆盖 |
|---|---|---|
| **离线** | 只要 Node | 逐包求和口径、账本逻辑、`Cr.` 显示、补丁幂等、从原版打补丁、`{credits_today}` 链路 |
| **在线** | `workbuddy-vault` + 已装 whale-widget | 真实取数、宿主积分换算、端到端事件流、原生分支、账单查询 |

在线部分缺条件时会**跳过并说明原因**，不算失败 —— 所以别人 clone 下来也能先跑离线部分。

**265 项测试**，每个踩过的坑都有对应断言。改代码前请先读 `CONTRIBUTING.md`。

---

## 与上游的关系

本插件是**过渡方案**。更干净的解法是让 whale-widget 原生支持（`kind: 'workbuddy'` 模板 + 逐请求账单取数）。如果那个 PR 被采纳，本插件的 `native` 模式检测会自动切换，届时可以把本插件降级为「只负责维护注册表」。

另一条路是让 `dsh-connect-workbuddy` 在对话路径也透传上游 SSE 里的 `usage.credit`（它目前只在探针/生图路径提取）——那样任何记账插件都能直接拿到精确值，本插件与 whale-widget 的估算都能退休。

---

## 许可

MIT
