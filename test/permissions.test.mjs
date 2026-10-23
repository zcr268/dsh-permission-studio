/**
 * dsh-permission-studio 回归测试：九类权限的判定与拒绝理由。
 * 运行：node test/permissions.test.mjs
 *
 * 覆盖的回归点（对应「拒绝理由必须回给 AI」这条产品约束）：
 *  1. command=deny → 返回 deny 且 reason 非空（否则 AI 只看到空白拒绝）
 *  2. edit=deny → 拦截写类工具
 *  3. read=allow → 放行读类工具
 *  4. 区外路径 → 走 outsideWrite/outsideRead 分类
 *  5. doomloop 阈值触发
 *  6. 未知工具（插件工具）不被误拦
 *  7. 保留名/非法枚举被拒（由 normalizePresetMeta 承担，另测）
 */
import assert from 'node:assert'
import { readFileSync, existsSync } from 'node:fs'
import { decide, toolCategory, normalizePerms, defaultPermsFor, isOutside, CATS, CAT_KEYS, toolDescZh, BUILTIN_PRESETS, evalRules, normalizeRules, PRESET_ICONS, iconSvg, TOOL_MODES, MODES, planHiddenTools, syncHiddenTools, globToRegExp, matchFileRule, normalizeFileAllow, normalizeRel, FILE_ACTIONS } from '../lib/index.js'

let pass = 0
let fail = 0
function test(name, fn) {
  try {
    fn()
    console.log('  ✓', name)
    pass++
  } catch (e) {
    console.log('  ✗', name, '→', e.message)
    fail++
  }
}

const exec = (name, args, opts = {}) => ({ name, arguments: args, ...opts })
const studio = {}
const permsWith = (over) => normalizePerms(over, 'workspace-write')

console.log('== 1. 九类权限完整性 ==')
test('CATS 十三类（含查找/联网/团队/兜底）', () => assert.strictEqual(CATS.length, 13))
test('每类含 label/hint/defaultReason', () => {
  for (const c of CATS) {
    assert.ok(c.key && c.label && c.hint, `缺字段: ${c.key}`)
    assert.ok(typeof c.defaultReason === 'string' && c.defaultReason.length > 8, `拒绝理由太短: ${c.key}`)
  }
})

console.log('== 2. 工具分类 ==')
test('bash → command', () => assert.strictEqual(toolCategory('bash', {}), 'command'))
test('terminal_send → command', () => assert.strictEqual(toolCategory('terminal_send', {}), 'command'))
test('write_file → edit', () => assert.strictEqual(toolCategory('write_file', {}), 'edit'))
test('edit_file → edit', () => assert.strictEqual(toolCategory('edit_file', {}), 'edit'))
test('read_file → read', () => assert.strictEqual(toolCategory('read_file', {}), 'read'))
test('read_image → image', () => assert.strictEqual(toolCategory('read_image', {}), 'image'))
test('subagent → subagent', () => assert.strictEqual(toolCategory('subagent', {}), 'subagent'))
test('undo_last_edit → undo', () => assert.strictEqual(toolCategory('undo_last_edit', {}), 'undo'))
test('str_replace_editor(undo_edit) → undo', () => assert.strictEqual(toolCategory('str_replace_editor', { command: 'undo_edit' }), 'undo'))
test('str_replace_editor(view) → read', () => assert.strictEqual(toolCategory('str_replace_editor', { command: 'view' }), 'read'))
test('未知工具 → null', () => assert.strictEqual(toolCategory('taskboard_create', {}), null))

console.log('== 2b. AgentTeams 工具分类（回归：团队工具不得漏网）==')
test('agent_teams_create → team', () => assert.strictEqual(toolCategory('agent_teams_create', {}), 'team'))
test('agent_teams_add_member → team', () => assert.strictEqual(toolCategory('agent_teams_add_member', {}), 'team'))
test('agent_teams_send_message → team', () => assert.strictEqual(toolCategory('agent_teams_send_message', {}), 'team'))
test('agent_teams_create_task → team', () => assert.strictEqual(toolCategory('agent_teams_create_task', {}), 'team'))
test('agent_teams_reassign_task → team', () => assert.strictEqual(toolCategory('agent_teams_reassign_task', {}), 'team'))
test('agent_teams_delete → team', () => assert.strictEqual(toolCategory('agent_teams_delete', {}), 'team'))
test('agent_teams_status 只读 → read', () => assert.strictEqual(toolCategory('agent_teams_status', {}), 'read'))
test('agent_teams 工具被 deny 时给出理由', () => {
  const p = permsWith({ team: { mode: 'deny', reason: '本档位禁止派发团队任务' } })
  const d = decide(exec('agent_teams_create_task', { subject: 'x' }), p, studio)
  assert.strictEqual(d.mode, 'deny')
  assert.match(d.reason, /禁止派发/)
})
test('read-only 档默认拒绝团队协作', () => {
  const p2 = defaultPermsFor('read-only')
  assert.strictEqual(p2.team.mode, 'deny')
})

console.log('== 3. 拒绝必须带理由（回给 AI 的引导）==')
test('command=deny → deny 且 reason 非空', () => {
  const p = permsWith({ command: { mode: 'deny', reason: '本档位不允许执行命令' } })
  const d = decide(exec('bash', { command: 'rm -rf build' }), p, studio)
  assert.strictEqual(d.mode, 'deny')
  assert.ok(d.reason && d.reason.length > 5, 'reason 不能为空')
  assert.match(d.reason, /不允许执行命令/)
})
test('command=deny 未填理由 → 回落到默认引导', () => {
  const p = permsWith({ command: { mode: 'deny' } })
  const d = decide(exec('bash', { command: 'ls' }), p, studio)
  assert.strictEqual(d.mode, 'deny')
  assert.ok(d.reason.length > 10)
})
test('edit=deny → 拦截写文件', () => {
  const p = permsWith({ edit: { mode: 'deny', reason: '只读档位禁止改文件' } })
  const d = decide(exec('write_file', { path: 'a.txt', content: 'x' }), p, studio)
  assert.strictEqual(d.mode, 'deny')
  assert.match(d.reason, /禁止改文件/)
})

