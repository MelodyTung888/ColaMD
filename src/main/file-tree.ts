import { constants as fsConstants } from 'fs'
import { copyFile, lstat, mkdir, readdir, realpath, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'path'

export const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd'] as const

export interface TreeEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
}

export interface DirectorySnapshot {
  rootPath: string
  directoryPath: string
  entries: TreeEntry[]
}

export class TreePathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TreePathError'
  }
}

function isPathInside(rootPath: string, targetPath: string): boolean {
  const child = relative(rootPath, targetPath)
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))
}

export function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_EXTENSIONS.includes(extname(filePath).toLowerCase() as typeof MARKDOWN_EXTENSIONS[number])
}

export async function canonicalizeTreeRoot(inputPath: string): Promise<string> {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new TreePathError('请选择有效的文件夹。')
  }

  const canonicalPath = await realpath(resolve(inputPath))
  const info = await stat(canonicalPath)
  if (!info.isDirectory()) throw new TreePathError('侧边栏根路径必须是文件夹。')
  return canonicalPath
}

async function rejectSymlinkComponents(rootPath: string, targetPath: string): Promise<void> {
  const child = relative(rootPath, targetPath)
  if (child === '') return

  let currentPath = rootPath
  for (const component of child.split(sep)) {
    currentPath = join(currentPath, component)
    try {
      const info = await lstat(currentPath)
      if (info.isSymbolicLink()) {
        throw new TreePathError('为保护目录边界，侧边栏不操作符号链接。')
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

export async function assertSafeTreePath(
  rootPath: string,
  inputPath: string,
  expectedKind?: 'file' | 'directory'
): Promise<string> {
  if (typeof inputPath !== 'string' || inputPath.trim() === '') {
    throw new TreePathError('无效的文件路径。')
  }

  const targetPath = resolve(inputPath)
  if (!isPathInside(rootPath, targetPath)) {
    throw new TreePathError('不能操作侧边栏根目录之外的内容。')
  }

  await rejectSymlinkComponents(rootPath, targetPath)
  const canonicalPath = await realpath(targetPath)
  if (!isPathInside(rootPath, canonicalPath)) {
    throw new TreePathError('路径解析后超出了侧边栏根目录。')
  }
  if (canonicalPath !== targetPath) {
    throw new TreePathError('为保护目录边界，侧边栏不操作符号链接。')
  }

  const info = await stat(canonicalPath)
  if (expectedKind === 'file' && !info.isFile()) throw new TreePathError('所选路径不是文件。')
  if (expectedKind === 'directory' && !info.isDirectory()) throw new TreePathError('所选路径不是文件夹。')
  return canonicalPath
}

export async function assertSafeTreeParent(rootPath: string, parentPath: string): Promise<string> {
  return assertSafeTreePath(rootPath, parentPath, 'directory')
}

function compareEntries(a: TreeEntry, b: TreeEntry): number {
  if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
  return a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' })
}

export async function listTreeDirectory(rootPath: string, directoryPath: string): Promise<DirectorySnapshot> {
  const safeDirectory = await assertSafeTreePath(rootPath, directoryPath, 'directory')
  const dirents = await readdir(safeDirectory, { withFileTypes: true })
  const entries: TreeEntry[] = []

  for (const dirent of dirents) {
    if (dirent.name.startsWith('.') || dirent.isSymbolicLink()) continue
    if (dirent.isDirectory()) {
      entries.push({
        name: dirent.name,
        path: join(safeDirectory, dirent.name),
        kind: 'directory'
      })
    } else if (dirent.isFile() && isMarkdownPath(dirent.name)) {
      entries.push({
        name: dirent.name,
        path: join(safeDirectory, dirent.name),
        kind: 'file'
      })
    }
  }

  entries.sort(compareEntries)
  return { rootPath, directoryPath: safeDirectory, entries }
}

function validateLeafName(inputName: string): string {
  if (typeof inputName !== 'string') throw new TreePathError('请输入名称。')
  const name = inputName.trim()
  if (!name || name === '.' || name === '..') throw new TreePathError('请输入有效的名称。')
  if (name.startsWith('.')) throw new TreePathError('名称不能以点号开头。')
  if (name !== basename(name) || /[/\\:*?"<>|\x00-\x1f]/.test(name)) {
    throw new TreePathError('名称中包含不支持的字符。')
  }
  return name
}

function markdownLeafName(inputName: string): string {
  const name = validateLeafName(inputName)
  const extension = extname(name).toLowerCase()
  if (!extension) return `${name}.md`
  if (!isMarkdownPath(name)) throw new TreePathError('Markdown 文档必须使用 .md、.markdown、.mdown 或 .mkd 扩展名。')
  return name
}

export async function createTreeEntry(
  rootPath: string,
  parentPath: string,
  kind: 'file' | 'directory',
  inputName: string
): Promise<{ path: string; snapshot: DirectorySnapshot }> {
  const safeParent = await assertSafeTreeParent(rootPath, parentPath)
  const name = kind === 'file' ? markdownLeafName(inputName) : validateLeafName(inputName)
  const targetPath = join(safeParent, name)

  if (!isPathInside(rootPath, targetPath)) throw new TreePathError('不能在侧边栏根目录之外创建内容。')
  if (kind === 'file') {
    await writeFile(targetPath, '', { encoding: 'utf-8', flag: 'wx' })
  } else {
    await mkdir(targetPath)
  }

  return { path: targetPath, snapshot: await listTreeDirectory(rootPath, safeParent) }
}

export async function duplicateTreeFile(
  rootPath: string,
  inputPath: string
): Promise<{ path: string; snapshot: DirectorySnapshot }> {
  const sourcePath = await assertSafeTreePath(rootPath, inputPath, 'file')
  if (!isMarkdownPath(sourcePath)) throw new TreePathError('只能创建 Markdown 文档的副本。')

  const parentPath = dirname(sourcePath)
  const extension = extname(sourcePath)
  const stem = basename(sourcePath, extension)

  for (let copyNumber = 1; copyNumber <= 10_000; copyNumber += 1) {
    const suffix = copyNumber === 1 ? ' 副本' : ` 副本 ${copyNumber}`
    const destinationPath = join(parentPath, `${stem}${suffix}${extension}`)
    try {
      await copyFile(sourcePath, destinationPath, fsConstants.COPYFILE_EXCL)
      return { path: destinationPath, snapshot: await listTreeDirectory(rootPath, parentPath) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
      throw error
    }
  }

  throw new TreePathError('同名副本过多，无法继续创建。')
}

export function describeTreeError(error: unknown): string {
  if (error instanceof TreePathError) return error.message
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  if (code === 'EEXIST') return '已有同名文件或文件夹。'
  if (code === 'ENOENT') return '文件或文件夹已不存在。'
  if (code === 'EACCES' || code === 'EPERM') return '没有权限完成此操作。'
  if (code === 'EROFS') return '该位置为只读，无法写入。'
  return error instanceof Error ? error.message : '文件操作失败。'
}
