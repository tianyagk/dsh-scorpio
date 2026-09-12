/**
 * 侧边栏「模组集」子页。
 *
 * 模组 = 一次冒险的**开场引子**：从哪一幕开始、关键 NPC、悬念与走向。
 * 它按世界书分组存放，会话四元组的第三环（module）。正文由 Agent 生成
 * （scorpio_module action=generate），这里也能手写导入一个。
 */
import React, { useState } from 'react'
import { api, type SnapshotResponse } from './api.ts'
import type { Module } from '../shared/model.ts'
import { Banner, Btn, Empty, Field, Markdown, MetaRow, Section, relTime } from './ui.tsx'

export interface ModulePageProps {
  sessionId: string
  data: SnapshotResponse
  busy: boolean
  onSelect: (moduleId: string) => Promise<void>
  onRemove: (moduleId: string) => Promise<void>
  onSaved: () => Promise<void>
  onError: (message: string | undefined) => void
}

type Scale = 'one-shot' | 'chapter' | 'campaign'

const SCALES: Array<{ value: Scale; label: string }> = [
  { value: 'one-shot', label: '单场引子' },
  { value: 'chapter', label: '章节' },
  { value: 'campaign', label: '长线' },
]

/** 篇幅 → 中文（未知取值原样回显）。 */
function scaleLabel(scale: string | undefined): string {
  return SCALES.find((item) => item.value === scale)?.label ?? (scale === undefined || scale === '' ? '未标注' : scale)
}

/** 手写模组的骨架：让「从哪一幕开始」这件事有固定落点。 */
const SKELETON = [
  '## 背景提要',
  '',
  '## 初始局面',
  '',
  '## 关键 NPC',
  '',
  '- 【姓名】：（目的 / 秘密 / 对玩家的态度）',
  '',
  '## 悬念与走向',
  '',
  '- ',
  '',
  '## 开场提问',
  '',
  '（你此刻在哪、手上有什么、谁在等你）',
  '',
].join('\n')

