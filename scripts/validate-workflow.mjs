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
  if (job.if) ifSteps++ // 条件也可能挂在任务级(release 只在 v* 标签上跑)
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

ok(ifSteps >= 1, `条件步骤 ${ifSteps} 个(如 release 只在标签上跑)`)
ok(jobs.release?.permissions?.contents === 'write', 'release 任务声明 contents: write(上传资产需要)')
ok(jobs.release?.if?.includes("refs/tags/v"), 'release 任务只在标签上运行')
ok((jobs.package?.needs === 'test'), 'package 依赖 test(回归不过不出包)')
// static 与 package 是兄弟任务:若 release 只依赖 package,typecheck/lint/build 挂了照样能发版
const releaseNeeds = Array.isArray(jobs.release?.needs) ? jobs.release.needs : [jobs.release?.needs]
ok(releaseNeeds.includes('static') && releaseNeeds.includes('package'), 'release 同时依赖 static 与 package', releaseNeeds.join(', '))

// 每个任务都要有超时:否则卡死时最长挂 6 小时(出包/安装包回归会启动真实进程)
const noTimeout = Object.entries(jobs).filter(([, j]) => !j['timeout-minutes']).map(([id]) => id)
ok(noTimeout.length === 0, '所有任务都设了 timeout-minutes', noTimeout.length ? `缺: ${noTimeout.join(', ')}` : Object.entries(jobs).map(([id, j]) => `${id}=${j['timeout-minutes']}min`).join('; '))
ok((jobs.static?.steps || []).some(s => /npm run validate:workflow/.test(s.run || '')), 'static 任务跑工作流自校验(改坏工作流先在这里拦下)')

// 表达式配对
const opens = (raw.match(/\$\{\{/g) || []).length
const closes = (raw.match(/\}\}/g) || []).length
ok(opens === closes && opens > 0, '${{ }} 表达式成对', `open=${opens} close=${closes}`)

// 关键点:Linux 任务必须跳过原生构建(node-pty 无 linux 预编译)
const staticRuns = (jobs.static?.steps || []).map(s => s.run).filter(Boolean).join('\n')
ok(/npm ci --ignore-scripts/.test(staticRuns), 'Linux 任务用 --ignore-scripts 跳过 node-pty 原生构建')
ok(!/npm test|audit:/.test(staticRuns), 'Linux 任务不跑需要 node-pty 的脚本(已挪到 windows 任务)')

// 步骤依赖顺序:界面/打包回归依赖真实产物,顺序错了会在 CI 上白跑一大轮才暴露
const runList = (jobId) => (jobs[jobId]?.steps || []).map(s => s.run).filter(Boolean)
const testRuns = runList('test')
const idxBuild = testRuns.findIndex(r => /npm run build/.test(r))
const idxUi = testRuns.findIndex(r => /npm run audit:ui/.test(r))
ok(idxUi >= 0, 'test 任务跑 audit:ui')
ok(idxBuild >= 0 && idxBuild < idxUi, 'test 任务先 npm run build 再 audit:ui(UI 回归加载 dist/ 产物)')
const pkgRuns = runList('package')
ok(pkgRuns.findIndex(r => /npm run app/.test(r)) < pkgRuns.findIndex(r => /audit:desktop|audit:installer/.test(r)),
  'package 任务先出包再跑打包版/安装包回归')
ok(/npm run dist:nsis/.test(pkgRuns.join('\n')), 'package 任务用 npm run dist:nsis 生成安装包')
// electron-builder 检测到 CI 环境、又能从 git remote 推断出 GitHub provider 时会**隐式尝试
// 发布 Release**,没有 GH_TOKEN 就直接 exit 1(安装包其实已经生成)——出包命令必须显式禁用发布。
ok(/--publish never/.test(scripts['dist:nsis'] || ''), 'dist:nsis 带 --publish never(防 CI 隐式发布)')
ok(/--publish never/.test(scripts.app || ''), 'npm run app 也带 --publish never')
ok(!runList('release').some(r => /audit:|npm test/.test(r)), 'release 任务只做版本校验与上传,不重复跑回归')

// 发版细节:PowerShell 不对原生命令展开通配符,`gh release upload release/*.exe` 会把字面量传给 gh,
// 到打标签那一步才失败(平时不跑 release 任务,极难发现),所以这里拦住。
const releaseSteps = jobs.release?.steps || []
const ghWithGlob = releaseSteps.filter(s => s.shell === 'pwsh' && /gh\s+release[^\n]*\*/.test(s.run || ''))
ok(ghWithGlob.length === 0, 'pwsh 步骤不把通配符直接交给 gh(需自己列文件)', ghWithGlob.length ? '发现 glob 传参' : 'release 用 Get-ChildItem 列文件')
const uploadStep = releaseSteps.find(s => /gh release upload/.test(s.run || ''))?.run || ''
ok(/\.blockmap/.test(uploadStep) && /\.exe/.test(uploadStep), '上传安装包与 blockmap 两个产物')
ok(/__uninstaller/.test(uploadStep), '上传时排除出包中途的临时卸载器(ServerHub Setup <ver>.__uninstaller.exe)')
ok(/\$LASTEXITCODE/.test(uploadStep), 'gh 的退出码被检查(否则上传失败会被后面的 view 掩盖成绿色)')
ok(/assets/.test(uploadStep) && /missing/i.test(uploadStep), '上传后核对资产确实出现在 Release 里')
ok(/isDraft/.test(uploadStep), '检查并取消 Release 草稿状态(防误注入 GH_TOKEN 时 electron-builder 抢先建 draft)')
ok(releaseSteps.some(s => /package\.json/.test(s.run || '') && /version/.test(s.run || '')), 'release 校验标签与 package.json 版本一致')
ok(/if-no-files-found/.test(JSON.stringify(jobs.package?.steps || [])), 'upload-artifact 设了 if-no-files-found(出包失败不会静默通过)')

console.log('\n' + '='.repeat(52))
console.log(`工作流校验: ${pass} PASS / ${fail} FAIL`)
console.log('='.repeat(52))
process.exit(fail ? 1 : 0)
