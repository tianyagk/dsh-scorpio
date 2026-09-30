/**
 * 侧边栏「角色卡」子页。
 *
 * 会话四元组的最后一环（character）：会话里正在扮演的那一张 + 当前世界的角色池。
 * 属性/技能按规则书 schema 取标签，pending 的项在界面上标成「待确认」——
 * 未与玩家确认过的数值不许伪装成已确认。
 *
 * 编辑走本地 draft + 脏标记：Agent 写入（或轮询到新快照）时以服务端为准覆盖草稿，
 * 玩家改动未保存前不会被静默丢弃（顶部会显示「未保存」）。
 */
import React, { useEffect, useRef, useState } from 'react'
import { api, type SnapshotResponse } from './api.ts'
import type { AttrValue, CharacterInstance, SlotEntry, SlotKind } from '../shared/model.ts'
import { Banner, Btn, Empty, Field, Section, num, relTime } from './ui.tsx'

export interface CharacterPageProps {
  sessionId: string
  data: SnapshotResponse
  busy: boolean
  onImport: (templateId: string) => Promise<void>
  onRemoveTemplate: (templateId: string) => Promise<void>
  onSaved: () => Promise<void>
  onError: (message: string | undefined) => void
}

const KINDS: Array<{ kind: SlotKind; label: string }> = [
  { kind: 'item', label: '物品' },
  { kind: 'ally', label: '队友' },
  { kind: 'pet', label: '宠物' },
  { kind: 'retainer', label: '随从' },
]

const STATUS_KINDS: Array<{ value: 'buff' | 'debuff' | 'neutral'; label: string }> = [
  { value: 'buff', label: '增益' },
  { value: 'debuff', label: '减益' },
  { value: 'neutral', label: '中性' },
]

function errText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** 输入框里的字符串：能当数字就用数字（属性/技能是数值型），否则原样保留。 */
function parseValue(raw: string): number | string {
  const text = raw.trim()
  if (text === '') return ''
  return Number.isFinite(Number(text)) ? Number(text) : raw
}

/** 数值输入框（数量 / 剩余回合）。空串 = 未标注。 */
function parseQty(raw: string): number | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  const value = Number(text)
  return Number.isFinite(value) ? value : undefined
}

