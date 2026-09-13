// dsh-edit-diff 浏览器端源码，由 tsdown 构建为标准 dsh client bundle。
//
// 构建产物通过 window.__ModuleLoader__.load 注册模块表条目，React 由宿主模块加载器解析。
// 默认导出 Cordis 插件对象，由浏览器内核挂载。
//
// 接管 edit/write 工具卡片：内置 DiffBlock 对新旧全文逐行染色且不做行级匹配，相同行在红绿两区各渲染一遍。
// 本插件接管 tool.call.toolview 的 edit/write key，用近线性行级 diff 跳过相同行，替换行做字符级下划线高亮。
// 视觉对齐内置 DiffBlock/ToolRow。卡片默认收起，长 diff 二次折叠。
//
// PTC 模式下 run_code 子调用中的 edit/write 同样显示去重 diff，按 callId 的 :code: 标记识别，从 argsRaw 动态构建。

import * as React from 'react'

/** 文档对象，非浏览器环境下为 null。 */
const DOC: Document | null = typeof document !== 'undefined' ? document : null

/** 单条 diff 操作，a 与 b 是两侧序列下标，缺失侧为 -1。 */
type DiffOpType = 'same' | 'del' | 'add'

interface DiffOp {
  type: DiffOpType
  a: number
  b: number
}

/** 行内高亮区间，左闭右开。 */
type CharRange = readonly [number, number]

/** 渲染行种类，path 为文件标题行，mid 为二次折叠提示行。 */
type LineKind = 'del' | 'add' | 'path' | 'mid' | 'plain'

interface RenderLine {
  kind: LineKind
  text: string
  hl: CharRange[]
}

/** 单个文件的改动对，oldText 为 null 表示新建。 */
interface FileDiff {
  path: string
  oldText: string | null
  newText: string
}

/** 卡片状态。 */
type CardState = 'running' | 'stopped' | 'error' | 'ok'

/** 卡片模型，由 block 推导出的渲染所需全部数据。 */
interface CardModel {
  title: string
  summary: string
  filePath: string | undefined
  state: CardState
  diffs: FileDiff[] | null
  output: string | null
}

/** 工具调用的参数面，running 与 settled 两态的字段位置不同。 */
interface CallFace {
  name?: unknown
  argsRaw?: unknown
}

/** 工具卡片数据块，字段一律按 unknown 收窄。 */
interface ToolBlock {
  kind?: unknown
  isError?: unknown
  error?: { name?: unknown; code?: unknown }
  meta?: unknown
  callId?: unknown
  parentCallId?: unknown
  argsRaw?: unknown
  name?: unknown
  call?: CallFace
  content?: unknown
  callView?: unknown
  resultView?: unknown
}

/** 组件 props，来自 tool.call.toolview 槽位。 */
interface DiffCardProps {
  block: ToolBlock
  cwd?: string
  toolName?: string
  openFile?: (path: string) => void
  inspect?: () => void
}

/** 宿主 slots 服务的最小子集。 */
interface SlotsService {
  inject(name: string, register: () => void): void
  register(options: { name: string; key: string; priority: number }, component: (props: DiffCardProps) => React.ReactElement): void
}

/** 宿主 timer 服务的最小子集。 */
interface TimerService {
  timeout(callback: () => void, ms: number): unknown
}

/** Cordis 上下文的最小子集，插件只用到 get、inject 与 effect。 */
interface PluginContext {
  get?(name: string): unknown
  inject?(deps: readonly string[], callback: (ctx: PluginContext) => void): void
  effect(callback: () => void | (() => void)): (() => void) | void
}

// ==================== 额外工具的参数名 ====================

/** 浏览器端读到的 extraTools 条目。 */
interface ExtraToolConfig {
  name: string
  pathKey?: string
  oldKey?: string
  newKey?: string
  contentKey?: string
}

/** settings 命名空间 dsh-edit-diff 的解析值。 */
interface PluginConfig {
  extraTools?: ExtraToolConfig[]
}

/** settings 服务的最小子集。 */
interface SettingsScopeService {
  bind<T>(spec: { namespace: string }): SettingsScopeFace<T>
}

