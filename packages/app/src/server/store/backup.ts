import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { exists } from './fs.ts'

const run = promisify(execFile)

/**
 * Backup and restore of config/ and assets/ through the system `tar`. Secrets are excluded
 * structurally rather than by option, since an archive is the thing most likely to be shared.
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

export type BackupResult = { readonly archive: string; readonly included: string[] }

/** Archives config/ and assets/; state/ is derived and left out. */
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
    // Per-machine, local-only files.
    '--exclude=config/overrides.local.json',
    '--exclude=config/.audit.jsonl',
    ...included,
  ])
  return { archive, included }
}

export type RestoreResult = { readonly dataDir: string; readonly entries: string[] }

/**
 * Unpacks an archive into the data directory. The archive is untrusted input, so entries outside
 * `config/` and `assets/` or escaping the tree are refused before `tar` runs.
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