export function CharacterPage(props: CharacterPageProps): React.ReactElement {
  const { sessionId, data, busy } = props

  const server = data.character
  const serverKey = server === undefined ? 'none' : `${server.sessionId}:${server.updatedAt}`
  const [draft, setDraft] = useState<CharacterInstance | undefined>(server)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState<string | undefined>(undefined)
  const [pendingRemove, setPendingRemove] = useState<string | undefined>(undefined)
  const [conflict, setConflict] = useState<CharacterInstance | undefined>(undefined)
  const seenKey = useRef<string | undefined>(undefined)

  // 服务端换了版本（Agent 写入 / 保存成功 / 导入模板）才处理，纯轮询不打断编辑。
  useEffect(() => {
    if (seenKey.current === serverKey) return
    seenKey.current = serverKey
    if (dirty && server !== undefined) {
      // 玩家正在编辑时 Agent 写了新版本：不覆盖草稿，把选择权交回玩家。
      // （旧实现直接 setDraft(server) + setDirty(false)，未保存的编辑会无声蒸发。）
      setConflict(server)
      return
    }
    setDraft(server)
    setDirty(false)
  }, [serverKey, server, dirty])

  const disabled = busy || saving !== undefined
  const pool = data.pool ?? []
  const schema = data.rulebook?.schema
  const attrDefs = schema?.attributes ?? []
  const skillDefs = schema?.skills ?? []

  const attrs = draft?.attrs ?? []
  const skills = draft?.skills ?? []
  const slots = draft?.slots ?? []
  const statuses = draft?.statuses ?? []
  const journal = draft?.journal ?? []

  const attrLabel = (id: string): string => attrDefs.find((def) => def.id === id)?.label ?? id
  const skillLabel = (id: string): string => skillDefs.find((def) => def.id === id)?.label ?? id

  // ── 草稿编辑 ──────────────────────────────────────────────────────────────

  const patch = (next: Partial<CharacterInstance>): void => {
    setDraft((prev) => (prev === undefined ? prev : { ...prev, ...next }))
    setDirty(true)
  }

  const setAttrValue = (index: number, raw: string): void => {
    patch({ attrs: attrs.map((item, i) => (i === index ? { ...item, value: parseValue(raw) } : item)) })
  }

  const confirmAttr = (index: number): void => {
    patch({ attrs: attrs.map((item, i) => (i === index ? { ...item, pending: false } : item)) })
  }

  const setSkillValue = (index: number, raw: string): void => {
    patch({ skills: skills.map((item, i) => (i === index ? { ...item, value: parseValue(raw) } : item)) })
  }

  const confirmSkill = (index: number): void => {
    patch({ skills: skills.map((item, i) => (i === index ? { ...item, pending: false } : item)) })
  }

  const addSlot = (kind: SlotKind): void => {
    const slot: SlotEntry = { id: `${kind}-${Date.now().toString(36)}-${slots.length}`, name: '', kind, owner: 'user' }
    patch({ slots: [...slots, slot] })
  }

  const setSlot = (id: string, next: Partial<SlotEntry>): void => {
    patch({ slots: slots.map((item) => (item.id === id ? { ...item, ...next } : item)) })
  }

  const removeSlot = (id: string): void => {
    patch({ slots: slots.filter((item) => item.id !== id) })
  }

  const addStatus = (): void => {
    patch({
      statuses: [
        ...statuses,
        { id: `status-${Date.now().toString(36)}-${statuses.length}`, label: '', kind: 'neutral' },
      ],
    })
  }

  const setStatus = (id: string, next: Partial<{ label: string; remaining: number | undefined; kind: 'buff' | 'debuff' | 'neutral' }>): void => {
    patch({ statuses: statuses.map((item) => (item.id === id ? { ...item, ...next } : item)) })
  }

  const removeStatus = (id: string): void => {
    patch({ statuses: statuses.filter((item) => item.id !== id) })
  }

  const removeJournal = (id: string): void => {
    patch({ journal: journal.filter((entry) => entry.id !== id) })
  }

  const missingAttrs = attrDefs.filter((def) => !attrs.some((item) => item.id === def.id))
  const missingSkills = skillDefs.filter((def) => !skills.some((item) => item.id === def.id))

  const fillFromSchema = (): void => {
    patch({
      attrs: [
        ...attrs,
        ...missingAttrs.map((def) => ({ id: def.id, value: def.base ?? def.min ?? 0, pending: def.base === undefined })),
      ],
      skills: [...skills, ...missingSkills.map((def) => ({ id: def.id, value: 0, pending: true }))],
    })
  }

  // ── 写操作 ────────────────────────────────────────────────────────────────

  const save = async (mode: 'session' | 'pool'): Promise<void> => {
    if (draft === undefined) return
    // 明文 JSON 可以被手工编辑，字段缺失时直接提交等于把残缺结构写回磁盘。
    const required = ['attrs', 'skills', 'slots', 'statuses', 'journal'] as const
    const missing = required.filter((key) => !Array.isArray((draft as unknown as Record<string, unknown>)[key]))
    if (missing.length > 0) {
      props.onError(
        `角色卡缺少字段：${missing.join('、')}——为避免写坏数据，请先用「从规则书补齐」或重新导入这张卡。`,
      )
      return
    }
    setSaving(mode)
    try {
      if (mode === 'pool') await api.saveToPool(sessionId, { ...draft, sessionId })
      else await api.saveCharacter(sessionId, { ...draft, sessionId })
      setDirty(false)
      props.onError(undefined)
      await props.onSaved()
    } catch (cause) {
      props.onError(errText(cause))
    } finally {
      setSaving(undefined)
    }
  }

  const doImport = async (templateId: string): Promise<void> => {
    try {
      await props.onImport(templateId)
      props.onError(undefined)
      await props.onSaved()
    } catch (cause) {
      props.onError(errText(cause))
    }
  }

  const doRemoveTemplate = async (templateId: string): Promise<void> => {
    try {
      await props.onRemoveTemplate(templateId)
      setPendingRemove(undefined)
      props.onError(undefined)
      await props.onSaved()
    } catch (cause) {
      props.onError(errText(cause))
    }
  }

  // ── 正在扮演 ──────────────────────────────────────────────────────────────

  const attrGrid = React.createElement(
    'div',
    { className: 'sc-attrs' },
    ...attrs.map((attr: AttrValue, index: number) =>
      React.createElement(
        'div',
        { key: attr.id + ':' + String(index), className: 'sc-attr', 'data-pending': attr.pending === true },
        React.createElement(
          'button',
          {
            className: 'sc-attr-label',
            title: attr.pending === true ? '点一下把这项标记为已确认' : attr.id,
            onClick: attr.pending === true ? () => confirmAttr(index) : undefined,
          },
          React.createElement('span', { className: 'sc-ellipsis' }, attrLabel(attr.id)),
          attr.pending === true ? React.createElement('span', { className: 'sc-tiny sc-nowrap' }, '待确认') : null,
        ),
        React.createElement('input', {
          className: 'sc-attr-input',
          value: String(attr.value ?? ''),
          disabled,
          onChange: (event) => setAttrValue(index, event.target.value),
        }),
        attr.note === undefined || attr.note === ''
          ? null
          : React.createElement('span', { className: 'sc-attr-note sc-wrap' }, attr.note),
        attr.max === undefined ? null : React.createElement('span', { className: 'sc-attr-note' }, `上限 ${num(attr.max)}`),
      ),
    ),
  )

  const skillGrid =
    skills.length === 0
      ? React.createElement('div', { className: 'sc-tiny sc-muted' }, '（暂无技能。等 Agent 依据规则书写入，或点上面的「从规则书补齐」。）')
      : React.createElement(
          'div',
          { className: 'sc-attrs' },
          ...skills.map((skill, index) =>
            React.createElement(
              'div',
              { key: skill.id + ':' + String(index), className: 'sc-attr', 'data-pending': skill.pending === true },
              React.createElement(
                'button',
                {
                  className: 'sc-attr-label',
                  title: skill.pending === true ? '点一下把这项标记为已确认' : skill.id,
                  onClick: skill.pending === true ? () => confirmSkill(index) : undefined,
                },
                React.createElement('span', { className: 'sc-ellipsis' }, skillLabel(skill.id)),
                skill.pending === true ? React.createElement('span', { className: 'sc-tiny sc-nowrap' }, '待确认') : null,
              ),
              React.createElement('input', {
                className: 'sc-attr-input',
                value: String(skill.value ?? ''),
                disabled,
                onChange: (event) => setSkillValue(index, event.target.value),
              }),
            ),
          ),
        )

  const slotsBlock = React.createElement(
    React.Fragment,
    null,
    ...KINDS.map((entry) => {
      const group = slots.filter((slot) => slot.kind === entry.kind)
      return React.createElement(
        'div',
        { key: entry.kind, style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
        React.createElement(
          'div',
          { className: 'sc-row' },
          React.createElement('span', { className: 'sc-group-title' }, `${entry.label}（${group.length}）`),
          React.createElement('span', { className: 'sc-spacer' }),
          React.createElement(
            Btn,
            { size: 'sm', variant: 'ghost', disabled, onClick: () => addSlot(entry.kind) },
            '+ 添加',
          ),
        ),
        group.length === 0
          ? React.createElement('div', { className: 'sc-tiny sc-muted' }, `（暂无${entry.label}）`)
          : React.createElement(
              'div',
              { className: 'sc-slots' },
              ...group.map((slot) =>
                React.createElement(
                  'div',
                  { key: slot.id, className: 'sc-slot', 'data-off': slot.active === false },
                  React.createElement(
                    'div',
                    { className: 'sc-slot-name' },
                    React.createElement('input', {
                      value: slot.name,
                      disabled,
                      placeholder: `${entry.label}名`,
                      onChange: (event) => setSlot(slot.id, { name: event.target.value }),
                    }),
                  ),
                  React.createElement(
                    'div',
                    { className: 'sc-slot-tags' },
                    entry.kind === 'item'
                      ? React.createElement('input', {
                          type: 'number',
                          title: '数量',
                          value: slot.qty === undefined ? '' : String(slot.qty),
                          disabled,
                          style: { width: 62, flex: 'none' },
                          onChange: (event) => setSlot(slot.id, { qty: parseQty(event.target.value) }),
                        })
                      : null,
                    React.createElement(
                      Btn,
                      {
                        size: 'sm',
                        variant: 'ghost',
                        tone: 'danger',
                        disabled,
                        onClick: () => removeSlot(slot.id),
                      },
                      '删除',
                    ),
                  ),
                  React.createElement(
                    'div',
                    { style: { flexBasis: '100%', minWidth: 0 } },
                    React.createElement('input', {
                      value: slot.desc ?? '',
                      disabled,
                      placeholder: '备注（外观 / 用途 / 态度…）',
                      onChange: (event) => setSlot(slot.id, { desc: event.target.value }),
                    }),
                  ),
                  React.createElement('span', { className: 'sc-tiny sc-muted sc-mono sc-nowrap' }, slot.id),
                ),
              ),
            ),
      )
    }),
  )

  const statusesBlock =
    statuses.length === 0
      ? React.createElement('div', { className: 'sc-tiny sc-muted' }, '（暂无状态）')
      : React.createElement(
          'div',
          { className: 'sc-list' },
          ...statuses.map((status) =>
            React.createElement(
              'div',
              { key: status.id, className: 'sc-item' },
              React.createElement(
                'div',
                { className: 'sc-item-main' },
                React.createElement('input', {
                  value: status.label,
                  disabled,
                  placeholder: '状态名（如：中毒 / 目盲）',
                  onChange: (event) => setStatus(status.id, { label: event.target.value }),
                }),
                React.createElement('span', { className: 'sc-item-meta' }, status.id),
              ),
              React.createElement('input', {
                type: 'number',
                title: '剩余回合',
                value: status.remaining === undefined ? '' : String(status.remaining),
                disabled,
                style: { width: 70, flex: 'none' },
                onChange: (event) => setStatus(status.id, { remaining: parseQty(event.target.value) }),
              }),
              React.createElement(
                'select',
                {
                  value: status.kind ?? 'neutral',
                  disabled,
                  style: { width: 84, flex: 'none' },
                  onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                    setStatus(status.id, { kind: event.target.value as 'buff' | 'debuff' | 'neutral' }),
                },
                ...STATUS_KINDS.map((item) => React.createElement('option', { key: item.value, value: item.value }, item.label)),
              ),
              React.createElement(
                Btn,
                { size: 'sm', variant: 'ghost', tone: 'danger', disabled, onClick: () => removeStatus(status.id) },
                '删除',
              ),
            ),
          ),
        )

  const journalBlock =
    journal.length === 0
      ? React.createElement('div', { className: 'sc-tiny sc-muted' }, '（暂无经历。Agent 会在场景收束时把关键后果写进来。）')
      : React.createElement(
          'div',
          { className: 'sc-list' },
          ...journal.map((entry) =>
            React.createElement(
              'div',
              { key: entry.id, className: 'sc-item' },
              React.createElement(
                'div',
                { className: 'sc-item-main' },
                React.createElement('span', { className: 'sc-item-name' }, entry.title),
                entry.text === undefined || entry.text === ''
                  ? null
                  : React.createElement('span', { className: 'sc-note sc-wrap' }, entry.text),
              ),
              React.createElement('span', { className: 'sc-tiny sc-muted sc-nowrap' }, relTime(entry.ts)),
              React.createElement(
                Btn,
                { size: 'sm', variant: 'ghost', tone: 'danger', disabled, onClick: () => removeJournal(entry.id) },
                '删除',
              ),
            ),
          ),
        )

  const conflictBanner =
    conflict === undefined
      ? null
      : React.createElement(Banner, {
          tone: 'warn',
          text: 'Agent 在会话里更新了角色卡，而你还有未保存的修改。',
          right: React.createElement(
            'span',
            { className: 'sc-row', style: { gap: 6 } },
            React.createElement(
              Btn,
              {
                size: 'sm',
                onClick: () => {
                  setDraft(conflict)
                  setDirty(false)
                  setConflict(undefined)
                },
              },
              '用服务端版本',
            ),
            React.createElement(Btn, { size: 'sm', variant: 'ghost', onClick: () => setConflict(undefined) }, '保留我的'),
          ),
        })

  const playSection = React.createElement(
    Section,
    {
      title: '正在扮演',
      right:
        draft === undefined
          ? undefined
          : React.createElement(
              'div',
              { className: 'sc-row sc-row-wrap' },
              dirty
                ? React.createElement('span', { className: 'sc-chip', 'data-tone': 'warn' }, '未保存')
                : React.createElement('span', { className: 'sc-chip', 'data-tone': 'ok' }, '已同步'),
              draft.initialized === true
                ? React.createElement('span', { className: 'sc-chip', 'data-tone': 'gold' }, '已初始化')
                : React.createElement('span', { className: 'sc-chip', 'data-tone': 'warn' }, '待初始化'),
              disabled ? React.createElement('span', { className: 'sc-spin' }) : null,
            ),
    },
    draft === undefined
      ? React.createElement(Empty, {
          text: '本会话还没有角色卡。从下面的角色池里挑一张，或者让 Agent 生成候选角色。',
        })
      : React.createElement(
          React.Fragment,
          null,
          React.createElement(
            'div',
            { className: 'sc-row sc-row-wrap' },
            React.createElement(
              Btn,
              {
                variant: 'primary',
                disabled: disabled || !dirty,
                title: dirty ? '写回会话角色卡' : '没有未保存的改动',
                onClick: () => {
                  void save('session')
                },
              },
              saving === 'session' ? '保存中…' : '保存',
            ),
            React.createElement(
              Btn,
              {
                disabled,
                title: '把当前这张另存为角色池里的模板',
                onClick: () => {
                  void save('pool')
                },
              },
              saving === 'pool' ? '另存中…' : '另存到角色池',
            ),
            React.createElement(
              Btn,
              {
                variant: 'ghost',
                disabled,
                title: '所有属性/技能都确认过之后，再把它置为已初始化',
                onClick: () => patch({ initialized: !draft.initialized }),
              },
              draft.initialized === true ? '标记为未初始化' : '标记为已初始化',
            ),
            React.createElement('span', { className: 'sc-spacer' }),
            React.createElement('span', { className: 'sc-tiny sc-muted sc-nowrap' }, `更新于 ${relTime(draft.updatedAt)}`),
          ),
          React.createElement(
            'div',
            { className: 'sc-row sc-row-wrap' },
            React.createElement(
              Field,
              { label: '姓名' },
              React.createElement('input', {
                value: draft.name,
                disabled,
                placeholder: '角色名',
                onChange: (event) => patch({ name: event.target.value }),
              }),
            ),
            React.createElement(
              Field,
              { label: '概念' },
              React.createElement('input', {
                value: draft.concept ?? '',
                disabled,
                placeholder: '一句话人设，如：落魄的走私船长',
                onChange: (event) => patch({ concept: event.target.value }),
              }),
            ),
          ),
          React.createElement(
            Field,
            { label: '扮演者', hint: '留空即由你本人扮演' },
            React.createElement('input', {
              value: draft.player ?? '',
              disabled,
              onChange: (event) => patch({ player: event.target.value }),
            }),
          ),
          React.createElement('div', { className: 'sc-divider' }),
          React.createElement(
            'div',
            { className: 'sc-row' },
            React.createElement('span', { className: 'sc-group-title' }, `属性（${attrs.length}）`),
            React.createElement('span', { className: 'sc-spacer' }),
            missingAttrs.length + missingSkills.length === 0
              ? null
              : React.createElement(
                  Btn,
                  {
                    size: 'sm',
                    variant: 'ghost',
                    disabled,
                    title: '缺的项会以「待确认」写进去，确认后才算数',
                    onClick: fillFromSchema,
                  },
                  `从规则书补齐 ${missingAttrs.length + missingSkills.length} 项`,
                ),
          ),
          attrs.length === 0
            ? React.createElement('div', { className: 'sc-tiny sc-muted' }, '（暂无属性。让 Agent 按规则书写入，或点右侧「从规则书补齐」。）')
            : attrGrid,
          React.createElement('div', { className: 'sc-row' },
            React.createElement('span', { className: 'sc-group-title' }, `技能（${skills.length}）`),
          ),
          skillGrid,
          React.createElement('div', { className: 'sc-divider' }),
          React.createElement(
            'div',
            { className: 'sc-row' },
            React.createElement('span', { className: 'sc-group-title' }, `随身（${slots.length}）`),
          ),
          slotsBlock,
          React.createElement('div', { className: 'sc-divider' }),
          React.createElement(
            'div',
            { className: 'sc-row' },
            React.createElement('span', { className: 'sc-group-title' }, `状态（${statuses.length}）`),
            React.createElement('span', { className: 'sc-spacer' }),
            React.createElement(Btn, { size: 'sm', variant: 'ghost', disabled, onClick: addStatus }, '+ 添加状态'),
          ),
          statusesBlock,
          React.createElement('div', { className: 'sc-divider' }),
          React.createElement(
            'div',
            { className: 'sc-row' },
            React.createElement('span', { className: 'sc-group-title' }, `经历（${journal.length}）`),
          ),
          journalBlock,
        ),
  )

  // ── 角色池 ────────────────────────────────────────────────────────────────

  const renderTemplate = (template: (typeof pool)[number]): React.ReactElement => {
    const isActive = server !== undefined && server.templateId === template.id
    const confirming = pendingRemove === template.id
    const summary =
      (template.attrs ?? []).length === 0
        ? '（无属性）'
        : (template.attrs ?? [])
            .slice(0, 6)
            .map((attr) => `${attr.id}=${String(attr.value ?? '')}`)
            .join('  ')
    return React.createElement(
      'div',
      { key: template.id, className: 'sc-item', 'data-active': isActive },
      React.createElement(
        'div',
        { className: 'sc-item-main' },
        React.createElement(
          'span',
          { className: 'sc-item-name' },
          `${isActive ? '★ ' : ''}${template.name === '' ? '（未命名）' : template.name}`,
        ),
        React.createElement(
          'span',
          { className: 'sc-item-meta' },
          `${template.id} · ${template.updatedAt === undefined ? '' : relTime(template.updatedAt)}`,
        ),
        template.concept === undefined || template.concept === ''
          ? null
          : React.createElement('span', { className: 'sc-note sc-wrap' }, template.concept),
        React.createElement('span', { className: 'sc-tiny sc-muted sc-mono sc-wrap' }, summary),
        React.createElement(
          'div',
          { className: 'sc-row sc-row-wrap', style: { marginTop: 2 } },
          template.generated === true ? React.createElement('span', { className: 'sc-chip', 'data-tone': 'gold' }, '模型生成') : null,
          template.rulebookId === undefined
            ? null
            : React.createElement('span', { className: 'sc-chip' }, `规则书 ${template.rulebookId}`),
          template.moduleId === undefined ? null : React.createElement('span', { className: 'sc-chip' }, `模组 ${template.moduleId}`),
          template.initialized === true ? null : React.createElement('span', { className: 'sc-chip', 'data-tone': 'warn' }, '待初始化'),
        ),
      ),
      React.createElement(
        'div',
        { className: 'sc-row sc-row-wrap', style: { flexBasis: '100%' } },
        React.createElement(
          Btn,
          {
            size: 'sm',
            variant: isActive ? 'ghost' : 'primary',
            disabled: disabled || isActive,
            onClick: () => {
              void doImport(template.id)
            },
          },
          isActive ? '扮演中' : '扮演这张',
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
                    void doRemoveTemplate(template.id)
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
              { size: 'sm', tone: 'danger', disabled, onClick: () => setPendingRemove(template.id) },
              '删除',
            ),
      ),
    )
  }

  const poolSection = React.createElement(
    Section,
    { title: `角色池（${pool.length}）` },
    pool.length === 0
      ? React.createElement(Empty, {
          text:
            '角色池是空的。让 Agent 说「生成候选角色」（scorpio_character action=generate），' +
            '它会依据世界书 + 规则书 + 模组生成几位候选，再由你用 ask_user_question 挑选/确认。',
        })
      : React.createElement('div', { className: 'sc-list' }, ...pool.map(renderTemplate)),
  )

  return React.createElement(
    'div',
    { className: 'sc-body sc-scroll' },
    conflictBanner,
    server === undefined && pool.length > 0
      ? React.createElement(Banner, { tone: 'info', text: '从角色池里选一张开始扮演。' })
      : null,
    playSection,
    poolSection,
  )
}