/** 一个 settings 命名空间的读取面。 */
interface SettingsScopeFace<T> {
  getSnapshot(): { value: T | undefined }
  subscribe(listener: () => void): () => void
}

/** 读取工具参数用的参数名。 */
interface KeySpec {
  pathKey: string
  oldKey: string
  newKey: string
  contentKey: string
}

/** 原生 edit 与 write 的参数名，也是未声明覆盖时的默认值。 */
const DEFAULT_SPEC: KeySpec = { pathKey: 'file_path', oldKey: 'old_string', newKey: 'new_string', contentKey: 'content' }

/** 额外接管的工具名到参数名，由 settings 的 extraTools 填充。 */
const extraSpecs = new Map<string, KeySpec>()

/** 把配置条目补全成完整参数名。 */
function toKeySpec(tool: ExtraToolConfig): KeySpec {
  return {
    pathKey: tool.pathKey ?? DEFAULT_SPEC.pathKey,
    oldKey: tool.oldKey ?? DEFAULT_SPEC.oldKey,
    newKey: tool.newKey ?? DEFAULT_SPEC.newKey,
    contentKey: tool.contentKey ?? DEFAULT_SPEC.contentKey,
  }
}

/** 取工具名对应的参数名，非本插件接管的工具返回 null。 */
function specFor(toolName: string | undefined): KeySpec | null {
  if (toolName === 'edit' || toolName === 'write') return DEFAULT_SPEC
  if (toolName === undefined) return null
  return extraSpecs.get(toolName) ?? null
}

// ==================== 近线性 diff 核心 ====================

/** 行级 Myers：前缀/后缀收缩后仅对中间核心区跑 diff，返回 op 数组。 */
function myersDiff(aList: readonly string[], bList: readonly string[]): DiffOp[] {
  const N = aList.length
  const M = bList.length
  const max = N + M
  let prev: Record<number, number> = { 1: 0 }
  const trace: Array<Record<number, number>> = []
  let dMax = 0
  let found = false
  for (let d = 0; d <= max; d++) {
    trace.push({ ...prev })
    const cur: Record<number, number> = {}
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && (prev[k - 1] ?? -Infinity) < (prev[k + 1] ?? -Infinity))) x = prev[k + 1] ?? 0
      else x = (prev[k - 1] ?? -1) + 1
      let y = x - k
      while (x < N && y < M && aList[x] === bList[y]) { x++; y++ }
      cur[k] = x
      if (x >= N && y >= M) { dMax = d; found = true; break }
    }
    prev = cur
    if (found) break
  }
  if (!found) {
    const ops: DiffOp[] = []
    for (let i = 0; i < N; i++) ops.push({ type: 'del', a: i, b: -1 })
    for (let j = 0; j < M; j++) ops.push({ type: 'add', a: -1, b: j })
    return ops
  }
  const ops: DiffOp[] = []
  let x = N
  let y = M
  for (let d = dMax; d > 0; d--) {
    const t = trace[d] ?? {}
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && (t[k - 1] ?? -Infinity) < (t[k + 1] ?? -Infinity))) prevK = k + 1
    else prevK = k - 1
    const prevX = t[prevK] ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) { ops.push({ type: 'same', a: x - 1, b: y - 1 }); x--; y-- }
    if (x === prevX) { ops.push({ type: 'add', a: -1, b: y - 1 }); y-- }
    else { ops.push({ type: 'del', a: x - 1, b: -1 }); x-- }
  }
  while (x > 0 && y > 0) { ops.push({ type: 'same', a: x - 1, b: y - 1 }); x--; y-- }
  ops.reverse()
  return ops
}