function errText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function ModulePage(props: ModulePageProps): React.ReactElement {
  const { sessionId, data, busy } = props

  const [pendingRemove, setPendingRemove] = useState<string | undefined>(undefined)
  const [editing, setEditing] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftTagline, setDraftTagline] = useState('')
  const [draftScale, setDraftScale] = useState<Scale>('one-shot')
  const [draftText, setDraftText] = useState('')
  const [saving, setSaving] = useState(false)

  const worldId = data.binding.worldId
  const world = data.worlds.find((item) => item.id === worldId)
  const modules = data.modules ?? []
  const current = data.module
  const currentId = data.binding.moduleId
  const disabled = busy || saving
  const spinner = disabled ? React.createElement('span', { className: 'sc-spin' }) : undefined

  const resetDraft = (): void => {
    setDraftName('')
    setDraftTagline('')
    setDraftScale('one-shot')
    setDraftText('')
  }

  const doSelect = async (moduleId: string): Promise<void> => {
    try {
      await props.onSelect(moduleId)
      props.onError(undefined)
      await props.onSaved()
    } catch (cause) {
      props.onError(errText(cause))
    }
  }

  const doRemove = async (moduleId: string): Promise<void> => {
    try {
      await props.onRemove(moduleId)
      setPendingRemove(undefined)
      props.onError(undefined)
      await props.onSaved()
    } catch (cause) {
      props.onError(errText(cause))
    }
  }

  const doSave = async (): Promise<void> => {
    const name = draftName.trim()
    if (name === '') {
      props.onError('先给这个模组起个名字')
      return
    }
    if (worldId === undefined) {
      props.onError('还没有绑定世界书。先在「世界书」页载入并绑定一本，模组才有落脚处。')
      return
    }
    setSaving(true)
    try {
      await api.saveModule(sessionId, {
        worldId,
        name,
        tagline: draftTagline.trim(),
        markdown: draftText,
        scale: draftScale,
        select: true,
      })
      resetDraft()
      setEditing(false)
      props.onError(undefined)
      await props.onSaved()
    } catch (cause) {
      props.onError(errText(cause))
    } finally {
      setSaving(false)
    }
  }

  const renderModule = (item: Module): React.ReactElement => {
    const isCurrent = item.id === currentId
    const confirming = pendingRemove === item.id
    return React.createElement(
      'div',
      { key: item.id, className: 'sc-item', 'data-active': isCurrent },
      React.createElement(
        'div',
        { className: 'sc-item-main' },
        React.createElement('span', { className: 'sc-item-name' }, `${isCurrent ? '★ ' : ''}${item.name}`),
        React.createElement(
          'span',
          { className: 'sc-item-meta' },
          `${item.id} · ${scaleLabel(item.scale)} · ${item.source === 'user' ? '手写' : 'Agent 生成'} · ${relTime(item.updatedAt)}`,
        ),
        item.tagline === ''
          ? null
          : React.createElement('span', { className: 'sc-tiny sc-dim sc-wrap' }, item.tagline),
      ),
      React.createElement(
        'div',
        { className: 'sc-row sc-row-wrap', style: { flexBasis: '100%' } },
        React.createElement(
          Btn,
          {
            size: 'sm',
            variant: isCurrent ? 'ghost' : 'primary',
            disabled: disabled || isCurrent,
            onClick: () => {
              void doSelect(item.id)
            },
          },
          isCurrent ? '当前' : '选用',
        ),
        confirming
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement('span', { className: 'sc-small sc-err sc-nowrap' }, '确认删除？'),
              React.createElement(
                Btn,
                {
                  size: 'sm',
                  tone: 'danger',
                  disabled,
                  onClick: () => {
                    void doRemove(item.id)
                  },
                },
                '确认',
              ),
              React.createElement(
                Btn,
                { size: 'sm', variant: 'ghost', disabled, onClick: () => setPendingRemove(undefined) },
                '取消',
              ),
            )
          : React.createElement(
              Btn,
              { size: 'sm', tone: 'danger', disabled, onClick: () => setPendingRemove(item.id) },
              '删除',
            ),
        React.createElement('span', { className: 'sc-spacer' }),
        React.createElement(
          'span',
          { className: 'sc-tiny sc-muted sc-nowrap' },
          item.rulebookId === undefined ? '跟随当前规则书' : `规则书 ${item.rulebookId}`,
        ),
      ),
    )
  }

  const listSection = React.createElement(
    Section,
    { title: `模组集（${modules.length}）`, right: spinner },
    React.createElement(
      'div',
      { className: 'sc-hint' },
      `当前世界：${world === undefined ? '未绑定（先去「世界书」页绑定一本）' : world.name}。模组按世界书分组存放，同一本世界书可以有多个开场引子。`,
    ),
    modules.length === 0
      ? React.createElement(Empty, {
          text:
            '还没有模组。模组是一次冒险的开场引子：从哪一幕开始、关键 NPC、悬念与走向。' +
            '让 Agent 说「生成一个模组」即可（它会调用 scorpio_module action=generate）。',
        })
      : React.createElement('div', { className: 'sc-list' }, ...modules.map(renderModule)),
  )

  const bodySection = React.createElement(
    Section,
    { title: current === undefined ? '模组正文' : `模组正文 · ${current.name}` },
    current === undefined
      ? React.createElement(Empty, {
          text: '还没选定模组。点上面某个模组的「选用」，或者展开最下面的编辑区自己写一个。',
        })
      : React.createElement(
          React.Fragment,
          null,
          current.markdownMissing === true
            ? React.createElement(Banner, {
                tone: 'warn',
                text: `模组文件已不在工作区里：${current.mdPath}。可以让 Agent 重新生成这个模组以恢复正文。`,
              })
            : null,
          React.createElement(MetaRow, {
            items: [
              { k: '篇幅', v: scaleLabel(current.scale) },
              { k: '更新', v: relTime(current.updatedAt) },
              { k: '来源', v: current.source === 'user' ? '手写' : 'Agent 生成' },
              { k: '规则书', v: current.rulebookId ?? '跟随当前' },
            ],
          }),
          React.createElement('div', { className: 'sc-tiny sc-muted sc-mono sc-wrap' }, current.mdPath),
          (current.markdown ?? '') === ''
            ? React.createElement('div', { className: 'sc-tiny sc-muted' }, '（正文为空或未读到）')
            : React.createElement(Markdown, { text: current.markdown ?? '', className: 'sc-preview' }),
        ),
  )

  const writeSection = React.createElement(
    Section,
    {
      title: '手写一个模组',
      right: React.createElement(
        Btn,
        {
          size: 'sm',
          variant: editing ? 'ghost' : 'default',
          disabled: disabled,
          onClick: () => setEditing((prev) => !prev),
        },
        editing ? '收起' : '展开编辑区',
      ),
    },
    editing
      ? React.createElement(
          React.Fragment,
          null,
          React.createElement(
            'div',
            { className: 'sc-row sc-row-wrap' },
            React.createElement(
              Field,
              { label: '名称' },
              React.createElement('input', {
                value: draftName,
                placeholder: '例如：雾港的第七夜',
                disabled,
                onChange: (event) => setDraftName(event.target.value),
              }),
            ),
            React.createElement(
              Field,
              { label: '一句话钩子' },
              React.createElement('input', {
                value: draftTagline,
                placeholder: '列表里显示的那一句',
                disabled,
                onChange: (event) => setDraftTagline(event.target.value),
              }),
            ),
          ),
          React.createElement(
            'div',
            { className: 'sc-row sc-row-wrap' },
            React.createElement(
              Field,
              { label: '篇幅' },
              React.createElement(
                'select',
                {
                  value: draftScale,
                  disabled,
                  onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setDraftScale(event.target.value as Scale),
                },
                ...SCALES.map((item) => React.createElement('option', { key: item.value, value: item.value }, item.label)),
              ),
            ),
            React.createElement('span', { className: 'sc-spacer' }),
            React.createElement(
              Btn,
              { size: 'sm', variant: 'ghost', disabled, onClick: () => setDraftText(SKELETON) },
              '套用骨架',
            ),
          ),
          React.createElement('textarea', {
            className: 'sc-editor sc-scroll',
            value: draftText,
            disabled,
            placeholder: '开场引子正文（markdown）：背景提要 / 初始局面 / 关键 NPC / 悬念与走向',
            onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDraftText(event.target.value),
          }),
          React.createElement(
            'div',
            { className: 'sc-row sc-row-wrap' },
            React.createElement(
              Btn,
              {
                variant: 'primary',
                disabled,
                onClick: () => {
                  void doSave()
                },
              },
              '保存并选用',
            ),
            React.createElement(
              Btn,
              {
                variant: 'ghost',
                disabled,
                onClick: () => {
                  resetDraft()
                  setEditing(false)
                },
              },
              '放弃',
            ),
            React.createElement('span', { className: 'sc-spacer' }),
            React.createElement('span', { className: 'sc-tiny sc-muted sc-nowrap' }, `${draftText.length} 字符`),
          ),
        )
      : React.createElement(
          'div',
          { className: 'sc-hint' },
          'Agent 生成的模组通常更贴世界书；如果你已经想好了开场，也可以在这里手写一份，保存后会自动选为当前模组。',
        ),
  )

  return React.createElement('div', { className: 'sc-body sc-scroll' }, listSection, bodySection, writeSection)
}