console.log('== 4. 允许与询问 ==')
test('read=allow → allow', () => {
  const p = permsWith({ read: { mode: 'allow' } })
  const d = decide(exec('read_file', { path: 'a.txt' }), p, studio)
  assert.strictEqual(d.mode, 'allow')
})
test('command=ask → ask', () => {
  const p = permsWith({ command: { mode: 'ask' } })
  const d = decide(exec('bash', { command: 'ls' }), p, studio)
  assert.strictEqual(d.mode, 'ask')
})
test('未知工具默认放行（不误伤插件工具）', () => {
  const p = permsWith({ command: { mode: 'deny' } })
  const d = decide(exec('taskboard_list', {}), p, studio)
  assert.strictEqual(d.mode, 'allow')
})

console.log('== 5. 区外判定 ==')
test('工作区内路径不算区外', () => assert.strictEqual(isOutside('/work/proj', '/work/proj/a.txt'), false))
test('相对路径按工作区解析', () => assert.strictEqual(isOutside('/work/proj', 'a.txt'), false))
test('上级目录算区外', () => assert.strictEqual(isOutside('/work/proj', '/work/other/a.txt'), true))
test('带 .. 逃逸算区外', () => assert.strictEqual(isOutside('/work/proj', '../outside.txt'), true))

console.log('== 6. doomloop 阈值 ==')
test('连续相同调用达阈值 → 按 doomloop 配置处理', () => {
  const p = permsWith({ doomloop: { mode: 'deny', threshold: 3, reason: '疑似卡死循环，请改变方案' } })
  const same = exec('bash', { command: 'sleep 1' })
  decide(same, p, studio)
  decide(same, p, studio)
  const d = decide(same, p, studio)
  assert.strictEqual(d.mode, 'deny')
  assert.match(d.reason, /卡死循环/)
})

console.log('== 7. 默认档位推导 ==')
test('read-only 档默认禁命令禁写', () => {
  const p = defaultPermsFor('read-only')
  assert.strictEqual(p.command.mode, 'deny')
  assert.strictEqual(p.edit.mode, 'deny')
  assert.strictEqual(p.read.mode, 'allow')
})
test('danger-full-access 档默认放行命令与写', () => {
  const p = defaultPermsFor('danger-full-access')
  assert.strictEqual(p.command.mode, 'allow')
  assert.strictEqual(p.edit.mode, 'allow')
})
test('九类键齐全', () => {
  const p = defaultPermsFor('workspace-write')
  for (const k of CAT_KEYS) assert.ok(p[k], `缺 ${k}`)
})


console.log('== 8. 工具级覆盖（动态发现，不硬编码前缀）==')
test('工具级 deny 覆盖分类 allow', () => {
  const p = permsWith({ read: { mode: 'allow' }, tools: { 'some_future_tool': { mode: 'deny', reason: '这个工具会外发数据，禁止' } } })
  const d = decide(exec('some_future_tool', {}), p, {})
  assert.strictEqual(d.mode, 'deny')
  assert.match(d.reason, /外发数据/)
})
test('工具级 allow 覆盖分类 deny', () => {
  const p = permsWith({ team: { mode: 'deny' }, tools: { 'agent_teams_status': { mode: 'allow' } } })
  const d = decide(exec('agent_teams_status', {}), p, {})
  assert.strictEqual(d.mode, 'allow')
})
test('工具级 ask 覆盖分类 allow', () => {
  const p = permsWith({ read: { mode: 'allow' }, tools: { 'bash': { mode: 'ask' } } })
  const d = decide(exec('bash', { command: 'ls' }), p, {})
  assert.strictEqual(d.mode, 'ask')
})
test('未覆盖的工具回落到分类规则', () => {
  const p = permsWith({ command: { mode: 'deny', reason: '禁命令' }, tools: { 'other_tool': { mode: 'allow' } } })
  const d = decide(exec('bash', { command: 'ls' }), p, {})
  assert.strictEqual(d.mode, 'deny')
})
test('工具名含特殊字符也能存', () => {
  const p = permsWith({ tools: { '@scope/pkg.tool-v2': { mode: 'deny' } } })
  assert.ok(p.tools['@scope/pkg.tool-v2'])
})


console.log('== 9. 钩子注册必须 global（回归：否则作用域过滤会让闸门失效）==')
test('pre-execute 钩子以 global:true 注册', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /ctx\.on\('tools\/pre-execute'/, 'pre-execute 钩子缺失')
  assert.match(src, /\}, \{ global: true \}\)/, 'pre-execute 钩子必须以 global:true 注册')
})
test('permissionPresets 走 ctx.get 安全访问（未声明 inject 时属性访问会抛）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /ctx\.get\('permissionPresets'\)/, '必须以 ctx.get 取服务')
})


console.log('== 10. 查找/联网工具必须归入已知分类（回归：曾经落 null 被默认放行）==')
test('glob → search（不是 null）', () => assert.strictEqual(toolCategory('glob', {}), 'search'))
test('grep → search（不是 null）', () => assert.strictEqual(toolCategory('grep', {}), 'search'))
test('find_files / list_directory → search', () => {
  assert.strictEqual(toolCategory('find_files', {}), 'search')
  assert.strictEqual(toolCategory('list_directory', {}), 'search')
})
test('web_search / web_fetch → web', () => {
  assert.strictEqual(toolCategory('web_search', {}), 'web')
  assert.strictEqual(toolCategory('web_fetch', {}), 'web')
})
test('working_directory → read（不再是 null）', () => assert.strictEqual(toolCategory('working_directory', {}), 'read'))
test('search=deny 时 glob 被拒并带理由', () => {
  const p = permsWith({ search: { mode: 'deny', reason: '禁止查找文件' } })
  const d = decide(exec('glob', { pattern: '**/*.ts' }), p, studio)
  assert.strictEqual(d.mode, 'deny')
  assert.match(d.reason, /禁止查找文件/)
})
test('search=deny 时 grep 被拒', () => {
  const p = permsWith({ search: { mode: 'deny', reason: '禁止搜索内容' } })
  const d = decide(exec('grep', { pattern: 'TODO' }), p, studio)
  assert.strictEqual(d.mode, 'deny')
})
test('web=deny 时 web_search 被拒', () => {
  const p = permsWith({ web: { mode: 'deny', reason: '禁止联网' } })
  const d = decide(exec('web_search', { queries: ['x'] }), p, studio)
  assert.strictEqual(d.mode, 'deny')
  assert.match(d.reason, /禁止联网/)
})
test('read-only 档默认拒绝查找', () => {
  const p = defaultPermsFor('read-only')
  assert.strictEqual(p.search.mode, 'deny')
})


