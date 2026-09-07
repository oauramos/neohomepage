import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileDurable } from './atomic.ts'

/**
 * Immutable, numbered snapshots of the config tree.
 *
 * One mechanism solves three separate problems: undo for an edit an AI made, rollback for a bad
 * upgrade, and never serving a broken page (the pointer only moves after the new generation is
 * complete). It is `nixos-rebuild switch` applied to about forty small JSON files.
 *
 * `CURRENT` is a plain text file holding the number, not a symlink: NAS and SMB-backed volumes
 * handle symlinks badly, and this is a NAS product.
 */

export type GenerationMeta = {
  readonly generation: number
  readonly createdAt: string
  readonly label: string
  readonly actor: string
  readonly configRevision: string
}

const GENERATION_DIGITS = 6

export function generationName(n: number): string {
  return String(n).padStart(GENERATION_DIGITS, '0')
}

export class Generations {
  readonly #stateDir: string

  constructor(stateDir: string) {
    this.#stateDir = stateDir
  }

  get root(): string {
    return join(this.#stateDir, 'generations')
  }

  get pointer(): string {
    return join(this.root, 'CURRENT')
  }

  path(n: number): string {
    return join(this.root, generationName(n))
  }

  async list(): Promise<number[]> {
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    return names
      .filter((name) => /^\d+$/.test(name))
      .map(Number)
      .sort((a, b) => a - b)
  }

  async current(): Promise<number | null> {
    try {
      const raw = (await readFile(this.pointer, 'utf8')).trim()
      const n = Number(raw)
      return Number.isInteger(n) && n > 0 ? n : null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async meta(n: number): Promise<GenerationMeta | null> {
    try {
      return JSON.parse(await readFile(join(this.path(n), 'meta.json'), 'utf8')) as GenerationMeta
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  /**
   * Copy the config tree into a new numbered generation and move the pointer.
   *
   * The pointer moves LAST and only after the directory is complete, so an interrupted cut leaves
   * an orphan directory rather than a dangling pointer — and the previous generation keeps
   * serving. `prune` sweeps orphans away later.
   */
  async cut(options: {
    readonly configDir: string
    readonly configRevision: string
    readonly actor: string
    readonly label?: string
  }): Promise<GenerationMeta> {
    const existing = await this.list()
    const next = (existing.at(-1) ?? 0) + 1
    const directory = this.path(next)
    await mkdir(directory, { recursive: true })

    // Everything except the per-machine override file, which is deliberately not part of a
    // shared snapshot: restoring someone else's laptop URLs onto the NAS would be a regression.
    await cp(options.configDir, join(directory, 'config'), {
      recursive: true,
      filter: (source) =>
        !source.endsWith('overrides.local.json') && !source.endsWith('.audit.jsonl'),
    })

    const meta: GenerationMeta = {
      generation: next,
      createdAt: new Date().toISOString(),
      label: options.label ?? '',
      actor: options.actor,
      configRevision: options.configRevision,
    }
    await writeFileDurable(join(directory, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
    await writeFileDurable(this.pointer, `${next}\n`)
    return meta
  }

  /**
   * Point at an older generation without destroying anything.
   *
   * Deliberately not "copy the old files back over config/": the newer generation stays on disk,
   * so a rollback is itself reversible. Restoring the config tree from a generation is a separate,
   * explicit action.
   */
  async rollback(n: number): Promise<void> {
    const available = await this.list()
    if (!available.includes(n)) {
      throw new Error(`generation ${n} does not exist (have: ${available.join(', ') || 'none'})`)
    }
    await writeFileDurable(this.pointer, `${n}\n`)
  }

  /** Restore a generation's config tree back into the live config directory. */
  async restoreConfig(n: number, configDir: string): Promise<void> {
    const source = join(this.path(n), 'config')
    await cp(source, configDir, { recursive: true, force: true })
  }

  /**
   * Keep the newest `keep` generations plus whichever one is currently pointed at.
   *
   * Pruning the current generation would be the one bug in this module that takes the site down,
   * so it is excluded explicitly rather than assumed to be recent.
   */
  async prune(keep = 10): Promise<number[]> {
    const all = await this.list()
    const active = await this.current()
    const doomed = all.slice(0, Math.max(0, all.length - keep)).filter((n) => n !== active)
    for (const n of doomed) await rm(this.path(n), { recursive: true, force: true })
    return doomed
  }
}