/** 行级 diff：线性前缀/后缀收缩，仅对中间核心区跑 Myers。 */
function lineDiff(aLines: readonly string[], bLines: readonly string[]): DiffOp[] {
  let p = 0
  const minLen = Math.min(aLines.length, bLines.length)
  while (p < minLen && aLines[p] === bLines[p]) p++
  let s = 0
  const al = aLines.length
  const bl = bLines.length
  while (s < minLen - p && aLines[al - 1 - s] === bLines[bl - 1 - s]) s++
  const ops: DiffOp[] = []
  for (let i = 0; i < p; i++) ops.push({ type: 'same', a: i, b: i })
  const aMid = aLines.slice(p, al - s)
  const bMid = bLines.slice(p, bl - s)
  for (const op of myersDiff(aMid, bMid)) {
    ops.push({ type: op.type, a: op.a === -1 ? -1 : op.a + p, b: op.b === -1 ? -1 : op.b + p })
  }
  for (let i = 0; i < s; i++) ops.push({ type: 'same', a: al - s + i, b: bl - s + i })
  return ops
}

/** 把字符级 op 汇总成高亮区间 [start, end)。 */
function charRanges(ops: readonly DiffOp[]): { del: CharRange[]; add: CharRange[] } {
  const delIdx: number[] = []
  const addIdx: number[] = []
  for (const op of ops) {
    if (op.type === 'del') delIdx.push(op.a)
    else if (op.type === 'add') addIdx.push(op.b)
  }
  const mk = (idx: number[]): CharRange[] => {
    if (idx.length === 0) return []
    idx.sort((a, b) => a - b)
    const out: CharRange[] = []
    let start = idx[0] as number
    let end = start
    for (let i = 1; i < idx.length; i++) {
      const value = idx[i] as number
      if (value === end + 1) end = value
      else { out.push([start, end + 1]); start = value; end = value }
    }
    out.push([start, end + 1])
    return out
  }
  return { del: mk(delIdx), add: mk(addIdx) }
}

function lineHighlight(oldStr: string, newStr: string): { del: CharRange[]; add: CharRange[] } {
  return charRanges(myersDiff([...oldStr], [...newStr]))
}