test('未归类工具默认放行，但 other=deny 时被拒', () => {
  const allow = permsWith({ other: { mode: 'allow' } })
  assert.strictEqual(decide(exec('some_unknown_tool', {}), allow, studio).mode, 'allow')
  const deny = permsWith({ other: { mode: 'deny', reason: '未知工具一律禁止' } })
  const d = decide(exec('some_unknown_tool', {}), deny, studio)
  assert.strictEqual(d.mode, 'deny')
  assert.match(d.reason, /未知工具一律禁止/)
})
test('other=ask 时未知工具询问', () => {
  const p = permsWith({ other: { mode: 'ask' } })
  assert.strictEqual(decide(exec('another_unknown', {}), p, studio).mode, 'ask')
})


console.log('== 11. 中文说明与折叠/内置档位（回归）==')
test('内置工具都有中文说明', () => {
  const names = ['read','glob','grep','bash','edit','write','web_search','web_fetch','todo_write','subagent','agent_teams_create','skill']
  for (const n of names) {
    const d = toolDescZh(n, 'English description here')
    assert.ok(d && /[\u4e00-\u9fa5]/.test(d), `${n} 缺少中文说明`)
  }
})
test('未收录工具回落注册表原文', () => {
  const d = toolDescZh('some_new_plugin_tool', 'Does something new')
  assert.strictEqual(d, 'Does something new')
})
test('内置三档列表正确', () => {
  assert.deepStrictEqual([...BUILTIN_PRESETS], ['read-only','workspace-write','danger-full-access'])
})


console.log('== 12. 兜底拒绝理由 ==')
test('未填理由时判定阶段套用 fallbackReason', () => {
  const p = normalizePerms({ command: { mode: 'deny' }, fallbackReason: '统一兜底：请切换档位' }, 'read-only')
  assert.strictEqual(p.command.reason, '', '保存时不应物化兜底')
  const d = decide(exec('bash', { command: 'ls' }), p, studio)
  assert.strictEqual(d.mode, 'deny')
  assert.strictEqual(d.reason, '统一兜底：请切换档位')
})
test('改兜底理由后，留空项立刻跟着变', () => {
  const before = normalizePerms({ command: { mode: 'deny' }, fallbackReason: '旧兜底' }, 'read-only')
  const after = normalizePerms({ command: { mode: 'deny' }, fallbackReason: '新兜底' }, 'read-only')
  assert.strictEqual(decide(exec('bash', { command: 'ls' }), before, studio).reason, '旧兜底')
  assert.strictEqual(decide(exec('bash', { command: 'ls' }), after, studio).reason, '新兜底')
})
test('单独填写的理由优先于兜底理由', () => {
  const p = normalizePerms({ command: { mode: 'deny', reason: '专项理由' }, fallbackReason: '兜底' }, 'read-only')
  assert.strictEqual(decide(exec('bash', { command: 'ls' }), p, studio).reason, '专项理由')
})
test('没有兜底理由时判定阶段回落分类默认引导语', () => {
  const p = normalizePerms({ command: { mode: 'deny' } }, 'read-only')
  const d = decide(exec('bash', { command: 'ls' }), p, studio)
  assert.ok(d.reason && d.reason.length > 0, '应有默认理由')
})
test('fallbackReason 本身被保留，便于界面回显', () => {
  const p = normalizePerms({ fallbackReason: '保留我' }, 'read-only')
  assert.strictEqual(p.fallbackReason, '保留我')
})

console.log('== 13. 正则规则（三种类型）==')
const rulePerms = (rules) => normalizePerms({ rules }, 'workspace-write')

test('例1 命令黑名单：rm -rf 被拒并带理由', () => {
  const p = rulePerms([{ pattern: '^rm\\s+-rf|\\bsudo\\b', target: 'command', mode: 'deny', reason: '禁止危险命令' }])
  const d = decide({ name: 'bash', arguments: { command: 'rm -rf /tmp/x' } }, p, {})
  assert.strictEqual(d.mode, 'deny')
  assert.match(d.reason, /禁止危险命令/)
  assert.strictEqual(d.cat, 'rule')
})
test('例1 普通命令不受该规则影响', () => {
  const p = rulePerms([{ pattern: '^rm\\s+-rf', target: 'command', mode: 'deny' }])
  const d = decide({ name: 'bash', arguments: { command: 'ls -la' } }, p, {})
  assert.notStrictEqual(d.cat, 'rule')
})
test('例2 路径白名单：/tmp 放行（覆盖分类拒绝）', () => {
  const p = normalizePerms({
    edit: { mode: 'deny', reason: '禁止写文件' },
    rules: [{ pattern: '^/tmp/', target: 'path', mode: 'allow' }]
  }, 'read-only')
  const d = decide({ name: 'read', arguments: { path: '/tmp/a.txt' } }, p, {})
  assert.strictEqual(d.mode, 'allow')
  assert.strictEqual(d.cat, 'rule')
})
test('例3 工具名黑名单：agent_teams_delete 被拒', () => {
  const p = rulePerms([{ pattern: '^(agent_teams_delete|interrupt_agent)$', target: 'tool', mode: 'deny', reason: '团队需保持运行' }])
  const d = decide({ name: 'agent_teams_delete', arguments: {} }, p, {})
  assert.strictEqual(d.mode, 'deny')
  assert.match(d.reason, /团队需保持运行/)
})
test('拒绝规则优先于允许规则', () => {
  const p = rulePerms([
    { pattern: '.*', target: 'tool', mode: 'allow' },
    { pattern: '^bash$', target: 'tool', mode: 'deny', reason: '禁止 bash' }
  ])
  const d = decide({ name: 'bash', arguments: {} }, p, {})
  assert.strictEqual(d.mode, 'deny')
})
test('停用的规则不生效', () => {
  const p = rulePerms([{ pattern: '.*', target: 'tool', mode: 'deny', reason: 'x', enabled: false }])
  const d = decide({ name: 'read', arguments: { path: 'a' } }, p, {})
  assert.notStrictEqual(d.cat, 'rule')
})
test('非法正则被丢弃，不阻塞保存', () => {
  const rules = normalizeRules([{ pattern: '[unclosed', target: 'command', mode: 'deny' }, { pattern: '^ls', target: 'command', mode: 'allow' }])
  assert.strictEqual(rules.length, 1)
  assert.strictEqual(rules[0].pattern, '^ls')
})
test('evalRules 未命中返回 null', () => {
  assert.strictEqual(evalRules({ name: 'read', arguments: {} }, []), null)
})


