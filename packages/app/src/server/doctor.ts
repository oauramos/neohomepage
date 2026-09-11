import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import type { Manifest } from '@neohomepage/catalog-schema'
import { isComposite } from '@neohomepage/catalog-schema'
import { CURRENT_SCHEMA_VERSION } from './config/schema.ts'
import type { Env } from './env.ts'
import { environmentVariableName } from './secrets/vault.ts'
import { targetShapeFields } from '../shared/target-shape.ts'
import type { ConfigTree } from './store/tree.ts'

/**
 * Read-only health checks behind `neo doctor`; every finding names a cause and a fix, none
 * repairs anything.
 */

export type Severity = 'error' | 'warning' | 'note'

export type Finding = {
  readonly severity: Severity
  /** Stable identifier; tests match on it. */
  readonly code: string
  readonly message: string
  /** Absent only when the message already says what to do. */
  readonly fix?: string
}

export type DoctorInput = {
  readonly env: Env
  readonly tree: ConfigTree
  readonly catalog: ReadonlyMap<string, Manifest>
  /** A predicate rather than a list: secrets held in environment variables cannot be enumerated. */
  readonly hasSecret: (name: string) => boolean
  /** Names in secrets.json; used only to spot orphans. */
  readonly storedNames: ReadonlySet<string>
  readonly diagnostics: readonly string[]
}

const ASSETS_WARN_BYTES = 50 * 1024 * 1024
const ASSET_FILE_WARN_BYTES = 2 * 1024 * 1024

export async function runDoctor(input: DoctorInput): Promise<Finding[]> {
  const findings: Finding[] = []

  findings.push(...checkSchemaVersion(input))
  findings.push(...checkCredentials(input))
  findings.push(...checkWidgets(input))
  findings.push(...(await checkGit(input.env)))
  findings.push(...(await checkAssets(input.env)))
  findings.push(...(await checkPermissions(input)))
  findings.push(...checkResolveDiagnostics(input))

  const order: Record<Severity, number> = { error: 0, warning: 1, note: 2 }
  return findings.sort(
    (a, b) => order[a.severity] - order[b.severity] || a.code.localeCompare(b.code, 'en-US'),
  )
}

function checkSchemaVersion({ tree }: DoctorInput): Finding[] {
  const version = tree.dashboard.schemaVersion
  if (version === CURRENT_SCHEMA_VERSION) return []
  return version > CURRENT_SCHEMA_VERSION
    ? [
        {
          severity: 'error',
          code: 'config-from-the-future',
          message: `config is schemaVersion ${version}; this build understands up to ${CURRENT_SCHEMA_VERSION}`,
          fix: 'upgrade neohomepage, or restore a backup taken with this version',
        },
      ]
    : [
        {
          severity: 'note',
          code: 'config-needs-migration',
          message: `config is schemaVersion ${version} and will be migrated to ${CURRENT_SCHEMA_VERSION} on next start`,
          fix: 'the tree is copied to state/backups/ first; nothing is lost if it fails',
        },
      ]
}

function checkCredentials({ tree, hasSecret, storedNames }: DoctorInput): Finding[] {
  const findings: Finding[] = []
  const referenced = new Map<string, string>()

  for (const target of tree.targets.values()) {
    for (const [field, ref] of Object.entries(target.secrets)) {
      referenced.set(ref.$secret, `${target.label} (${target.id}), field "${field}"`)
    }
  }

  for (const [name, owner] of referenced) {
    if (hasSecret(name)) continue
    findings.push({
      severity: 'error',
      code: 'missing-credential',
      message: `no value for secret "${name}" — needed by ${owner}`,
      fix: `set ${environmentVariableName(name)}, or enter it in the editor`,
    })
  }

  // Only the file is checked for orphans; an unused environment variable is often deliberate.
  for (const name of storedNames) {
    if (referenced.has(name)) continue
    findings.push({
      severity: 'warning',
      code: 'orphan-credential',
      message: `secret "${name}" is stored but no target references it`,
      fix: 'delete it from secrets/secrets.json, or rebind the widget that used it',
    })
  }

  return findings
}

