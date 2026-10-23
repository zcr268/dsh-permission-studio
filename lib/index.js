/**
 * dsh-permission-studio —— 权限档位编辑器（Host 侧）。
 *
 * 每个档位（preset）不只有 sandbox + approval，还包括一整套逐项可配的细粒度权限：
 *   九类权限各自可选 询问(ask) / 允许(allow) / 拒绝(deny)，
 *   选拒绝时可写「拒绝理由」——该理由会原样回给 AI，作为它调整方案的引导。
 *
 * 生效方式：
 *   - sandbox / approval / 名称 / 描述 仍写回 @deepseek-ai/dsh-permission-presets 的 profile patch
 *     （会话内 /permission 立即可选）。
 *   - 九类细粒度权限写在插件自己的配置里（$DSH_HOME/permission-studio/config.json），
 *     由本插件挂 tools/pre-execute 闸门裁决：deny 返回 { kind: 'deny', reason } 给模型，
 *     ask 交回 DSH 原生审批（由该档位的 approval 旋钮决定是否弹窗），allow 直接放行。
 *
 * 九类权限（与 dsh-permgate 同一套语义）：
 *   command      执行命令            outsideRead   读取工作区外文件
 *   outsideWrite 写入工作区外        read          读取文件
 *   edit         编辑/写入文件        image         读取图片
 *   undo         撤销操作            subagent      启动子代理
 *   team         团队协作（AgentTeams 的 agent_teams_* 工具）
 *   doomloop     重复操作（同一调用连续放行 N 次）
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export const name = 'dsh-permission-studio'
export const inject = ['webServer', 'configEditor']

const ROUTE = '/permission-studio'
/** 插件版本：页面头部显示，便于确认在线更新是否真的装上了。 */
const VERSION = '0.2.1'
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access']
const APPROVAL_POLICIES = ['ask', 'never']
const RESERVED = new Set(['custom', 'auto'])
/**
 * 档位徽标：16x16 网格的线性图标，和 DSH 原生图标同一套观感
 * （极细描边、圆头圆角、单色描边）。用内联 SVG 而不是 emoji——
 * emoji 跨平台渲染不一致，粗细也和 DSH 的线条不搭。
 *
 * 全部按 16px 显示设计：尺寸小，所以线宽取 1.3、外形留 1.4 的内边距，
 * 避免小尺寸下糊成一坨。多条路径用 | 分隔。
 */
const PRESET_ICONS = [
  { id: 'shield', label: '盾牌', d: 'M8 1.9 L13.1 3.8 V7.6 C13.1 10.9 11 13.2 8 14.1 C5 13.2 2.9 10.9 2.9 7.6 V3.8 Z' },
  { id: 'eye', label: '眼睛', d: 'M1.7 8 C3.3 4.9 5.5 3.4 8 3.4 C10.5 3.4 12.7 4.9 14.3 8 C12.7 11.1 10.5 12.6 8 12.6 C5.5 12.6 3.3 11.1 1.7 8 Z|M9.7 8 A1.7 1.7 0 1 1 6.3 8 A1.7 1.7 0 1 1 9.7 8 Z' },
  { id: 'eyeoff', label: '闭眼', d: 'M8 3.4 C5.5 3.4 3.3 4.9 1.7 8 C3.3 11.1 5.5 12.6 8 12.6 C10.5 12.6 12.7 11.1 14.3 8 C12.7 4.9 10.5 3.4 8 3.4 Z|M2.6 2.6 L13.4 13.4' },
  { id: 'lock', label: '锁', d: 'M4.6 7.3 H11.4 A1.2 1.2 0 0 1 12.6 8.5 V12.4 A1.2 1.2 0 0 1 11.4 13.6 H4.6 A1.2 1.2 0 0 1 3.4 12.4 V8.5 A1.2 1.2 0 0 1 4.6 7.3 Z|M5.9 7.3 V5.2 A2.1 2.1 0 0 1 10.1 5.2 V7.3' },
  { id: 'key', label: '钥匙', d: 'M7.1 5.5 A2.2 2.2 0 1 1 2.7 5.5 A2.2 2.2 0 1 1 7.1 5.5 Z|M6.6 7.1 L13.2 13.7|M11.1 11.6 L12.9 9.8' },
  { id: 'pencil', label: '铅笔', d: 'M2.9 13.2 L3.6 10.2 L10.4 3.4 A1.75 1.75 0 0 1 12.9 5.9 L6.1 12.7 Z|M9.4 4.4 L11.9 6.9' },
  { id: 'terminal', label: '终端', d: 'M4.4 3.9 H11.6 A1.4 1.4 0 0 1 13 5.3 V10.7 A1.4 1.4 0 0 1 11.6 12.1 H4.4 A1.4 1.4 0 0 1 3 10.7 V5.3 A1.4 1.4 0 0 1 4.4 3.9 Z|M5.7 6.9 L7.3 8.1 L5.7 9.3|M8.7 9.4 H10.7' },
  { id: 'bolt', label: '闪电', d: 'M9.2 1.9 L4.2 9.1 H7.6 L6.8 14.1 L11.8 6.9 H8.4 Z' },
  { id: 'star', label: '星标', d: 'M8 2.1 L9.5 5.9 L13.6 6.2 L10.5 8.9 L11.5 12.9 L8 10.8 L4.5 12.9 L5.5 8.9 L2.4 6.2 L6.5 5.9 Z' },
  { id: 'box', label: '容器', d: 'M8 2.3 L13.4 5.2 V10.8 L8 13.7 L2.6 10.8 V5.2 Z|M2.6 5.2 L8 8.1 L13.4 5.2|M8 8.1 V13.7' },
  { id: 'user', label: '单人', d: 'M10.1 5.4 A2.1 2.1 0 1 1 5.9 5.4 A2.1 2.1 0 1 1 10.1 5.4 Z|M2.9 13.5 C2.9 11.1 5 9.7 8 9.7 C11 9.7 13.1 11.1 13.1 13.5' },
  { id: 'users', label: '团队', d: 'M9.4 5.5 A1.9 1.9 0 1 1 5.6 5.5 A1.9 1.9 0 1 1 9.4 5.5 Z|M2.6 13.3 C2.6 11.2 4.5 9.9 7.5 9.9 C10.5 9.9 12.4 11.2 12.4 13.3|M11.3 4.1 A1.6 1.6 0 1 1 11.3 7.3|M12.3 9.9 C13.8 10.3 14.8 11.5 14.8 13.3' },
  { id: 'clock', label: '时钟', d: 'M13.6 8 A5.6 5.6 0 1 1 2.4 8 A5.6 5.6 0 1 1 13.6 8 Z|M8 4.9 V8.2 L10.2 9.6' },
  { id: 'ban', label: '禁止', d: 'M13.6 8 A5.6 5.6 0 1 1 2.4 8 A5.6 5.6 0 1 1 13.6 8 Z|M4.1 4.1 L11.9 11.9' },
  { id: 'flask', label: '实验', d: 'M6.4 2.2 H9.6|M7.1 2.2 V6.5 L3.6 12.3 A1.5 1.5 0 0 0 4.9 14.6 H11.1 A1.5 1.5 0 0 0 12.4 12.3 L8.9 6.5 V2.2|M5.6 10.6 H10.4' },
  { id: 'gear', label: '齿轮', d: 'M8 2.2 L9.3 3.9 L11.4 3.5 L11.9 5.6 L13.8 6.6 L12.9 8.5 L13.8 10.4 L11.9 11.4 L11.4 13.5 L9.3 13.1 L8 14.8 L6.7 13.1 L4.6 13.5 L4.1 11.4 L2.2 10.4 L3.1 8.5 L2.2 6.6 L4.1 5.6 L4.6 3.5 L6.7 3.9 Z|M9.6 8.5 A1.6 1.6 0 1 1 6.4 8.5 A1.6 1.6 0 1 1 9.6 8.5 Z' }
]

/** 生成一个图标的内联 SVG；未知 id 返回空串（不显示徽标）。 */
function iconSvg(id, size) {
  const icon = PRESET_ICONS.find((i) => i.id === id)
  if (!icon) return ''
  const px = size || 16
  const parts = icon.d.split('|').map((d) => '<path d="' + d + '"/>').join('')
  return '<svg width="' + px + '" height="' + px + '" viewBox="0 0 16 16" fill="none" stroke="currentColor"'
    + ' stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + parts + '</svg>'
}

/** 内置三档：界面上默认隐藏（可开关显示），且不允许删除。 */
const BUILTIN_PRESETS = ['read-only', 'workspace-write', 'danger-full-access']
const PERMISSION_IDS = new Set(['permission'])
const PERMISSION_NAMES = new Set(['@deepseek-ai/dsh-permission-presets'])

/** 九类权限的元数据：显示名、说明、默认拒绝理由（复刻「告诉 AI 为什么被拒、该怎么改」的引导语义）。 */
const CATS = [
  {
    key: 'command',
    label: '执行命令',
    hint: 'bash / pwsh / terminal 等 shell 工具',
    defaultReason: '本档位不允许执行命令。请先说明要执行的命令与目的，或请用户切换到允许执行命令的档位。'
  },
  {
    key: 'outsideRead',
    label: '读取工作区外文件',
    hint: '路径落在当前工作区之外的读取',
    defaultReason: '禁止读取工作区外的文件。如需该文件，请让用户将其复制进工作区，或切换到允许区外读取的档位。'
  },
  {
    key: 'outsideWrite',
    label: '写入工作区外',
    hint: '路径落在当前工作区之外的写入/编辑',
    defaultReason: '禁止写入工作区外的文件。请把结果写在当前工作区内，或请用户切换到允许区外写入的档位。'
  },
  {
    key: 'read',
    label: '读取文件',
    hint: '读取工作区内文件内容',
    defaultReason: '本档位不允许读取文件内容。请只基于用户提供的信息作答。'
  },
  {
    key: 'search',
    label: '查找文件',
    hint: 'glob 按路径找文件 / grep 搜索文件内容',
    defaultReason: '本档位不允许查找文件。请让用户直接提供需要的文件内容或路径。'
  },
  {
    key: 'edit',
    label: '编辑/写入文件',
    hint: '写入、修改、删除、重命名文件',
    defaultReason: '本档位为只读，禁止修改文件。请把改动以建议或补丁形式输出，不要直接写盘；或请用户切换到可写档位。'
  },
  {
    key: 'image',
    label: '读取图片',
    hint: '读取工作区内图片',
    defaultReason: '本档位不允许读取图片。请让用户用文字描述图片内容。'
  },
  {
    key: 'web',
    label: '联网访问',
    hint: 'web_search 搜索 / web_fetch 抓取网页',
    defaultReason: '本档位不允许联网访问。请只基于本地信息与用户提供的内容作答。'
  },
  {
    key: 'undo',
    label: '撤销操作',
    hint: 'undo_last_edit / str_replace_editor 的 undo_edit',
    defaultReason: '本档位不允许撤销操作。如需回退，请请用户手动处理或切换到允许撤销的档位。'
  },
  {
    key: 'subagent',
    label: '启动子代理',
    hint: 'subagent / subagent_fork / workflow',
    defaultReason: '本档位不允许启动子代理。请直接在当前会话内完成。'
  },
  {
    key: 'team',
    label: '团队协作',
    hint: 'AgentTeams 的 agent_teams_* 工具（建团队 / 派任务 / 发消息 / 改计划）',
    defaultReason: '本档位不允许团队协作操作（创建团队、分配任务、召回成员等）。请直接在当前会话内完成，或请用户切换到允许团队协作的档位。'
  },
  {
    key: 'other',
    label: '其他工具（未分类兜底）',
    hint: '未归入以上任何分类的工具，默认放行；设为询问/拒绝可覆盖',
    defaultReason: '本档位不允许使用该工具。请改用其他方式完成任务，或请用户切换档位。'
  },
  {
    key: 'doomloop',
    label: '重复操作',
    hint: '同一调用连续放行超过阈值时触发',
    defaultReason: '检测到重复操作：同一次调用已连续放行多次，疑似卡死循环。请停止重复尝试，改用别的方案或询问用户。'
  }
]
const CAT_KEYS = CATS.map((c) => c.key)
const MODES = ['ask', 'allow', 'deny']
/** 工具级模式多一个 hide：把工具从模型的工具清单里整条剔除（不是调用时拒绝）。 */
const TOOL_MODES = ['ask', 'allow', 'deny', 'hide']

/* ------------------------------ 工具分类判定 ------------------------------ */

const SHELL_TOOL_RE = /^(bash|pwsh|powershell|shell|sh|zsh|cmd|exec|terminal|run_command|execute)$/i
const READ_TOOL_RE = /^(read|read_file|read_text|read_file_text|fs_read|view|cat|read_multiple_files|working_directory)$/i
const SEARCH_TOOL_RE = /^(glob|grep|find_files|search_files|list_directory|ls|tree|search_content|rg)$/i
const WEB_TOOL_RE = /^(web_search|web_fetch|fetch|browse|http_get|http_request)$/i
const EDIT_TOOL_RE = /^(write|write_file|edit|edit_file|apply_patch|create_file|delete_file|move_file|rename|str_replace|str_replace_editor|insert|patch|write_text|fs_write)$/i
const IMAGE_TOOL_RE = /^(read_image|view_image|image|read_image_file|see_image)$/i
const UNDO_TOOL_RE = /^(undo_last_edit|undo|revert)$/i
const SUBAGENT_TOOL_RE = /^(subagent|subagent_fork|workflow|ralph)$/i

