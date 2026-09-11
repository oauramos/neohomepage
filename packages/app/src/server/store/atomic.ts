import { open, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import writeFileAtomic from 'write-file-atomic'

/**
 * Durable file writes. `write-file-atomic` fsyncs the temp file and renames but never fsyncs the
 * containing directory, so that is done here; atomic rename is only guaranteed on a local
 * filesystem, not over NFS or SMB.
 */

/** Best effort: directory fsync fails on some filesystems and on Windows, and must not fail a write that already landed. */
async function fsyncDirectory(path: string): Promise<void> {
  let handle
  try {
    handle = await open(path, 'r')
    await handle.sync()
  } catch {
    // Best effort.
  } finally {
    await handle?.close().catch(() => {})
  }
}

export type WriteOptions = {
  readonly mode?: number
}

export async function writeFileDurable(
  path: string,
  contents: string,
  options: WriteOptions = {},
): Promise<void> {
  await writeFilesDurable(new Map([[path, contents]]), options)
}

/** Not a multi-file transaction: each file is atomically old or new, and each directory is flushed once at the end. */
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