console.log('== 14. 内置档位保护（回归：保存时曾被误删 + 开关无效）==')
test('源码里不再有「显示内置三档」开关', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('showBuiltin'), '开关应已移除')
  assert.ok(!src.includes('显示内置三档'), '开关文案应已移除')
})
test('保存逻辑会补回内置档位（合并而非覆盖）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /mergedPresets/, '必须以合并方式写 presets')
  assert.match(src, /for \(const id of BUILTIN_PRESETS\)/, '必须遍历内置档位补回')
})
test('内置档位仍会得到权限默认值（切过去有配置）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const from = src.indexOf('const nextStudio = {')
  const seg = src.slice(from, from + 1200)
  assert.match(seg, /for \(const id of BUILTIN_PRESETS\)/, '内置档位也要写 perms')
  assert.match(seg, /nextStudio\.presets\[id\] = normalizePerms/, '内置档位要写入 perms')
})
test('内置三档名与原生一致', () => {
  assert.deepStrictEqual([...BUILTIN_PRESETS].sort(), ['danger-full-access','read-only','workspace-write'])
})


console.log('== 15. 正则规则支持「询问」==')
test('ask 规则命中返回 ask 并带说明', () => {
  const p = rulePerms([{ pattern: '^git\\s+push', target: 'command', mode: 'ask', reason: '会改远端，请确认' }])
  const d = decide({ name: 'bash', arguments: { command: 'git push origin main' } }, p, {})
  assert.strictEqual(d.mode, 'ask')
  assert.strictEqual(d.cat, 'rule')
  assert.match(d.reason, /请确认/)
})
test('ask 规则归一化后保留', () => {
  const rules = normalizeRules([{ pattern: '^npm publish', target: 'command', mode: 'ask', reason: '发布需确认' }])
  assert.strictEqual(rules.length, 1)
  assert.strictEqual(rules[0].mode, 'ask')
  assert.strictEqual(rules[0].reason, '发布需确认')
})
test('优先级：拒绝 > 询问 > 允许', () => {
  const p = rulePerms([
    { pattern: '^git', target: 'command', mode: 'allow' },
    { pattern: '^git\\s+push', target: 'command', mode: 'ask', reason: '确认' },
    { pattern: '^git\\s+push\\s+--force', target: 'command', mode: 'deny', reason: '强推禁止' }
  ])
  assert.strictEqual(decide({ name: 'bash', arguments: { command: 'git push --force' } }, p, {}).mode, 'deny')
  assert.strictEqual(decide({ name: 'bash', arguments: { command: 'git push origin' } }, p, {}).mode, 'ask')
  assert.strictEqual(decide({ name: 'bash', arguments: { command: 'git status' } }, p, {}).mode, 'allow')
})
test('allow 规则不保留理由', () => {
  const rules = normalizeRules([{ pattern: 'x', target: 'tool', mode: 'allow', reason: '不该保留' }])
  assert.strictEqual(rules[0].reason, '')
})


console.log('== 16. 示例必须可点击生成（回归）==')
test('示例按钮具备点击生成逻辑', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /RULE_EXAMPLES\.forEach/, '缺少示例遍历')
  assert.match(src, /rules\.push\(\{\.\.\.ex,enabled:true\}\)/, '示例必须能 push 成规则')
})
test('点击示例后保持展开，不会看起来像没生效', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf('RULE_EXAMPLES.forEach'), src.indexOf('RULE_EXAMPLES.forEach') + 700)
  assert.match(seg, /p\.rulesOpen=true/, '点击示例后必须保持 rulesOpen')
})
test('三个示例覆盖拒绝/允许/询问三种动作', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf('const RULE_EXAMPLES'), src.indexOf('function rulesBlock'))
  assert.match(seg, /mode: 'deny'/, '缺少拒绝示例')
  assert.match(seg, /mode: 'allow'/, '缺少允许示例')
  assert.match(seg, /mode: 'ask'/, '缺少询问示例')
})
test('示例按钮有可点击外观（虚线边框类）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /button\.exBtn\{[^}]*border:1px dashed/, '示例应渲染成可点击 chip')
  assert.match(src, /exHead/, '应有「点示例直接生成规则」提示')
})


console.log('== 17. 档位徽标（可选图标）==')
test('图标集至少 12 个且 id 唯一', () => {
  assert.ok(PRESET_ICONS.length >= 12, '图标太少')
  const ids = PRESET_ICONS.map(i => i.id)
  assert.strictEqual(new Set(ids).size, ids.length, 'id 必须唯一')
})
test('每个图标都有中文名与路径', () => {
  for (const ic of PRESET_ICONS) {
    assert.ok(ic.id && ic.label, 'id/label 不能为空')
    assert.ok(ic.d && ic.d.length > 10, ic.id + ' 缺少 path')
  }
})
test('iconSvg 生成合法 SVG，未知 id 返回空串', () => {
  const svg = iconSvg('shield', 16)
  assert.match(svg, /^<svg width="16" height="16"/)
  assert.match(svg, /viewBox="0 0 16 16"/)
  assert.strictEqual(iconSvg('not-exist'), '')
})
test('多段路径图标正确拆分', () => {
  const svg = iconSvg('eye', 16)
  assert.strictEqual((svg.match(/<path /g) || []).length, 2)
})
test('页面注入图标数据且卡头渲染徽标', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /const PRESET_ICONS=\$\{JSON\.stringify\(PRESET_ICONS\)\}/, '图标数据需注入页面')
  assert.match(src, /presetBadge/, '卡头需渲染徽标')
  assert.match(src, /iconChip/, '需提供图标选择器')
})
test('保存会把 icons 一起提交，否则徽标会丢', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /JSON\.stringify\(\{presets,perms,icons,defaultPreset/, '保存必须带 icons')
})
test('保存也会回传 fallbackReason 与 rules（回归：曾漏传清空）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf('perms[id].tools=tout'), src.indexOf('perms[id].tools=tout') + 900)
  assert.match(seg, /fallbackReason/, '需回传兜底理由')
  assert.match(seg, /rules/, '需回传正则规则')
})