const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'target', 'target_path', 'paths', 'files', 'directory', 'dir', 'cwd']
const COMMAND_KEYS = ['command', 'cmd', 'script', 'code', 'input']

function toolCategory(execName, args) {
  const tool = String(execName || '')
  if (SHELL_TOOL_RE.test(tool) || tool.startsWith('terminal_')) return 'command'
  if (UNDO_TOOL_RE.test(tool)) return 'undo'
  if (tool === 'str_replace_editor') {
    const cmd = args && typeof args === 'object' ? String(args.command || '') : ''
    if (cmd === 'undo_edit') return 'undo'
    if (cmd === 'view') return 'read'
    return 'edit'
  }
  if (SEARCH_TOOL_RE.test(tool)) return 'search'
  if (WEB_TOOL_RE.test(tool)) return 'web'
  if (IMAGE_TOOL_RE.test(tool)) return 'image'
  if (SUBAGENT_TOOL_RE.test(tool)) return 'subagent'
  if (tool.startsWith('agent_teams_')) {
    // 只读查询跟随「读取文件」档位（查状态不该反复弹窗），会改动团队的动作归 team
    return /^agent_teams_(status|list|get|inspect)/.test(tool) ? 'read' : 'team'
  }
  if (EDIT_TOOL_RE.test(tool)) return 'edit'
  if (READ_TOOL_RE.test(tool)) return 'read'
  return null
}

/** 从参数里粗提路径（不做 glob 展开，只用于判定「是否在工作区外」）。 */
function pathsOf(args) {
  const out = []
  if (!args || typeof args !== 'object') return out
  for (const key of PATH_KEYS) {
    const v = args[key]
    if (typeof v === 'string' && v.trim()) out.push(v.trim())
    else if (Array.isArray(v)) for (const item of v) if (typeof item === 'string' && item.trim()) out.push(item.trim())
  }
  return out
}

/** 工作区根：尽力从 agent/session 取，取不到返回 null（此时不做区外判定，交回沙箱兜底）。 */
function workspaceRootOf(exec) {
  try {
    const agent = exec && exec.agent
    const session = agent && agent.session
    const candidates = [
      session && session.workspace && session.workspace.path,
      session && session.workspace && session.workspace.root,
      session && session.workspaceRoot,
      session && session.cwd,
      agent && agent.workspace && agent.workspace.path,
      agent && agent.cwd
    ]
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0 && isAbsolute(c)) return c
    }
  } catch {}
  return null
}

function isOutside(root, rawPath) {
  if (!root || !rawPath) return false
  try {
    const abs = isAbsolute(rawPath) ? rawPath : resolve(root, rawPath)
    const rel = relative(root, abs)
    return rel !== '' && (rel.startsWith('..') || rel.startsWith(`..${sep}`))
  } catch {
    return false
  }
}

/**
 * 简易 glob → 正则：支持 `*`（段内）、`**`（跨段）、`?`。
 * 只用于文件白名单匹配，不做真实文件系统展开。
 */
function globToRegExp(pattern) {
  const src = String(pattern || '').trim().replace(/^\.\//, '')
  if (!src) return null
  let out = ''
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (ch === '*') {
      if (src[i + 1] === '*') {
        i += 1
        if (src[i + 1] === '/') { i += 1; out += '(?:.*/)?' } else out += '.*'
      } else out += '[^/]*'
    } else if (ch === '?') {
      out += '[^/]'
    } else {
      out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  try { return new RegExp('^' + out + '$') } catch { return null }
}

/** 把任意路径归一成「相对工作区、正斜杠」的形式，便于和 glob 比对。 */
function normalizeRel(root, rawPath) {
  let rel = String(rawPath || '').trim()
  if (!rel) return ''
  if (root) {
    try { rel = relative(root, isAbsolute(rel) ? rel : resolve(root, rel)) || rel } catch {}
  }
  return rel.split(sep).join('/')
}

/**
 * 单个路径命中的规则：{ mode, pattern, reason } 或 null（未命中）。
 * 同一条规则里读和写分别有动作；一条都没命中时返回 null，交给上层按备用策略处理。
 * 多条同时命中时按 deny > ask > allow 取最严的，避免「白名单顺手盖掉黑名单」。
 */
function matchFileRule(root, rawPath, needWrite, entries) {
  const rel = normalizeRel(root, rawPath)
  if (!rel) return null
  let best = null
  const rank = { deny: 3, ask: 2, allow: 1 }
  for (const e of entries) {
    const re = globToRegExp(e.pattern)
    if (!re || !re.test(rel)) continue
    const mode = needWrite ? e.write : e.read
    if (!mode) continue
    if (!best || rank[mode] > rank[best.mode]) best = { mode, pattern: e.pattern, reason: e.reason || '' }
  }
  return best
}

/** 文件规则拒绝时回给 AI 的话：把命中的规则和「未列出的怎么办」都说清楚。 */
function fileRuleReason(fa, path, action, matched) {
  const all = fa.entries || []
  if (all.length === 0) {
    return '本档位启用了文件规则但没有列出任何可访问的路径（未列出的文件一律拒绝），因此 ' + String(path)
      + ' 无法' + action + '。请让用户在文件规则里加入允许的路径，或切换到其它档位。'
  }
  const shown = all.slice(0, 4).map((e) => {
    const r = e.read || '—'
    const w = e.write || '—'
    return e.pattern + '(读:' + r + ' 写:' + w + ')'
  }).join('、')
  const more = all.length > 4 ? ' 等 ' + all.length + ' 条' : ''
  const head = matched
    ? '本档位在文件规则里明确拒绝' + action + ' ' + String(path) + '。'
    : '本档位只允许读写文件规则里列出的路径，' + String(path) + ' 未被列出。'
  return head + ' 现有规则：' + shown + more + '；未列出的文件按「' + (fa.fallback === 'deny' ? '一律拒绝' : '跟随分类规则')
    + '」处理。请让用户调整文件规则，或切换到其它档位。'
}

function hasAny(mode) {
  return MODES.includes(mode)
}

/* ------------------------------ 配置存储 ------------------------------ */

function configPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'permission-studio', 'config.json')
}

async function loadStudioConfig() {
  try {
    const raw = await readFile(configPath(), 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

async function saveStudioConfig(doc) {
  const file = configPath()
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, JSON.stringify(doc, null, 2), 'utf8')
}

/** 按 sandbox 档位类型推导默认细粒度权限（只读档默认禁写禁命令，全权档默认放行）。 */
function defaultPermsFor(sandbox) {
  const readonly = sandbox === 'read-only'
  const full = sandbox === 'danger-full-access'
  const out = {}
  for (const key of CAT_KEYS) {
    if (key === 'command') out[key] = { mode: readonly ? 'deny' : full ? 'allow' : 'ask' }
    else if (key === 'team') out[key] = { mode: readonly ? 'deny' : full ? 'allow' : 'ask' }
    else if (key === 'edit') out[key] = { mode: readonly ? 'deny' : full ? 'allow' : 'ask' }
    else if (key === 'outsideWrite') out[key] = { mode: readonly ? 'deny' : full ? 'allow' : 'ask' }
    else if (key === 'outsideRead') out[key] = { mode: full ? 'allow' : 'ask' }
    else if (key === 'search') out[key] = { mode: readonly ? 'deny' : full ? 'allow' : 'allow' }
    else if (key === 'web') out[key] = { mode: full ? 'allow' : 'ask' }
    else if (key === 'other') out[key] = { mode: 'allow' }
    else if (key === 'doomloop') out[key] = { mode: 'ask', threshold: 6 }
    else out[key] = { mode: 'allow' }
  }
  return out
}

/** 归一化一份档位的细粒度权限：只接受合法 mode，deny 时保留 reason（≤200 字）。 */
/** 归一化工具级覆盖：键为工具名，mode 合法才保留，deny 时保留 reason。 */
function normalizeToolPerms(raw) {
  const out = {}
  const src = raw && typeof raw === 'object' ? raw : {}
  for (const name of Object.keys(src)) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 120) continue
    const cur = src[name]
    if (!cur || typeof cur !== 'object') continue
    if (!TOOL_MODES.includes(cur.mode)) continue
    const item = { mode: cur.mode }
    if (cur.mode === 'deny') {
      // 同样只保留用户填写的理由；留空由判定阶段用兜底理由填充
      item.reason = typeof cur.reason === 'string' && cur.reason.trim() ? cur.reason.trim().slice(0, 300) : ''
    }
    out[name] = item
  }
  return out
}

/**
 * 文件规则（白名单与黑名单融合在一张表里）。
 * 每条：pattern + 读动作 + 写动作，动作取值 allow/ask/deny。
 * fallback 决定「没被任何规则命中的文件」怎么办：category（跟随分类）或 deny（一律拒绝）。
 *
 * 兼容老配置：旧版用布尔 read/write 表示「有没有授权」，true→allow、false→deny。
 */
const FILE_ACTIONS = ['allow', 'ask', 'deny']

function normalizeFileAction(value, legacyBool) {
  if (typeof value === 'string' && FILE_ACTIONS.includes(value)) return value
  if (typeof legacyBool === 'boolean') return legacyBool ? 'allow' : 'deny'
  return ''
}

function normalizeFileAllow(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const list = Array.isArray(src.entries) ? src.entries.slice(0, 50) : []
  const entries = []
  for (const e of list) {
    if (!e || typeof e !== 'object') continue
    const pattern = typeof e.pattern === 'string' ? e.pattern.trim().slice(0, 300) : ''
    if (!pattern) continue
    let read = normalizeFileAction(e.read, e.read)
    let write = normalizeFileAction(e.write, e.write)
    // 兼容老数据：read/write 是布尔时按 true→allow、false→deny 处理；
    // 但老数据里「没勾的那一侧」本意是「不授权」而不是「显式黑名单」，
    // 所以单侧为 false 且另一侧为 true 时，把 false 侧降级为「不设置」。
    if (typeof e.read === 'boolean' && typeof e.write === 'boolean') {
      if (e.read === false && e.write === true) read = ''
      if (e.write === false && e.read === true) write = ''
    }
    if (!read && !write) read = 'allow'
    const reason = typeof e.reason === 'string' ? e.reason.trim().slice(0, 300) : ''
    entries.push({ pattern, read, write, reason })
  }
  const fallback = src.fallback === 'deny' ? 'deny' : 'category'
  return { enabled: src.enabled === true, fallback, entries }
}

function normalizePerms(raw, sandbox) {
  const base = defaultPermsFor(sandbox)
  const out = {}
  const src = raw && typeof raw === 'object' ? raw : {}
  for (const key of CAT_KEYS) {
    const cur = src[key] && typeof src[key] === 'object' ? src[key] : {}
    const mode = hasAny(cur.mode) ? cur.mode : base[key].mode
    const item = { mode }
    if (mode === 'deny') {
      // 只存用户真正填写的理由；兜底理由与分类默认理由在「判定时」解析。
      // 这样改兜底理由能立刻作用于所有留空项，而不是各自留一份旧快照。
      item.reason = typeof cur.reason === 'string' && cur.reason.trim() ? cur.reason.trim().slice(0, 300) : ''
    }
    if (key === 'doomloop') {
      const t = Number(cur.threshold)
      item.threshold = Number.isFinite(t) && t >= 1 ? Math.floor(t) : 6
    }
    out[key] = item
  }
  out.tools = normalizeToolPerms(src.tools)
  out.rules = normalizeRules(src.rules)
  // 保留兜底理由本身，供界面回显与后续编辑
  out.fallbackReason = typeof src.fallbackReason === 'string' ? src.fallbackReason.slice(0, 300) : ''
  out.fileAllow = normalizeFileAllow(src.fileAllow)
  return out
}

/** 正则规则归一化：非法正则直接丢弃，不阻塞保存。 */
function normalizeRules(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const r of raw.slice(0, 60)) {
    if (!r || typeof r.pattern !== 'string') continue
    const pattern = r.pattern.trim()
    if (pattern.length === 0 || pattern.length > 300) continue
    try {
      new RegExp(pattern)
    } catch (e) {
      continue
    }
    const target = ['tool', 'command', 'path', 'any'].includes(r.target) ? r.target : 'any'
    const mode = r.mode === 'allow' ? 'allow' : r.mode === 'ask' ? 'ask' : 'deny'
    out.push({
      pattern,
      target,
      mode,
      // 拒绝与询问都保留理由：询问时用于说明「为什么要确认这一步」
      reason: mode !== 'allow' && typeof r.reason === 'string' ? r.reason.slice(0, 300) : '',
      enabled: r.enabled !== false
    })
  }
  return out
}

/* ------------------------------ 工具中文说明 ------------------------------ */

/**
 * 内置工具的中文说明。注册表里是英文原文，这里给出中文对照；
 * 未收录的工具（第三方插件新装的）回落到注册表原文，不会丢信息。
 */