function contentLines(text: string): string[] {
  if (text === '') return []
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

/** 从 ops 构建渲染行，仅含真实差异；替换对删/增行数相等做行内字符高亮。 */
function buildDiffLines(oldLines: readonly string[], newLines: readonly string[]): RenderLine[] {
  const ops = lineDiff(oldLines, newLines)
  const out: RenderLine[] = []
  let i = 0
  while (i < ops.length) {
    if (ops[i]?.type === 'same') { i++; continue }
    const dStart = i
    while (i < ops.length && ops[i]?.type === 'del') i++
    const addStart = i
    while (i < ops.length && ops[i]?.type === 'add') i++
    const delOps = ops.slice(dStart, addStart)
    const addOps = ops.slice(addStart, i)
    if (delOps.length === addOps.length && delOps.length > 0) {
      for (let k = 0; k < delOps.length; k++) {
        const del = delOps[k]
        const add = addOps[k]
        if (del === undefined || add === undefined) continue
        const oldText = oldLines[del.a] ?? ''
        const newText = newLines[add.b] ?? ''
        const hl = lineHighlight(oldText, newText)
        out.push({ kind: 'del', text: oldText, hl: hl.del })
        out.push({ kind: 'add', text: newText, hl: hl.add })
      }
    } else {
      for (const op of delOps) out.push({ kind: 'del', text: oldLines[op.a] ?? '', hl: [] })
      for (const op of addOps) out.push({ kind: 'add', text: newLines[op.b] ?? '', hl: [] })
    }
  }
  return out
}

// ==================== 卡片模型 ====================

/** 收窄外部 diff 数据，字段不合法时返回 null。 */
function narrowDiffs(diffs: unknown): FileDiff[] | null {
  if (!Array.isArray(diffs) || diffs.length === 0) return null
  const out: FileDiff[] = []
  for (const item of diffs as unknown[]) {
    if (item === null || typeof item !== 'object') return null
    const record = item as { path?: unknown; oldText?: unknown; newText?: unknown }
    if (typeof record.path !== 'string') return null
    if (record.oldText !== null && typeof record.oldText !== 'string') return null
    if (typeof record.newText !== 'string') return null
    out.push({ path: record.path, oldText: record.oldText as string | null, newText: record.newText })
  }
  return out
}

/** 从卡片数据块中取出 diff，取不到时回退到参数意图。 */
function extractDiffs(block: ToolBlock, spec: KeySpec | null): FileDiff[] | null {
  const done = 'kind' in block
  // PTC 子调用标记：新版 DSH 用 parentCallId；旧版 callId 含 ':code:'，双兼容
  const subCall = block.parentCallId !== void 0 ||
    (typeof block.callId === 'string' && block.callId.includes(':code:'))

  // settled 且非错误：取真实应用的 diff，新版 DSH 存放在 block.meta.diffs。
  // 结构与内置 diffCardModel/appliedDiffs 同构，支持多 hunk。
  if (done && !subCall && block.isError !== true) {
    const meta = block.meta
    if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
      const diffs = (meta as { diffs?: unknown }).diffs
      if (Array.isArray(diffs) && diffs.length > 0) {
        const narrowed = narrowDiffs(diffs)
        if (narrowed !== null) return narrowed
      }
    }
  }

  // 子调用 / running / 兜底：没有真实 diff，改为从参数意图推断。
  // running 的 argsRaw/name 在 block 顶层，settled 的挪到 block.call 上，两处兼容。
  // settled 失败同样不显示意图 diff，与内置 diffCardModel 一致。
  if (done && !subCall && block.isError === true) return null
  const rawArgs = (block.call !== undefined ? block.call.argsRaw : block.argsRaw) ?? ''
  const argsRaw = typeof rawArgs === 'string' ? rawArgs : ''
  if (spec !== null) {
    try {
      const args: unknown = JSON.parse(argsRaw)
      if (args !== null && typeof args === 'object') {
        const record = args as Record<string, unknown>
        const filePath = record[spec.pathKey]
        if (typeof filePath === 'string' && filePath !== '') {
          const oldText = record[spec.oldKey]
          const newText = record[spec.newKey]
          if (typeof oldText === 'string' && typeof newText === 'string') {
            return narrowDiffs([{ path: filePath, oldText: oldText || null, newText }])
          }
          if (typeof record[spec.contentKey] === 'string') {
            return narrowDiffs([{ path: filePath, oldText: null, newText: record[spec.contentKey] as string }])
          }
        }
      }
    } catch {}
  }

  // 旧版 DSH 在 0.1.x 重构前没有以上字段，回退从 callView/resultView 读 diff。
  if (!done) {
    const callView = block.callView
    if (callView === null || typeof callView !== 'object' || (callView as { card?: unknown }).card !== 'diff') return null
    return narrowDiffs((callView as { diffs?: unknown }).diffs)
  }
  const resultView = block.resultView
  if (resultView === null || typeof resultView !== 'object' || (resultView as { card?: unknown }).card !== 'diff') return null
  return narrowDiffs((resultView as { diffs?: unknown }).diffs)
}

/** 汇总工具结果文本。 */
function resultText(block: ToolBlock): string {
  if (!('kind' in block)) return ''
  const parts: string[] = []
  const content = Array.isArray(block.content) ? block.content : []
  for (const item of content as unknown[]) {
    const record = item !== null && typeof item === 'object' ? item as { type?: unknown; text?: unknown } : null
    const isText = record !== null && record.type === 'text' && typeof record.text === 'string'
    parts.push(isText ? record.text as string : JSON.stringify(item))
  }
  if (parts.length === 0 && block.error !== undefined) {
    parts.push(String(block.error.name) + ': ' + String(block.error.code))
  }
  return parts.join('\n')
}

function firstLine(t: string): string {
  const n = t.indexOf('\n')
  return n === -1 ? t : t.slice(0, n)
}