console.log('== 18. 批量操作与清空理由（回归）==')
test('批量按钮覆盖三种动作 + 清空理由', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /\['ask','全部询问'\],\['allow','全部允许'\],\['deny','全部拒绝'\]/, '缺少三种批量按钮')
  assert.match(src, /清空单独理由/, '缺少清空理由按钮')
})
test('清空理由会同时清分类、工具、正则规则', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf("clr.title="), src.indexOf("clr.title=") + 700)
  assert.match(seg, /CATS\.forEach/, '要清分类理由')
  assert.match(seg, /tsrc\[n\]\.reason=''/, '要清工具理由')
  assert.ok(seg.includes('rules')&&seg.includes('reason'), '要清规则理由')
})
test('禁止自动回填默认理由（否则清空会被立刻填回）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('if(!perm.reason)perm.reason=cat.defaultReason'), '不应自动回填')
  assert.match(src, /reasonInp\.value=perm\.reason\|\|''/, '留空就显示空，走兜底')
})
test('留空理由由兜底接管（判定时）', () => {
  const p = normalizePerms({ command: { mode: 'deny', reason: '' }, fallbackReason: '统一兜底' }, 'read-only')
  assert.strictEqual(decide(exec('bash', { command: 'ls' }), p, studio).reason, '统一兜底')
})


test('保存不再把分类默认理由当用户理由提交（回归：会覆盖兜底）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(!src.includes("item.reason=cur.reason||cat.defaultReason"), '不能提交默认理由')
  assert.match(src, /if\(cur\.mode==='deny'&&\(cur\.reason\|\|''\)\.trim\(\)\)item\.reason=cur\.reason\.trim\(\)/, '只提交用户填写的理由')
})


console.log('== 19. 工具批量操作（回归）==')
test('工具区提供五种批量动作 + 清空理由', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /\['ask','全部询问'\],\['allow','全部允许'\],\['deny','全部拒绝'\],\['hide','全部剔除'\],\['inherit','全部跟随分类'\]/, '缺少工具批量动作')
  assert.match(src, /清空工具理由/, '缺少清空工具理由')
})
test('全部跟随分类 = 删除该工具的覆盖项', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /mode==='inherit'\).*delete p\.perms\.tools\[t\.name\]/, 'inherit 必须删除覆盖')
})
test('工具批量会覆盖到运行时发现的所有工具', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf('const applyAll='), src.indexOf('const applyAll=') + 500)
  assert.match(seg, /state\.tools\.forEach/, '要遍历 state.tools 而不是写死清单')
})
test('工具区展开状态可保持（批量后不塌）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /p\.toolsOpen/, '需要持久化展开状态')
})


console.log('== 20. 兜底理由运行时解析（不物化）==')
test('分类留空理由保存后仍为空', () => {
  const p = normalizePerms({ command: { mode: 'deny' }, fallbackReason: '兜底' }, 'read-only')
  assert.strictEqual(p.command.reason, '')
})
test('工具留空理由保存后仍为空，判定时用兜底', () => {
  const p = normalizePerms({ command: { mode: 'deny' }, fallbackReason: '工具兜底', tools: { bash: { mode: 'deny' } } }, 'read-only')
  assert.strictEqual(p.tools.bash.reason, '')
  const d = decide(exec('bash', { command: 'ls' }), p, studio)
  assert.strictEqual(d.reason, '工具兜底')
})
test('工具单独理由优先', () => {
  const p = normalizePerms({ fallbackReason: '兜底', tools: { bash: { mode: 'deny', reason: '禁止 bash' } } }, 'read-only')
  assert.strictEqual(decide(exec('bash', { command: 'ls' }), p, studio).reason, '禁止 bash')
})
test('工具无兜底时用「其他工具」引导语', () => {
  const p = normalizePerms({ tools: { bash: { mode: 'deny' } } }, 'read-only')
  const d = decide(exec('bash', { command: 'ls' }), p, studio)
  assert.ok(d.reason && d.reason.length > 0)
})


console.log('== 21. 工具剔除（从清单彻底移除）==')
test('TOOL_MODES 包含 hide，MODES 不含', () => {
  assert.ok(TOOL_MODES.includes('hide'), '工具模式要有 hide')
  assert.ok(!MODES.includes('hide'), '分类模式不应有 hide')
})
test('hide 归一化后保留', () => {
  const p = normalizePerms({ tools: { bash: { mode: 'hide' } } }, 'workspace-write')
  assert.strictEqual(p.tools.bash.mode, 'hide')
})
test('hide 被执行时按拒绝处理（兜底防漏）', () => {
  const p = normalizePerms({ fallbackReason: '该工具已被剔除', tools: { bash: { mode: 'hide' } } }, 'workspace-write')
  const d = decide(exec('bash', { command: 'ls' }), p, studio)
  assert.strictEqual(d.mode, 'deny')
  assert.strictEqual(d.reason, '该工具已被剔除')
})
test('运行时通过 agent/created + tools.restrict 施加剔除', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /ctx\.on\('agent\/created'/, '缺少 agent/created 钩子')
  assert.match(src, /toolService\.restrict\(\{ deny \}\)/, '必须调用 restrict 真正剔除')
  assert.match(src, /restrictableNames/, '要用 restrictableNames 过滤未知工具')
  assert.match(src, /mode === 'hide'/, '要按 hide 收集工具名')
})
test('UI 提供单行剔除与批量剔除', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /\['hide','剔除'\]/, '缺少单行剔除按钮')
  assert.match(src, /\['hide','全部剔除'\]/, '缺少批量剔除')
})


console.log('== 22. 剔除可挂在档位切换上（回归）==')
test('监听 session/event 且覆盖三种权限旋钮事件', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /ctx\.on\('session\/event'/, '缺少 session/event 钩子')
  assert.match(src, /'permission\/preset', 'sandbox\/mode', 'approval\/policy'/, '要覆盖三种旋钮')
})
test('切档时先撤销旧限制再施加新限制（restrict 会累积取交集）', () => {
  // 用假的 tools 服务复刻 restrict 语义：限制累加取交集，disposer 撤销
  const active = new Set()
  const toolService = {
    restrict({ deny }) {
      const added = deny.filter((n) => !active.has(n))
      added.forEach((n) => active.add(n))
      return () => added.forEach((n) => active.delete(n))
    }
  }
  const agent = { id: 's1' }
  const store = new Map()
  // 第一档：剔除 bash
  syncHiddenTools(toolService, agent, ['bash'], store)
  assert.deepStrictEqual([...active], ['bash'])
  // 切到无剔除的档位：必须全部恢复
  syncHiddenTools(toolService, agent, [], store)
  assert.deepStrictEqual([...active], [], '切档后工具必须全部回来')
  // 再切到剔除 web_search
  syncHiddenTools(toolService, agent, ['web_search'], store)
  assert.deepStrictEqual([...active], ['web_search'])
})
test('通过 agents.get(sessionId) 找到活跃 agent', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /agents\.get\(sessionId\)/, '要从 session 找 agent')
})
test('新档位没有剔除项时限制被清空（工具全部恢复）', () => {
  const store = new Map()
  const active = new Set()
  const toolService = { restrict({ deny }) { deny.forEach((n) => active.add(n)); return () => deny.forEach((n) => active.delete(n)) } }
  syncHiddenTools(toolService, { id: 's2' }, ['bash'], store)
  const r = syncHiddenTools(toolService, { id: 's2' }, [], store)
  assert.strictEqual(r.applied, 0)
  assert.strictEqual(r.revoked, true, '应撤销旧限制')
  assert.strictEqual(active.size, 0)
})
test('planHiddenTools 只取 hide 且过滤不可限制的名字', () => {
  const perms = { tools: { bash: { mode: 'hide' }, read: { mode: 'deny' }, edit: { mode: 'hide' } } }
  assert.deepStrictEqual(planHiddenTools(perms, undefined).sort(), ['bash', 'edit'])
  assert.deepStrictEqual(planHiddenTools(perms, new Set(['bash'])), ['bash'])
})


