/**
 * Generates the widget reference from the manifests into a committed file, so the page is
 * reviewable in the same diff as a manifest change; CI fails when it is stale.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { format, resolveConfig } from 'prettier'
import {
  AUTH_KINDS,
  DECODERS,
  deriveRequires,
  isComposite,
  parseManifest,
  sourceKinds,
  TEMPLATES,
  type AuthKind,
  type Manifest,
} from '@neohomepage/catalog-schema'

const ROOT = resolve(import.meta.dirname, '../../..')
const CATALOG_DIR = resolve(process.env.NEOHOMEPAGE_CATALOG_DIR ?? join(ROOT, 'catalog'))
const OUT = resolve(process.env.NEOHOMEPAGE_DOCS_OUT ?? join(ROOT, 'docs/widgets/index.md'))

const AUTH_LABEL: Record<AuthKind, string> = {
  none: 'none',
  header: 'API key header',
  basic: 'username and password',
  query: 'API key in the query string',
  'session-exchange': 'log in, then a session',
}

const HEADER = `# Widgets

::: warning Generated
This page is generated from \`catalog/*/manifest.json\` by \`pnpm catalog:docs\`. Edit a manifest,
not this file — CI fails if the two disagree.
:::

Every widget here is data: a JSON manifest declaring its fields, its authentication, the one
request it makes and a projection written in a language that cannot loop, recurse or call out.
None of them is a React component, and none of them ships code. That is what makes a catalog
contributed by strangers safe to install.
`

function credentialNote(manifest: Manifest): string {
  const fields = isComposite(manifest)
    ? sourceKinds(manifest).flatMap((entry) => entry.source.fields)
    : manifest.target.fields
  const secrets = fields.filter((field) => field.kind === 'secret')
  if (secrets.length === 0) return 'no credential'
  const names = [...new Set(secrets.map((field) => field.label))]
  return names.join(', ')
}

async function main(): Promise<number> {
  const slugs = (await readdir(CATALOG_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const manifests: Manifest[] = []
  for (const slug of slugs) {
    const parsed = parseManifest(
      JSON.parse(await readFile(join(CATALOG_DIR, slug, 'manifest.json'), 'utf8')),
    )
    if (!parsed.ok) {
      console.error(
        `${slug}: ${parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`,
      )
      return 1
    }
    manifests.push(parsed.manifest)
  }

  const byCategory = new Map<string, Manifest[]>()
  for (const manifest of manifests) {
    const bucket = byCategory.get(manifest.category) ?? []
    bucket.push(manifest)
    byCategory.set(manifest.category, bucket)
  }

  const lines: string[] = [HEADER]

  const seen = {
    templates: new Set<string>(),
    authKinds: new Set<string>(),
    fetchKinds: new Set<string>(),
  }
  for (const manifest of manifests) {
    const derived = deriveRequires(manifest)
    for (const one of derived.templates) seen.templates.add(one)
    for (const one of derived.authKinds) seen.authKinds.add(one)
    for (const one of derived.fetchKinds) seen.fetchKinds.add(one)
  }
  lines.push(
    `**${manifests.length} widgets** covering ${seen.templates.size} of ${TEMPLATES.length} ` +
      `presentation templates, ${seen.authKinds.size} of ${AUTH_KINDS.length} authentication ` +
      `kinds and ${seen.fetchKinds.size} of ${DECODERS.length} response formats.\n`,
  )

  for (const category of [...byCategory.keys()].sort()) {
    lines.push(`## ${category.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase())}\n`)
    lines.push('| Widget | Shows | Needs | Renders as |')
    lines.push('| --- | --- | --- | --- |')
    for (const manifest of (byCategory.get(category) ?? []).sort((a, b) =>
      a.id.localeCompare(b.id, 'en-US'),
    )) {
      const auth = [...new Set(deriveRequires(manifest).authKinds.map((kind) => AUTH_LABEL[kind]))]
      const shows = isComposite(manifest)
        ? `${sourceKinds(manifest).length} source kinds merged into one tile`
        : Object.keys(manifest.operations).join(', ')
      lines.push(
        `| **${manifest.displayName}** <br><code>${manifest.id}</code> | ${shows} | ` +
          `${credentialNote(manifest)} <br><small>${auth.join(', ')}</small> | ` +
          `\`${manifest.presentation.template}\` |`,
      )
    }
    lines.push('')
  }

  lines.push(`## Adding one

A widget is three files and no code:

\`\`\`
catalog/<slug>/manifest.json                 # the whole integration
catalog/<slug>/fixtures/<name>.upstream.*    # a recorded real response
catalog/<slug>/fixtures/<name>.expected.json # the projection it must produce
catalog/<slug>/README.md                     # which vendor documentation you worked from
\`\`\`

The fixture's extension follows the decoder: \`.json\`, \`.ics\` or \`.txt\`. It is read through the
real decoder, so an iCalendar fixture exercises recurrence expansion and timezone conversion
offline rather than being a hand-written guess at what the decoder emits.

\`\`\`sh
pnpm catalog:validate    # schema, limits, and the derived-vs-declared \`requires\` check
pnpm catalog:test        # runs every projection against its fixtures, with no network
\`\`\`

\`catalog:test\` does not merely avoid the network — it makes \`fetch\` throw. A widget whose test
only passes while your LAN is up is a broken widget, and the difference is invisible otherwise.

\`requires\` is **derived from the manifest and compared to what you declared**; a hand-maintained
requirement list drifts within weeks, and that drift is exactly the "installs fine, then renders
nothing" bug. Run \`pnpm --filter @neohomepage/app catalog requires --write\` to fill it in.

One service per pull request. A thirty-widget PR cannot have been written from thirty sets of
vendor documentation, and it cannot be reviewed.

## Widgets that bind several services

Most widgets bind one target. A **composite** widget binds several, of possibly different kinds,
and merges them into one tile — the calendar above is the example. It replaces
\`target\`/\`operations\`/\`projection\` with:

- \`roles\` — the binding slots, each naming which target shapes it accepts and how many.
- \`compose\` — how the merged streams become one list: distinct, sort, limit, and whether a
  partial answer still renders.

Inside a role, each accepted kind declares its own fields, its own authentication and **one**
operation with one or more \`emits\`. Several emits over one response is how Radarr contributes
three dated events per film — in cinemas, physical, digital — from a single HTTP request.
`)

  const markdown = lines.join('\n')
  await writeFile(OUT, await format(markdown, { ...(await resolveConfig(OUT)), filepath: OUT }))
  console.log(`wrote ${OUT} (${manifests.length} widgets)`)
  return 0
}

process.exitCode = await main()
