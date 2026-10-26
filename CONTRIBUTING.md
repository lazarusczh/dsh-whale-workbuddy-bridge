# 贡献指南

## 先读这个

本插件做的事有点特殊：它**修改另一个插件（dsh-whale-widget）的文件**。
这不是随便选的方案，而是有硬约束——详见 README 的「补丁是插件自己维护的」一节。

改代码前请先理解这几个已经踩过的坑，它们都在源码注释里：

| 坑 | 结论 | 在哪 |
|---|---|---|
| 余额读 `TotalDosage` | 错，它把月度包「额度总量」当剩余相加 | `lib/index.js` 的 `summarizeAccounts` |
| 用 token 费率算整轮 | 错，高估 20~180 倍 | `lib/credit-rates.mjs` |
| `cache_read ⊆ input` | 不适用于本链路，两者互斥 | 同上 |
| 补丁锚点太脆 | 改用「结构特征 + 结果判据」 | `lib/patch-whale.mjs` |
| 测试反向还原原版 | 太脆，改用最小原版替身 | `test-patch-module.mjs` |

## 开发环境

```bash
# 1. 装依赖（本项目零运行时依赖，只有开发期的 Node）
node -v   # 需要 >= 20

# 2. 跑测试
node run-tests.mjs
```

测试分**离线**和**在线**两类。离线部分任何环境都能跑；在线部分需要：

- 本机有 `$DSH_HOME/workbuddy-vault/`（登录过 WorkBuddy）
- 已安装 `dsh-whale-widget`

缺条件时会跳过并说明原因，不算失败。

## 提 PR 前

1. **`node run-tests.mjs` 必须全绿**（在线部分若因缺环境跳过，请在 PR 里说明）
2. 新增逻辑请配测试 —— 这个项目的 bug 大多是「想当然」，测试是唯一的刹车
3. 如果你改动了补丁逻辑，**同时更新 `test-all-placeholders.mjs` 的最小原版替身**
   （否则从原版打补丁的验证会失效）

## 隐私红线（重要）

这个插件会读 `workbuddy-vault` 里的 **accessToken / refreshToken / uid**。
提交任何东西之前请确认：

- ❌ 不要把 token、uin、uid、accountId、昵称、真实模型条目 id 写进代码/测试/README
- ❌ 不要提交 `.dshw-*.json`、`.workbuddy-*.json`、`.credentials.yaml`
- ✅ 需要示例时用 `api_xxxxxxxx_xxxxx` 这类占位
- ✅ 调试输出只打印「有没有 / 几位 / 哪个区域」，不打印值

`.gitignore` 已经挡掉了运行产物，但**代码里手写的**要自己检查。

## 报告问题

请附上：

- DSH 版本、whale-widget 版本、操作系统
- `node apply-turn-credits-patch.mjs --check` 的输出
- `/dsh-workbuddy-bridge/status.json` 的返回（**已脱敏**，不含 token）
- 具体现象 + 你期望的结果

如果涉及余额数字不对，请说明：WorkBuddy 本体显示多少、挂件显示多少、你算的「今日已用」是多少。