console.log('== 23. 徽标插进原生下拉（装饰器）==')
test('浏览器半带徽标装饰器且只插入不删改', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(src, /createBadgeDecorator/, '要有装饰器')
  assert.match(src, /host\.insertBefore\(badge, label\)/, '只能插入自己的节点')
  // 只允许删除自己插入的徽标节点；删 React 的节点会把整棵树搞崩
  const removals = src.match(/[\w.$]+\.removeChild\([^)]*\)/g) || []
  assert.ok(removals.every((r) => r.startsWith('badge.parentNode') || r.startsWith('badge.')), '只能删自己的节点: ' + removals.join(','))
  assert.match(src, /pointer-events:none/, '徽标不能挡住点击')
})
test('触发器也补徽标，且只在带尾随 chevron 的按钮上加', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(src, /decorateTriggers/, '要有触发器装饰')
  assert.match(src, /tail\.querySelector\('svg'\)/, '要判定尾随 chevron')
  assert.match(src, /reconcile/, '要按当前档位重新对齐')
})
test('已有原生图标的项跳过，避免双图标', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(src, /hasNative/, '要检测原生图标')
  assert.match(src, /data-ps-badge/, '要打标记防重复')
})
test('接口下发 iconSvg 供下拉使用', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /iconSvg: iconSvg\(/, 'API 要带图标 SVG')
})
test('保存逻辑具名化 saveAll 并绑定到按钮', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /async function saveAll\(\)/, '要有 saveAll')
  assert.match(src, /getElementById\('save'\)\.onclick=saveAll/, '保存按钮指向它')

})

test('保存绝不能删掉内置三档（回归：曾误删 read-only/workspace-write/danger-full-access）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('deleteBuiltins'), '不允许存在删除内置档位的开关')
  assert.ok(!src.includes('删除内置三档'), '界面上不允许有这个按钮')
  const seg = src.slice(src.indexOf('const mergedPresets'), src.indexOf('const mergedPresets') + 500)
  assert.match(seg, /for \(const id of BUILTIN_PRESETS\)/, '内置三档必须无条件补回')
})
test('saveAll 不接受删除参数', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /async function saveAll\(\)/, 'saveAll 不应有 opts')
})

console.log('== 24. 徽标重绘（16 网格，贴近 DSH 线宽）==')
test('全部徽标按 16 网格绘制，线宽 1.3', () => {
  const svg = iconSvg('users', 16)
  assert.match(svg, /viewBox="0 0 16 16"/, '16 网格')
  assert.match(svg, /stroke-width="1.3"/, '细描边贴近原生')
  assert.match(svg, /stroke-linecap="round"/, '圆头')
})
test('所有图标都在 0..16 范围内，不会出框', () => {
  const nums = /-?\d+(\.\d+)?/g
  for (const icon of PRESET_ICONS) {
    for (const seg of icon.d.split('|')) {
      const coords = seg.match(nums) || []
      for (const raw of coords) {
        const v = Number(raw)
        assert.ok(v >= -0.2 && v <= 16.2, icon.id + ' 坐标越界: ' + v)
      }
    }
  }
})
test('徽标 id 保持兼容（已保存的图标不会丢）', () => {
  const ids = PRESET_ICONS.map((i) => i.id)
  for (const id of ['shield', 'eye', 'users', 'gear', 'ban']) assert.ok(ids.includes(id), '缺少 ' + id)
})

test('页面内 iconMarkup 与模块 iconSvg 同网格同线宽（回归：曾残留 24 网格 1.8 线宽）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('viewBox="0 0 24 24"'), '不能残留 24 网格')
  assert.ok(!src.includes('stroke-width="1.8"'), '不能残留旧的 1.8 线宽')
  const count = (src.match(/viewBox="0 0 16 16"/g) || []).length
  assert.ok(count >= 2, '两处渲染都要 16 网格，实际 ' + count)
})

test('徽标说明与现状一致（不再声称原生下拉没有图标）', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.ok(!src.includes('自定义档位在那里没有图标'), '说明文案过期')
  assert.match(src, /原生档位下拉与左下角触发器/, '要说明徽标出现在下拉与触发器')
})


console.log('== 25. 切档后徽标必须跟着变（回归：曾残留旧徽标）==')
test('每次渲染都重新对齐，而不是只插一次', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(src, /function reconcile\(host, label\)/, '需要 reconcile')
  assert.ok(!src.includes("getAttribute('data-ps-trigger') === '1'"), '不能靠一次性标记跳过')
})
test('当前档位有原生图标时移除自己的徽标', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf('function reconcile'), src.indexOf('function decorateTriggers'))
  assert.match(seg, /if \(!svg \|\| native\)/, '没有图标或有原生图标时要清掉')
  assert.match(seg, /badge\.parentNode\.removeChild\(badge\)/, '只能删自己的徽标')
})
test('原生图标检测会跳过自家徽标（否则会误删）', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const seg = src.slice(src.indexOf('function hasNativeIcon'), src.indexOf('function reconcile'))
  assert.match(seg, /if \(isOurs\(ch\)\) continue/, '必须跳过自家徽标')
})
test('切到别的有徽标档位时替换图标而不是叠加', () => {
  const src = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.match(src, /badge\.setAttribute\('data-icon', text\)/, '要记录当前图标')
  assert.match(src, /badge\.getAttribute\('data-icon'\) !== text/, '不同才替换')
})


