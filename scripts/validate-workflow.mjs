// 本地校验 GitHub Actions 工作流:YAML 能解析、结构完整、引用到的 npm 脚本真实存在、
// uses 的 action 都带版本号、${{ }} 表达式成对。避免"推上去才发现工作流语法错"。
import fs from 'fs'
import yaml from 'js-yaml'

const wfPath = '.github/workflows/ci.yml'
const raw = fs.readFileSync(wfPath, 'utf8')
let pass = 0, fail = 0
const ok = (c, label, extra = '') => {
  if (c) { pass++; console.log('  ✅', label) } else { fail++; console.log('  ❌', label) }
  if (extra) console.log('     ', extra)
}

let doc
try { doc = yaml.load(raw); ok(true, 'YAML 可解析') } catch (e) { ok(false, 'YAML 可解析', e.message); process.exit(1) }

// YAML 1.1 会把裸 on: 解析成布尔 true,这里两种都接受
const triggers = doc.on ?? doc[true]
ok(!!triggers, '存在 on 触发块', JSON.stringify(Object.keys(triggers || {})))
ok(triggers?.push?.tags?.includes('v*'), '打 v* 标签会触发')
// workflow_dispatch / pull_request 写成无值键时 YAML 解析为 null,属合法写法,故用 in 判断
ok('workflow_dispatch' in (triggers || {}), '支持手动触发(workflow_dispatch)')
ok('pull_request' in (triggers || {}), 'PR 也会触发')
ok(!!doc.concurrency, '配置了 concurrency(避免重复运行)')

const jobs = doc.jobs || {}
const ids = Object.keys(jobs)
ok(ids.length === 4, '共 4 个任务(static/test/package/release)', ids.join(', '))
for (const need of ['static', 'test', 'package', 'release']) ok(ids.includes(need), `存在任务 ${need}`)

// 收集所有 run 步骤里的 npm 脚本名,核对 package.json
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const scripts = pkg.scripts || {}
const usedScripts = new Set()
const usedActions = []
let runSteps = 0, ifSteps = 0
for (const [id, job] of Object.entries(jobs)) {
  ok(!!job['runs-on'], `${id}: 指定了 runs-on`, job['runs-on'])
  const steps = job.steps || []
  ok(steps.length > 0, `${id}: 有步骤(${steps.length} 个)`)
  for (const s of steps) {
    if (s.uses) usedActions.push(`${id}: ${s.uses}`)
    if (s.run) {
      runSteps++
      for (const m of s.run.matchAll(/npm run ([\w:.-]+)/g)) usedScripts.add(m[1])
    }
    if (s.if) ifSteps++
  }
}
ok(runSteps >= 8, `run 步骤数合理(${runSteps} 个)`)
const missing = [...usedScripts].filter(n => !scripts[n])
ok(missing.length === 0, 'run 里引用的 npm 脚本都存在于 package.json', missing.length ? `缺失: ${missing.join(', ')}` : `用到: ${[...usedScripts].join(', ')}`)

const unpinned = usedActions.filter(u => !/@v\d/.test(u))
ok(unpinned.length === 0, '所有 uses 都带主版本号', unpinned.length ? unpinned.join(', ') : usedActions.join('; '))

ok(id => true, `条件步骤 ${ifSteps} 个`)
ok(jobs.release?.permissions?.contents === 'write', 'release 任务声明 contents: write(上传资产需要)')
ok(jobs.release?.if?.includes("refs/tags/v"), 'release 任务只在标签上运行')
ok((jobs.package?.needs === 'test'), 'package 依赖 test(回归不过不出包)')
ok((jobs.release?.needs === 'package'), 'release 依赖 package')

// 表达式配对
const opens = (raw.match(/\$\{\{/g) || []).length
const closes = (raw.match(/\}\}/g) || []).length
ok(opens === closes && opens > 0, '${{ }} 表达式成对', `open=${opens} close=${closes}`)

// 关键点:Linux 任务必须跳过原生构建(node-pty 无 linux 预编译)
const staticRuns = (jobs.static?.steps || []).map(s => s.run).filter(Boolean).join('\n')
ok(/npm ci --ignore-scripts/.test(staticRuns), 'Linux 任务用 --ignore-scripts 跳过 node-pty 原生构建')
ok(!/npm test|audit:/.test(staticRuns), 'Linux 任务不跑需要 node-pty 的脚本(已挪到 windows 任务)')

console.log('\n' + '='.repeat(52))
console.log(`工作流校验: ${pass} PASS / ${fail} FAIL`)
console.log('='.repeat(52))
process.exit(fail ? 1 : 0)
