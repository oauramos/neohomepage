import { execFile } from 'node:child_process'
import { access, mkdir } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Backup and restore for people who would rather not use git.
 *
 * Shells out to the system `tar` rather than adding an archive library: it is present everywhere
 * this app runs, it handles permissions and symlinks correctly, and a tarball someone can open
 * with tools they already have beats a bespoke format.
 *
 * Secrets are never included. They are excluded structurally, not by an option the caller might
 * forget — an archive is the thing most likely to be emailed, dropped in a shared folder, or
 * attached to a support ticket.
 */

export class TarUnavailableError extends Error {
  constructor(cause: unknown) {
    super('`tar` is not available on PATH; use git or copy config/ and assets/ by hand', { cause })
    this.name = 'TarUnavailableError'
  }
}

async function requireTar(): Promise<void> {
  try {
    await run('tar', ['--version'])
  } catch (error) {
    throw new TarUnavailableError(error)
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export type BackupResult = { readonly archive: string; readonly included: string[] }

/**
 * Archive config/ and assets/ — the two directories that reconstruct a dashboard.
 *
 * state/ is left out because it is derived; restoring an old rendered page would just serve stale
 * HTML until the next publish.
 */
export async function backup(options: {
  readonly dataDir: string
  readonly archive: string
}): Promise<BackupResult> {
  await requireTar()
  const dataDir = resolve(options.dataDir)
  const archive = resolve(options.archive)
  await mkdir(dirname(archive), { recursive: true })

  const included: string[] = []
  for (const name of ['config', 'assets']) {
    if (await exists(resolve(dataDir, name))) included.push(name)
  }
  if (included.length === 0) throw new Error(`nothing to back up in ${dataDir}`)

  await run('tar', [
    '-czf',
    archive,
    '-C',
    dataDir,
    // Excluded explicitly even though they live under config/: per-machine and local-only.
    '--exclude=config/overrides.local.json',
    '--exclude=config/.audit.jsonl',
    ...included,
  ])
  return { archive, included }
}

export type RestoreResult = { readonly dataDir: string; readonly entries: string[] }

/**
 * Unpack an archive into a data directory.
 *
 * Refuses an archive containing anything but `config/` and `assets/`. A tarball is an untrusted
 * input — it may have come from someone else — and `tar` will happily write `../../etc/anything`
 * or a symlink pointing outside the tree unless something checks first.
 */
export async function restore(options: {
  readonly archive: string
  readonly dataDir: string
}): Promise<RestoreResult> {
  await requireTar()
  const archive = resolve(options.archive)
  const dataDir = resolve(options.dataDir)

  const { stdout } = await run('tar', ['-tzf', archive])
  const entries = stdout.split('\n').filter((line) => line.trim() !== '')
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.split('/').includes('..')) {
      throw new Error(`refusing archive: entry escapes the data directory (${entry})`)
    }
    const top = entry.split('/')[0]
    if (top !== 'config' && top !== 'assets') {
      throw new Error(
        `refusing archive: it contains "${entry}", and a restore may only write config/ and assets/`,
      )
    }
  }

  await mkdir(dataDir, { recursive: true })
  await run('tar', ['-xzf', archive, '-C', dataDir])
  return { dataDir, entries }
}

export function defaultArchiveName(now: Date): string {
  return `neohomepage-backup-${now.toISOString().replace(/[:.]/g, '-')}.tar.gz`
}

export { basename }
