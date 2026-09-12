/**
 * 侧边栏「世界书」子页。
 *
 * 天蝎座三条主线里的第一条：世界观资料本身。规则书是它的**派生子项**——
 * 同一本世界书可以挂多套不同风格的规则（d100 / d20 / d6 骰池 / 自定义），
 * 这里负责载入、绑定、翻文件、挑规则。
 *
 * 这是会话四元组的第一环（world）：没绑世界书之前，规则书 / 模组 / 角色卡都无处落脚。
 * 只用项目既有的 `.sc-*` 类名，根元素固定为 `.sc-body.sc-scroll`（高度与滚动交给父容器）。
 */
import React, { useMemo, useState } from 'react'
import { api, type SnapshotResponse, type WorldView } from './api.ts'
import { RULE_STYLES, type Rulebook } from '../shared/model.ts'
import { Banner, Btn, Empty, Field, Markdown, MetaRow, Section, num, relTime } from './ui.tsx'

export interface WorldbookPageProps {
  sessionId: string
  data: SnapshotResponse
  busy: boolean
  onLoad: (path: string, name: string, listOnly: boolean) => Promise<void>
  onBind: (worldId: string) => Promise<void>
  onRename: (worldId: string, name: string) => Promise<void>
  onRemove: (worldId: string) => Promise<void>
  onSelectRulebook: (rulebookId: string, worldId: string) => Promise<void>
  onSaved: () => Promise<void>
  onError: (message: string | undefined) => void
}

/** 单文件正文预览上限：超出只提示总长度，不把整本书塞进 DOM。 */
const FILE_PREVIEW_CHARS = 8000

/** 预览用的 `<pre>`：等宽、可换行、最大高度内滚动。 */
const PRE_STYLE: React.CSSProperties = {
  margin: 0,
  padding: '8px 10px',
  border: '1px solid var(--sc-border)',
  borderRadius: 8,
  background: 'var(--sc-card2)',
  color: 'var(--sc-text)',
  fontFamily: 'var(--sc-mono)',
  fontSize: 11,
  lineHeight: 1.6,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 280,
  overflow: 'auto',
}

function errText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 规则书风格 → 中文标签（d100 低位 / d20 高骰 / D6 骰池 / 自定义）。 */
function styleLabel(style: Rulebook['style']): string {
  return RULE_STYLES.find((item) => item.id === style)?.label ?? String(style)
}