/** 由数据块推导卡片模型。 */
function buildCardModel(block: ToolBlock, toolName: string | undefined, cwd: string | undefined): CardModel {
  const done = 'kind' in block
  const spec = specFor(toolName)
  const rawArgs = done ? (block.call?.argsRaw ?? '') : (block.argsRaw ?? '')
  const argsRaw = typeof rawArgs === 'string' ? rawArgs : ''
  const state: CardState = !done ? 'running' : block.error?.code === 'interrupted' ? 'stopped' : block.isError === true ? 'error' : 'ok'
  let kind: 'edit' | 'write' | null = toolName === 'edit' ? 'edit' : toolName === 'write' ? 'write' : null
  let filePath: string | undefined
  let summary = ''
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      const p = (spec === null ? undefined : record[spec.pathKey]) ?? record.path
      if (typeof p === 'string' && p !== '') filePath = firstLine(p)
      if (kind === null && spec !== null) {
        const oldText = record[spec.oldKey]
        const newText = record[spec.newKey]
        if (typeof oldText === 'string' && typeof newText === 'string') kind = 'edit'
        else if (typeof record[spec.contentKey] === 'string') kind = 'write'
      }
      const values = Object.values(record).filter((v): v is string => typeof v === 'string' && v !== '')
      summary = values.length > 0 ? firstLine(values[0] as string) : argsRaw
    } else summary = firstLine(argsRaw)
  } catch { summary = firstLine(argsRaw) }
  if (filePath !== undefined) summary = filePath
  if (filePath !== undefined && cwd !== undefined) {
    const root = cwd.replace(/[/\\]+$/, '')
    if (filePath.startsWith(root + '/') || filePath.startsWith(root + '\\')) summary = filePath.slice(root.length + 1)
  }
  const title = kind === 'edit' ? 'Edit' : kind === 'write' ? 'Write' : (toolName ?? '')
  const diffs = extractDiffs(block, spec)
  const output = done ? (resultText(block) || null) : null
  return { title, summary, filePath, state, diffs, output }
}

// ==================== 组件 ====================