const TOOL_ZH = {
  // 文件读取
  read: '读取文件内容',
  read_image: '读取图片',
  working_directory: '查看或切换当前工作目录',
  // 查找
  glob: '按通配符查找文件路径',
  grep: '按正则搜索文件内容',
  // 写入
  write: '写入或覆盖文件',
  edit: '编辑文件片段',
  // 命令
  bash: '执行 shell 命令',
  // 联网
  web_search: '联网搜索',
  web_fetch: '抓取指定网页内容',
  // 子代理 / 团队
  subagent: '启动子代理处理独立任务',
  subagent_fork: '启动继承当前对话的子代理',
  workflow: '运行多子代理编排脚本',
  send_message: '给代理发消息',
  interrupt_agent: '中断子代理当前工作',
  list_agents: '列出已启动的子代理',
  agent_teams_create: '创建团队',
  agent_teams_add_member: '添加团队成员',
  agent_teams_remove_member: '移除团队成员',
  agent_teams_create_task: '创建团队任务',
  agent_teams_update_task: '更新任务状态或产出',
  agent_teams_claim_task: '认领自己的任务',
  agent_teams_reassign_task: '重试/改派/接管任务',
  agent_teams_amend_task: '修订质量任务的契约',
  agent_teams_approve: '批准并启动团队计划',
  agent_teams_edit_plan: '修改团队计划',
  agent_teams_send_message: '给团队成员发消息',
  agent_teams_status: '查看团队状态',
  agent_teams_resume: '恢复已暂停的团队',
  agent_teams_delete: '结束并归档团队',
  // 任务 / 计划
  todo_write: '记录并更新待办清单',
  create_goal: '创建跨轮次持续推进的目标',
  get_goal: '读取当前目标',
  update_goal: '更新目标状态',
  exit_plan_mode: '提交计划并退出计划模式',
  // 后台任务
  job_list: '列出后台任务',
  job_output: '读取后台任务输出',
  job_kill: '终止后台任务',
  // 其他
  skill: '加载技能说明',
  present: '把文件作为交付物呈现',
  ask_user_question: '向用户提问确认',
  plugin_manager: '查看或启停插件',
  cordis_inspect_list: '列出可检查的内部对象',
  cordis_inspect_query: '只读查询内部状态',
  // 定时
  schedule_create: '创建定时提醒',
  schedule_update: '修改定时提醒',
  schedule_list: '列出定时提醒',
  schedule_delete: '删除定时提醒'
}

/** 取工具的中文说明；没有对照时用注册表原文（截断）。 */
function toolDescZh(name, original) {
  const zh = TOOL_ZH[name]
  if (typeof zh === 'string' && zh.length > 0) return zh
  const raw = typeof original === 'string' ? original.trim() : ''
  if (raw.length === 0) return ''
  return raw.slice(0, 90)
}

/* ------------------------------ 工具目录（动态发现） ------------------------------ */

/**
 * 从运行中的工具注册表枚举所有可见工具。
 * 这是「动态发现」的唯一来源 —— 不硬编码任何插件前缀：
 * 任何插件注册的工具（AgentTeams、taskboard、子代理…）都会自动出现，
 * 用户可按工具逐项设置 询问/允许/拒绝。
 */
function toolCatalog(ctx) {
  const found = new Map()
  let registry
  try {
    registry = ctx && typeof ctx.get === 'function' ? ctx.get('tools') : undefined
  } catch (e) {
    return { tools: [], error: String((e && e.message) || e) }
  }
  if (!registry) return { tools: [], error: 'tools 服务不可用' }

  function absorb(layer) {
    const table = layer && layer.tools
    if (!table || typeof table.entries !== 'function') return
    try {
      for (const [name, def] of table.entries()) {
        if (typeof name === 'string' && name.length > 0) found.set(name, def)
      }
    } catch (e) {}
  }

  // 1) 全局层
  try { absorb(registry.layers && registry.layers.global) } catch (e) {}
  // 2) 各作用域层（插件通过 ctx.inject 注册的工具落在自己的 scope 层，
  //    只读全局层会漏掉它们——analyzeImage 就是这么漏的）
  try {
    const scoped = registry.layers && registry.layers.scoped
    if (scoped && typeof scoped.values === 'function') {
      for (const layer of scoped.values()) absorb(layer)
    }
  } catch (e) {}
  // 3) 兜底：若内部层结构变了，退回公开的 schemas() 投影
  if (found.size === 0) {
    try {
      if (typeof registry.schemas === 'function') {
        for (const schema of registry.schemas()) {
          if (schema && typeof schema.name === 'string') found.set(schema.name, schema)
        }
      }
    } catch (e) {}
  }

  const tools = []
  for (const [name, def] of found.entries()) {
    const rawDesc = def && typeof def.description === 'string' ? def.description : ''
    tools.push({ name, description: toolDescZh(name, rawDesc), category: toolCategory(name, {}) || 'other' })
  }
  tools.sort((a, b) => a.name.localeCompare(b.name))
  return { tools }
}

/* ------------------------------ 当前档位解析 ------------------------------ */

function currentSession(exec) {
  try {
    const agent = exec && exec.agent
    if (agent && agent.session) return agent.session
    if (agent && typeof agent.sessionId === 'string' && ctx0 && typeof ctx0.get === 'function') {
      const sessions = ctx0.get('sessions')
      if (sessions && typeof sessions.list === 'function') {
        const all = sessions.list()
        if (Array.isArray(all)) {
          const hit = all.find((s) => s && (s.id === agent.sessionId || s.sessionId === agent.sessionId))
          if (hit) return hit
        }
      }
    }
  } catch {}
  return null
}
/** 由 apply 注入的 ctx 引用，供无参调用路径兜底解析会话。 */
let ctx0 = null

function currentPresetName(exec, ctx) {
  try {
    const session = currentSession(exec)
    if (!session) return null
    // 用 ctx.get 安全取服务：未声明 inject 时直接属性访问在 cordis 里会抛错
    const pp = typeof ctx.get === 'function' ? ctx.get('permissionPresets') : ctx.permissionPresets
    if (pp && typeof pp === 'object') {
      if (typeof pp.permissionState === 'function') {
        const st = pp.permissionState(session)
        if (st && typeof st.preset === 'string' && st.preset.length > 0) return st.preset
      }
      if (typeof pp.current === 'function') {
        const cur = pp.current(session)
        if (typeof cur === 'string' && cur.length > 0 && cur !== 'custom') return cur
      }
    }
  } catch {}
  return null
}

/* ------------------------------ 裁决 ------------------------------ */

const loopState = new Map()

function loopKey(exec) {
  const session = currentSession(exec)
  const id = session && (session.id || session.sessionId || 'default')
  return String(id || 'default')
}

function fingerprint(exec) {
  let args
  try {
    args = JSON.stringify(exec.arguments || {})
  } catch {
    args = String(exec.arguments)
  }
  if (args.length > 2000) args = args.slice(0, 2000)
  return String(exec.name) + '|' + args
}

/**
 * 正则规则引擎：按「目标字符串」做 allow/deny 匹配，优先级高于分类与工具级设置。
 *
 * 规则形状：{ pattern, target, mode: 'allow'|'deny', reason }
 *   - target: 'tool'（工具名）| 'command'（命令文本）| 'path'（路径参数）| 'any'（以上都试）
 *   - pattern: JS 正则源码（不带 /.../ 包裹）
 *   - mode: 'allow' 立即放行（白名单）| 'deny' 立即拒绝
 *
 * 求值顺序：deny 规则先于 allow 规则；同类中按数组顺序，第一条命中即生效。
 * 这样「白名单 + 黑名单」可以共存：先看有没有明确禁止，再看有没有明确放行。
 */
function matchRule(rule, subject) {
  if (!rule || typeof rule.pattern !== 'string' || rule.pattern.length === 0) return false
  try {
    const re = new RegExp(rule.pattern)
    return re.test(subject)
  } catch (e) {
    return false // 正则写错视为不命中，不阻塞主流程
  }
}

/** 收集一次调用可能被规则检查的目标字符串。 */
function ruleSubjects(exec) {
  const name = String(exec.name || '')
  const args = exec.arguments || {}
  const out = { tool: name, command: '', paths: [] }
  for (const k of COMMAND_KEYS) {
    const v = args[k]
    if (typeof v === 'string' && v.length > 0) out.command += (out.command ? ' ' : '') + v
  }
  for (const p of pathsOf(args)) out.paths.push(p)
  return out
}

/**
 * 对一次调用求值正则规则。
 * @returns {{mode:string, reason:string, rule:object}|null} 命中的规则；未命中返回 null
 */
function evalRules(exec, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null
  const subj = ruleSubjects(exec)
  const enabled = rules.filter((r) => r && r.enabled !== false && MODES.includes(r.mode))
  const hit = (rule) => {
    const target = rule.target || 'any'
    if (target === 'tool') return matchRule(rule, subj.tool)
    if (target === 'command') return subj.command.length > 0 && matchRule(rule, subj.command)
    if (target === 'path') return subj.paths.some((p) => matchRule(rule, p))
    return matchRule(rule, subj.tool)
      || (subj.command.length > 0 && matchRule(rule, subj.command))
      || subj.paths.some((p) => matchRule(rule, p))
  }
  // 优先级：拒绝 > 询问 > 允许。黑名单先兜住危险操作，询问居中，白名单兜底放行。
  const deny = enabled.find((r) => r.mode === 'deny' && hit(r))
  if (deny) return { mode: 'deny', reason: deny.reason || '', rule: deny }
  const ask = enabled.find((r) => r.mode === 'ask' && hit(r))
  if (ask) return { mode: 'ask', reason: ask.reason || '', rule: ask }
  const allow = enabled.find((r) => r.mode === 'allow' && hit(r))
  if (allow) return { mode: 'allow', reason: '', rule: allow }
  return null
}

/**
 * 拒绝理由解析：用户单独填写的 > 档位兜底理由 > 分类默认引导语。
 * 放在判定阶段而不是保存阶段，改兜底能一次生效到所有留空项。
 */
function resolveDenyReason(result, perms) {
  if (!result || result.mode !== 'deny') return result
  if (result.reason && result.reason.trim().length > 0) return result
  const fb = perms && typeof perms.fallbackReason === 'string' ? perms.fallbackReason.trim() : ''
  if (fb.length > 0) return { ...result, reason: fb }
  const key = String(result.cat || '').replace(/^tool:/, '')
  const cat = CATS.find((c) => c.key === key)
  if (cat && cat.defaultReason) return { ...result, reason: cat.defaultReason }
  // 逐工具拒绝（cat 形如 tool:xxx）没有专属分类时，用「其他工具」的引导语
  const other = CATS.find((c) => c.key === 'other')
  if (String(result.cat || '').startsWith('tool:') && other && other.defaultReason) {
    return { ...result, reason: other.defaultReason }
  }
  return { ...result, reason: '该操作在当前权限档位下被拒绝。' }
}

/** 从档位配置里算出「要剔除」的工具名；restrictable 提供时只保留可限制的全局工具。 */
function planHiddenTools(perms, restrictable) {
  const toolsMap = (perms && perms.tools) || {}
  const wanted = Object.keys(toolsMap).filter((n) => toolsMap[n] && toolsMap[n].mode === 'hide')
  if (restrictable instanceof Set) return wanted.filter((n) => restrictable.has(n))
  return wanted
}

/**
 * 把剔除计划施加到某个 tools 服务：先撤销上一轮的限制，再按需施加新的。
 *
 * DSH 的 restrict 是「取交集累加」的，不撤销就等于只增不减——切档到没有剔除项的
 * 档位时工具必须能全部回来，所以这里必须 revoke → apply。
 *
 * @param toolService - 具备 restrict() 的工具服务（agent 作用域）
 * @param agent - 用于取旧 disposer 的 agent（需要 id）
 * @param deny - 本次要剔除的工具名
 * @param store - Map<agentId, disposer>，跨调用保存撤销句柄
 * @returns {{revoked:boolean, applied:number}}
 */
function syncHiddenTools(toolService, agent, deny, store) {
  let revoked = false
  const prev = store.get(agent.id)
  if (typeof prev === 'function') {
    try {
      prev()
      revoked = true
    } catch (e) {}
    store.delete(agent.id)
  }
  if (!deny || deny.length === 0) return { revoked, applied: 0 }
  const dispose = toolService.restrict({ deny })
  store.set(agent.id, dispose)
  return { revoked, applied: deny.length }
}

function decide(exec, perms, studio) {
  return resolveDenyReason(decideInner(exec, perms, studio), perms)
}

