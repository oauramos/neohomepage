import { access, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileDurable } from './atomic.ts'

/**
 * First-boot seeding of the data directory.
 *
 * The `.gitignore` is the load-bearing file here: `git init` on this directory has to be safe for
 * someone who has not read the documentation, which means secrets/ and state/ must already be
 * excluded before they can possibly be committed.
 */

export type SeedPaths = {
  readonly dataDir: string
  readonly configDir: string
  readonly assetsDir: string
  readonly secretsDir: string
  readonly stateDir: string
}

const GITIGNORE = `# Written by neohomepage on first boot.
#
# secrets/ holds API keys. It must never be committed — not even encrypted: a repository gets
# copied, mirrored and cloned, and an offline attacker gets unlimited attempts at the passphrase.
# See https://neohomepage.dev/guide/backup for how credentials survive a restore instead.
secrets/

# state/ is derived from config/ and rebuilt on boot. Committing it would turn every publish into
# a large commit of duplicated HTML.
state/

# Per-machine settings: laptop-vs-NAS URLs, and the reason people stop git-syncing without it.
config/overrides.local.json

# Append-only local history, not shared state.
config/.audit.jsonl
`

const GITATTRIBUTES = `# Config is line-oriented JSON. Normalising line endings keeps diffs meaningful when the same
# repository is checked out on Windows and on the NAS.
** text eol=lf
*.png binary
*.jpg binary
*.jpeg binary
*.webp binary
*.avif binary
*.woff2 binary
`

const README = `# neohomepage data

This directory is your dashboard. Back it up by making it a git repository:

    git init
    git remote add origin git@github.com:you/neohomepage-data.git
    git add -A && git commit -m "my dashboard" && git push -u origin main

## What is in here

| Directory  | Committed | What it is                                                    |
| ---------- | --------- | ------------------------------------------------------------- |
| config/    | yes       | Layout, widgets, targets, theme. Contains no secret values.    |
| assets/    | yes       | Backgrounds, local icons, fonts.                               |
| secrets/   | **no**    | API keys, mode 0600. Excluded by .gitignore.                   |
| state/     | **no**    | Caches and rendered pages. Delete it and it rebuilds.          |

## Restoring

Clone this repository, provide your API keys, and start the app. It finds a populated config/ and
an empty state/, runs any migrations, rebuilds, and serves the same dashboard. There is no import
step.

Your API keys are not in here on purpose. The recommended way to carry them across a wipe is
environment variables — config only ever stores a reference like {"$secret": "sonarr.apiKey"}, and
the value is read from NEOHOMEPAGE_SECRET_SONARR_APIKEY (or ..._FILE) at request time. Keep them in
your compose file or systemd unit, which you already store somewhere safe.

See https://neohomepage.dev/guide/backup for the other two options.
`

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Idempotent: never overwrites a file the user may have edited. */
export async function seedDataDirectory(paths: SeedPaths): Promise<string[]> {
  const written: string[] = []

  await mkdir(paths.configDir, { recursive: true })
  await mkdir(paths.assetsDir, { recursive: true })
  await mkdir(paths.stateDir, { recursive: true })
  // 0700: the directory itself, not just the files in it. A world-readable directory containing
  // 0600 files still leaks the names of every service you run.
  await mkdir(paths.secretsDir, { recursive: true, mode: 0o700 })

  for (const [name, contents] of [
    ['.gitignore', GITIGNORE],
    ['.gitattributes', GITATTRIBUTES],
    ['README.md', README],
  ] as const) {
    const path = join(paths.dataDir, name)
    if (await exists(path)) continue
    await writeFileDurable(path, contents)
    written.push(path)
  }

  return written
}