function DiffCard(props: DiffCardProps): React.ReactElement {
  const { block, cwd, openFile, inspect, toolName } = props
  // open：点行头展开整个卡片；revealed：展开后点「展开其余」显示全部行
  const [open, setOpen] = React.useState(false)
  const [revealed, setRevealed] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const m = buildCardModel(block, toolName, cwd)
  const fileLines = m.diffs === null ? null : m.diffs.map(d => ({ path: d.path, lines: buildDiffLines(contentLines(d.oldText ?? ''), contentLines(d.newText)) }))
  const hasAny = fileLines !== null && fileLines.some(f => f.lines.length > 0)
  const displayLines = hasAny ? fileLines : null
  const addCount = displayLines === null ? 0 : displayLines.reduce((sum, f) => sum + f.lines.filter(l => l.kind === 'add').length, 0)
  const delCount = displayLines === null ? 0 : displayLines.reduce((sum, f) => sum + f.lines.filter(l => l.kind === 'del').length, 0)
  const files = m.diffs === null ? 0 : m.diffs.length
  const hasContent = displayLines !== null || m.output !== null
  const expandable = hasContent
  const status = m.state === 'running' ? '运行中' : m.state === 'error' ? '失败' : m.state === 'stopped' ? '已中断' : null
  const failureSummary = m.state === 'error' && m.output !== null ? firstLine(m.output) : null
  const summaryText = failureSummary !== null ? failureSummary : (m.summary || m.title)
  const fileLink = m.filePath !== undefined && openFile !== undefined && failureSummary === null
  const MAX = 14
  let flatLines: RenderLine[] | null = null
  let hidden = 0
  if (displayLines !== null && open) {
    const rows: RenderLine[] = []
    for (const f of displayLines) {
      rows.push({ kind: 'path', text: f.path, hl: [] })
      rows.push(...f.lines)
    }
    hidden = rows.length - MAX
    if (hidden < 0) hidden = 0
    if (hidden > 0 && !revealed) {
      const headN = Math.ceil(MAX / 2)
      flatLines = [
        ...rows.slice(0, headN),
        { kind: 'mid', text: '⋯ 展开其余 ' + hidden + ' 行差异', hl: [] },
        ...rows.slice(rows.length - (MAX - headN)),
      ]
    } else {
      flatLines = rows
    }
  }
  const onToggle = (): void => { setOpen(v => !v); setRevealed(false) }
  const onOpenFile = (event: React.MouseEvent): void => {
    event.stopPropagation()
    if (m.filePath !== undefined && openFile !== undefined) openFile(m.filePath)
  }
  const onCopy = (): void => {
    if (copied || flatLines === null || flatLines.length === 0) return
    const txt = flatLines.map(l => l.kind === 'del' ? '- ' + l.text : l.kind === 'add' ? '+ ' + l.text : l.text).join('\n')
    copyTextIntoClipboard(txt)
    setCopied(true)
    const timeout = timerRef.timeout
    if (timeout !== null) timeout(() => setCopied(false), 1200)
  }
  const rowType = m.title === 'Write' ? 'write' : m.title === 'Edit' ? 'edit' : 'file'
  return React.createElement('div', { className: 'edd-root', 'data-variant': rowType, 'data-state': m.state },
    status !== null && React.createElement('span', { className: 'edd-vh' }, status),
    React.createElement('div', { className: 'edd-row', onClick: onToggle, role: 'button', tabIndex: expandable ? 0 : -1, 'aria-expanded': open },
      React.createElement('span', { className: 'edd-icon' }, '✎'),
      React.createElement('span', { className: 'edd-title' }, m.title),
      summaryText !== '' && React.createElement(React.Fragment, null,
        React.createElement('span', { className: 'edd-sep', 'aria-hidden': true }),
        fileLink
          ? React.createElement('button', { type: 'button', className: 'edd-filelink', onClick: onOpenFile }, summaryText)
          : React.createElement('span', { className: 'edd-summary' + (failureSummary !== null ? ' edd-err' : '') }, summaryText)
      ),
      expandable && React.createElement('span', { className: 'edd-chev' + (open ? ' edd-chev-open' : '') }, '›')
    ),
    React.createElement('div', { className: 'edd-bodyWrap' },
      (flatLines === null ? null : React.createElement('div', { className: 'edd-body' },
        React.createElement('button', { type: 'button', className: 'edd-copy', onClick: onCopy }, copied ? '复制成功' : '复制'),
        flatLines.map((line, idx) => {
          if (line.kind === 'mid') return React.createElement('button', { key: idx, type: 'button', className: 'edd-expand', onClick: () => setRevealed(true) }, line.text)
          const prefix = line.kind === 'del' ? '-' : line.kind === 'add' ? '+' : ''
          const kids: React.ReactNode[] = []
          if (prefix !== '') kids.push(React.createElement('span', { key: 'p', className: 'edd-marker' }, prefix))
          if (line.kind === 'del' || line.kind === 'add') {
            if (line.text.length === 0) {
              kids.push(React.createElement('span', { key: 'e', className: 'edd-empty' }, '␣'))
            } else if (line.hl.length > 0) {
              let last = 0
              for (const range of line.hl) {
                if (range[0] > last) kids.push(React.createElement('span', { key: 't' + last, className: 'edd-plain' }, line.text.slice(last, range[0])))
                kids.push(React.createElement('span', { key: 'h' + range[0], className: 'edd-hl' }, line.text.slice(range[0], range[1])))
                last = range[1]
              }
              if (last < line.text.length) kids.push(React.createElement('span', { key: 't' + last, className: 'edd-plain' }, line.text.slice(last)))
            } else {
              kids.push(React.createElement('span', { key: 't', className: 'edd-plain' }, line.text))
            }
          } else {
            kids.push(React.createElement('span', { key: 't', className: 'edd-plain' }, line.text))
          }
          return React.createElement('div', { key: idx, className: 'edd-line ' + (line.kind === 'del' ? 'edd-del' : line.kind === 'add' ? 'edd-add' : line.kind === 'path' ? 'edd-path' : 'edd-plain-line') }, kids)
        })
      )),
      open && m.output !== null && flatLines === null && React.createElement('div', { className: 'edd-io' },
        React.createElement('span', { className: 'edd-iolabel' }, 'OUT'),
        React.createElement('span', { className: 'edd-iotext' }, m.output)
      ),
      open && ((flatLines !== null && flatLines.length > 0) || m.output !== null) && React.createElement('div', { className: 'edd-foot' }, '└ +' + addCount + ' -' + delCount + ' · ' + files + ' file' + (files === 1 ? '' : 's')),
      open && React.createElement('div', { className: 'edd-actions' },
        inspect !== undefined && ((flatLines !== null && flatLines.length > 0) || m.output !== null) && React.createElement('button', { type: 'button', className: 'edd-inspect', onClick: inspect }, 'Inspect')
      )
    )
  )
}

