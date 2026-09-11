import { useEffect, useRef, useState } from 'react'
import type { BookmarkGroup, BookmarkLink, NavItem, Section } from '../../server/config/schema.ts'
import { composeHref } from '../../shared/links.ts'

/**
 * The sections editor: what a page is made of, top to bottom.
 *
 * The draft is the page's sparse section list — what the user SET, with blanks where the page's
 * defaults apply — and every edit is written back whole after a short pause, because a section
 * list is an order as much as a set and the server validates the whole thing at once. A 422 is
 * shown in place and the draft kept, so a half-typed group title never loses the rest.
 */

type Breakpoint = { readonly id: string; readonly cols: number; readonly minWidth: number }

type PageConfig = {
  readonly id: string
  readonly sections: Section[]
  readonly breakpoints: Breakpoint[]
  readonly maxRows: number | null
}

const KINDS: { kind: Section['kind']; label: string; blurb: string }[] = [
  { kind: 'navbar', label: 'Navbar', blurb: 'Title, links, a clock, a search box.' },
  { kind: 'grid', label: 'Grid', blurb: 'A board of widgets with its own columns.' },
  { kind: 'bookmarks', label: 'Bookmarks', blurb: 'Named groups of links, in columns.' },
]

const NAV_KINDS: { kind: NavItem['kind']; label: string }[] = [
  { kind: 'title', label: 'Title' },
  { kind: 'text', label: 'Text' },
  { kind: 'links', label: 'Links' },
  { kind: 'clock', label: 'Clock' },
  { kind: 'search', label: 'Search' },
  { kind: 'spacer', label: 'Spacer' },
]

const DISPLAYS = [
  { id: 'list', label: 'List' },
  { id: 'cards', label: 'Cards' },
  { id: 'icons', label: 'Icons' },
  { id: 'chips', label: 'Chips' },
] as const

const ENGINES = ['duckduckgo', 'google', 'bing', 'brave', 'startpage', 'kagi'] as const

/** Ids must start with a letter — they end up in CSS selectors — so the prefix is one. */
function newId(prefix: string): string {
  return `${prefix}${Math.random().toString(36).slice(2, 10)}`
}

function blankSection(kind: Section['kind']): Section {
  switch (kind) {
    case 'navbar':
      return { id: newId('n'), kind, title: null, items: [{ id: newId('i'), kind: 'title' }] }
    case 'grid':
      return { id: newId('g'), kind, title: null, cols: {}, maxRows: null }
    case 'bookmarks':
      return {
        id: newId('b'),
        kind,
        title: null,
        columns: {},
        display: 'list',
        groups: [{ id: newId('grp'), title: 'Links', links: [] }],
      }
  }
}

function blankNavItem(kind: NavItem['kind']): NavItem {
  const id = newId('i')
  switch (kind) {
    case 'title':
    case 'spacer':
      return { id, kind }
    case 'text':
      return { id, kind, text: 'Text' }
    case 'links':
      return { id, kind, links: [] }
    case 'clock':
      return { id, kind, showDate: true, hour12: false }
    case 'search':
      return { id, kind, engine: 'duckduckgo', placeholder: 'Search' }
  }
}

function blankLink(): BookmarkLink {
  return {
    id: newId('l'),
    label: 'New link',
    // A placeholder host that validates, so the list saves while the URL is still being typed.
    base: { scheme: 'http', host: 'example.home', port: 80 },
    path: '/',
    icon: null,
  }
}

/**
 * A link is typed as a URL and stored as parts. The split happens here, in the browser, so the
 * request that reaches the server carries scheme, host, port and path — never a URL string.
 */
function parseUrl(raw: string): Pick<BookmarkLink, 'base' | 'path'> | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const scheme = url.protocol === 'https:' ? 'https' : 'http'
  const port = url.port === '' ? (scheme === 'https' ? 443 : 80) : Number(url.port)
  const path = `${url.pathname}${url.search}${url.hash}` || '/'
  if (path.includes('..') || path.includes('//')) return null
  return { base: { scheme, host: url.hostname, port }, path }
}

function move<T>(list: readonly T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return [...list]
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item as T)
  return next
}

/** The three small buttons every reorderable row has, in the same order everywhere. */
function RowActions({
  label,
  onUp,
  onDown,
  onRemove,
}: {
  label: string
  onUp: () => void
  onDown: () => void
  onRemove: () => void
}) {
  return (
    <span className="nh-row-actions">
      <button type="button" className="nh-mini" onClick={onUp} aria-label={`Move ${label} up`}>
        ▲
      </button>
      <button type="button" className="nh-mini" onClick={onDown} aria-label={`Move ${label} down`}>
        ▼
      </button>
      <button
        type="button"
        className="nh-mini nh-mini-danger"
        onClick={onRemove}
        aria-label={`Remove ${label}`}
      >
        ×
      </button>
    </span>
  )
}

