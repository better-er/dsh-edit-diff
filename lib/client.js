// dsh-edit-diff 浏览器端，标准 dsh client bundle 形态。
//
// 通过 window.__ModuleLoader__.load 注册模块表条目，factory 从注入的 require
// 解析 react 等外部依赖。默认导出 Cordis 插件对象，由浏览器内核挂载。
//
// 接管 edit/write 工具卡片：内置 DiffBlock 对新旧全文逐行染色，不做行级匹配，
// 相同行在红绿两区各渲染一遍。本插件接管 tool.call.toolview 的 edit/write key，
// 用近线性行级 diff 公共前缀/后缀收缩 + Myers 跳过相同行，替换行做字符级
// 下划线高亮。视觉对齐内置 DiffBlock/ToolRow。卡片默认收起，长 diff 二次折叠。
// PTC 模式下 run_code 子调用中的 edit/write 同样显示去重 diff，
// 通过 callId 中的 :code: 标记识别子调用，从 argsRaw 动态构建 diff。

window.__ModuleLoader__.load({
  id: 'dsh-edit-diff',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')
    const DOC = typeof document !== 'undefined' ? document : null

    // ==================== 近线性 diff 核心 ====================

    /** 行级 Myers：前缀/后缀收缩后仅对中间核心区跑 diff，返回 op 数组。 */
    function myersDiff(aList, bList) {
      const N = aList.length, M = bList.length
      const max = N + M
      let prev = { 1: 0 }
      const trace = []
      let dMax = 0, found = false
      for (let d = 0; d <= max; d++) {
        trace.push({ ...prev })
        const cur = {}
        for (let k = -d; k <= d; k += 2) {
          let x
          if (k === -d || (k !== d && (prev[k - 1] ?? -Infinity) < (prev[k + 1] ?? -Infinity))) x = (prev[k + 1] ?? 0)
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
        const ops = []
        for (let i = 0; i < N; i++) ops.push({ type: 'del', a: i, b: -1 })
        for (let j = 0; j < M; j++) ops.push({ type: 'add', a: -1, b: j })
        return ops
      }
      const ops = []
      let x = N, y = M
      for (let d = dMax; d > 0; d--) {
        const t = trace[d]
        const k = x - y
        let prevK
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
    function lineDiff(aLines, bLines) {
      let p = 0
      const minLen = Math.min(aLines.length, bLines.length)
      while (p < minLen && aLines[p] === bLines[p]) p++
      let s = 0
      const al = aLines.length, bl = bLines.length
      while (s < minLen - p && aLines[al - 1 - s] === bLines[bl - 1 - s]) s++
      const ops = []
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
    function charRanges(ops) {
      const delR = [], addR = []
      for (const op of ops) {
        if (op.type === 'del') delR.push(op.a)
        else if (op.type === 'add') addR.push(op.b)
      }
      const mk = (idx) => {
        if (idx.length === 0) return []
        idx.sort((a, b) => a - b)
        const out = []; let s = idx[0], e = idx[0]
        for (let i = 1; i < idx.length; i++) {
          if (idx[i] === e + 1) e = idx[i]
          else { out.push([s, e + 1]); s = idx[i]; e = idx[i] }
        }
        out.push([s, e + 1])
        return out
      }
      return { del: mk(delR), add: mk(addR) }
    }
    function lineHighlight(oldStr, newStr) {
      return charRanges(myersDiff([...oldStr], [...newStr]))
    }

    function contentLines(text) {
      if (text === '') return []
      return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
    }

    /** 从 ops 构建渲染行，仅含真实差异；替换对删/增行数相等做行内字符高亮。 */
    function buildDiffLines(oldLines, newLines) {
      const ops = lineDiff(oldLines, newLines)
      const out = []
      let i = 0
      while (i < ops.length) {
        if (ops[i].type === 'same') { i++; continue }
        const dStart = i
        while (i < ops.length && ops[i].type === 'del') i++
        const addStart = i
        while (i < ops.length && ops[i].type === 'add') i++
        const delOps = ops.slice(dStart, addStart)
        const addOps = ops.slice(addStart, i)
        if (delOps.length === addOps.length && delOps.length > 0) {
          for (let k = 0; k < delOps.length; k++) {
            const hl = lineHighlight(oldLines[delOps[k].a], newLines[addOps[k].b])
            out.push({ kind: 'del', text: oldLines[delOps[k].a], hl: hl.del })
            out.push({ kind: 'add', text: newLines[addOps[k].b], hl: hl.add })
          }
        } else {
          for (const op of delOps) out.push({ kind: 'del', text: oldLines[op.a], hl: [] })
          for (const op of addOps) out.push({ kind: 'add', text: newLines[op.b], hl: [] })
        }
      }
      return out
    }

    // ==================== 卡片模型 ====================

    function narrowDiffs(diffs) {
      if (!Array.isArray(diffs) || diffs.length === 0) return null
      const out = []
      for (const h of diffs) {
        if (typeof h !== 'object' || h === null) return null
        const path = h.path, oldText = h.oldText, newText = h.newText
        if (typeof path !== 'string') return null
        if (oldText !== null && typeof oldText !== 'string') return null
        if (typeof newText !== 'string') return null
        out.push({ path, oldText, newText })
      }
      return out
    }

    function extractDiffs(block) {
      const done = 'kind' in block
      // PTC 子调用标记：新版 DSH 用 parentCallId；旧版 callId 含 ':code:'，双兼容
      const subCall = block.parentCallId !== void 0 ||
        (typeof block.callId === 'string' && block.callId.includes(':code:'))

      // settled 且非错误：取真实应用的 diff，新版 DSH 存放在 block.meta.diffs。
      // 结构与内置 diffCardModel/appliedDiffs 同构，支持多 hunk。
      if (done && !subCall && !block.isError) {
        const meta = block.meta
        if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
          const diffs = meta.diffs
          if (Array.isArray(diffs) && diffs.length > 0) {
            const n = narrowDiffs(diffs)
            if (n !== null) return n
          }
        }
      }

      // 子调用 / running / 兜底：没有真实 diff，改为从参数意图推断。
      // running 的 argsRaw/name 在 block 顶层，settled 的挪到 block.call 上，两处兼容。
      // settled 失败同样不显示意图 diff，与内置 diffCardModel 一致。
      if (done && !subCall && block.isError) return null
      const argsRaw = (block.call ? block.call.argsRaw : block.argsRaw) ?? ''
      const name = block.call ? block.call.name : block.name
      if (name === 'edit' || name === 'write') {
        try {
          const args = JSON.parse(argsRaw)
          if (args && typeof args === 'object') {
            const filePath = args.file_path
            if (typeof filePath === 'string' && filePath !== '') {
              if (name === 'write' && typeof args.content === 'string') {
                return narrowDiffs([{ path: filePath, oldText: null, newText: args.content }])
              }
              if (name === 'edit' && typeof args.old_string === 'string' && typeof args.new_string === 'string') {
                return narrowDiffs([{ path: filePath, oldText: args.old_string || null, newText: args.new_string }])
              }
            }
          }
        } catch {}
      }

      // 旧版 DSH 在 0.1.x 重构前没有以上字段，回退从 callView/resultView 读 diff。
      if (!done) {
        const call = block.callView && block.callView.card === 'diff' ? block.callView : null
        return call ? narrowDiffs(call.diffs) : null
      }
      const result = block.resultView && block.resultView.card === 'diff' ? block.resultView : null
      return result ? narrowDiffs(result.diffs) : null
    }

    function resultText(block) {
      if (!('kind' in block)) return ''
      const parts = []
      for (const b of block.content) {
        parts.push(b.type === 'text' ? b.text : JSON.stringify(b))
      }
      if (parts.length === 0 && block.error !== undefined) parts.push(block.error.name + ': ' + block.error.code)
      return parts.join('\n')
    }

    function firstLine(t) { const n = t.indexOf('\n'); return n === -1 ? t : t.slice(0, n) }

    function buildCardModel(block, toolName, cwd) {
      const done = 'kind' in block
      const argsRaw = (done ? (block.call ? block.call.argsRaw : '') : (block.argsRaw ?? ''))
      const state = !done ? 'running' : (block.error && block.error.code === 'interrupted') ? 'stopped' : block.isError ? 'error' : 'ok'
      let filePath
      let summary = ''
      try {
        const parsed = JSON.parse(argsRaw)
        if (parsed && typeof parsed === 'object') {
          const p = parsed.file_path ?? parsed.path
          if (typeof p === 'string' && p !== '') filePath = firstLine(p)
          const vs = Object.values(parsed).filter(v => typeof v === 'string' && v !== '')
          summary = vs.length > 0 ? firstLine(vs[0]) : argsRaw
        } else summary = firstLine(argsRaw)
      } catch { summary = firstLine(argsRaw) }
      if (filePath !== undefined) summary = filePath
      if (filePath !== undefined && cwd) {
        const root = cwd.replace(/[/\\]+$/, '')
        if (filePath.startsWith(root + '/') || filePath.startsWith(root + '\\')) summary = filePath.slice(root.length + 1)
      }
      const title = toolName === 'edit' ? 'Edit' : toolName === 'write' ? 'Write' : (toolName || '')
      const diffs = extractDiffs(block)
      const output = done ? (resultText(block) || null) : null
      return { title, summary, filePath, state, diffs, output }
    }

    // ==================== 组件 ====================

    function DiffCard(props) {
      const block = props.block, cwd = props.cwd, openFile = props.openFile, inspect = props.inspect, toolName = props.toolName
      // open：点行头展开整个卡片；revealed：展开后点「展开其余」显示全部行
      const [open, setOpen] = React.useState(false)
      const [revealed, setRevealed] = React.useState(false)
      const [copied, setCopied] = React.useState(false)
      const m = buildCardModel(block, toolName, cwd)
      const fileLines = m.diffs === null ? null : m.diffs.map(d => ({ path: d.path, lines: buildDiffLines(contentLines(d.oldText ?? ''), contentLines(d.newText)) }))
      const hasAny = fileLines !== null && fileLines.some(f => f.lines.length > 0)
      const displayLines = hasAny ? fileLines : null
      const addCount = displayLines ? displayLines.reduce((s, f) => s + f.lines.filter(l => l.kind === 'add').length, 0) : 0
      const delCount = displayLines ? displayLines.reduce((s, f) => s + f.lines.filter(l => l.kind === 'del').length, 0) : 0
      const files = m.diffs ? m.diffs.length : 0
      const hasContent = displayLines !== null || m.output !== null
      const expandable = hasContent
      const status = m.state === 'running' ? '运行中' : m.state === 'error' ? '失败' : m.state === 'stopped' ? '已中断' : null
      const failureSummary = m.state === 'error' && m.output !== null ? firstLine(m.output) : null
      const summaryText = failureSummary !== null ? failureSummary : (m.summary || m.title)
      const fileLink = m.filePath !== undefined && openFile !== undefined && failureSummary === null
      const MAX = 14
      let flatLines = null
      let hidden = 0
      if (displayLines && open) {
        flatLines = []
        for (const f of displayLines) {
          flatLines.push({ kind: 'path', text: f.path, hl: [] })
          flatLines.push(...f.lines)
        }
        hidden = flatLines.length - MAX
        if (hidden < 0) hidden = 0
        if (hidden > 0 && !revealed) {
          const headN = Math.ceil(MAX / 2)
          flatLines = flatLines.slice(0, headN)
            .concat({ kind: 'mid', text: '⋯ 展开其余 ' + hidden + ' 行差异', hl: [] })
            .concat(flatLines.slice(flatLines.length - (MAX - headN)))
        }
      }
      const onToggle = () => { setOpen(v => !v); setRevealed(false) }
      const onOpenFile = (e) => { e.stopPropagation(); if (m.filePath !== undefined) openFile(m.filePath) }
      const onCopy = () => {
        if (copied || flatLines === null || flatLines.length === 0) return
        const txt = flatLines.map(l => l.kind === 'del' ? '- ' + l.text : l.kind === 'add' ? '+ ' + l.text : l.text).join('\n')
        copyTextIntoClipboard(txt)
        setCopied(true)
        timerRef.timeout(() => setCopied(false), 1200)
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
          flatLines && React.createElement('div', { className: 'edd-body' },
            React.createElement('button', { type: 'button', className: 'edd-copy', onClick: onCopy }, copied ? '复制成功' : '复制'),
            flatLines.map((l, idx) => {
              if (l.kind === 'mid') return React.createElement('button', { key: idx, type: 'button', className: 'edd-expand', onClick: () => setRevealed(true) }, l.text)
              const prefix = l.kind === 'del' ? '-' : l.kind === 'add' ? '+' : ''
              const kids = []
              if (prefix) kids.push(React.createElement('span', { key: 'p', className: 'edd-marker' }, prefix))
              if (l.kind === 'del' || l.kind === 'add') {
                if (l.text.length === 0) {
                  kids.push(React.createElement('span', { key: 'e', className: 'edd-empty' }, '␣'))
                } else if (l.hl.length > 0) {
                  let last = 0
                  for (const r of l.hl) {
                    if (r[0] > last) kids.push(React.createElement('span', { key: 't' + last, className: 'edd-plain' }, l.text.slice(last, r[0])))
                    kids.push(React.createElement('span', { key: 'h' + r[0], className: 'edd-hl' }, l.text.slice(r[0], r[1])))
                    last = r[1]
                  }
                  if (last < l.text.length) kids.push(React.createElement('span', { key: 't' + last, className: 'edd-plain' }, l.text.slice(last)))
                } else {
                  kids.push(React.createElement('span', { key: 't', className: 'edd-plain' }, l.text))
                }
              } else {
                kids.push(React.createElement('span', { key: 't', className: 'edd-plain' }, l.text))
              }
              return React.createElement('div', { key: idx, className: 'edd-line ' + (l.kind === 'del' ? 'edd-del' : l.kind === 'add' ? 'edd-add' : l.kind === 'path' ? 'edd-path' : 'edd-plain-line') }, kids)
            })
          ),
          open && m.output !== null && flatLines === null && React.createElement('div', { className: 'edd-io' },
            React.createElement('span', { className: 'edd-iolabel' }, 'OUT'),
            React.createElement('span', { className: 'edd-iotext' }, m.output)
          ),
          open && ((flatLines && flatLines.length > 0) || m.output !== null) && React.createElement('div', { className: 'edd-foot' }, '└ +' + addCount + ' -' + delCount + ' · ' + files + ' file' + (files === 1 ? '' : 's')),
          open && React.createElement('div', { className: 'edd-actions' },
            inspect !== undefined && ((flatLines && flatLines.length > 0) || m.output !== null) && React.createElement('button', { type: 'button', className: 'edd-inspect', onClick: inspect }, 'Inspect')
          )
        )
      )
    }

    // ==================== 剪贴板与样式 ====================

    let timerRef = { timeout: null }

    function copyTextIntoClipboard(txt) {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).catch(() => {})
        return
      }
      if (!DOC) return
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

    function ensureStyle() {
      if (!DOC || styleTag) return
      const tag = DOC.createElement('style')
      tag.dataset.plugin = 'dsh-edit-diff'
      tag.textContent = CSS
      DOC.head.appendChild(tag)
      styleTag = tag
    }
    let styleTag = null

    // ==================== 插件 ====================

    const plugin = {
      name: 'dsh-edit-diff',
      inject: ['slots', 'timer'],
      apply(ctx) {
        const slots = ctx.get && ctx.get('slots')
        if (!slots) return
        const timer = ctx.get && ctx.get('timer')
        if (timer && timer.timeout) timerRef.timeout = (fn, ms) => timer.timeout(fn, ms)

        ctx.effect(function () {
          ensureStyle()
          return function () {
            if (styleTag && styleTag.parentNode) styleTag.parentNode.removeChild(styleTag)
            styleTag = null
          }
        })

        slots.inject('tool.call.toolview', () => {
          // priority 要低于默认 0，遮蔽 file-mutation-toolview 的 edit/write，最低者渲染；
          // 若也传 0 会在同一 key 上 clash，而非替换。
          slots.register({ name: 'tool.call.toolview', key: 'edit', priority: -1 }, DiffCard)
          slots.register({ name: 'tool.call.toolview', key: 'write', priority: -1 }, DiffCard)
        })
      },
    }

    exports.default = plugin
    exports.name = plugin.name
    exports.inject = plugin.inject
    exports.apply = plugin.apply

    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    return module.exports
  },
})