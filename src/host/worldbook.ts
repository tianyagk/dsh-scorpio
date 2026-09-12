/**
 * 工作区解析与世界书扫描。
 *
 * 边界很硬：插件只读写 **会话 cwd 之下的路径**（世界书目录、规则书 md、
 * `.scorpio/` 状态目录）。任何越界（`..`、绝对路径指向外部、符号链接逃逸）
 * 一律拒绝，理由是这些文件会直接进模型上下文与工具写手。
 */
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  MAX_BOOK_CHARS,
  MAX_DEPTH,
  MAX_FILES,
  MAX_FILE_CHARS,
  STATE_DIR,
  isSkippedDir,
  isTextFile,
  type WorldbookFile,
} from '../shared/model.ts'
import { log, type PluginContext } from './context.ts'

/** 一次扫描的结果。 */
export interface ScanResult {
  /** 世界书相对工作区的路径（POSIX）。 */
  rel: string
  /** 绝对路径。 */
  abs: string
  files: WorldbookFile[]
  totalChars: number
  /** 目录名（作为书名候选）。 */
  dirName: string
}

export class PathFenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PathFenceError'
  }
}

const toPosix = (p: string): string => p.split(sep).join('/')

/** 会话的 cwd：优先 sessionQuery 的持久头，其次内存态 sessions。 */
export async function resolveSessionCwd(ctx: PluginContext, sessionId: string): Promise<string | undefined> {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  const query = ctx.get('sessionQuery')
  if (query !== undefined) {
    try {
      const snapshot = await query.readSession(sessionId)
      const cwd = snapshot?.session?.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch (error) {
      log('sessionQuery.readSession failed:', sessionId, String(error))
    }
  }
  const sessions = ctx.get('sessions')
  if (sessions !== undefined) {
    try {
      const live = sessions.get(sessionId)
      const cwd = live?.header?.cwd
      if (typeof cwd === 'string' && cwd !== '') return cwd
    } catch (error) {
      log('sessions.get failed:', sessionId, String(error))
    }
  }
  return undefined
}

/** 会话跑在哪个 preset 上（最新 agent-preset/selected 事件优先，其次创建头）。 */
export async function resolveSessionPreset(
  ctx: PluginContext,
  sessionId: string,
): Promise<{ preset?: string; cwd?: string }> {
  if (typeof sessionId !== 'string' || sessionId === '') return {}
  const query = ctx.get('sessionQuery')
  if (query !== undefined) {
    try {
      const snapshot = await query.readSession(sessionId)
      const header = snapshot?.session
      const events = Array.isArray(snapshot?.events) ? snapshot.events : []
      let preset: string | undefined
      for (let i = events.length - 1; i >= 0; i -= 1) {
        const event = events[i]
        if (event?.type === 'agent-preset/selected') {
          const picked = event.data?.agentPreset
          if (typeof picked === 'string' && picked !== '') preset = picked
          break
        }
      }
      if (preset === undefined && typeof header?.agentPreset === 'string') preset = header.agentPreset
      return { preset, cwd: typeof header?.cwd === 'string' ? header.cwd : undefined }
    } catch (error) {
      log('resolveSessionPreset failed:', sessionId, String(error))
    }
  }
  const cwd = await resolveSessionCwd(ctx, sessionId)
  const sessions = ctx.get('sessions')
  const header = sessions?.get(sessionId)?.header
  return { preset: typeof header?.agentPreset === 'string' ? header.agentPreset : undefined, cwd }
}

/** workspace 根（已 realpath）。 */
export async function resolveWorkspace(workspace: string): Promise<string> {
  if (typeof workspace !== 'string' || workspace.trim() === '') {
    throw new PathFenceError('缺少工作区路径（会话 cwd 未知）')
  }
  const abs = resolve(workspace)
  try {
    return await realpath(abs)
  } catch {
    throw new PathFenceError(`工作区不存在或不可读：${workspace}`)
  }
}

function inside(root: string, target: string): boolean {
  if (target === root) return true
  return target.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * 把一个「工作区内的相对路径」解析成绝对路径，并证明它真的在工作区内
 * （对已存在的部分取 realpath，避免符号链接逃逸）。
 */
export async function resolveInside(workspace: string, rel: string): Promise<string> {
  const root = await resolveWorkspace(workspace)
  if (typeof rel !== 'string' || rel.trim() === '') throw new PathFenceError('路径为空')
  const cleaned = rel.trim().replace(/^\.\/+/, '')
  if (isAbsolute(cleaned)) throw new PathFenceError('只接受工作区内的相对路径')
  const target = resolve(root, cleaned)
  if (!inside(root, target)) throw new PathFenceError(`路径越出工作区：${rel}`)
  // 对最近的已存在祖先取 realpath，防止符号链接指向外部。
  let probe = target
  for (let i = 0; i < 64; i += 1) {
    try {
      const real = await realpath(probe)
      if (!inside(root, real) && real !== target) {
        throw new PathFenceError(`路径经符号链接指向工作区外：${rel}`)
      }
      if (probe === target) return real
      const tail = target.slice(probe.length).replace(/^[/\\]+/, '')
      return join(real, tail)
    } catch (error) {
      if (error instanceof PathFenceError) throw error
      const parent = resolve(probe, '..')
      if (parent === probe || !inside(root, parent)) {
        if (!inside(root, target)) throw new PathFenceError(`路径越出工作区：${rel}`)
        return target
      }
      probe = parent
    }
  }
  throw new PathFenceError(`路径过深：${rel}`)
}

/** 状态目录绝对路径（不创建）。 */
export async function stateDirOf(workspace: string): Promise<string> {
  const root = await resolveWorkspace(workspace)
  return join(root, STATE_DIR)
}

async function walk(
  root: string,
  dir: string,
  depth: number,
  out: WorldbookFile[],
  budget: { files: number; chars: number },
): Promise<void> {
  if (depth > MAX_DEPTH || budget.files >= MAX_FILES) return
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (error) {
    log('readdir failed:', dir, String(error))
    return
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (budget.files >= MAX_FILES) return
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (isSkippedDir(entry.name)) continue
      await walk(root, abs, depth + 1, out, budget)
      continue
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue
    if (!isTextFile(entry.name)) continue
    let size = 0
    try {
      const info = await stat(abs)
      if (!info.isFile()) continue
      size = info.size
    } catch {
      continue
    }
    if (size === 0) continue
    const rel = toPosix(relative(root, abs))
    let text = ''
    let truncated = false
    let error: string | undefined
    try {
      const raw = await readFile(abs, 'utf8')
      if (raw.includes('\u0000')) {
        error = '二进制或编码非 UTF-8，已跳过'
      } else if (raw.length > MAX_FILE_CHARS) {
        text = raw.slice(0, MAX_FILE_CHARS)
        truncated = true
      } else {
        text = raw
      }
    } catch (cause) {
      error = `读取失败：${cause instanceof Error ? cause.message : String(cause)}`
    }
    const chars = text.length
    budget.files += 1
    budget.chars += chars
    out.push({
      rel,
      chars,
      truncated,
      ...(text === '' ? {} : { text }),
      ...(error === undefined ? {} : { error }),
    })
  }
}

/**
 * 扫描世界书目录：递归收集文本文件的清单与（在预算内的）全文。
 * @param workspace - 会话 cwd（真实路径）。
 * @param rel - 工作区内的相对目录。
 * @param listOnly - 只建立清单，不携带全文。
 */
export async function scanWorldbook(
  workspace: string,
  rel: string,
  listOnly = false,
): Promise<ScanResult> {
  const abs = await resolveInside(workspace, rel)
  let info
  try {
    info = await stat(abs)
  } catch {
    throw new PathFenceError(`世界书路径不存在：${rel}`)
  }
  if (!info.isDirectory()) throw new PathFenceError(`世界书路径不是目录：${rel}`)

  const files: WorldbookFile[] = []
  const budget = { files: 0, chars: 0 }
  await walk(abs, abs, 0, files, budget)

  if (files.length === 0) {
    throw new PathFenceError(
      `目录里没有扫描到文本文件（支持 ${'.md .txt .json .yaml …'}）：${rel}`,
    )
  }

  let running = 0
  for (const file of files) {
    running += file.chars
    if (listOnly || running > MAX_BOOK_CHARS) {
      delete file.text
      if (running > MAX_BOOK_CHARS) file.truncated = true
    }
  }

  const root = await resolveWorkspace(workspace)
  const dirName = toPosix(relative(root, abs)) === '' ? 'workspace' : (abs.split(sep).pop() ?? 'world')
  return {
    rel: toPosix(relative(root, abs)),
    abs,
    files,
    totalChars: running,
    dirName,
  }
}

/** 读取世界书里的单个文本文件（侧边栏查看/编辑用）。 */
export async function readWorldbookFile(
  workspace: string,
  fileRel: string,
): Promise<{ rel: string; text: string; chars: number; truncated: boolean }> {
  const abs = await resolveInside(workspace, fileRel)
  const info = await stat(abs).catch(() => undefined)
  if (info === undefined || !info.isFile()) throw new PathFenceError(`文件不存在：${fileRel}`)
  if (!isTextFile(abs)) throw new PathFenceError(`不是可编辑的文本文件：${fileRel}`)
  const raw = await readFile(abs, 'utf8')
  if (raw.includes('\u0000')) throw new PathFenceError(`二进制文件不可编辑：${fileRel}`)
  const truncated = raw.length > MAX_FILE_CHARS
  return {
    rel: fileRel,
    text: truncated ? raw.slice(0, MAX_FILE_CHARS) : raw,
    chars: raw.length,
    truncated,
  }
}