function LinkRows({
  links,
  onChange,
}: {
  links: readonly BookmarkLink[]
  onChange: (links: BookmarkLink[]) => void
}) {
  // What the user has typed per link, kept apart from the stored parts so an unfinished URL does
  // not snap back to the last valid one on every keystroke.
  const [typed, setTyped] = useState<Record<string, string>>({})
  const update = (index: number, patch: Partial<BookmarkLink>) =>
    onChange(links.map((link, i) => (i === index ? { ...link, ...patch } : link)))

  return (
    <div className="nh-link-rows">
      {links.map((link, index) => {
        const raw = typed[link.id] ?? composeHref(link.base, link.path)
        const invalid = parseUrl(raw) === null
        return (
          <div key={link.id} className="nh-link-row">
            <input
              className="nh-input nh-link-label"
              value={link.label}
              aria-label="Label"
              placeholder="Label"
              onChange={(event) => update(index, { label: event.target.value })}
            />
            <input
              className="nh-input nh-link-url"
              value={raw}
              aria-label="URL"
              aria-invalid={invalid}
              placeholder="http://host:port/path"
              onChange={(event) => {
                const value = event.target.value
                setTyped((current) => ({ ...current, [link.id]: value }))
                const parsed = parseUrl(value)
                if (parsed !== null) update(index, parsed)
              }}
            />
            <input
              className="nh-input nh-link-icon"
              value={link.icon ?? ''}
              aria-label="Icon"
              placeholder="icon"
              onChange={(event) =>
                update(index, {
                  icon: event.target.value.trim() === '' ? null : event.target.value.trim(),
                })
              }
            />
            <RowActions
              label={link.label}
              onUp={() => onChange(move(links, index, index - 1))}
              onDown={() => onChange(move(links, index, index + 1))}
              onRemove={() => onChange(links.filter((_, i) => i !== index))}
            />
          </div>
        )
      })}
      <button
        type="button"
        className="nh-button-quiet"
        onClick={() => onChange([...links, blankLink()])}
      >
        + Add link
      </button>
    </div>
  )
}

/** One number per breakpoint; blank means "the page's default", which the placeholder shows. */
function PerBreakpoint({
  label,
  values,
  breakpoints,
  placeholder,
  max,
  onChange,
}: {
  label: string
  values: Readonly<Record<string, number>>
  breakpoints: readonly Breakpoint[]
  placeholder: (breakpoint: Breakpoint) => number
  max: number
  onChange: (values: Record<string, number>) => void
}) {
  return (
    <div className="nh-field">
      <span className="nh-field-label">{label}</span>
      <div className="nh-cols">
        {breakpoints.map((breakpoint) => (
          <label key={breakpoint.id} className="nh-col-field">
            <span>{breakpoint.id}</span>
            <input
              className="nh-input"
              type="number"
              min={1}
              max={max}
              value={values[breakpoint.id] ?? ''}
              placeholder={String(placeholder(breakpoint))}
              onChange={(event) => {
                const next = { ...values }
                const parsed = Number(event.target.value)
                if (event.target.value === '' || !Number.isFinite(parsed))
                  delete next[breakpoint.id]
                else next[breakpoint.id] = Math.max(1, Math.min(max, Math.round(parsed)))
                onChange(next)
              }}
            />
          </label>
        ))}
      </div>
    </div>
  )
}