export function WorldbookPage(props: WorldbookPageProps): React.ReactElement {
  const { sessionId, data, busy } = props

  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [listOnly, setListOnly] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<string | undefined>(undefined)
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined)
  const [renameText, setRenameText] = useState('')
  const [toggledId, setToggledId] = useState<string | undefined>(undefined)
  const [openRel, setOpenRel] = useState<string | undefined>(undefined)
  const [fileView, setFileView] = useState<
    { rel: string; text: string; chars: number; truncated: boolean } | undefined
  >(undefined)
  const [fileBusy, setFileBusy] = useState<string | undefined>(undefined)
  const [rulesOpen, setRulesOpen] = useState(true)

  const boundId = data.binding.worldId
  // '' 表示「用户手动收起了当前那本」，undefined 表示「跟随会话绑定」。
  const activeId = toggledId === undefined ? boundId : toggledId === '' ? undefined : toggledId
  const world = useMemo(() => data.worlds.find((item) => item.id === activeId), [data.worlds, activeId])
  const rules = world?.rules ?? []
  const current = data.rulebook
  const spinner = busy ? React.createElement('span', { className: 'sc-spin' }) : undefined

  // ── 写操作 ────────────────────────────────────────────────────────────────

  const toggleWorld = (id: string): void => {
    setOpenRel(undefined)
    setFileView(undefined)
    setToggledId((prev) => {
      const shown = prev === undefined ? boundId : prev
      return shown === id ? '' : id
    })
  }

  const doLoad = async (): Promise<void> => {
    const rel = path.trim()
    if (rel === '') {
      props.onError('请先填写工作区内的相对目录，例如 corpus')
      return
    }
    try {
      await props.onLoad(rel, name.trim(), listOnly)
      setPath('')
      setName('')
      props.onError(undefined)
      await props.onSaved()
    } catch (cause) {
      props.onError(errText(cause))
    }
  }

  const doBind = async (worldId: string): Promise<void> => {
    try {
      await props.onBind(worldId)
      props.onError(undefined)
      await props.onSaved()
    } catch (cause) {
      props.onError(errText(cause))
    }
  }

  const doRename = async (worldId: string): Promise<void> => {
    const next = renameText.trim()
    if (next === '') {
      props.onError('显示名不能为空')
      return
    }
    try {
      await props.onRename(worldId, next)
      setRenamingId(undefined)
      setRenameText('')
      props.onError(undefined)
      await props.onSaved()
    } catch (cause) {
      props.onError(errText(cause))
    }
  }

  const doRemove = async (worldId: string): Promise<void> => {
    try {
      await props.onRemove(worldId)
      setPendingRemove(undefined)
      props.onError(undefined)
      await props.onSaved()
    } catch (cause) {
      props.onError(errText(cause))
    }
  }

  const doUseRulebook = async (rulebookId: string, worldId: string): Promise<void> => {
    try {
      await props.onSelectRulebook(rulebookId, worldId)
      props.onError(undefined)
      await props.onSaved()
    } catch (cause) {
      props.onError(errText(cause))
    }
  }

  /** 点文件名 → 取正文；再点收起。正文只在本地缓存一份，避免来回请求。 */
  const doOpenFile = async (worldId: string, rel: string): Promise<void> => {
    if (openRel === rel) {
      setOpenRel(undefined)
      setFileView(undefined)
      return
    }
    setOpenRel(rel)
    setFileView(undefined)
    setFileBusy(rel)
    try {
      const result = await api.worldFile(sessionId, worldId, rel)
      setFileView({ rel: result.rel, text: result.text, chars: result.chars, truncated: result.truncated })
      props.onError(undefined)
    } catch (cause) {
      props.onError(errText(cause))
      setOpenRel(undefined)
    } finally {
      setFileBusy(undefined)
    }
  }

  // ── 世界书列表 ────────────────────────────────────────────────────────────

  const renderRulebook = (rulebook: Rulebook, worldId: string): React.ReactElement => {
    const isCurrent = data.binding.rulebookId === rulebook.id
    return React.createElement(
      'div',
      { key: rulebook.id, className: 'sc-item', 'data-active': isCurrent },
      React.createElement(
        'div',
        { className: 'sc-item-main' },
        React.createElement('span', { className: 'sc-item-name' }, `${isCurrent ? '★ ' : ''}${rulebook.title}`),
        React.createElement(
          'span',
          { className: 'sc-item-meta' },
          `${styleLabel(rulebook.style)} · ${rulebook.schema?.system ?? '—'} · ${rulebook.schema?.baseDice ?? '—'}`,
        ),
        rulebook.pitch === undefined || rulebook.pitch === ''
          ? null
          : React.createElement('span', { className: 'sc-tiny sc-dim sc-wrap' }, rulebook.pitch),
        React.createElement(
          'span',
          { className: 'sc-tiny sc-muted' },
          `${rulebook.id} · 写入于 ${relTime(rulebook.writtenAt)}`,
        ),
      ),
      React.createElement(
        Btn,
        {
          size: 'sm',
          variant: isCurrent ? 'ghost' : 'primary',
          disabled: busy || isCurrent,
          title: isCurrent ? '当前会话已在用这一套' : '把这一套设为当前会话的规则书',
          onClick: () => {
            void doUseRulebook(rulebook.id, worldId)
          },
        },
        isCurrent ? '当前' : '选用',
      ),
    )
  }

  const renderFiles = (target: WorldView): React.ReactElement =>
    React.createElement(
      'div',
      { className: 'sc-list' },
      ...(target.files ?? []).map((file) =>
        React.createElement(
          'div',
          { key: file.rel, style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
          React.createElement(
            'button',
            {
              className: 'sc-file',
              title: openRel === file.rel ? '收起正文' : '读取正文',
              onClick: () => {
                void doOpenFile(target.id, file.rel)
              },
            },
            React.createElement('span', { className: 'sc-file-rel' }, `${openRel === file.rel ? '▾ ' : '▸ '}${file.rel}`),
            React.createElement('span', { className: 'sc-tiny sc-muted sc-nowrap' }, `${num(file.chars)} 字符`),
            file.truncated === true ? React.createElement('span', { className: 'sc-chip', 'data-tone': 'warn' }, '已截断') : null,
            file.error === undefined ? null : React.createElement('span', { className: 'sc-chip', 'data-tone': 'err' }, file.error),
            fileBusy === file.rel ? React.createElement('span', { className: 'sc-spin' }) : null,
          ),
          openRel === file.rel
            ? fileView === undefined
              ? React.createElement('div', { className: 'sc-tiny sc-muted' }, '读取中…')
              : React.createElement(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 } },
                  React.createElement('pre', { style: PRE_STYLE }, fileView.text.slice(0, FILE_PREVIEW_CHARS)),
                  fileView.chars > FILE_PREVIEW_CHARS || fileView.truncated
                    ? React.createElement(
                        'div',
                        { className: 'sc-tiny sc-muted' },
                        `只预览前 ${num(FILE_PREVIEW_CHARS)} 字符，全文共 ${num(fileView.chars)} 字符` +
                          (fileView.truncated ? '（源文件本身已被截断）' : ''),
                      )
                    : null,
                )
            : null,
        ),
      ),
    )

  const renderWorld = (item: WorldView): React.ReactElement => {
    const isBound = item.id === boundId
    const isActive = item.id === activeId
    const confirming = pendingRemove === item.id
    const renaming = renamingId === item.id
    const worldRules = item.rules ?? []

    return React.createElement(
      'div',
      { key: item.id, className: 'sc-item', 'data-active': isBound },
      React.createElement(
        'button',
        {
          className: 'sc-item-main',
          style: { textAlign: 'left' },
          title: isActive ? '收起文件清单' : '展开文件清单',
          onClick: () => toggleWorld(item.id),
        },
        React.createElement('span', { className: 'sc-item-name' }, `${isBound ? '★ ' : ''}${item.name}`),
        React.createElement(
          'span',
          { className: 'sc-item-meta' },
          `${item.id} · ${item.path}`,
        ),
        React.createElement(
          'span',
          { className: 'sc-tiny sc-muted' },
          `${item.fileCount} 个文件 · ${num(item.totalChars)} 字符 · 载入于 ${relTime(item.loadedAt)}` +
            (isBound ? '' : ' · 未绑定当前会话'),
        ),
      ),
      renaming
        ? React.createElement(
            'div',
            { className: 'sc-row', style: { flexBasis: '100%' } },
            React.createElement('input', {
              value: renameText,
              disabled: busy,
              placeholder: '新的显示名',
              onChange: (event) => setRenameText(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') void doRename(item.id)
              },
            }),
            React.createElement(
              Btn,
              {
                size: 'sm',
                variant: 'primary',
                disabled: busy,
                onClick: () => {
                  void doRename(item.id)
                },
              },
              '保存',
            ),
            React.createElement(
              Btn,
              {
                size: 'sm',
                variant: 'ghost',
                disabled: busy,
                onClick: () => {
                  setRenamingId(undefined)
                  setRenameText('')
                },
              },
              '取消',
            ),
          )
        : React.createElement(
            'div',
            { className: 'sc-row sc-row-wrap', style: { flexBasis: '100%' } },
            React.createElement(
              Btn,
              {
                size: 'sm',
                variant: isBound ? 'ghost' : 'primary',
                disabled: busy || isBound,
                onClick: () => {
                  void doBind(item.id)
                },
              },
              isBound ? '已绑定' : '绑定',
            ),
            React.createElement(
              Btn,
              {
                size: 'sm',
                disabled: busy,
                onClick: () => {
                  setRenamingId(item.id)
                  setRenameText(item.name)
                  setPendingRemove(undefined)
                },
              },
              '改名',
            ),
            confirming
              ? React.createElement(
                  React.Fragment,
                  null,
                  React.createElement('span', { className: 'sc-small sc-err sc-nowrap' }, '确认移除？'),
                  React.createElement(
                    Btn,
                    {
                      size: 'sm',
                      tone: 'danger',
                      disabled: busy,
                      onClick: () => {
                        void doRemove(item.id)
                      },
                    },
                    '确认',
                  ),
                  React.createElement(
                    Btn,
                    { size: 'sm', variant: 'ghost', disabled: busy, onClick: () => setPendingRemove(undefined) },
                    '取消',
                  ),
                )
              : React.createElement(
                  Btn,
                  { size: 'sm', tone: 'danger', disabled: busy, onClick: () => setPendingRemove(item.id) },
                  '移除',
                ),
            React.createElement('span', { className: 'sc-spacer' }),
            React.createElement(
              'span',
              { className: 'sc-tiny sc-muted sc-nowrap' },
              `${worldRules.length} 套规则 · ${(item.modules ?? []).length} 个模组 · ${item.characterCount ?? 0} 张角色`,
            ),
          ),
      isActive
        ? React.createElement(
            'div',
            { style: { flexBasis: '100%', display: 'flex', flexDirection: 'column', gap: 7, minWidth: 0 } },
            (item.files ?? []).length === 0
              ? React.createElement('div', { className: 'sc-tiny sc-muted' }, '这本世界书里没有可读文本文件。')
              : renderFiles(item),
            React.createElement(
              'details',
              {
                open: rulesOpen,
                onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => setRulesOpen(event.currentTarget.open),
                style: { border: '1px dashed var(--sc-border-strong)', borderRadius: 9, padding: '6px 9px' },
              },
              React.createElement(
                'summary',
                { style: { cursor: 'pointer', fontSize: 11.5, fontWeight: 600 } },
                `规则书（${worldRules.length} 套）`,
              ),
              worldRules.length === 0
                ? React.createElement(
                    'div',
                    { className: 'sc-tiny sc-muted', style: { marginTop: 6 } },
                    '这本世界书还没有规则书。让 Agent 依据本世界生成一套即可（scorpio_rulebook_write）。',
                  )
                : React.createElement(
                    'div',
                    { className: 'sc-list', style: { marginTop: 7 } },
                    ...worldRules.map((rulebook) => renderRulebook(rulebook, item.id)),
                  ),
            ),
          )
        : null,
    )
  }

  const loadSection = React.createElement(
    Section,
    { title: '载入世界书', right: spinner },
    React.createElement(
      'div',
      { className: 'sc-row sc-row-wrap' },
      React.createElement(
        Field,
        { label: '资料目录（相对工作区）', hint: '递归读入目录内的 md / txt / json / yaml 等文本' },
        React.createElement('input', {
          value: path,
          placeholder: 'corpus',
          disabled: busy,
          onChange: (event) => setPath(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') void doLoad()
          },
        }),
      ),
      React.createElement(
        Field,
        { label: '显示名（可选）', hint: '缺省取目录名' },
        React.createElement('input', {
          value: name,
          placeholder: '例如：午夜迷航',
          disabled: busy,
          onChange: (event) => setName(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') void doLoad()
          },
        }),
      ),
    ),
    React.createElement(
      'div',
      { className: 'sc-row sc-row-wrap' },
      React.createElement(
        'label',
        { className: 'sc-row sc-small sc-muted', style: { gap: 6, cursor: 'pointer' } },
        React.createElement('input', {
          type: 'checkbox',
          checked: listOnly,
          disabled: busy,
          style: { width: 'auto', flex: 'none' },
          onChange: (event) => setListOnly(event.target.checked),
        }),
        '只登记清单（不读全文，适合超大目录）',
      ),
      React.createElement('span', { className: 'sc-spacer' }),
      React.createElement(
        Btn,
        {
          variant: 'primary',
          disabled: busy,
          onClick: () => {
            void doLoad()
          },
        },
        '载入',
      ),
    ),
  )

  const listSection = React.createElement(
    Section,
    { title: `世界书（${data.worlds.length}）` },
    data.worlds.length === 0
      ? React.createElement(Empty, { text: '还没有载入世界书。填好上面的目录后点「载入」。' })
      : React.createElement('div', { className: 'sc-list' }, ...data.worlds.map(renderWorld)),
  )

  const previewSection = React.createElement(
    Section,
    { title: current === undefined ? '规则书正文' : `规则书正文 · ${current.title}` },
    current === undefined
      ? React.createElement(Empty, {
          text: '当前会话还没有选定规则书。展开上面某本世界书，点其中一套规则书右侧的「选用」。',
        })
      : React.createElement(
          React.Fragment,
          null,
          current.markdownMissing === true
            ? React.createElement(Banner, {
                tone: 'warn',
                text: `规则书文件已不在工作区里：${current.mdPath}。可以让 Agent 重新写入这套规则（scorpio_rulebook_write）以恢复正文。`,
              })
            : null,
          React.createElement(MetaRow, {
            items: [
              { k: '风格', v: styleLabel(current.style) },
              { k: '系统', v: current.schema?.system ?? '—' },
              {
                k: '骰式',
                v: `${current.schema?.baseDice ?? '—'} · ${current.schema?.direction === 'rollUnder' ? '低位' : '高位'}`,
              },
              { k: '写入', v: relTime(current.writtenAt) },
            ],
          }),
          React.createElement('div', { className: 'sc-tiny sc-muted sc-mono sc-wrap' }, current.mdPath),
          current.pitch === undefined || current.pitch === ''
            ? null
            : React.createElement('div', { className: 'sc-note sc-wrap' }, current.pitch),
          (current.markdown ?? '') === ''
            ? React.createElement('div', { className: 'sc-tiny sc-muted' }, '（正文为空，可让 Agent 重新写入）')
            : React.createElement(Markdown, { text: current.markdown ?? '', className: 'sc-preview' }),
        ),
  )

  return React.createElement(
    'div',
    { className: 'sc-body sc-scroll' },
    React.createElement(
      'div',
      { className: 'sc-hint sc-sec-body-hint' },
      '规则书由 Agent 依据本世界生成，同一本世界书可以有多套不同风格的规则（d100 / d20 / d6 骰池 / 自定义）。',
    ),
    loadSection,
    listSection,
    previewSection,
  )
}