function decideInner(exec, perms, studio) {
  const name = String(exec.name || '')
  const args = exec.arguments

  // 0) 正则规则最高优先：deny 规则 → allow 规则（白名单可覆盖分类，黑名单可兜住一切）
  const ruled = evalRules(exec, perms && perms.rules)
  if (ruled && ruled.mode === 'deny') {
    return { mode: 'deny', reason: ruled.reason, cat: 'rule', value: name }
  }
  if (ruled && ruled.mode === 'ask') {
    return { mode: 'ask', reason: ruled.reason, cat: 'rule', value: name }
  }
  if (ruled && ruled.mode === 'allow') {
    return { mode: 'allow', reason: '', cat: 'rule', value: name }
  }

  // 1) 工具级覆盖（动态发现的工具清单）优先于任何分类规则
  const override = perms && perms.tools ? perms.tools[name] : undefined
  if (override && override.mode === 'hide') {
    // 已从工具清单剔除；若仍被调用（如缓存了下发的 schema），照样拦住
    return { mode: 'deny', reason: override.reason, cat: 'tool:' + name, value: '' }
  }
  if (override && MODES.includes(override.mode)) {
    return { mode: override.mode, reason: override.reason, cat: 'tool:' + name, value: '' }
  }

  const rawCat = toolCategory(name, args)

  // 兜底：未归类的工具走 other 分类（默认放行，但用户可设 ask/deny 覆盖）
  if (rawCat === null) {
    const quick = studio.quickTools && studio.quickTools[name]
    if (quick && hasAny(quick.mode)) return { mode: quick.mode, reason: quick.reason, cat: name, value: null }
    const otherPerm = perms && perms.other
    if (otherPerm && MODES.includes(otherPerm.mode) && otherPerm.mode !== 'allow') {
      return { mode: otherPerm.mode, reason: otherPerm.reason, cat: 'other', value: name }
    }
    return { mode: 'allow', reason: '', cat: null, value: null }
  }

  // 区外拆闸：读类走 outsideRead，写类走 outsideWrite
  let cat = rawCat
  const root = workspaceRootOf(exec)
  if (root && (rawCat === 'read' || rawCat === 'image' || rawCat === 'search' || rawCat === 'edit' || rawCat === 'undo')) {
    const outside = pathsOf(args).some((p) => isOutside(root, p))
    if (outside) cat = (rawCat === 'read' || rawCat === 'image' || rawCat === 'search') ? 'outsideRead' : 'outsideWrite'
  }

  // 文件规则：允许 / 询问 / 拒绝 三态，逐条按路径匹配（比分类更细的一层）
  const fa = perms && perms.fileAllow
  if (fa && fa.enabled
      && (rawCat === 'read' || rawCat === 'search' || rawCat === 'image' || rawCat === 'edit' || rawCat === 'undo')) {
    const ruleList = Array.isArray(fa.entries) ? fa.entries : []
    const needWrite = rawCat === 'edit' || rawCat === 'undo'
    const targets = pathsOf(args)
    if (targets.length > 0) {
      const hits = targets.map((p) => {
        const hit = matchFileRule(root, p, needWrite, ruleList)
        return { path: p, mode: hit ? hit.mode : null, reason: hit ? hit.reason : '' }
      })
      const denied = hits.find((h) => h.mode === 'deny')
      const asked = hits.find((h) => h.mode === 'ask')
      const unmatched = hits.find((h) => h.mode === null)
      const action = needWrite ? '写入' : '读取'
      if (denied) {
        // 规则自己写了提示词就用它，否则用通用说明
        const reason = denied.reason && denied.reason.trim() ? denied.reason.trim() : fileRuleReason(fa, denied.path, action, true)
        return { mode: 'deny', reason, cat: 'fileAllow', value: name }
      }
      if (asked) {
        return { mode: 'ask', reason: '', cat: 'fileAllow', value: name }
      }
      if (!unmatched) {
        // 全部命中 allow：这一层直接放行，不必再受分类规则牵制
        return { mode: 'allow', reason: '', cat: 'fileAllow', value: name }
      }
      if (fa.fallback === 'deny') {
        return { mode: 'deny', reason: fileRuleReason(fa, unmatched.path, action, false), cat: 'fileAllow', value: name }
      }
    }
  }

  // 重复操作：连续相同调用达到阈值 → 按 doomloop 配置  // 重复操作：连续相同调用达到阈值 → 按 doomloop 配置
  const catPerm = perms[cat] || { mode: 'allow' }
  if (cat !== 'doomloop') {
    const key = loopKey(exec)
    const fp = fingerprint(exec)
    const st = loopState.get(key) || { fp: '', count: 0 }
    const threshold = (perms.doomloop && perms.doomloop.threshold) || 6
    if (st.fp === fp) {
      st.count += 1
      if (st.count >= threshold && perms.doomloop && perms.doomloop.mode !== 'allow') {
        loopState.set(key, { fp: '', count: 0 })
        return {
          mode: perms.doomloop.mode,
          reason: perms.doomloop.reason || '检测到重复操作：同一次调用已连续放行多次，疑似卡死循环。',
          cat: 'doomloop',
          value: name
        }
      }
    } else {
      st.fp = fp
      st.count = 1
    }
    loopState.set(key, st)
  }

  return { mode: catPerm.mode, reason: catPerm.reason, cat, value: pathsOf(args)[0] || '' }
}

/* ------------------------------ 路由与 UI ------------------------------ */

function findPermissionEntry(configEditor) {
  for (const c of configEditor.configuration()) {
    const entry = c.entry
    const id = entry.options.id
    const entryName = entry.options.name
    if (id !== undefined && PERMISSION_IDS.has(id)) return c
    if (entryName !== undefined && PERMISSION_NAMES.has(entryName)) return c
  }
  return undefined
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 512 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text.length ? JSON.parse(text) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function writeJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function normalizePresetMeta(presets) {
  if (typeof presets !== 'object' || presets === null || Array.isArray(presets)) throw new Error('presets 必须是对象')
  const keys = Object.keys(presets)
  if (keys.length === 0) throw new Error('至少保留一个档位')
  const out = {}
  for (const key of keys) {
    if (RESERVED.has(key)) throw new Error(`档位名 "${key}" 是保留名（custom/auto 不可用）`)
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(key)) throw new Error(`档位名 "${key}" 只允许小写字母/数字/连字符`)
    const v = presets[key]
    if (typeof v !== 'object' || v === null) throw new Error(`档位 "${key}" 缺少配置`)
    if (!SANDBOX_MODES.includes(v.sandbox)) throw new Error(`档位 "${key}" 的 sandbox 不合法`)
    if (!APPROVAL_POLICIES.includes(v.approval)) throw new Error(`档位 "${key}" 的 approval 不合法`)
    const name = v.name === undefined ? undefined : String(v.name)
    const description = v.description === undefined ? undefined : String(v.description)
    out[key] = {
      sandbox: v.sandbox,
      approval: v.approval,
      ...(name === undefined ? {} : { name }),
      ...(description === undefined ? {} : { description })
    }
  }
  return out
}

function resolveDefaultPreset(rawDefault, keys, current) {
  if (rawDefault === undefined || rawDefault === null || rawDefault === '') {
    return current && keys.includes(current) ? current : keys[0]
  }
  if (!keys.includes(rawDefault)) throw new Error(`默认档 "${rawDefault}" 不在档位表里`)
  return rawDefault
}

/* ------------------------------ 宿主插件 ------------------------------ */

export function apply(ctx) {
  ctx0 = ctx
  const webServer = ctx.get('webServer')
  const configEditor = ctx.get('configEditor')
  if (webServer === undefined || configEditor === undefined) return

  // 细粒度权限（自己文件）+ 档位元信息（permission patch）
  let studio = {}
  const ready = (async () => {
    studio = await loadStudioConfig()
  })()

  // ── 工具剔除：把 hide 的工具从模型的工具清单里真正移除 ──────────
  // DSH 的 tools.restrict() 只允许在 agent 作用域调用，所以挂在 agent/created 上，
  // 按该会话当前档位算出要剔除的工具名，再对 agent.ctx 施加限制。
  const hiddenDisposers = new Map()

  async function applyHiddenTools(agent, presetName) {
    const toolService = agent && agent.ctx ? agent.ctx.get('tools') : undefined
    if (!toolService || typeof toolService.restrict !== 'function') return
    const perms = studio.presets && studio.presets[presetName]
    // 只保留 DSH 认识的全局工具名，未知名字会让 restrict 抛错
    let restrictable
    try {
      const view = typeof toolService.view === 'function' ? toolService.view(agent) : undefined
      restrictable = view && view.restrictableNames instanceof Set ? view.restrictableNames : undefined
    } catch (e) {
      restrictable = undefined
    }
    const deny = planHiddenTools(perms, restrictable)
    try {
      // restrict 的限制会「取交集」累积，切档必须先撤销上一条（否则工具回不来）
      const result = syncHiddenTools(toolService, agent, deny, hiddenDisposers)
      if (result.applied === 0) return
      if (process.env.DSH_PSTUDIO_DEBUG === '1') {
        // 施加后立刻回读该 agent 的工具清单，验证工具确实消失（而不是只写了个配置）
        let left = 'unknown'
        try {
          const names = toolService.schemas(agent).map((x) => x.name)
          const still = deny.filter((n) => names.includes(n))
          left = 'visible=' + names.length + ' stillPresent=[' + still.join(',') + ']'
        } catch (e) {
          left = 'readback failed: ' + ((e && e.message) || e)
        }
        console.log('[pstudio] hidden for ' + agent.id + ': deny=[' + deny.join(',') + '] ' + left)
      }
    } catch (e) {
      console.log('[pstudio] restrict failed: ' + ((e && e.message) || e))
    }
  }

  // ── 档位切换即时生效：不必等新建会话 ──────────────────────────
  // permission/preset、sandbox/mode、approval/policy 任一变化都重新计算并施加剔除。
  const PRESET_EVENTS = new Set(['permission/preset', 'sandbox/mode', 'approval/policy'])
  ctx.on('session/event', async (session, event) => {
    try {
      if (!event || !PRESET_EVENTS.has(event.type)) return
      await ready
      const sessionId = session && session.id
      if (!sessionId) return
      const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined
      const agent = agents && typeof agents.get === 'function' ? agents.get(sessionId) : undefined
      if (!agent) return
      const presetName = currentPresetName({ agent }, ctx)
      if (!presetName) return
      await applyHiddenTools(agent, presetName)
    } catch (e) {
      console.log('[pstudio] preset change hook failed: ' + ((e && e.message) || e))
    }
  }, { global: true })

  ctx.on('agent/created', async ({ agent }) => {
    try {
      await ready
      if (!agent) return
      const presetName = currentPresetName({ agent }, ctx)
      if (!presetName) return
      await applyHiddenTools(agent, presetName)
    } catch (e) {
      console.log('[pstudio] agent/created hook failed: ' + ((e && e.message) || e))
    }
  }, { global: true })

  // 启动自检：确认关键服务可见（缺服务会导致闸门静默放行，必须能看见）
  try {
    const pp = typeof ctx.get === 'function' ? ctx.get('permissionPresets') : undefined
    const tools = typeof ctx.get === 'function' ? ctx.get('tools') : undefined
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    console.log('[permission-studio] ppProto: ' + (pp ? Object.getOwnPropertyNames(Object.getPrototypeOf(pp)).join('/') : 'none'))
    console.log('[permission-studio] services: permissionPresets=' + (pp ? 'yes' : 'NO')
      + ' tools=' + (tools ? 'yes' : 'NO')
      + ' sessions=' + (sessions ? 'yes' : 'NO')
      + (pp ? ' ppApi=' + Object.keys(pp).join('/') : ''))
  } catch (e) {
    console.log('[permission-studio] service probe failed: ' + ((e && e.message) || e))
  }

  // pre-execute 闸门：按当前档位的九类权限裁决
  // ⚠️ 必须 global:true：宿主用 waterfall(scopeTarget(exec.agent), ...) 派发，
  // 带作用域过滤；非 global 的监听器会被 filter 掉，钩子形同不存在（曾导致
  // 「档位全拒绝但 ls 仍能执行」）。global 让本闸门对所有 agent 生效。
  ctx.on('tools/pre-execute', async (exec, next) => {
    try {
      await ready
      const presetName = currentPresetName(exec, ctx)
      if (process.env.DSH_PSTUDIO_DEBUG === '1') {
        const pp = typeof ctx.get === 'function' ? ctx.get('permissionPresets') : undefined
        const session = exec && exec.agent && exec.agent.session
        let detail = 'none'
        try {
          if (pp && session) {
            const st = typeof pp.permissionState === 'function' ? pp.permissionState(session) : null
            const cur = typeof pp.current === 'function' ? pp.current(session) : null
            detail = 'state=' + JSON.stringify(st) + ' current=' + JSON.stringify(cur)
          }
        } catch (e) {
          detail = 'ERR ' + ((e && e.message) || e)
        }
        console.log('[pstudio] tool=' + exec.name + ' preset=' + String(presetName)
          + ' session=' + (session ? 'yes' : 'no')
          + ' ' + detail
          + ' loaded=' + Object.keys((studio && studio.presets) || {}).join(','))
      }
      if (!presetName) return next()
      const perms = studio.presets && studio.presets[presetName]
      if (!perms) return next()
      const d = decide(exec, normalizePerms(perms, (studio.sandboxOf && studio.sandboxOf[presetName]) || 'workspace-write'), studio)
      if (d.mode === 'deny') {
        const reason = d.reason || '该操作在当前权限档位下被拒绝。'
        return { kind: 'deny', reason }
      }
      if (d.mode === 'ask') return next() // 交回 DSH 原生审批（受该档位 approval 旋钮控制）
      return next()
    } catch (e) {
      // fail-safe：本插件自身异常时不放行可疑调用
      return { kind: 'deny', reason: '权限档位插件内部错误，已拒绝本次调用；请重试或切换到其他档位。' }
    }
  }, { global: true })

  const disposer = webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      const rawUrl = (req.url ?? '').split('?')[0]
      try {
        await ready
        if (req.method === 'GET' && (rawUrl === ROUTE || rawUrl === ROUTE + '/')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(renderPage())
          return
        }
        if (req.method === 'GET' && rawUrl === ROUTE + '/api') {
          const found = findPermissionEntry(configEditor)
          if (found === undefined) {
            writeJson(res, 404, { ok: false, error: '未找到 permission 配置条目（@deepseek-ai/dsh-permission-presets）' })
            return
          }
          const current = found.entry.options.config ?? {}
          const presets = current.presets ?? {}
          const merged = {}
          for (const [id, meta] of Object.entries(presets)) {
            merged[id] = {
              sandbox: meta.sandbox,
              approval: meta.approval,
              name: meta.name,
              description: meta.description,
              icon: (studio.icons || {})[id] || '',
              iconSvg: iconSvg((studio.icons || {})[id] || '', 16),
              perms: normalizePerms((studio.presets || {})[id], meta.sandbox)
            }
          }
          const catalog = toolCatalog(ctx)
          writeJson(res, 200, {
            ok: true,
            presets: merged,
            defaultPreset: current.defaultPreset ?? '',
            cats: CATS.map((c) => ({ key: c.key, label: c.label, hint: c.hint, defaultReason: c.defaultReason })),
            tools: catalog.tools,
            toolsError: catalog.error,
            modes: MODES,
            enum: { sandbox: SANDBOX_MODES, approval: APPROVAL_POLICIES }
          })
          return
        }
        if (req.method === 'POST' && rawUrl === ROUTE + '/api') {
          const found = findPermissionEntry(configEditor)
          if (found === undefined) {
            writeJson(res, 404, { ok: false, error: '未找到 permission 配置条目（@deepseek-ai/dsh-permission-presets）' })
            return
          }
          let body
          try {
            body = await readJson(req)
          } catch {
            writeJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
            return
          }
          let meta
          let permsIn
          try {
            meta = normalizePresetMeta(body.presets)
            permsIn = body.perms && typeof body.perms === 'object' ? body.perms : {}
            for (const key of Object.keys(meta)) {
              const raw = permsIn[key]
              if (raw !== undefined && (typeof raw !== 'object' || raw === null)) throw new Error(`档位 "${key}" 的权限配置格式不正确`)
              normalizePerms(raw, meta[key].sandbox)
            }
          } catch (e) {
            writeJson(res, 400, { ok: false, error: (e && e.message) || String(e) })
            return
          }
          const keys = Object.keys(meta)
          let defaultPreset
          try {
            defaultPreset = resolveDefaultPreset(body.defaultPreset, keys, found.entry.options.config && found.entry.options.config.defaultPreset)
          } catch (e) {
            writeJson(res, 400, { ok: false, error: (e && e.message) || String(e) })
            return
          }
          // 1) 先写细粒度权限（自己文件）
          const nextStudio = { ...studio, presets: {}, sandboxOf: {} }
          for (const key of keys) {
            nextStudio.presets[key] = normalizePerms(permsIn[key], meta[key].sandbox)
            nextStudio.sandboxOf[key] = meta[key].sandbox
          }
          // 内置档位沿用旧配置（没有就给默认值），切到内置档位时行为可预期
          const prevPresets = (studio && studio.presets) || {}
          for (const id of BUILTIN_PRESETS) {
            if (Object.hasOwn(nextStudio.presets, id)) continue
            const sandbox = (found.entry.options.config?.presets?.[id]?.sandbox) || id
            nextStudio.presets[id] = normalizePerms(prevPresets[id], sandbox)
            nextStudio.sandboxOf[id] = sandbox
          }
          if (body.quickTools && typeof body.quickTools === 'object') nextStudio.quickTools = body.quickTools
          // 档位图标：存在本插件自己的配置里，不写进 DSH 原生 permission 配置（避免 schema 冲突）
          if (body.icons && typeof body.icons === 'object') {
            const nextIcons = {}
            for (const key of keys) {
              const raw = body.icons[key]
              if (typeof raw === 'string' && PRESET_ICONS.some((i) => i.id === raw)) nextIcons[key] = raw
            }
            nextStudio.icons = nextIcons
          }
          try {
            await saveStudioConfig(nextStudio)
            studio = nextStudio
          } catch (e) {
            writeJson(res, 500, { ok: false, error: '写入细粒度权限失败：' + ((e && e.message) || e) })
            return
          }
          // 2) 再写档位元信息（profile patch → 热重载）
          try {
            const current = found.entry.options.config ?? {}
            // 内置三档不在界面上编辑，但绝不能被保存动作删除：
            // 把它们从当前 profile 配置里补回去（用户看不到 ≠ 该被抹掉）。
            const currentPresets = current.presets && typeof current.presets === 'object' ? current.presets : {}
            const mergedPresets = { ...meta }
            // 内置三档无条件补回：保存动作只负责改档位内容，绝不允许顺手删掉别人。
            for (const id of BUILTIN_PRESETS) {
              if (currentPresets[id] && !Object.hasOwn(mergedPresets, id)) mergedPresets[id] = currentPresets[id]
            }
            const next = { ...current, presets: mergedPresets, defaultPreset }
            await configEditor.edit(found.entry, () => next)
          } catch (e) {
            writeJson(res, 400, { ok: false, error: (e && e.message) || String(e) })
            return
          }
          writeJson(res, 200, { ok: true })
          return
        }
        writeJson(res, 404, { ok: false, error: 'not found' })
      } catch (e) {
        writeJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
      }
    }
  })
  return () => disposer()
}

