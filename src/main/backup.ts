/**
 * Copies the host's data folder (messages, notes, media) into another folder, typically one
 * that a cloud drive keeps in sync. Only new or changed files are copied, and nothing is ever
 * removed from the copy: a backup must not lose what the original lost.
 */
import { copyFile, mkdir, readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

export const BACKUP_FOLDER = 'Duo backup'

const within = (child: string, parent: string): boolean => {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

async function copyTree(from: string, to: string): Promise<number> {
  await mkdir(to, { recursive: true })
  let copied = 0
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      copied += await copyTree(source, target)
    } else if (entry.isFile() && !/\.(part|tmp)$/.test(entry.name)) {
      const [a, b] = await Promise.all([stat(source), stat(target).catch(() => null)])
      if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) continue
      await copyFile(source, target)
      copied++
    }
  }
  return copied
}

/** Returns how many files were copied. */
export async function runBackup(dataDir: string, backupDir: string): Promise<number> {
  const target = join(backupDir, BACKUP_FOLDER)
  if (within(target, dataDir) || within(dataDir, target)) throw new Error('backup-inside-data')
  return copyTree(dataDir, target)
}

/** Copies existing data into a newly chosen data folder, unless that folder already holds some. */
export async function moveData(from: string, to: string): Promise<void> {
  if (within(to, from) || within(from, to)) return
  const existing = await readdir(to).catch(() => [] as string[])
  if (existing.includes('messages.jsonl') || existing.includes('notes.json')) return
  await copyTree(from, to).catch(() => 0)
}