function NavbarFields({
  section,
  onChange,
}: {
  section: Extract<Section, { kind: 'navbar' }>
  onChange: (section: Section) => void
}) {
  const [adding, setAdding] = useState<NavItem['kind']>('links')
  const items = section.items
  const setItems = (next: NavItem[]) => onChange({ ...section, items: next })
  const update = (index: number, item: NavItem) =>
    setItems(items.map((it, i) => (i === index ? item : it)))

  return (
    <div className="nh-panel-stack">
      {items.map((item, index) => (
        <div key={item.id} className="nh-nav-item">
          <div className="nh-row">
            <span className="nh-kind">{NAV_KINDS.find((k) => k.kind === item.kind)?.label}</span>
            {item.kind === 'text' ? (
              <input
                className="nh-input nh-grow"
                value={item.text}
                aria-label="Text"
                onChange={(event) => update(index, { ...item, text: event.target.value })}
              />
            ) : null}
            {item.kind === 'search' ? (
              <>
                <select
                  className="nh-input nh-select"
                  value={item.engine}
                  aria-label="Search engine"
                  onChange={(event) =>
                    update(index, {
                      ...item,
                      engine: event.target.value as (typeof ENGINES)[number],
                    })
                  }
                >
                  {ENGINES.map((engine) => (
                    <option key={engine} value={engine}>
                      {engine}
                    </option>
                  ))}
                </select>
                <input
                  className="nh-input nh-grow"
                  value={item.placeholder}
                  aria-label="Placeholder"
                  onChange={(event) => update(index, { ...item, placeholder: event.target.value })}
                />
              </>
            ) : null}
            {item.kind === 'clock' ? (
              <>
                <label className="nh-check">
                  <input
                    type="checkbox"
                    checked={item.showDate}
                    onChange={(event) => update(index, { ...item, showDate: event.target.checked })}
                  />
                  date
                </label>
                <label className="nh-check">
                  <input
                    type="checkbox"
                    checked={item.hour12}
                    onChange={(event) => update(index, { ...item, hour12: event.target.checked })}
                  />
                  12-hour
                </label>
              </>
            ) : null}
            <RowActions
              label={item.kind}
              onUp={() => setItems(move(items, index, index - 1))}
              onDown={() => setItems(move(items, index, index + 1))}
              onRemove={() => setItems(items.filter((_, i) => i !== index))}
            />
          </div>
          {item.kind === 'links' ? (
            <LinkRows links={item.links} onChange={(links) => update(index, { ...item, links })} />
          ) : null}
        </div>
      ))}
      <div className="nh-row">
        <select
          className="nh-input nh-select"
          value={adding}
          aria-label="Item to add"
          onChange={(event) => setAdding(event.target.value as NavItem['kind'])}
        >
          {NAV_KINDS.map((kind) => (
            <option key={kind.kind} value={kind.kind}>
              {kind.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="nh-button-quiet"
          onClick={() => setItems([...items, blankNavItem(adding)])}
        >
          + Add item
        </button>
      </div>
    </div>
  )
}

function GridFields({
  section,
  page,
  onChange,
}: {
  section: Extract<Section, { kind: 'grid' }>
  page: PageConfig
  onChange: (section: Section) => void
}) {
  return (
    <div className="nh-panel-stack">
      <PerBreakpoint
        label="Columns"
        values={section.cols}
        breakpoints={page.breakpoints}
        placeholder={(breakpoint) => breakpoint.cols}
        max={24}
        onChange={(cols) => onChange({ ...section, cols })}
      />
      <label className="nh-field">
        <span className="nh-field-label">Max rows</span>
        <input
          className="nh-input"
          type="number"
          min={1}
          max={200}
          value={section.maxRows ?? ''}
          placeholder={page.maxRows === null ? 'no limit' : String(page.maxRows)}
          onChange={(event) =>
            onChange({
              ...section,
              maxRows:
                event.target.value === ''
                  ? null
                  : Math.max(1, Math.round(Number(event.target.value))),
            })
          }
        />
        <p className="nh-field-help">
          With a limit, a widget that does not fit is refused rather than pushed below the fold.
        </p>
      </label>
    </div>
  )
}

function BookmarksFields({
  section,
  page,
  onChange,
}: {
  section: Extract<Section, { kind: 'bookmarks' }>
  page: PageConfig
  onChange: (section: Section) => void
}) {
  const groups = section.groups
  const setGroups = (next: BookmarkGroup[]) => onChange({ ...section, groups: next })
  const update = (index: number, group: BookmarkGroup) =>
    setGroups(groups.map((g, i) => (i === index ? group : g)))

  return (
    <div className="nh-panel-stack">
      <PerBreakpoint
        label="Groups per row"
        values={section.columns}
        breakpoints={page.breakpoints}
        placeholder={(breakpoint) => Math.max(1, Math.min(12, Math.round(breakpoint.cols / 3)))}
        max={12}
        onChange={(columns) => onChange({ ...section, columns })}
      />
      <div className="nh-field">
        <span className="nh-field-label">Display</span>
        <div className="nh-seg" role="group" aria-label="Display">
          {DISPLAYS.map((display) => (
            <button
              key={display.id}
              type="button"
              className="nh-seg-item"
              aria-pressed={section.display === display.id}
              onClick={() => onChange({ ...section, display: display.id })}
            >
              {display.label}
            </button>
          ))}
        </div>
      </div>
      {groups.map((group, index) => (
        <div key={group.id} className="nh-group-edit">
          <div className="nh-row">
            <input
              className="nh-input nh-grow"
              value={group.title}
              aria-label="Group title"
              placeholder="Group title"
              onChange={(event) => update(index, { ...group, title: event.target.value })}
            />
            <RowActions
              label={group.title}
              onUp={() => setGroups(move(groups, index, index - 1))}
              onDown={() => setGroups(move(groups, index, index + 1))}
              onRemove={() => setGroups(groups.filter((_, i) => i !== index))}
            />
          </div>
          <LinkRows links={group.links} onChange={(links) => update(index, { ...group, links })} />
        </div>
      ))}
      <button
        type="button"
        className="nh-button-quiet"
        onClick={() => setGroups([...groups, { id: newId('grp'), title: 'New group', links: [] }])}
      >
        + Add group
      </button>
    </div>
  )
}

export function SectionsPanel({ pageId, onChanged }: { pageId: string; onChanged: () => void }) {
  const [page, setPage] = useState<PageConfig | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let live = true
    void fetch(`/api/pages/${pageId}`)
      .then((response) => response.json() as Promise<PageConfig>)
      .then((loaded) => {
        if (live) setPage(loaded)
      })
      .catch(() => {
        if (live) setError('Could not load the page.')
      })
    return () => {
      live = false
    }
  }, [pageId])

  /** Write the whole list after a pause; the last edit in a burst is the one that lands. */
  const commit = (sections: Section[]) => {
    if (page === null) return
    setPage({ ...page, sections })
    if (timer.current !== null) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      setSaving(true)
      void fetch(`/api/pages/${pageId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sections }),
      })
        .then(async (response) => {
          if (response.ok) {
            setError(null)
            onChanged()
            return
          }
          const body = (await response.json().catch(() => ({}))) as { error?: string }
          setError(body.error ?? `Save failed (${String(response.status)})`)
        })
        .catch(() => setError('Save failed: the server did not answer.'))
        .finally(() => setSaving(false))
    }, 500)
  }

  if (page === null) {
    return <p className="nh-panel-note">{error ?? 'Loading…'}</p>
  }

  const sections = page.sections
  const replace = (index: number, section: Section) =>
    commit(sections.map((s, i) => (i === index ? section : s)))

  return (
    <div className="nh-panel-stack">
      <p className="nh-panel-note">
        The page is these sections, top to bottom. Widgets live in grid sections; move one from the
        Widgets tab.
      </p>
      <ol className="nh-sections">
        {sections.map((section, index) => {
          const kind = KINDS.find((k) => k.kind === section.kind)
          const expanded = open === section.id
          return (
            <li key={section.id} className="nh-section-card" data-neo-kind={section.kind}>
              <div className="nh-section-head">
                <button
                  type="button"
                  className="nh-section-toggle"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : section.id)}
                >
                  <span className="nh-kind">{kind?.label}</span>
                  <span className="nh-section-name">
                    {section.title ?? (section.kind === 'navbar' ? 'Header' : 'Untitled')}
                  </span>
                </button>
                <RowActions
                  label={section.title ?? kind?.label ?? section.kind}
                  onUp={() => commit(move(sections, index, index - 1))}
                  onDown={() => commit(move(sections, index, index + 1))}
                  onRemove={() => commit(sections.filter((_, i) => i !== index))}
                />
              </div>
              {expanded ? (
                <div className="nh-section-body">
                  {section.kind === 'navbar' ? null : (
                    <label className="nh-field">
                      <span className="nh-field-label">Title</span>
                      <input
                        className="nh-input"
                        value={section.title ?? ''}
                        placeholder="none"
                        onChange={(event) =>
                          replace(index, {
                            ...section,
                            title: event.target.value === '' ? null : event.target.value,
                          })
                        }
                      />
                    </label>
                  )}
                  {section.kind === 'navbar' ? (
                    <NavbarFields section={section} onChange={(next) => replace(index, next)} />
                  ) : section.kind === 'grid' ? (
                    <GridFields
                      section={section}
                      page={page}
                      onChange={(next) => replace(index, next)}
                    />
                  ) : (
                    <BookmarksFields
                      section={section}
                      page={page}
                      onChange={(next) => replace(index, next)}
                    />
                  )}
                </div>
              ) : null}
            </li>
          )
        })}
      </ol>
      <div className="nh-row">
        <span className="nh-panel-dim">Add:</span>
        {KINDS.map((kind) => (
          <button
            key={kind.kind}
            type="button"
            className="nh-button-quiet"
            title={kind.blurb}
            onClick={() => {
              const section = blankSection(kind.kind)
              commit([...sections, section])
              setOpen(section.id)
            }}
          >
            {kind.label}
          </button>
        ))}
      </div>
      {error !== null ? (
        <p className="nh-status-note" role="alert">
          {error}
        </p>
      ) : saving ? (
        <p className="nh-panel-dim">Saving…</p>
      ) : null}
    </div>
  )
}
