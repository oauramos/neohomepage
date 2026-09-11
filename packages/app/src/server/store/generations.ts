import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileDurable } from './atomic.ts'
import { isEnoent } from './fs.ts'

/**
 * Immutable, numbered snapshots of the config tree; the pointer only moves once a generation is
 * complete. `CURRENT` is a text file, not a symlink: NAS and SMB-backed volumes handle symlinks badly.
 */

export type GenerationMeta = {
  readonly generation: number
  readonly createdAt: string
  readonly label: string
  readonly actor: string
  readonly configRevision: string
  /**
   * Fingerprint of the built asset tags this generation embedded; an app upgrade renames bundles
   * without touching config, and the boot check compares against this.
   */
  readonly assetsHash: string
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
      if (isEnoent(error)) return []
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
      if (isEnoent(error)) return null
      throw error
    }
  }

  async meta(n: number): Promise<GenerationMeta | null> {
    try {
      return JSON.parse(await readFile(join(this.path(n), 'meta.json'), 'utf8')) as GenerationMeta
    } catch (error) {
      if (isEnoent(error)) return null
      throw error
    }
  }

  /** The pointer moves last, so an interrupted cut leaves an orphan directory (swept by `prune`), never a dangling pointer. */
  async cut(options: {
    readonly configDir: string
    readonly configRevision: string
    readonly actor: string
    readonly assetsHash?: string
    readonly label?: string
  }): Promise<GenerationMeta> {
    const existing = await this.list()
    const next = (existing.at(-1) ?? 0) + 1
    const directory = this.path(next)
    await mkdir(directory, { recursive: true })

    // overrides.local.json is per-machine and not part of a shared snapshot.
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
      assetsHash: options.assetsHash ?? '',
    }
    await writeFileDurable(join(directory, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`)
    await writeFileDurable(this.pointer, `${next}\n`)
    return meta
  }

  /** Moves the pointer only; newer generations stay on disk so a rollback is reversible. `restoreConfig` copies files back. */
  async rollback(n: number): Promise<void> {
    const available = await this.list()
    if (!available.includes(n)) {
      throw new Error(`generation ${n} does not exist (have: ${available.join(', ') || 'none'})`)
    }
    await writeFileDurable(this.pointer, `${n}\n`)
  }

  async restoreConfig(n: number, configDir: string): Promise<void> {
    const source = join(this.path(n), 'config')
    await cp(source, configDir, { recursive: true, force: true })
  }

  /** Removes all but the newest `keep` generations, never the one currently pointed at. */
  async prune(keep = 10): Promise<number[]> {
    const all = await this.list()
    const active = await this.current()
    const doomed = all.slice(0, Math.max(0, all.length - keep)).filter((n) => n !== active)
    for (const n of doomed) await rm(this.path(n), { recursive: true, force: true })
    return doomed
  }
}
