// Verify isCreditModel now uses source.provider (the authoritative field),
// and that the name heuristics still work as fallback.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

const HOST = path.join(DSH_HOME, 'profiles', 'desktop', 'node_modules', 'dsh-whale-widget', 'lib/index.js')
const src = readFileSync(HOST, 'utf8')

const regSrc = /function isCreditModel\(modelName, provider\) \{[\s\S]*?\n    \}/.exec(src)[0]
const registry = JSON.parse(readFileSync(path.join(DSH_HOME, '.dshw-api.json'), 'utf8'))
const readApiRegistry = () => registry
const isCreditModel = new Function('readApiRegistry', regSrc + '; return isCreditModel')(readApiRegistry)

let pass = 0, fail = 0
function check(label, actual, expected) {
  if (actual === expected) { pass++; console.log('  OK   ' + label + ' -> ' + actual) }
  else { fail++; console.log('  FAIL ' + label + ' -> got ' + actual + ', want ' + expected) }
}

console.log('=== provider is the authoritative signal ===')
check("provider='workbuddy', real name", isCreditModel('GLM-5.3 · x0.79', 'workbuddy'), true)
check("provider='workbuddy', bare name", isCreditModel('GLM-5.3', 'workbuddy'), true)
check("provider='workbuddy', deepseek-looking name", isCreditModel('DeepSeek-V4.1-Flash', 'workbuddy'), true)
check("provider='codebuddy'", isCreditModel('anything', 'codebuddy'), true)

console.log('\n=== other providers are excluded even if name looks odd ===')
check("provider='deepseek' + x-suffix name", isCreditModel('GLM-5.3 · x0.79', 'deepseek'), false)
check("provider='openai'", isCreditModel('workbuddy-gpt', 'openai'), false)
check("provider='anthropic'", isCreditModel('claude', 'anthropic'), false)
check("provider='deepseek'", isCreditModel('deepseek-flash', 'deepseek'), false)

console.log('\n=== no provider: fall back to name heuristics ===')
check('real name with x-suffix', isCreditModel('GLM-5.3 · x0.79', ''), true)
check('bare deepseek name', isCreditModel('deepseek-flash', ''), false)
check('workbuddy in name', isCreditModel('workbuddy-glm', ''), true)
check('provider=custom + x-suffix', isCreditModel('Kimi-K2 · x0.20', 'custom'), true)
check('provider=custom + deepseek', isCreditModel('deepseek-v4-pro', 'custom'), false)

console.log('\n=== registry matchIds still works ===')
const reg2 = { models: [{ id: 'api_workbuddy_credits', provider: 'workbuddy', matchIds: ['glm-5.3'] }] }
const isCreditModel2 = new Function('readApiRegistry', regSrc + '; return isCreditModel')(() => reg2)
check('matchIds hits bare GLM-5.3', isCreditModel2('GLM-5.3', ''), true)
check('matchIds misses gpt-4o', isCreditModel2('gpt-4o', ''), false)

console.log('\n=== provider recorded into aggregate ===')
check('byModelUsage stores provider', src.includes("const u = agg.byModelUsage[model] || { hit: 0, miss: 0, out: 0, provider: '' }"), true)
check('provider assigned', src.includes('if (provider) u.provider = provider'), true)
check('source.provider read', src.includes('const provider = src.provider || '), true)

console.log('\n=== result: ' + pass + ' passed, ' + fail + ' failed ===')
process.exit(fail ? 1 : 0)