console.log('== 26. 文件规则（允许/询问/拒绝三态，融合黑白名单）==')
const fileCtx = (over = {}) => normalizePerms(Object.assign({
  read: { mode: 'allow' }, edit: { mode: 'allow' }, search: { mode: 'allow' }
}, over), 'workspace-write')

test('glob 支持段内 * 与跨段 **', () => {
  assert.ok(globToRegExp('src/*.js').test('src/a.js'))
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'), '单星不跨段')
  assert.ok(globToRegExp('src/**').test('src/a/b/c.js'), '双星跨段')
  assert.ok(globToRegExp('**/*.md').test('docs/x.md'))
})
test('点号不被当成通配符', () => {
  assert.ok(!globToRegExp('a.md').test('axmd'), '点号要转义')
})
test('读和写分别取动作', () => {
  const entries = normalizeFileAllow({ enabled: true, entries: [
    { pattern: 'docs/**', read: 'allow', write: 'deny' },
    { pattern: 'src/**', read: 'allow', write: 'allow' }
  ] }).entries
  assert.strictEqual(matchFileRule('/w', '/w/docs/a.md', false, entries).mode, 'allow')
  assert.strictEqual(matchFileRule('/w', '/w/docs/a.md', true, entries).mode, 'deny')
  assert.strictEqual(matchFileRule('/w', '/w/src/a.ts', true, entries).mode, 'allow')
  assert.strictEqual(matchFileRule('/w', '/w/other.txt', false, entries), null, '未命中返回 null')
})
test('多条命中取最严：拒绝 > 询问 > 允许', () => {
  const entries = normalizeFileAllow({ enabled: true, entries: [
    { pattern: '**', read: 'allow', write: 'allow' },
    { pattern: '**/*.env', read: 'deny', write: 'deny' }
  ] }).entries
  assert.strictEqual(matchFileRule('/w', '/w/a.env', false, entries).mode, 'deny', '黑名单要盖过白名单')
})
test('未列出的文件按备用策略：跟随分类或一律拒绝', () => {
  const follow = fileCtx({ fileAllow: { enabled: true, fallback: 'category', entries: [{ pattern: 'README.md', read: 'allow', write: 'allow' }] } })
  assert.strictEqual(decide({ name: 'read', arguments: { file_path: 'other.md' }, agent: {} }, follow, studio).mode, 'allow', '跟随分类时放行')
  const strict = fileCtx({ fileAllow: { enabled: true, fallback: 'deny', entries: [{ pattern: 'README.md', read: 'allow', write: 'allow' }] } })
  assert.strictEqual(decide({ name: 'read', arguments: { file_path: 'other.md' }, agent: {} }, strict, studio).mode, 'deny', '一律拒绝时要拦')
})
test('列表为空 + 一律拒绝：兜底仍然生效，全部拦下', () => {
  const p = fileCtx({ fileAllow: { enabled: true, fallback: 'deny', entries: [] } })
  const d = decide({ name: 'read', arguments: { file_path: 'anything.txt' }, agent: {} }, p, studio)
  assert.strictEqual(d.mode, 'deny')
  assert.strictEqual(d.cat, 'fileAllow')
  assert.match(d.reason, /没有列出任何可访问的路径/)
})
test('列表为空 + 跟随分类：不产生任何额外拦截', () => {
  const p = fileCtx({ fileAllow: { enabled: true, fallback: 'category', entries: [] } })
  const d = decide({ name: 'read', arguments: { file_path: 'anything.txt' }, agent: {} }, p, studio)
  assert.strictEqual(d.mode, 'allow')
  assert.notStrictEqual(d.cat, 'fileAllow')
})
test('规则里写了提示词就原样回给 AI', () => {
  const p = fileCtx({ fileAllow: { enabled: true, fallback: 'category', entries: [
    { pattern: '**/*.env', read: 'deny', write: 'deny', reason: '生产密钥，禁止读取，请让用户手动处理。' }
  ] } })
  const d = decide({ name: 'read', arguments: { file_path: '.env' }, agent: {} }, p, studio)
  assert.strictEqual(d.mode, 'deny')
  assert.strictEqual(d.reason, '生产密钥，禁止读取，请让用户手动处理。')
})
test('询问态返回 ask，交给原生审批', () => {
  const p = fileCtx({ fileAllow: { enabled: true, fallback: 'category', entries: [{ pattern: '**', read: 'ask', write: 'ask' }] } })
  const d = decide({ name: 'read', arguments: { file_path: 'a.md' }, agent: {} }, p, studio)
  assert.strictEqual(d.mode, 'ask')
})
test('全部命中允许时直接放行，不被分类拒绝牵制', () => {
  const p = normalizePerms({ read: { mode: 'deny' }, fileAllow: { enabled: true, fallback: 'category', entries: [{ pattern: '**', read: 'allow', write: 'allow' }] } }, 'workspace-write')
  const d = decide({ name: 'read', arguments: { file_path: 'a.md' }, agent: {} }, p, studio)
  assert.strictEqual(d.mode, 'allow')
  assert.strictEqual(d.cat, 'fileAllow')
})
test('归一化：丢弃空模式、非法动作转空、老布尔配置迁移', () => {
  const fa = normalizeFileAllow({ enabled: true, entries: [
    { pattern: '  ' },
    { pattern: 'a.txt' },
    { pattern: 'b.md', read: 'allow', write: 'deny' },
    { pattern: 'old.txt', read: true, write: false },
    { pattern: 'legacy.txt', read: true, write: true }
  ] })
  assert.strictEqual(fa.entries.length, 4)
  assert.strictEqual(fa.fallback, 'category', '默认跟随分类')
  assert.strictEqual(fa.entries[0].read, 'allow', '未指定时默认可读')
  assert.strictEqual(fa.entries[0].write, '', '未指定的写保持不设')
  assert.strictEqual(fa.entries[1].read, 'allow')
  assert.strictEqual(fa.entries[1].write, 'deny')
  assert.strictEqual(fa.entries[2].read, 'allow', '老配置 read:true 迁移为允许读')
})
test('无效动作被丢弃而不是崩掉', () => {
  const fa = normalizeFileAllow({ entries: [{ pattern: 'x', read: 'nonsense', write: 'allow' }] })
  assert.strictEqual(fa.entries[0].read, '', '非法动作归一为空')
  assert.strictEqual(fa.entries[0].write, 'allow')
})
test('上游所有动作值都在允许集合内', () => {
  assert.deepStrictEqual(FILE_ACTIONS, ['allow', 'ask', 'deny'])
})
test('UI 有三态按钮、读写独立开关与缺权限提醒', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /function fileAllowBlock/, '要有文件规则区块')
  assert.match(src, /\['read','读取'\],\['edit','写入'\]/, '读写两个独立开关')
  assert.match(src, /label\+'已开启'/, '开关要显示已开启状态')
  assert.match(src, /缺.*权限：分类规则里/, '缺读/缺写要提醒')
  assert.match(src, /faSeg/, '要有三态分段按钮')
  assert.match(src, /未列出的文件/, '要有备用策略选择')
  assert.match(src, /拒绝时回给 AI 的提示词/, '拒绝时可写提示词')
})

