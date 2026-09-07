import { open, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import writeFileAtomic from 'write-file-atomic'

/**
 * Durable file writes.
 *
 * `write-file-atomic` writes a temp file, fsyncs *that file descriptor*, and renames. Verified in
 * write-file-atomic@8.0.0 lib/index.js: it fsyncs the temp fd (~line 121) and renames (~line 144),
 * and never opens the containing directory. On a NAS, a power cut between the rename and the
 * directory's own writeback loses the last save even though every individual write looked durable.
 * So we fsync the directory ourselves.
 *
 * Atomic rename is POSIX-guaranteed only within one directory on a local filesystem — not over
 * NFS or SMB, which is exactly where people will point a git-synced config folder. That is a
 * documented limitation, not something this module can fix.
 */

/** Directory fsync fails on some filesystems (and on Windows). A best-effort flush is still
 *  strictly better than none, and a failure here must not fail the write that already landed. */
async function fsyncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch {
    // Intentionally swallowed: see above.
  } finally {
    await handle?.close().catch(() => {})
  }
}

export type WriteOptions = {
  /** File mode. Secrets are written 0o600; config is left at the process umask. */
  readonly mode?: number
}

export async function writeFileDurable(
  path: string,
  contents: string,
  options: WriteOptions = {},
): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true })
  await writeFileAtomic(path, contents, {
    ...(options.mode === undefined ? {} : { mode: options.mode }),
  })
  await fsyncDirectory(directory)
}

/**
 * Write several files as one unit.
 *
 * This is not a transaction — POSIX has no multi-file atomic rename — and pretending otherwise
 * would be worse than being explicit. What it does guarantee: each individual file is either its
 * old contents or its new contents, never a truncated mix, and the directory is flushed once at
 * the end rather than once per file.
 */
export async function writeFilesDurable(
  files: ReadonlyMap<string, string>,
  options: WriteOptions = {},
): Promise<void> {
  const directories = new Set<string>()
  for (const [path, contents] of files) {
    const directory = dirname(path)
    if (!directories.has(directory)) {
      await mkdir(directory, { recursive: true })
      directories.add(directory)
    }
    await writeFileAtomic(path, contents, {
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    })
  }
  for (const directory of directories) await fsyncDirectory(directory)
}