function checkWidgets({ tree, catalog }: DoctorInput): Finding[] {
  const findings: Finding[] = []

  for (const widget of tree.widgets.values()) {
    const manifest = catalog.get(widget.type)
    if (manifest === undefined) {
      findings.push({
        severity: 'error',
        code: 'unknown-widget-type',
        message: `widget "${widget.id}" is a "${widget.type}", which is not in the catalog`,
        fix: 'update the catalog, or delete the widget',
      })
      continue
    }

    if (isComposite(manifest)) {
      for (const [roleName, role] of Object.entries(manifest.roles)) {
        const bound = widget.bindings[roleName] ?? []
        if (bound.length < role.min) {
          findings.push({
            severity: 'error',
            code: 'role-unfilled',
            message: `widget "${widget.id}" needs at least ${role.min} target on role "${roleName}" and has ${bound.length}`,
            fix: 'bind one in the editor, or delete the widget',
          })
        }
        for (const targetId of bound) {
          const target = tree.targets.get(targetId)
          if (target === undefined) {
            findings.push({
              severity: 'error',
              code: 'missing-target',
              message: `widget "${widget.id}" binds target "${targetId}", which does not exist`,
              fix: 'rebind it in the editor',
            })
            continue
          }
          if (role.kinds[target.widgetType] === undefined) {
            findings.push({
              severity: 'error',
              code: 'wrong-target-shape',
              message:
                `widget "${widget.id}" binds a "${target.widgetType}" to role "${roleName}", ` +
                `which accepts ${Object.keys(role.kinds).join(', ')}`,
              fix: 'rebind it, or install a catalog version that accepts this shape',
            })
          }
        }
      }
      continue
    }

    if (widget.targetId === null) {
      findings.push({
        severity: 'warning',
        code: 'widget-unbound',
        message: `widget "${widget.id}" has no target and will never fetch`,
        fix: 'bind one in the editor, or delete the widget',
      })
    } else if (!tree.targets.has(widget.targetId)) {
      findings.push({
        severity: 'error',
        code: 'missing-target',
        message: `widget "${widget.id}" points at target "${widget.targetId}", which does not exist`,
        fix: 'rebind it in the editor',
      })
    }
  }

  for (const target of tree.targets.values()) {
    const used = [...tree.widgets.values()].some(
      (widget) =>
        widget.targetId === target.id ||
        Object.values(widget.bindings).some((bound) => bound.includes(target.id)),
    )
    if (!used) {
      findings.push({
        severity: 'warning',
        code: 'orphan-target',
        message: `target "${target.id}" (${target.label}) is not used by any widget`,
        fix: 'delete it — its credential is on disk for a service nothing displays',
      })
    }

    // The write path routes secret-kind fields to the vault, so one here is from an older release
    // or a hand-edited file.
    const declared = targetShapeFields(catalog, target.widgetType)
    for (const name of Object.keys(target.fields)) {
      if (declared?.find((field) => field.name === name)?.kind === 'secret') {
        findings.push({
          severity: 'error',
          code: 'credential-in-config',
          message: `target "${target.id}" has "${name}" as a plain field, but the manifest declares it a secret`,
          fix: 're-enter the credential in the editor, then ROTATE it — this file may be in git',
        })
      }
    }
  }

  return findings
}

const exec = promisify(execFile)

async function checkGit(env: Env): Promise<Finding[]> {
  let tracked: string
  try {
    const { stdout } = await exec('git', ['ls-files'], { cwd: env.dataDir, maxBuffer: 8 << 20 })
    tracked = stdout
  } catch {
    // Not a git repository, or no git installed.
    return []
  }

  const findings: Finding[] = []
  const files = tracked.split('\n').filter((line) => line !== '')
  const forbidden = [
    { dir: relative(env.dataDir, env.secretsDir), code: 'secrets-tracked' as const },
    { dir: relative(env.dataDir, env.stateDir), code: 'state-tracked' as const },
  ]

  for (const { dir, code } of forbidden) {
    if (dir.startsWith('..')) continue
    const hits = files.filter((file) => file === dir || file.startsWith(`${dir}/`))
    if (hits.length === 0) continue
    findings.push({
      severity: 'error',
      code,
      message: `${hits.length} file(s) under ${dir}/ are tracked by git`,
      fix:
        code === 'secrets-tracked'
          ? `git rm -r --cached ${dir} && ROTATE every credential — they are in the history`
          : `git rm -r --cached ${dir} and add it to .gitignore`,
    })
  }

  if (files.length === 0) {
    findings.push({
      severity: 'note',
      code: 'nothing-committed',
      message: `${env.dataDir} is a git repository with nothing committed yet`,
      fix: 'git add -A && git commit -m "initial config" — this is your backup',
    })
  }

  return findings
}

/** Every file under `dir`, depth-first in readdir order. Empty when the directory is unreadable. */
async function walkFiles(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await walkFiles(path)))
    else out.push(path)
  }
  return out
}

async function checkAssets(env: Env): Promise<Finding[]> {
  const findings: Finding[] = []
  let total = 0

  for (const path of await walkFiles(env.assetsDir)) {
    const info = await stat(path)
    total += info.size
    if (info.size > ASSET_FILE_WARN_BYTES) {
      findings.push({
        severity: 'warning',
        code: 'large-asset',
        message: `${relative(env.dataDir, path)} is ${(info.size / 1024 / 1024).toFixed(1)} MB`,
        fix: 'a background this large is committed forever, even after you delete it — re-save it smaller',
      })
    }
  }

  if (total > ASSETS_WARN_BYTES) {
    findings.push({
      severity: 'warning',
      code: 'assets-large',
      message: `assets/ is ${(total / 1024 / 1024).toFixed(0)} MB, which will make cloning slow`,
      fix: 'remove unused backgrounds, or move assets/ to Git LFS',
    })
  }

  return findings
}

async function checkPermissions({ env, storedNames }: DoctorInput): Promise<Finding[]> {
  if (storedNames.size === 0) return []
  const path = join(env.secretsDir, 'secrets.json')
  try {
    const mode = (await stat(path)).mode & 0o777
    if ((mode & 0o077) !== 0) {
      return [
        {
          severity: 'warning',
          code: 'secrets-readable',
          message: `secrets.json is mode ${mode.toString(8)}; every user on this machine can read it`,
          fix: `chmod 600 ${path}`,
        },
      ]
    }
  } catch {
    // No file when secrets come entirely from environment variables.
  }
  return []
}

function checkResolveDiagnostics({ diagnostics }: DoctorInput): Finding[] {
  return diagnostics.map((message) => ({
    severity: 'warning' as const,
    code: 'resolve',
    message,
  }))
}

/** Unknown keys survive a round trip so a rollback loses nothing; doctor is where they surface. */
export async function unknownKeys(configDir: string): Promise<Finding[]> {
  const findings: Finding[] = []

  for (const file of (await walkFiles(configDir)).filter((path) => path.endsWith('.json'))) {
    try {
      JSON.parse(await readFile(file, 'utf8'))
    } catch {
      findings.push({
        severity: 'error',
        code: 'unparseable-config',
        message: `${file} is not valid JSON`,
        fix: 'fix it by hand, or restore it from git',
      })
    }
  }
  return findings
}