// ==================== 剪贴板与样式 ====================

/** 宿主 timer 服务的时间回调，未注入时为 null。 */
const timerRef: { timeout: ((callback: () => void, ms: number) => void) | null } = { timeout: null }

function copyTextIntoClipboard(txt: string): void {
  if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && navigator.clipboard.writeText !== undefined) {
    navigator.clipboard.writeText(txt).catch(() => {})
    return
  }
  if (DOC === null) return
  const ta = DOC.createElement('textarea')
  ta.value = txt
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  DOC.body.appendChild(ta)
  ta.select()
  try { DOC.execCommand('copy') } catch {}
  DOC.body.removeChild(ta)
}

// 视觉对齐内置 DiffBlock / ToolRow：复用同一批主题 token，字号/圆角/背景保持一致。
const CSS = [
  '.edd-root{box-sizing:border-box;color:var(--dsw-alias-label-primary);}',
  '.edd-vh{position:absolute;width:1px;height:1px;clip:rect(0 0 0 0);overflow:hidden;white-space:nowrap;}',
  '.edd-row{display:flex;align-items:center;gap:6px;cursor:pointer;min-height:24px;padding:4px 0;font-size:14px;line-height:24px;}',
  '.edd-icon{color:var(--dsw-alias-label-secondary);flex:none;font-style:normal;}',
  '.edd-title{font-weight:400;flex:none;color:var(--dsw-alias-label-primary);}',
  '.edd-sep{flex:none;width:2px;height:2px;border-radius:1px;margin:0 8px;background:var(--dsw-alias-label-caption);}',
  '.edd-summary{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:24px;color:var(--dsw-alias-label-tertiary);text-align:left;}',
  '.edd-err{color:var(--dsw-alias-state-error-primary);}',
  '.edd-filelink{flex:1 1 auto;min-width:0;margin:0;padding:0;border:none;background:none;font-family:inherit;font-size:14px;line-height:24px;color:var(--dsw-alias-label-secondary);text-decoration:underline;text-decoration-color:var(--dsw-alias-label-quaternary);text-underline-offset:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;cursor:pointer;}',
  '.edd-filelink:hover{color:var(--dsw-alias-label-primary);text-decoration-color:currentColor;}',
  '.edd-chev{margin-left:auto;color:var(--dsw-alias-label-secondary);flex:none;transition:transform .12s;display:inline-block;}',
  '.edd-chev-open{transform:rotate(90deg);}',
  '.edd-bodyWrap{overflow:hidden;}',
  '.edd-body{position:relative;margin:8px 0;background:var(--dsw-alias-markdown-code-block);border-radius:12px;font:var(--dsw-font-markdown-code-block);overflow-x:auto;overflow-y:hidden;padding:12px 14px 12px 14px;box-sizing:border-box;}',
  '.edd-copy{position:absolute;top:8px;right:12px;z-index:1;background-color:transparent;border:none;padding:0;margin:0;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xs-13);}',
  '.edd-copy:hover{color:var(--dsw-alias-label-primary);}',
  '.edd-path{color:var(--dsw-alias-label-primary);font-weight:600;padding-right:56px;}',
  '.edd-line{min-height:22px;white-space:pre;}',
  '.edd-del{color:var(--dsw-alias-state-error-primary);}',
  '.edd-add{color:var(--dsw-alias-state-success-primary);}',
  '.edd-marker{color:inherit;opacity:1;user-select:none;}',
  '.edd-plain{white-space:pre;}',
  '.edd-empty{opacity:.5;font-style:italic;}',
  '.edd-hl{text-decoration:underline;text-decoration-thickness:2px;text-decoration-color:currentColor;font-weight:600;}',
  '.edd-expand{display:inline-block;margin:2px 0;padding:1px 0;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font:var(--dsw-font-markdown-code-block);text-align:left;}',
  '.edd-expand:hover{color:var(--dsw-alias-label-secondary);}',
  '.edd-foot{padding:0 14px 12px;font:var(--dsw-font-markdown-code-block);color:var(--dsw-alias-label-tertiary);}',
  '.edd-io{padding:8px 14px;}',
  '.edd-iolabel{margin-right:8px;color:var(--dsw-alias-label-caption);font-weight:600;}',
  '.edd-iotext{color:var(--dsw-alias-label-secondary);white-space:pre-wrap;word-break:break-word;}',
  '.edd-actions{padding:4px 0 2px 4px;}',
  '.edd-inspect{display:inline-flex;align-items:center;gap:4px;margin:0;padding:2px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;cursor:pointer;opacity:0;transition:opacity .12s ease;}',
  '.edd-root:hover .edd-inspect,.edd-inspect:focus-visible{opacity:1;}',
  '.edd-inspect:hover{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary);}',
].join('')

