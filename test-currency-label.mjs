// 验证积分单位显示为 Cr.（而不是 CREDITS）。
//
// 直接从已安装的 whale-widget 里抽出 apiCurrencyLabel / apiFmtMoney / fmt 来跑，
// 测的是产品代码本身，不是复制品。
import { readFileSync } from 'node:fs'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE, '.dsh')
const CLIENT = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'assets', 'whale-widget.js')
const src = readFileSync(CLIENT, 'utf8')

let pass = 0, fail = 0
function check(label, actual, expected) {
  const ok = actual === expected
  if (ok) { pass++; console.log('  OK   ' + label + ' -> ' + JSON.stringify(actual)) }
  else { fail++; console.log('  FAIL ' + label + ' -> got ' + JSON.stringify(actual) + ', want ' + JSON.stringify(expected)) }
}

// 抽出三个函数（都是顶层 function 声明）
function extract(name) {
  const re = new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}', 'm')
  const m = re.exec(src)
  if (!m) throw new Error('没找到 ' + name)
  return m[0]
}
const labelsSrc = /var CURRENCY_LABELS = \{[^}]*\}/.exec(src)
if (!labelsSrc) { console.log('✗ 没找到 CURRENCY_LABELS'); process.exit(1) }

const code = [
  labelsSrc[0],
  extract('apiCurrencyLabel'),
  extract('apiFmtMoney'),
  extract('fmt'),
  'return { apiCurrencyLabel, apiFmtMoney, fmt }',
].join('\n')

const { apiCurrencyLabel, apiFmtMoney, fmt } = new Function(code)()

console.log('=== apiCurrencyLabel ===')
check('CREDITS 显示为 Cr.', apiCurrencyLabel('CREDITS'), 'Cr.')
check('CNY 保持原样', apiCurrencyLabel('CNY'), 'CNY')
check('USD 保持原样', apiCurrencyLabel('USD'), 'USD')
check('未知币种原样透传', apiCurrencyLabel('XYZ'), 'XYZ')
check('空值安全', apiCurrencyLabel(''), '')

console.log('\n=== apiFmtMoney（气泡/模型模块用）===')
check('积分金额', apiFmtMoney(2763.48, 'CREDITS'), '2763.48 Cr.')
check('人民币不变', apiFmtMoney(12.5, 'CNY'), '¥ 12.50')
check('美元不变', apiFmtMoney(3.2, 'USD'), '$ 3.20')
check('无币种', apiFmtMoney(100, ''), '100.00')
check('非数字', apiFmtMoney('abc', 'CREDITS'), '--')

console.log('\n=== fmt（侧栏用）===')
check('积分金额', fmt(2763.48, 'CREDITS'), '2763.48 Cr.')
check('人民币不变', fmt(12.5, 'CNY'), '¥ 12.50')
check('非数字', fmt('abc', 'CREDITS'), '-- Cr.')

console.log('\n=== 数据层仍用 CREDITS（显示别名不影响存储）===')
const regPath = path.join(DSH_HOME, '.dshw-api.json')
const reg = JSON.parse(readFileSync(regPath, 'utf8'))
check('注册表 currency 仍是 CREDITS', reg.models[0].currency, 'CREDITS')

console.log('\n=== 长度对比 ===')
const before = '2763.48 CREDITS'
const after = apiFmtMoney(2763.48, 'CREDITS')
console.log('  改前: ' + before + '（' + before.length + ' 字符）')
console.log('  改后: ' + after + '（' + after.length + ' 字符）')
check('确实变短了', after.length < before.length, true)

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