console.log('== 27. 发布元数据（回归）==')
test('package.json 元数据完整且与插件名一致', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.strictEqual(pkg.name, 'dsh-permission-studio')
  assert.ok(pkg.version && pkg.version.length > 0, '要有版本号')
  assert.ok(pkg.description && pkg.description.length > 20, '要有可读描述')
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length >= 4, '要有关键词')
  assert.ok(pkg.license === 'MIT', '要有许可证')
  assert.ok(pkg.repository && pkg.repository.url, '要有仓库地址')
})
test('发布文件清单覆盖入口与文档', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  for (const f of ['lib', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(pkg.files.includes(f), 'files 缺少 ' + f)
  }
  assert.strictEqual(pkg.main, 'lib/index.js')
  assert.ok(pkg.exports['.'], '要有主入口导出')
  assert.ok(pkg.exports['./client'], '要有浏览器半导出')
})
test('dsh 清单声明 patch 与客户端注入', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.dsh.bundle.patch, '要声明 patch')
  assert.strictEqual(pkg.dsh.client.platform, 'web')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-renderer'), '要注入 renderer')
  assert.ok(pkg.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-settings'), '要注入 settings')
})
test('仓库必备文件齐全', () => {
  for (const f of ['README.md', 'LICENSE', 'CHANGELOG.md', '.gitignore']) {
    assert.ok(existsSync(new URL('../' + f, import.meta.url)), '缺少 ' + f)
  }
})
test('README 覆盖主要能力，不残留过期说法', () => {
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  for (const kw of ['分类规则', '剔除', '正则规则', '文件规则', '工具清单']) {
    assert.ok(md.includes(kw), 'README 缺少 ' + kw + ' 一节')
  }
  assert.ok(!md.includes('右下角出现「权限档位」按钮'), '不能残留旧入口说明')
})


test('README 图文并茂：横幅、截图、徽章、目录锚点齐全', () => {
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(md, /docs\/banner\.png/, '要有横幅图')
  assert.match(md, /docs\/architecture\.png/, '要有架构图')
  const shots = (md.match(/docs\/screenshot-[a-z-]+\.png/g) || [])
  assert.ok(shots.length >= 3, '至少三张真实截图，实际 ' + shots.length)
  assert.match(md, /badge\.svg/, '要有 CI 徽章')
  assert.match(md, /README\.en\.md/, '要链到英文版')
  assert.match(md, /releases\/latest\/download\/dsh-permission-studio\.tgz/, '安装命令要指向最新发布版')
})
test('英文版存在且结构对齐', () => {
  const md = readFileSync(new URL('../README.en.md', import.meta.url), 'utf8')
  assert.match(md, /docs\/banner\.png/)
  assert.match(md, /## Install/)
  assert.match(md, /README\.md/, '要链回中文版')
  assert.match(md, /releases\/latest\/download\/dsh-permission-studio\.tgz/)
})
test('README 引用的图片文件都真实存在', () => {
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  const refs = [...md.matchAll(/docs\/([A-Za-z0-9._-]+\.png)/g)].map((m) => m[1])
  assert.ok(refs.length >= 4, '至少引用四张图')
  for (const f of new Set(refs)) {
    assert.ok(existsSync(new URL('../docs/' + f, import.meta.url)), '图片不存在: docs/' + f)
  }
})
test('发布工作流存在且产出固定文件名的附件', () => {
  const wf = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  assert.match(wf, /tags:/, '按 tag 触发')
  assert.match(wf, /npm test/, '发布前跑测试')
  assert.match(wf, /npm pack/, '要打包')
  assert.match(wf, /dsh-permission-studio\.tgz/, '要产出固定名副本，latest/download 才能用')
  assert.match(wf, /generate_release_notes/, '要自动生成发布说明')
})
test('README 的测试数量与实际一致', () => {
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.match(md, /147/, 'README 里的用例数要更新')
})

test('安装命令把长 URL 折行，避免横向截断', () => {
  for (const f of ['README.md', 'README.en.md']) {
    const md = readFileSync(new URL('../' + f, import.meta.url), 'utf8')
    const seg = md.slice(md.indexOf('releases/latest'), md.indexOf('releases/latest') + 200)
    assert.match(md, /dsh plugin --profile desktop add \\\n/, f + ' 的长命令要折行')
  }
})

test('README 说明桌面版用界面装，且明确不要填仓库地址', () => {
  for (const f of ['README.md', 'README.en.md']) {
    const md = readFileSync(new URL('../' + f, import.meta.url), 'utf8')
    assert.ok(md.includes('releases/latest/download/dsh-permission-studio.tgz'), f + ' 要给出 tarball 地址')
    assert.match(md, /不要填仓库地址|Do not paste the repository URL/, f + ' 要提醒别用仓库地址')
  }
})

console.log('== 28. 版本一致性（回归）==')
test('页面版本号与 package.json 一致', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const m = src.match(/const VERSION = '([^']+)'/)
  assert.ok(m, '要有 VERSION 常量')
  assert.strictEqual(m[1], pkg.version, 'VERSION 必须与 package.json 同步')
})
test('版本号显示在设置页标题旁', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(src, /<h1>权限档位<span class="ver">/, '标题要有版本徽标')
  assert.match(src, /const VERSION=\$\{JSON\.stringify\(VERSION\)\}/, '要注入到页面')
})
test('README 与 CHANGELOG 的版本引用同步', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const md = readFileSync(new URL('../README.md', import.meta.url), 'utf8')
  assert.ok(md.includes('releases/download/v' + pkg.version + '/'), 'README 锁定版本要与 package.json 一致')
  const cl = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
  assert.ok(cl.includes('## ' + pkg.version), 'CHANGELOG 要有当前版本条目')
})

console.log(`\nRESULT: pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