let styleTag: HTMLStyleElement | null = null

function ensureStyle(): void {
  if (DOC === null || styleTag !== null) return
  const tag = DOC.createElement('style')
  tag.dataset.plugin = 'dsh-edit-diff'
  tag.textContent = CSS
  DOC.head.appendChild(tag)
  styleTag = tag
}

// ==================== 插件 ====================

const plugin = {
  name: 'dsh-edit-diff',
  inject: ['slots', 'timer'],
  apply(ctx: PluginContext): void {
    const slots = ctx.get?.('slots') as SlotsService | undefined
    if (slots === undefined) return
    const timer = ctx.get?.('timer') as TimerService | undefined
    if (timer !== undefined && typeof timer.timeout === 'function') {
      timerRef.timeout = (callback, ms) => { timer.timeout(callback, ms) }
    }

    ctx.effect(function () {
      ensureStyle()
      return function () {
        if (styleTag !== null && styleTag.parentNode !== null) styleTag.parentNode.removeChild(styleTag)
        styleTag = null
      }
    })

    slots.inject('tool.call.toolview', () => {
      // priority 要低于默认 0，遮蔽 file-mutation-toolview 的 edit/write，最低者渲染。
      // 若也传 0 会在同一 key 上 clash，而非替换。
      slots.register({ name: 'tool.call.toolview', key: 'edit', priority: -1 }, DiffCard)
      slots.register({ name: 'tool.call.toolview', key: 'write', priority: -1 }, DiffCard)
    })

    // extraTools 经 settings 命名空间到达。没有挂载 settings 时上面两张卡片照常工作。
    if (typeof ctx.inject !== 'function') return
    ctx.inject(['settingsScope'], (settingsCtx) => {
      const settingsScope = settingsCtx.get?.('settingsScope') as SettingsScopeService | undefined
      if (settingsScope === undefined || typeof settingsScope.bind !== 'function') return
      const scope = settingsScope.bind<PluginConfig>({ namespace: 'dsh-edit-diff' })
      let disposeExtra: (() => void) | void
      // 配置变化时整批重建：先换参数名表，再重建这批 key 的注册。
      const sync = (): void => {
        if (typeof disposeExtra === 'function') disposeExtra()
        const value = scope.getSnapshot().value
        const tools = Array.isArray(value?.extraTools) ? value.extraTools : []
        extraSpecs.clear()
        const names: string[] = []
        for (const tool of tools) {
          if (tool === null || typeof tool !== 'object') continue
          if (typeof tool.name !== 'string' || tool.name === '') continue
          if (tool.name === 'edit' || tool.name === 'write') continue
          extraSpecs.set(tool.name, toKeySpec(tool))
          names.push(tool.name)
        }
        disposeExtra = ctx.effect(() => {
          for (const name of names) {
            slots.inject('tool.call.toolview', () => {
              slots.register({ name: 'tool.call.toolview', key: name, priority: -1 }, DiffCard)
            })
          }
        })
      }
      scope.subscribe(sync)
      sync()
    })
  },
}

export default plugin
export const name = plugin.name
export const inject = plugin.inject
export const apply = plugin.apply