/* ------------------------------ 管理页 ------------------------------ */

function renderPage() {
  const meta = JSON.stringify(CATS)
  const modes = JSON.stringify(MODES)
  const sandboxModes = JSON.stringify(SANDBOX_MODES)
  const approvalPolicies = JSON.stringify(APPROVAL_POLICIES)
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>权限档位</title>
<style>
:root{--ink:#0f1115;--muted:#81858c;--line:rgba(0,0,0,.12);--line-strong:rgba(0,0,0,.16);--soft:#f5f6f8;--active:#ebedf2;--danger:#c0341d;--ok:#2f7d44}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--ink);font:14px/1.6 -apple-system,system-ui,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
h1 .ver{font-family:ui-monospace,Menlo,monospace;font-size:11px;font-weight:400;color:var(--muted);background:rgba(51,47,40,.06);border-radius:999px;padding:2px 8px;margin-left:8px;vertical-align:middle;letter-spacing:0}
.wrap{max-width:860px;margin:0 auto;padding:24px 20px 72px}
h1{font-size:20px;font-weight:600;letter-spacing:-.01em;margin:0 0 2px}
.sub{color:var(--muted);font-size:13px;margin:0 0 18px}
.sub code{background:var(--soft);border-radius:6px;padding:1px 5px;font-size:12px}
.card{border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px;background:#fff}
.head{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
.id{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-weight:600;font-size:14px;line-height:36px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;margin-top:8px}
label{display:flex;flex-direction:column;font-size:12px;color:var(--muted);gap:4px}
input,select{height:36px;border:1px solid var(--line-strong);border-radius:12px;padding:0 10px;background:#fff;color:var(--ink);font:inherit;font-size:14px}
input:focus,select:focus{outline:none;border-color:rgba(0,0,0,.32);box-shadow:0 0 0 3px rgba(0,0,0,.04)}
input[type="checkbox"]{height:16px;width:16px;border-radius:4px;padding:0}
button{height:32px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);font:inherit;font-size:13px;cursor:pointer;transition:background .12s ease}
button:hover{background:var(--soft)}
button.primary{background:var(--ink);color:#fff;border-color:var(--ink)}
button.primary:hover{background:#233}
button:disabled{opacity:.5;cursor:default}
.msg{margin-top:12px;font-size:13px;min-height:1.4em;color:var(--muted)}
.msg.ok{color:var(--ok)}
.msg.err{color:var(--danger)}
.cat{margin-top:12px;border-top:1px solid rgba(0,0,0,.08);padding-top:12px}
.catHead{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.catName{font-weight:600;font-size:13px}
.catHint{font-size:12px;color:var(--muted)}
.catReason{margin-top:8px;display:none}
.catReason input{width:100%}
.catReason.show{display:block}
.permMode{display:inline-flex;gap:6px}
.permMode button{height:30px;border-radius:8px;color:var(--muted);border-color:var(--line)}
.permMode button[aria-pressed="true"]{background:var(--ink);color:#fff;border-color:var(--ink)}
.permMode button[data-mode="deny"][aria-pressed="true"]{background:var(--danger);border-color:var(--danger);color:#fff}
.permMode button[data-mode="allow"][aria-pressed="true"]{background:var(--ink);border-color:var(--ink);color:#fff}
.toolbar{position:sticky;bottom:0;background:#fff;padding:12px 0 6px;margin-top:16px;border-top:1px solid var(--line);display:flex;gap:8px}
.del{color:var(--danger)}
button.collapse{height:24px;width:24px;padding:0;border:none;background:transparent;color:var(--muted);font-size:11px;display:inline-flex;align-items:center;justify-content:center}
button.collapse:hover{background:var(--soft);border-radius:6px}
button.collapse .caret{display:block}
.titleWrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1 1 auto;min-width:0}
.nameTag{font-size:13px;color:var(--ink)}
.builtinTag{font-size:11px;color:var(--muted);background:var(--soft);border-radius:5px;padding:1px 6px}
.defaultTag{font-size:11px;color:#fff;background:var(--ink);border-radius:5px;padding:1px 6px}
.summary{font-size:11.5px;color:var(--muted);margin-left:auto}
.head.fields{margin-top:10px;padding-top:10px;border-top:1px solid rgba(0,0,0,.06)}
.fallbackRow{margin-top:10px}
.fallbackRow label{flex:1 1 100%}
.fallbackRow input{background:#fffdf8;width:100%}
details.rulesBlock{margin-top:12px;border:1px solid var(--border);border-radius:9px;padding:0 12px 4px}
.faHead{margin:2px 0 8px}
.faToggle{font-size:13px;color:var(--ink);display:inline-flex;flex-direction:row;align-items:center;gap:6px;cursor:pointer}
.faList{display:flex;flex-direction:column;gap:6px}
.faRow{display:flex;align-items:center;gap:8px}
input.faPattern{flex:1 1 auto;min-width:0;height:32px;font-size:13px}
.faMode{font-size:12.5px;color:var(--muted);display:inline-flex;flex-direction:row;align-items:center;gap:4px;flex:none;cursor:pointer}
button.faDel{height:28px;padding:0 10px;font-size:12px;flex:none}
button.faAdd{margin-top:8px;height:30px;font-size:12.5px}
.faExamples{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:10px}
.faExLabel{font-size:12px;color:var(--muted)}
button.faChip{height:26px;padding:0 9px;font-size:12px;border-radius:999px;background:#fffdf8;font-family:ui-monospace,Menlo,monospace}
.faNote{font-size:11.5px;color:var(--muted);line-height:1.6;margin:10px 0 8px}
.faHint{font-size:12px;color:var(--muted);line-height:1.6;margin:2px 0 10px;padding:8px 10px;background:rgba(51,47,40,.03);border-radius:7px}
.faWarn{display:flex;flex-direction:row;align-items:center;gap:10px;flex-wrap:wrap;margin:0 0 10px;padding:9px 11px;border-radius:7px;background:rgba(176,58,40,.06);border:1px solid rgba(176,58,40,.25)}
.faWarnText{flex:1 1 320px;font-size:12px;line-height:1.6;color:#8d2f21}
button.faFix{height:28px;padding:0 11px;font-size:12px;flex:none;background:#B03A28;color:#fff;border-color:#B03A28}
button.faQuick{margin:0 0 10px;height:30px;font-size:12.5px}
.faQuickRow{display:flex;flex-direction:row;align-items:center;gap:8px;margin:2px 0 10px;flex-wrap:wrap}
.faQuickLabel{font-size:12px;color:var(--muted)}
button.faQuickBtn{height:28px;font-size:12.5px}
button.faQuickBtn.on{background:#eef3ea;border-color:#7D8A6E;color:#4a5b3f}
.faEntry{border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px;background:#fffdf8}
.faModes{display:flex;flex-direction:row;gap:16px;margin-top:6px;flex-wrap:wrap}
.faModeGrp{display:inline-flex;flex-direction:row;align-items:center;gap:4px}
.faModeName{font-size:12px;color:var(--muted);margin-right:2px}
button.faSeg{height:26px;padding:0 9px;font-size:12px;border-radius:6px}
button.faSeg.on-allow{background:#eef3ea;border-color:#7D8A6E;color:#4a5b3f}
button.faSeg.on-ask{background:#fbf3e6;border-color:#A98056;color:#7a5731}
button.faSeg.on-deny{background:rgba(176,58,40,.09);border-color:#B03A28;color:#8d2f21}
.faReasonBox{margin-top:6px}
input.faReason{width:100%;height:30px;font-size:12.5px;background:#fff}
.faFallback{display:flex;flex-direction:row;align-items:center;gap:8px;margin:10px 0 4px}
select.faSel{height:30px;font-size:12.5px;width:auto;border-radius:8px}
details.rulesBlock>summary{cursor:pointer;font-size:13px;color:var(--ink);padding:10px 0;list-style:none;font-weight:500}
details.rulesBlock>summary::-webkit-details-marker{display:none}
details.rulesBlock>summary:before{content:'';display:inline-block;width:6px;height:6px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:rotate(-45deg);margin-right:8px;vertical-align:2px}
details.rulesBlock[open]>summary:before{transform:rotate(45deg)}
.rulesBody{padding-bottom:10px}
.rulesTip{font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:10px}
.ruleRow{display:flex;gap:6px;align-items:center;margin-bottom:6px}
.ruleEn{height:15px;width:15px;flex:0 0 auto}
.ruleTarget,.ruleMode{height:30px;font-size:12px;padding:0 6px;flex:0 0 auto;width:auto}
.rulePat{flex:1 1 auto;height:30px;font-size:12.5px;font-family:ui-monospace,Menlo,monospace}
.ruleDel{flex:0 0 auto;height:30px;width:30px;padding:0;font-size:15px;line-height:1}
.ruleWarn{font-size:11.5px;color:var(--danger);margin:-2px 0 6px 21px}
.ruleReasonRow{margin:0 0 10px 21px}
.ruleReasonRow input{height:30px;font-size:12.5px;width:100%}
.rulesBtns{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center}
.catHeadRow{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
.batchRow{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.batchLabel{font-size:12px;color:var(--muted)}
.toolBatch{margin:2px 0 8px}
.permMode button[data-mode="hide"][aria-pressed="true"]{background:var(--danger);color:#fff;border-color:var(--danger)}
button.batchBtn{height:26px;padding:0 9px;font-size:12px}
button.clrBtn{color:var(--muted)}
.exHead{font-size:12px;color:var(--muted);flex:1 1 100%;margin-top:4px}
.exMode{font-size:11.5px;color:var(--muted)}
button.ghost{background:#fff;border:1px solid var(--border);color:var(--ink);height:30px;padding:0 10px;font-size:12.5px;border-radius:8px}
button.ghost:hover{background:var(--soft)}
button.exBtn{color:var(--ink);border:1px dashed var(--line-strong);background:#fbfbfc;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.presetBadge{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:6px;background:var(--soft);color:var(--ink);flex:0 0 auto}
.iconRow{margin-top:12px}
.iconLabel{font-size:12.5px;color:var(--muted);margin-bottom:6px}
.iconWrap{display:flex;gap:6px;flex-wrap:wrap}
button.iconChip{width:32px;height:32px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);background:#fff;border-radius:8px;color:#5b6068;cursor:pointer}
button.iconChip:hover{background:var(--soft);color:var(--ink)}
button.iconChip.active{background:var(--active);border-color:#9aa0aa;color:var(--ink);box-shadow:inset 0 0 0 1px #9aa0aa}
button.clearChip{width:auto;padding:0 10px;font-size:12px;color:var(--muted)}
.iconNote{font-size:11.5px;color:var(--muted);flex:1 1 100%;margin-top:6px;line-height:1.5}
.syncRow{display:flex;align-items:center;gap:6px;margin-top:10px;flex-wrap:wrap}
.syncLabel{font-size:12px;color:var(--muted)}
select.syncSel{height:30px;font-size:12.5px;width:auto;border-radius:8px}
.presetBadge svg{display:block}
button.exBtn:hover{background:#f0f2f6;border-color:#9aa0aa;border-style:solid}
button.exBtn:active{background:#e6e9ef}
.exLabel{font-size:12px;color:var(--muted);margin-right:2px}
.exAction{color:var(--ok);font-weight:600}
details.toolsBlock{margin-top:12px;border-top:1px solid rgba(0,0,0,.08);padding-top:10px}
details.toolsBlock>summary{cursor:pointer;font-weight:600;font-size:13px;list-style:none;display:flex;align-items:center;gap:8px}
details.toolsBlock>summary::-webkit-details-marker{display:none}
details.toolsBlock>summary::before{content:'▸';color:var(--muted);font-size:11px}
details.toolsBlock[open]>summary::before{content:'▾'}
.toolSearch{height:32px;margin:10px 0 8px;width:100%}
.toolRow{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:7px 0;border-top:1px dashed rgba(0,0,0,.06)}
.toolName{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;min-width:190px}
.toolCat{font-size:11px;color:var(--muted);background:var(--soft);border-radius:5px;padding:1px 6px}
.toolDesc{font-size:12px;color:var(--muted);flex:1 1 220px;min-width:0}
.toolRow .permMode button{height:26px;padding:0 8px;font-size:12px}
.toolRow .catReason{margin-top:0;flex:1 1 100%}
.toolEmpty{font-size:12.5px;color:var(--muted);padding:6px 0}
</style>
</head>
<body>
<div class="wrap">
<h1>权限档位<span class="ver">v${VERSION}</span></h1>
<p class="sub">每个档位是一整套权限：沙箱、审批、按操作类型分类的批量规则，以及运行时自动发现的工具清单（逐项覆盖）。选「拒绝」时填写的理由会原样告诉 AI，引导它改正。会话中通过 <code>/permission</code> 切换档位。</p>
<div id="list"></div>
<div class="toolbar">
  <button id="add">＋ 新增档位</button>
  <button id="save" class="primary">保存全部</button>
</div>
<div class="msg" id="msg"></div>
</div>
<script>
const CATS=${meta};
const VERSION=${JSON.stringify(VERSION)};
const MODES=${modes};
const TOOL_MODES=${JSON.stringify(TOOL_MODES)};
const SANDBOX_MODES=${sandboxModes};
const BUILTIN_PRESETS=${JSON.stringify(BUILTIN_PRESETS)};
function iconMarkup(id,size){
  const ic=PRESET_ICONS.find(x=>x.id===id);
  if(!ic)return '';
  const px=size||16;
  const parts=ic.d.split('|').map(d=>'<path d="'+d+'"/>').join('');
  return '<svg width="'+px+'" height="'+px+'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+parts+'</svg>';
}
const PRESET_ICONS=${JSON.stringify(PRESET_ICONS)};
const APPROVAL_POLICIES=${approvalPolicies};
const MODE_LABEL={ask:'询问',allow:'允许',deny:'拒绝'};
const TOOL_MODE_LABEL={ask:'询问',allow:'允许',deny:'拒绝',hide:'剔除'};
const state={presets:{},defaultPreset:'',tools:[]};

function el(tag,attrs,text){const n=document.createElement(tag);if(attrs)for(const k in attrs){if(k==='class')n.className=attrs[k];else n.setAttribute(k,attrs[k]);}if(text!==undefined)n.textContent=text;return n;}

async function load(){
  const r=await fetch('/permission-studio/api');
  const d=await r.json();
  if(!d.ok)throw new Error(d.error||'load failed');
  state.presets=d.presets||{};
  // 把 icon 挂到 preset 对象上，卡头与选择器都读 p.icon
  Object.keys(state.presets).forEach(id=>{state.presets[id].icon=(d.presets[id]||{}).icon||'';});
  state.defaultPreset=d.defaultPreset||'';
  state.tools=d.tools||[];
  render();
}

function catBlock(presetId,cat,perm){
  const box=el('div',{class:'cat'});
  const head=el('div',{class:'catHead'});
  head.appendChild(el('span',{class:'catName'},cat.label));
  head.appendChild(el('span',{class:'catHint'},cat.hint));
  box.appendChild(head);

  const row=el('div',{class:'row'});
  const modeWrap=el('div',{class:'permMode'});
  const reasonWrap=el('div',{class:'catReason'});
  const reasonLb=el('label',{},'拒绝理由（留空则用上方兜底理由）');
  const reasonInp=el('input',{type:'text',placeholder:cat.defaultReason});
  reasonInp.oninput=()=>{perm.reason=reasonInp.value;};
  reasonLb.appendChild(reasonInp);
  reasonWrap.appendChild(reasonLb);
  box.appendChild(row);
  box.appendChild(reasonWrap);

  const modeBtns={};
  function syncUI(){
    for(const m of MODES){
      const b=modeBtns[m];
      if(!b)continue;
      if(perm.mode===m)b.setAttribute('aria-pressed','true');
      else b.removeAttribute('aria-pressed');
    }
    if(perm.mode==='deny'){
      // 不再自动把默认理由写进 perm.reason：留空即表示「用兜底理由」，
      // 否则「批量清空理由」会被下一次渲染立刻填回来，等于清不掉。
      reasonInp.value=perm.reason||'';
      reasonWrap.classList.add('show');
    }else{
      reasonWrap.classList.remove('show');
    }
  }

  MODES.forEach(m=>{
    const b=el('button',{type:'button'},MODE_LABEL[m]);
    b.dataset.mode=m;
    b.onclick=()=>{perm.mode=m;syncUI();};
    modeBtns[m]=b;
    modeWrap.appendChild(b);
  });
  row.appendChild(modeWrap);

  if(cat.key==='doomloop'){
    const th=el('label',{},'阈值（连续相同调用次数）');
    const inp=el('input',{type:'number',min:'1',max:'100',value:String(perm.threshold||6)});
    inp.oninput=()=>{perm.threshold=Math.max(1,parseInt(inp.value||'6',10)||6);};
    th.appendChild(inp);
    row.appendChild(th);
  }

  syncUI();
  return box;
}

function toolRow(presetId,p,tool){
  const row=el('div',{class:'toolRow'});
  row.appendChild(el('span',{class:'toolName'},tool.name));
  row.appendChild(el('span',{class:'toolCat'},tool.category||'other'));
  row.appendChild(el('span',{class:'toolDesc'},tool.description||''));

  if(!p.perms.tools)p.perms.tools={};
  const cur=p.perms.tools[tool.name]||null;
  const modeWrap=el('div',{class:'permMode'});

  const reasonWrap=el('div',{class:'catReason'});
  const reasonInp=el('input',{type:'text',placeholder:'拒绝理由（回给 AI 的引导）'});
  reasonInp.oninput=()=>{ if(p.perms.tools[tool.name])p.perms.tools[tool.name].reason=reasonInp.value; };
  reasonWrap.appendChild(reasonInp);

  const btns={};
  function sync(){
    const active=p.perms.tools[tool.name]||null;
    for(const k of ['inherit'].concat(TOOL_MODES)){
      const b=btns[k];
      if(!b)continue;
      const on=(k==='inherit'&&!active)||(active&&active.mode===k);
      if(on)b.setAttribute('aria-pressed','true');else b.removeAttribute('aria-pressed');
    }
    if(active&&active.mode==='deny'){
      reasonInp.value=active.reason||'';
      reasonWrap.classList.add('show');
    }else{
      reasonWrap.classList.remove('show');
    }
  }

  [['inherit','跟随分类'],['ask','询问'],['allow','允许'],['deny','拒绝'],['hide','剔除']].forEach(([k,label])=>{
    const b=el('button',{type:'button'},label);
    b.dataset.mode=k==='inherit'?'inherit':k;
    b.onclick=()=>{
      if(k==='inherit'){ delete p.perms.tools[tool.name]; }
      else {
        p.perms.tools[tool.name]={mode:k};
        if(k==='deny')p.perms.tools[tool.name].reason='';
      }
      sync();
    };
    btns[k]=b;
    modeWrap.appendChild(b);
  });
  row.appendChild(modeWrap);
  row.appendChild(reasonWrap);
  sync();
  return row;
}

function toolsBlock(presetId,p){
  const det=el('details',{class:'toolsBlock'});
  const sum=el('summary',{},'工具清单（运行时自动发现 '+state.tools.length+' 个）');
  det.appendChild(sum);
  const search=el('input',{type:'text',class:'toolSearch',placeholder:'搜索工具名或描述…'});
  det.appendChild(search);

  // ── 工具批量操作：一次性改所有已发现工具的设置 ──
  if(!p.perms.tools)p.perms.tools={};
  const tBatch=el('div',{class:'batchRow toolBatch'});
  tBatch.appendChild(el('span',{class:'batchLabel'},'批量（全部 '+state.tools.length+' 个工具）：'));
  const applyAll=(mode)=>{
    state.tools.forEach(t=>{
      if(mode==='inherit'){ delete p.perms.tools[t.name]; return; }
      const cur=p.perms.tools[t.name]||{};
      p.perms.tools[t.name]={mode:mode,reason:cur.reason||''};
    });
    p.toolsOpen=true;
    render();
  };
  [['ask','全部询问'],['allow','全部允许'],['deny','全部拒绝'],['hide','全部剔除'],['inherit','全部跟随分类']].forEach(([m,label])=>{
    const b=el('button',{type:'button',class:'ghost batchBtn'},label);
    b.onclick=()=>applyAll(m);
    tBatch.appendChild(b);
  });
  const tClr=el('button',{type:'button',class:'ghost batchBtn clrBtn'},'清空工具理由');
  tClr.title='清空逐工具单独填写的拒绝理由，统一改用档位兜底理由';
  tClr.onclick=()=>{
    Object.keys(p.perms.tools).forEach(n=>{if(p.perms.tools[n])p.perms.tools[n].reason='';});
    p.toolsOpen=true;
    render();
  };
  tBatch.appendChild(tClr);
  det.appendChild(tBatch);

  const list=el('div');
  det.appendChild(list);

  function paint(filter){
    list.innerHTML='';
    const q=(filter||'').trim().toLowerCase();
    const rows=state.tools.filter(t=>!q||t.name.toLowerCase().includes(q)||(t.description||'').toLowerCase().includes(q)||(t.category||'').includes(q));
    if(rows.length===0){ list.appendChild(el('div',{class:'toolEmpty'},state.tools.length? '没有匹配的工具':'未发现任何工具（工具服务不可用）')); return; }
    rows.forEach(t=>list.appendChild(toolRow(presetId,p,t)));
  }
  search.oninput=()=>paint(search.value);
  // 展开时才填充，避免每张卡片都铺满 DOM
  det.addEventListener('toggle',()=>{ p.toolsOpen=det.open; if(det.open && list.childElementCount===0) paint(''); });
  if(p.toolsOpen) det.open=true;
  if(det.open) paint('');
  return det;
}

function card(id,p){
  const isBuiltin=BUILTIN_PRESETS.includes(id);
  const c=el('div',{class:'card'});
  // 注意：折叠态是持久状态，只在「首次见到该档位」时初始化为折叠。
  // 早期写成 if(!p.collapsed)p.collapsed=true 会在每次 render 强制折叠，点击永远打不开。
  if(typeof p.collapsed!=='boolean')p.collapsed=true;

  // ── 折叠头：点标题区展开/收起 ────────────────────────────────
  const head=el('div',{class:'head'});
  const toggle=el('button',{type:'button',class:'collapse'});
  toggle.setAttribute('aria-expanded',String(!p.collapsed));
  // 用内联 SVG 画箭头：字符 ▸/▾ 在部分环境（无 CJK 字体的 headless）会渲染成方块或点
  toggle.innerHTML='<svg class="caret" width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">'
    +'<path d="'+(p.collapsed?'M3 1 L7 5 L3 9':'M1 3 L5 7 L9 3')+'" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  toggle.onclick=()=>{p.collapsed=!p.collapsed;render();};
  head.appendChild(toggle);

  const title=el('div',{class:'titleWrap'});
  if(p.icon){
    const badge=el('span',{class:'presetBadge'});
    badge.innerHTML=iconMarkup(p.icon,16);
    badge.title='档位徽标';
    title.appendChild(badge);
  }
  const idEl=el('span',{class:'id'},id);
  title.appendChild(idEl);
  if(p.name)title.appendChild(el('span',{class:'nameTag'},p.name));
  if(isBuiltin)title.appendChild(el('span',{class:'builtinTag'},'内置'));
  if(state.defaultPreset===id)title.appendChild(el('span',{class:'defaultTag'},'默认'));
  // 摘要：N 项拒绝 / M 项询问
  const denys=CATS.filter(k=>p.perms[k.key]&&p.perms[k.key].mode==='deny').length;
  const asks=CATS.filter(k=>p.perms[k.key]&&p.perms[k.key].mode==='ask').length;
  title.appendChild(el('span',{class:'summary'},'拒绝 '+denys+' · 询问 '+asks+' · 共 '+CATS.length+' 类'));
  head.appendChild(title);
  c.appendChild(head);

  if(p.collapsed)return c;

  // ── 展开后的字段 ────────────────────────────────────────────
  const fields=el('div',{class:'head fields'});
  const sb=el('label',{},'沙箱');
  const sbSel=el('select');
  SANDBOX_MODES.forEach(m=>{const o=el('option',{value:m},m);if(p.sandbox===m)o.selected=true;sbSel.appendChild(o);});
  sbSel.onchange=()=>{p.sandbox=sbSel.value;};
  sb.appendChild(sbSel);fields.appendChild(sb);

  const ap=el('label',{},'审批');
  const apSel=el('select');
  APPROVAL_POLICIES.forEach(m=>{const o=el('option',{value:m},m);if(p.approval===m)o.selected=true;apSel.appendChild(o);});
  apSel.onchange=()=>{p.approval=apSel.value;};
  ap.appendChild(apSel);fields.appendChild(ap);

  const nm=el('label',{},'显示名');
  const nmInp=el('input',{type:'text',value:p.name||'',placeholder:'可选'});
  nmInp.oninput=()=>{p.name=nmInp.value;};
  nm.appendChild(nmInp);fields.appendChild(nm);

  const df=el('label',{},'设为默认');
  const dfInp=el('input',{type:'checkbox'});
  dfInp.checked=state.defaultPreset===id;
  dfInp.onchange=()=>{if(dfInp.checked)state.defaultPreset=id;};
  df.appendChild(dfInp);fields.appendChild(df);

  if(!isBuiltin){
    const del=el('button',{type:'button',class:'del'},'删除');
    del.onclick=()=>{delete state.presets[id];if(state.defaultPreset===id)state.defaultPreset='';render();};
    fields.appendChild(del);
  }
  c.appendChild(fields);

  const ds=el('div',{class:'row'});
  const dsLb=el('label',{},'描述');
  const dsInp=el('input',{type:'text',value:p.description||'',placeholder:'可选'});
  dsInp.oninput=()=>{p.description=dsInp.value;};
  dsLb.appendChild(dsInp);ds.appendChild(dsLb);
  c.appendChild(ds);

  // ── 兜底拒绝理由：一处填写，所有未单独填写理由的拒绝项自动套用 ──
  const fbRow=el('div',{class:'row fallbackRow'});
  const fbLb=el('label',{},'兜底拒绝理由（所有未单独填写的拒绝项都套用它）');
  if(!p.perms)p.perms={};
  const fbInp=el('input',{type:'text',value:p.perms.fallbackReason||'',placeholder:'例如：本档位不允许该操作，请说明你的目的并请用户切换档位。'});
  fbInp.oninput=()=>{p.perms.fallbackReason=fbInp.value;};
  fbLb.appendChild(fbInp);fbRow.appendChild(fbLb);
  c.appendChild(fbRow);

  // ── 正则规则：按工具名/命令/路径做允许或拒绝 ──
  if(!Array.isArray(p.perms.rules))p.perms.rules=[];
  c.appendChild(rulesBlock(id,p));

  // ── 文件白名单：只允许读写指定路径 ──
  c.appendChild(fileAllowBlock(id,p));

  // ── 档位徽标选择 ──
  const icRow=el('div',{class:'iconRow'});
  icRow.appendChild(el('div',{class:'iconLabel'},'档位徽标（显示在档位名前面，可选）'));
  const icWrap=el('div',{class:'iconWrap'});
  PRESET_ICONS.forEach(ic=>{
    const b=el('button',{type:'button',class:'iconChip'+(p.icon===ic.id?' active':'')});
    b.title=ic.label;
    b.innerHTML=iconMarkup(ic.id,16);
    b.onclick=()=>{p.icon=(p.icon===ic.id?'':ic.id);p.rulesOpen=p.rulesOpen===true;render();};
    icWrap.appendChild(b);
  });
  const clear=el('button',{type:'button',class:'iconChip clearChip'},'无');
  clear.title='不显示徽标';
  clear.onclick=()=>{p.icon='';render();};
  icWrap.appendChild(clear);
  icRow.appendChild(icWrap);
  icRow.appendChild(el('div',{class:'iconNote'},
    '徽标会显示在本页档位卡头、原生档位下拉与左下角触发器上；内置三档保留 DSH 自带图标，互不冲突。'));
  c.appendChild(icRow);



  // ── 批量操作：一次改完 13 类，不用逐条点 ──
  const permsTitle=el('div',{class:'catHeadRow'});
  permsTitle.style.marginTop='12px';
  permsTitle.appendChild(el('span',{class:'catName'},'分类规则（按操作类型批量设置）'));

  const batch=el('div',{class:'batchRow'});
  [['ask','全部询问'],['allow','全部允许'],['deny','全部拒绝']].forEach(([m,label])=>{
    const b=el('button',{type:'button',class:'ghost batchBtn'},label);
    b.onclick=()=>{
      CATS.forEach(cat=>{
        if(!p.perms[cat.key])p.perms[cat.key]={mode:m};
        p.perms[cat.key].mode=m;
      });
      render();
    };
    batch.appendChild(b);
  });
  const clr=el('button',{type:'button',class:'ghost batchBtn clrBtn'},'清空单独理由');
  clr.title='把 13 类、逐工具、正则规则里单独填写的拒绝理由全部清空，统一改用上方兜底理由';
  clr.onclick=()=>{
    CATS.forEach(cat=>{if(p.perms[cat.key])p.perms[cat.key].reason='';});
    const tsrc=p.perms.tools||{};
    Object.keys(tsrc).forEach(n=>{if(tsrc[n])tsrc[n].reason='';});
    (p.perms.rules||[]).forEach(r=>{r.reason='';});
    p.rulesOpen=p.rulesOpen===true;
    render();
  };
  batch.appendChild(clr);
  permsTitle.appendChild(batch);
  c.appendChild(permsTitle);

  CATS.forEach(cat=>{
    if(!p.perms[cat.key])p.perms[cat.key]={mode:'ask'};
    c.appendChild(catBlock(id,cat,p.perms[cat.key]));
  });
  if(!p.perms.tools)p.perms.tools={};
  c.appendChild(toolsBlock(id,p));
  return c;
}

/**
 * 正则规则编辑区。
 * 三个示例覆盖三种典型用法：命令黑名单、路径白名单、工具名黑名单。
 */
const RULE_EXAMPLES = [
  {
    pattern: '^rm\\s+-rf|\\bsudo\\b|\\bmkfs\\b',
    target: 'command',
    mode: 'deny',
    reason: '禁止危险命令（rm -rf / sudo / mkfs）。如果确实需要，请让用户手动执行。'
  },
  {
    pattern: '^/tmp/|^\\.cache/',
    target: 'path',
    mode: 'allow',
    reason: ''
  },
  {
    pattern: '^git\\s+(push|reset\\s+--hard)|\\bnpm\\s+publish\\b',
    target: 'command',
    mode: 'ask',
    reason: '该命令会改动远端仓库或发布产物，请先确认。'
  }
];

/**
 * 文件白名单：把「读/写文件」这件事收窄到列出的路径。
 *
 * 注意这是「比分类更细」的一层，只作用于带路径参数的文件类工具
 * （读取、查找、编辑、图片、撤销）；shell 命令里改文件请用分类/正则规则管。
 */
/**
 * 文件规则：白名单与黑名单融合成一张表。
 *
 * 每条规则 = 路径模式 + 读动作 + 写动作（允许/询问/拒绝），拒绝时可写提示词。
 * 「未列出的文件」另设备用策略：跟随分类规则，或一律拒绝（此时就是纯白名单）。
 *
 * 这一层只作用于带路径参数的文件工具；shell 命令改文件仍由分类与正则规则管。
 */
function fileAllowBlock(id,p){
  if(!p.perms.fileAllow||typeof p.perms.fileAllow!=='object')p.perms.fileAllow={enabled:false,fallback:'category',entries:[]};
  const fa=p.perms.fileAllow;
  if(!Array.isArray(fa.entries))fa.entries=[];
  if(typeof fa.enabled!=='boolean')fa.enabled=false;
  if(fa.fallback!=='deny')fa.fallback='category';

  const det=el('details',{class:'rulesBlock fileAllowBlock'});
  const readN=fa.entries.filter(e=>e.read==='allow').length;
  const writeN=fa.entries.filter(e=>e.write==='allow').length;
  det.appendChild(el('summary',{}, fa.enabled
    ? '文件规则（'+fa.entries.length+' 条 · 允许读 '+readN+' · 允许写 '+writeN+' · 未列出'+(fa.fallback==='deny'?'一律拒绝':'跟随分类')+'）'
    : '文件规则（允许/拒绝/询问指定路径，默认关闭）'));
  if(fa.open===true)det.open=true;
  det.addEventListener('toggle',()=>{fa.open=det.open;});

  // ── 启用开关 ──
  const head=el('div',{class:'faHead'});
  const cb=el('input',{type:'checkbox'});
  cb.checked=fa.enabled;
  cb.onchange=()=>{fa.enabled=cb.checked;fa.open=true;render();};
  const cbLb=el('label',{class:'faToggle'});
  cbLb.appendChild(cb);
  cbLb.appendChild(document.createTextNode(' 启用文件规则'));
  head.appendChild(cbLb);
  det.appendChild(head);

  // ── 读/写两个独立快捷开关：单独打开某一侧，不必去分类区找 ──
  const quick=el('div',{class:'faQuickRow'});
  quick.appendChild(el('span',{class:'faQuickLabel'},'快捷：'));
  [['read','读取'],['edit','写入']].forEach(([k,label])=>{
    const cur=p.perms[k]&&p.perms[k].mode;
    const on=cur==='allow';
    const b=el('button',{type:'button',class:'ghost faQuickBtn'+(on?' on':'')},on?label+'已开启':'开启'+label);
    b.title=on?('点击关闭'+label+'（改为拒绝）'):('把分类规则里的「'+label+'」设为允许');
    b.onclick=()=>{
      if(!p.perms[k])p.perms[k]={mode:'allow'};
      p.perms[k].mode=on?'deny':'allow';
      fa.open=true;render();
    };
    quick.appendChild(b);
  });
  det.appendChild(quick);

  if(!fa.enabled){
    det.appendChild(el('div',{class:'faHint'},
      '未启用：文件访问完全按上面的分类规则与正则规则处理，这张表不生效（内容会保留，下次开启不用重填）。'));
    return det;
  }

  // ── 缺读 / 缺写提醒 ──
  [['read','读取'],['edit','写入']].forEach(([k,label])=>{
    const mode=p.perms[k]&&p.perms[k].mode;
    if(mode!=='deny')return;
    const warn=el('div',{class:'faWarn'});
    warn.appendChild(el('span',{class:'faWarnText'},
      '缺'+label+'权限：分类规则里「'+label+'」是拒绝，没被下面规则命中的文件将无法'+label+'。'));
    const fix=el('button',{type:'button',class:'faFix'},'开启'+label);
    fix.onclick=()=>{if(!p.perms[k])p.perms[k]={mode:'allow'};p.perms[k].mode='allow';fa.open=true;render();};
    warn.appendChild(fix);
    det.appendChild(warn);
  });

  // ── 规则列表 ──
  const list=el('div',{class:'faList'});
  const ACT=[['allow','允许'],['ask','询问'],['deny','拒绝']];
  fa.entries.forEach((e,i)=>{
    const card=el('div',{class:'faEntry'});
    const top=el('div',{class:'faRow'});
    const inp=el('input',{type:'text',class:'faPattern',value:e.pattern||'',placeholder:'路径或通配符，例如 src/** 或 docs/notes.md'});
    inp.oninput=()=>{e.pattern=inp.value;};
    top.appendChild(inp);
    const del=el('button',{type:'button',class:'ghost faDel'},'删除');
    del.onclick=()=>{fa.entries.splice(i,1);fa.open=true;render();};
    top.appendChild(del);
    card.appendChild(top);

    const modes=el('div',{class:'faModes'});
    [['read','读'],['write','写']].forEach(([key,label])=>{
      const grp=el('div',{class:'faModeGrp'});
      grp.appendChild(el('span',{class:'faModeName'},label));
      ACT.forEach(([val,txt])=>{
        const b=el('button',{type:'button',class:'faSeg'+(e[key]===val?' on-'+val:'')},txt);
        b.onclick=()=>{e[key]=val;if(key==='read'&&val==='allow'&&!e.write)e.write='allow';fa.open=true;render();};
        grp.appendChild(b);
      });
      modes.appendChild(grp);
    });
    card.appendChild(modes);

    // 拒绝时才能写提示词（回给 AI 的引导）
    if(e.read==='deny'||e.write==='deny'){
      const rb=el('div',{class:'faReasonBox'});
      const ri=el('input',{type:'text',class:'faReason',value:e.reason||'',
        placeholder:'拒绝时回给 AI 的提示词，例如：这个文件是生产配置，请让用户手动改。'});
      ri.oninput=()=>{e.reason=ri.value;};
      rb.appendChild(ri);
      card.appendChild(rb);
    }
    list.appendChild(card);
  });
  det.appendChild(list);

  const add=el('button',{type:'button',class:'ghost faAdd'},'+ 新增规则');
  add.onclick=()=>{fa.entries.push({pattern:'',read:'allow',write:'allow',reason:''});fa.open=true;render();};
  det.appendChild(add);

  // ── 未列出的文件怎么办 ──
  const fbRow=el('div',{class:'faFallback'});
  fbRow.appendChild(el('span',{class:'faQuickLabel'},'未列出的文件：'));
  const sel=el('select',{class:'faSel'});
  [['category','跟随分类规则（推荐）'],['deny','一律拒绝（纯白名单）']].forEach(([v,l])=>{
    const o=el('option',{value:v},l);
    if(fa.fallback===v)o.selected=true;
    sel.appendChild(o);
  });
  sel.onchange=()=>{fa.fallback=sel.value;fa.open=true;render();};
  fbRow.appendChild(sel);
  det.appendChild(fbRow);

  const ex=el('div',{class:'faExamples'});
  ex.appendChild(el('span',{class:'faExLabel'},'示例：'));
  [['src/**','整目录可读写','allow','allow'],
   ['docs/*.md','只读','allow','deny'],
   ['**/*.env','禁止访问','deny','deny']].forEach(([pat,label,rd,wr])=>{
    const chip=el('button',{type:'button',class:'faChip'},pat);
    chip.title=label+'（点一下加入）';
    chip.onclick=()=>{fa.entries.push({pattern:pat,read:rd,write:wr,reason:''});fa.enabled=true;fa.open=true;render();};
    ex.appendChild(chip);
  });
  det.appendChild(ex);

  det.appendChild(el('div',{class:'faNote'},
    '多条规则同时命中时按「拒绝 > 询问 > 允许」取最严的。只对带路径参数的文件工具生效（读取、查找、编辑、图片、撤销）；shell 命令改文件请用分类或正则规则管。'));
  return det;
}

function rulesBlock(id,p){
  const wrap=el('details',{class:'rulesBlock'});
  if(p.rulesOpen)wrap.open=true;
  wrap.addEventListener('toggle',()=>{p.rulesOpen=wrap.open;});

  const rules=p.perms.rules;
  const n=rules.length;
  const sum=el('summary',{},'正则规则（'+(n>0?n+' 条':'未设置')+'，优先级最高，可覆盖分类）');
  wrap.appendChild(sum);

  const body=el('div',{class:'rulesBody'});
  const tip=el('div',{class:'rulesTip'});
  tip.innerHTML='按<b>工具名</b>、<b>命令文本</b>或<b>路径</b>做正则匹配。优先级：<b>拒绝 &gt; 询问 &gt; 允许</b>；正则用 JavaScript 语法（不带首尾斜杠）。';
  body.appendChild(tip);

  rules.forEach((r,idx)=>{
    const row=el('div',{class:'ruleRow'});

    const en=el('input',{type:'checkbox',class:'ruleEn'});
    en.checked=r.enabled!==false;
    en.title='启用/停用';
    en.onchange=()=>{r.enabled=en.checked;};
    row.appendChild(en);

    const tg=el('select',{class:'ruleTarget'});
    [['command','命令'],['path','路径'],['tool','工具名'],['any','任意']].forEach(([v,l])=>{
      const o=el('option',{value:v},l); if((r.target||'any')===v)o.selected=true; tg.appendChild(o);
    });
    tg.onchange=()=>{r.target=tg.value;};
    row.appendChild(tg);

    const md=el('select',{class:'ruleMode'});
    [['deny','拒绝'],['ask','询问'],['allow','允许']].forEach(([v,l])=>{
      const o=el('option',{value:v},l); if(r.mode===v)o.selected=true; md.appendChild(o);
    });
    md.onchange=()=>{r.mode=md.value;p.rulesOpen=true;render();};
    row.appendChild(md);

    const pat=el('input',{type:'text',class:'rulePat',value:r.pattern||'',placeholder:'正则，例如 ^rm\\s+-rf'});
    pat.oninput=()=>{r.pattern=pat.value;};
    row.appendChild(pat);

    const rm=el('button',{type:'button',class:'del ruleDel'},'×');
    rm.title='删除这条规则';
    rm.onclick=()=>{rules.splice(idx,1);p.rulesOpen=true;render();};
    row.appendChild(rm);

    body.appendChild(row);

    // 非法正则就地提示，不让用户保存后才发现
    if(r.pattern){
      try{ new RegExp(r.pattern); }catch(e){
        const warn=el('div',{class:'ruleWarn'},'正则语法错误：'+((e&&e.message)||''));
        body.appendChild(warn);
      }
    }

    if(r.mode==='deny'||r.mode==='ask'){
      const rrow=el('div',{class:'ruleReasonRow'});
      const ph=r.mode==='deny'
        ? '拒绝理由（会原样告诉 AI；留空则用兜底理由）'
        : '询问说明（弹审批时展示给用户，说明为什么要确认这一步）';
      const rinp=el('input',{type:'text',value:r.reason||'',placeholder:ph});
      rinp.oninput=()=>{r.reason=rinp.value;};
      rrow.appendChild(rinp);
      body.appendChild(rrow);
    }
  });

  const btns=el('div',{class:'rulesBtns'});
  const add=el('button',{type:'button',class:'ghost'},'+ 新增规则');
  add.onclick=()=>{rules.push({pattern:'',target:'command',mode:'deny',reason:'',enabled:true});p.rulesOpen=true;render();};
  btns.appendChild(add);

  // 示例做成可点击的 chip：点一下就生成一条现成规则，之后按需改参数
  body.appendChild(el('div',{class:'exHead'},'点示例直接生成规则（生成后可改参数）：'));
  RULE_EXAMPLES.forEach((ex,i)=>{
    const meta=[
      {label:'例1 危险命令',action:'拒绝',title:'命中 rm -rf / sudo / mkfs 时直接拦下，理由会告诉 AI 为什么'},
      {label:'例2 路径白名单',action:'允许',title:'命中 /tmp 或 .cache 路径时放行，可越过分类的拒绝'},
      {label:'例3 发布前确认',action:'询问',title:'命中 git push / npm publish 时弹审批，由你当场决定'}
    ][i];
    const b=el('button',{type:'button',class:'ghost exBtn'});
    b.title=meta.title;
    b.appendChild(el('span',{class:'exAction'},'+ '));
    b.appendChild(el('span',{},meta.label));
    b.appendChild(el('span',{class:'exMode'},'（'+meta.action+'）'));
    b.onclick=()=>{
      rules.push({...ex,enabled:true});
      p.rulesOpen=true;      // 保持展开：否则重渲染后折叠起来，看着像没生效
      render();
    };
    btns.appendChild(b);
  });
  body.appendChild(btns);

  wrap.appendChild(body);
  return wrap;
}

function render(){
  const list=document.getElementById('list');
  list.innerHTML='';
  // 内置三档固定不显示（它们在 profile 配置里保留，只是不出现在编辑列表）
  Object.keys(state.presets).forEach(id=>{
    const isBuiltin=BUILTIN_PRESETS.includes(id);
    if(isBuiltin)return;
    const p=state.presets[id];
    if(!p.perms)p.perms={};
    list.appendChild(card(id,p));
  });
  if(Object.keys(state.presets).length===0)list.appendChild(el('div',{class:'card'},'暂无档位，点击新增'));
}

document.getElementById('add').onclick=()=>{
  let i=1;let base='custom-1';
  while(state.presets[base]){i++;base='custom-'+i;}
  const perms={};
  CATS.forEach(cat=>{perms[cat.key]={mode: cat.key==='doomloop'?'ask':'ask'};if(cat.key==='doomloop')perms[cat.key].threshold=6;});
  state.presets[base]={sandbox:'workspace-write',approval:'ask',name:'自定义 '+i,description:'',perms};
  render();
};

async function saveAll(){
  const btn=document.getElementById('save');
  btn.disabled=true;
  const msg=document.getElementById('msg');
  msg.className='msg';msg.textContent='保存中…';
  try{
    const presets={};const perms={};const icons={};
    Object.keys(state.presets).forEach(id=>{
      const p=state.presets[id];
      presets[id]={sandbox:p.sandbox,approval:p.approval};
      if(p.name)presets[id].name=p.name;
      if(p.description)presets[id].description=p.description;
      perms[id]={};
      CATS.forEach(cat=>{
        const cur=p.perms[cat.key]||{mode:'ask'};
        const item={mode:cur.mode};
        // 只提交用户真正填写的理由；留空就交给服务端用兜底理由/分类默认理由补
        if(cur.mode==='deny'&&(cur.reason||'').trim())item.reason=cur.reason.trim();
        if(cat.key==='doomloop')item.threshold=cur.threshold||6;
        perms[id][cat.key]=item;
      });
      const tsrc=p.perms.tools||{};
      const tout={};
      Object.keys(tsrc).forEach(name=>{
        const cur=tsrc[name];
        if(!cur||!cur.mode)return;
        const item={mode:cur.mode};
        if(cur.mode==='deny')item.reason=(cur.reason||'').trim()||undefined;
        tout[name]=item;
      });
      perms[id].tools=tout;
      // 兜底理由与正则规则也要回传，否则保存会清空它们
      if((p.perms.fallbackReason||'').trim())perms[id].fallbackReason=p.perms.fallbackReason.trim();
      const faSrc=p.perms.fileAllow||{};
      const ACTS=['allow','ask','deny'];
      perms[id].fileAllow={
        enabled:faSrc.enabled===true,
        fallback:faSrc.fallback==='deny'?'deny':'category',
        entries:(faSrc.entries||[]).filter(e=>e&&e.pattern&&e.pattern.trim()).map(e=>{
          const item={pattern:e.pattern.trim()};
          if(ACTS.includes(e.read))item.read=e.read;
          if(ACTS.includes(e.write))item.write=e.write;
          if((item.read==='deny'||item.write==='deny')&&(e.reason||'').trim())item.reason=e.reason.trim();
          return item;
        })
      };
      perms[id].rules=(p.perms.rules||[]).filter(r=>r&&r.pattern).map(r=>{
        const item={pattern:r.pattern,target:r.target||'any',mode:r.mode||'deny',enabled:r.enabled!==false};
        if(r.mode!=='allow'&&(r.reason||'').trim())item.reason=r.reason.trim();
        return item;
      });
      if(p.icon)icons[id]=p.icon;
    });
    const r=await fetch('/permission-studio/api',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({presets,perms,icons,defaultPreset:state.defaultPreset})});
    const d=await r.json();
    if(!d.ok)throw new Error(d.error||'save failed');
    msg.className='msg ok';msg.textContent='已保存：档位、分类规则与工具级设置均已生效（会话内 /permission 立即切换）。';
    await load();
  }catch(e){msg.className='msg err';msg.textContent='保存失败：'+(e&&e.message||e);}
  btn.disabled=false;
}
document.getElementById('save').onclick=saveAll;

load().catch(e=>{const m=document.getElementById('msg');m.className='msg err';m.textContent='加载失败：'+(e&&e.message||e);});
</script>
</body>
</html>`
}
/** 供回归测试使用的纯函数导出（不参与插件运行时契约）。 */
export { decide, toolCategory, normalizePerms, defaultPermsFor, isOutside, CATS, MODES, TOOL_MODES, CAT_KEYS, toolDescZh, BUILTIN_PRESETS, evalRules, normalizeRules, PRESET_ICONS, iconSvg, planHiddenTools, syncHiddenTools, globToRegExp, matchFileRule, normalizeFileAllow, normalizeRel, FILE_ACTIONS }
