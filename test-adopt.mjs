// 验证「接管已有条目」：拿一份**注册表副本**（含面板生成的条目）
// 跑 syncRegistry，确认它被认领而不是新增一条。
//
// 用法：node test-adopt.mjs <指向某个 .dshw-api.json 所在目录>
//   —— 脚本会**原地修改**那份注册表，所以请先复制一份再用，别指向真实的 $DSH_HOME。
import fs from 'node:fs'
import path from 'node:path'
import { syncRegistry } from './lib/index.js'

const home = process.argv[2]
if (!home) {
  console.error('用法: node test-adopt.mjs <含 .dshw-api.json 的目录>')
  console.error('提示: 先复制一份注册表到临时目录，脚本会原地修改它。')
  process.exit(2)
}
const file = path.join(home, '.dshw-api.json')
if (!fs.existsSync(file)) {
  console.error('没找到 ' + file)
  process.exit(2)
}
const before = JSON.parse(fs.readFileSync(file, 'utf8'))
console.log('接管前 models:', before.models.map((m) => m.id + ' / ' + m.provider).join(', '))
console.log('接管前 usage 键:', Object.keys(before.usage).join(', '))

const r1 = syncRegistry(home, 'native')
const after1 = JSON.parse(fs.readFileSync(file, 'utf8'))
console.log('\n第一次 sync changed=' + r1.changed, '认领 id=' + r1.id)
console.log('接管后 models:', after1.models.map((m) => m.id + ' / ' + m.provider).join(', '))
console.log('条目数:', before.models.length, '->', after1.models.length, after1.models.length === 1 ? '✓ 未新增' : '✗ 出现了重复')
console.log('usage 段保留:', Object.keys(after1.usage).join(', ') || '(空)')
console.log('createdAt 保留:', after1.models[0].createdAt === before.models[0].createdAt)

const r2 = syncRegistry(home, 'native')
console.log('\n第二次 sync changed=' + r2.changed, '(期望 false)')

// 再测模式切换：native -> custom 应该原地改写，不新增
const r3 = syncRegistry(home, 'custom')
const after3 = JSON.parse(fs.readFileSync(file, 'utf8'))
console.log('\n切到 custom: changed=' + r3.changed, '条目数=' + after3.models.length, after3.models.length === 1 ? '✓' : '✗')
console.log('  provider=' + after3.models[0].provider, 'keyRef=' + after3.models[0].keyRef, 'allowCustomHost=' + after3.models[0].allowCustomHost)
console.log('  原 id 保留:', after3.models[0].id === before.models[0].id)
console.log('  usage 仍在:', Object.keys(after3.usage).join(', '))
