import { createElement as h, type ReactNode } from 'react'
import type { ProjectionEnvelope } from '@neohomepage/catalog-schema'
import { SEARCH_ACTIONS } from './links.ts'
import type {
  Resolved,
  ResolvedBookmarksSection,
  ResolvedGridSection,
  ResolvedLink,
  ResolvedNavbarSection,
  ResolvedPage,
  ResolvedSection,
  ResolvedWidget,
} from './resolved.ts'

/**
 * The board, rendered from one tree by `renderToStaticMarkup` at publish time and by the SPA in
 * the browser. Uses `createElement` rather than JSX because Node strips types and cannot load
 * `.tsx`. Positioning comes from the emitted stylesheet, which targets each tile's `data-neo-i`.
 */

export type WidgetData = Readonly<Record<string, ProjectionEnvelope | undefined>>

/**
 * A formatted time arrives as `{v, iso}`: the text ships for the no-JS case, the instant beside
 * it for the client to re-render relative times from.
 */
function renderValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object' && value !== null && 'v' in value && 'iso' in value) {
    const time = value as { v: string; iso: string }
    return h('time', { dateTime: time.iso, 'data-neo-rel': '' }, time.v)
  }
  return String(value)
}

function placeholder(text: string): ReactNode {
  return h('p', { className: 'nh-placeholder' }, text)
}

function statsBlock(envelope: ProjectionEnvelope, template: string): ReactNode {
  const stats = envelope.projection?.stats
  if (stats === undefined || stats.length === 0) return null
  return h(
    'dl',
    { className: 'nh-stats', 'data-neo-template': template, key: 'stats' },
    stats.map((stat) =>
      h('div', { className: 'nh-stat', key: stat.label }, [
        h('dt', { key: 'label' }, stat.label),
        h(
          'dd',
          { key: 'value', ...(stat.tone === undefined ? {} : { 'data-neo-tone': stat.tone }) },
          renderValue(stat.value),
        ),
      ]),
    ),
  )
}

function itemsBlock(envelope: ProjectionEnvelope): ReactNode {
  const items = envelope.projection?.items
  if (items === undefined || items.length === 0) return null
  return h(
    'ul',
    { className: 'nh-items', key: 'items' },
    items.map((item, index) =>
      h('li', { className: 'nh-item', key: `${item.title}-${index}` }, [
        h('span', { className: 'nh-item-title', key: 't' }, item.title),
        item.subtitle === undefined
          ? null
          : h('span', { className: 'nh-item-subtitle', key: 's' }, item.subtitle),
        item.badge === undefined
          ? null
          : h('span', { className: 'nh-item-badge', key: 'b' }, renderValue(item.badge)),
      ]),
    ),
  )
}

function gaugesBlock(envelope: ProjectionEnvelope): ReactNode {
  const gauges = envelope.projection?.gauges
  if (gauges === undefined || gauges.length === 0) return null
  return h(
    'div',
    { className: 'nh-gauges', key: 'gauges' },
    gauges.map((gauge) => {
      const fraction = gauge.total > 0 ? Math.min(1, Math.max(0, gauge.used / gauge.total)) : 0
      return h('div', { className: 'nh-gauge', key: gauge.label }, [
        h('span', { className: 'nh-gauge-label', key: 'l' }, gauge.label),
        h(
          'span',
          {
            className: 'nh-gauge-track',
            key: 'track',
            role: 'meter',
            'aria-label': gauge.label,
            'aria-valuenow': Math.round(fraction * 100),
            'aria-valuemin': 0,
            'aria-valuemax': 100,
          },
          h('span', {
            className: 'nh-gauge-fill',
            // Thresholds live here, not in the manifest: "nearly full" is the same for any gauge.
            'data-neo-tone': fraction >= 0.9 ? 'bad' : fraction >= 0.75 ? 'warn' : 'ok',
            style: { width: `${(fraction * 100).toFixed(1)}%` },
          }),
        ),
      ])
    }),
  )
}

function statusBlock(envelope: ProjectionEnvelope): ReactNode {
  const status = envelope.projection?.status ?? 'unknown'
  const label = status === 'ok' ? 'up' : status
  return h('div', { className: 'nh-status', 'data-neo-status': status, key: 'status' }, [
    h('span', { className: 'nh-status-dot', key: 'dot', 'aria-hidden': 'true' }),
    h('span', { className: 'nh-status-label', key: 'label' }, label),
  ])
}

/**
 * The href comes from the resolved widget first, not the projection: a projection exists only
 * after a probe succeeds, and a bookmark whose service answers with a 401 is still a bookmark.
 */
function linkBlock(widget: ResolvedWidget, envelope: ProjectionEnvelope | undefined): ReactNode {
  const first = envelope?.projection?.items?.[0]
  const href = widget.href ?? first?.href
  const label = first?.subtitle ?? widget.title
  return href === undefined
    ? placeholder(label)
    : h('a', { className: 'nh-link', href, rel: 'noreferrer' }, label)
}

/** Closed set of presentation templates; a manifest naming another is refused at catalog load. */
export const TEMPLATES = ['stat-grid', 'list', 'gauge-set', 'status-badge', 'link-tile'] as const
export type TemplateName = (typeof TEMPLATES)[number]

export function isTemplate(value: string): value is TemplateName {
  return (TEMPLATES as readonly string[]).includes(value)
}

function renderTemplate(
  template: TemplateName,
  widget: ResolvedWidget,
  envelope: ProjectionEnvelope | undefined,
): ReactNode {
  if (template === 'link-tile') return linkBlock(widget, envelope)
  // No envelope: nothing fetched yet. Null projection: fetched and never succeeded.
  if (envelope === undefined || envelope.projection === null) {
    return placeholder(envelope?.meta.errorCode === undefined ? 'No data yet' : 'Unavailable')
  }

  switch (template) {
    case 'stat-grid':
      return statsBlock(envelope, template) ?? placeholder('No readings')
    case 'list':
      // Keyed siblings, so a tile that gains or loses its stats block cannot reuse the wrong node.
      return [statsBlock(envelope, template), itemsBlock(envelope)]
    case 'gauge-set':
      return gaugesBlock(envelope) ?? placeholder('No gauges')
    case 'status-badge':
      return [statusBlock(envelope), statsBlock(envelope, template)]
    default: {
      const exhaustive: never = template
      throw new Error(`unhandled template ${String(exhaustive)}`)
    }
  }
}

export function widgetTile(
  widget: ResolvedWidget,
  envelope: ProjectionEnvelope | undefined,
): ReactNode {
  const state = envelope?.meta.state ?? 'pending'
  const body = widget.unsupported
    ? // A labelled placeholder rather than nothing, so a missing catalog type does not read as data loss.
      placeholder(`Unknown widget type "${widget.type}"`)
    : isTemplate(widget.template)
      ? renderTemplate(widget.template, widget, envelope)
      : placeholder(`Unsupported layout "${widget.template}"`)

  return h(
    'article',
    {
      key: widget.id,
      'data-neo-i': widget.id,
      'data-neo-state': state,
      'data-neo-template': widget.template,
      ...(widget.look.stats === 'inherit' ? {} : { 'data-neo-stats': widget.look.stats }),
      ...(widget.look.align === 'inherit' ? {} : { 'data-neo-align': widget.look.align }),
      className: 'nh-tile',
      'aria-labelledby': `${widget.id}-title`,
    },
    [
      h('header', { className: 'nh-tile-head', key: 'head' }, [
        h('span', { className: 'nh-tile-titles', key: 'titles' }, [
          widget.iconUrl === null ? null : iconFor(widget.title, widget.iconUrl),
          h(
            'h2',
            { id: `${widget.id}-title`, className: 'nh-tile-title', key: 'title' },
            widget.title,
          ),
        ]),
        state === 'stale' || state === 'error'
          ? h(
              'span',
              { className: 'nh-chip', 'data-neo-chip': state, key: 'chip' },
              state === 'error' ? (envelope?.meta.errorCode ?? 'unavailable') : 'stale',
            )
          : null,
      ]),
      h('div', { className: 'nh-tile-body', key: 'body' }, body),
    ],
  )
}

export type RenderOptions = {
  /** What a clock shows. The publish step passes the render instant; the browser ticks it. */
  readonly now?: Date
  /** Edit mode's hook to render a grid section; everything around it stays the view-mode markup. */
  readonly renderGrid?: (section: ResolvedGridSection) => ReactNode
}

/**
 * The cached image when there is one, else the label's initial. Decorative either way, so hidden
 * from assistive technology.
 */
function iconFor(
  label: string,
  iconUrl: string | null,
  mode: 'image' | 'mask' = 'image',
  color: string | null = null,
): ReactNode {
  if (iconUrl !== null && mode === 'mask') {
    // Glyph sets ship black shapes; masking paints them in the text colour (or the named one),
    // and a mask image can never run anything.
    return h('span', {
      className: 'nh-icon nh-icon-mask',
      'aria-hidden': 'true',
      style: {
        '--nh-icon-url': `url("${iconUrl}")`,
        ...(color === null ? {} : { '--nh-icon-color': color }),
      },
      key: 'icon',
    })
  }
  if (iconUrl !== null) {
    return h('img', {
      className: 'nh-icon',
      src: iconUrl,
      alt: '',
      width: 20,
      height: 20,
      loading: 'lazy',
      decoding: 'async',
      key: 'icon',
    })
  }
  return h(
    'span',
    { className: 'nh-icon nh-icon-glyph', 'aria-hidden': 'true', key: 'icon' },
    label.trim().charAt(0).toUpperCase(),
  )
}

function linkGlyph(link: ResolvedLink): ReactNode {
  return iconFor(link.label, link.iconUrl, link.iconMode, link.iconColor)
}

function linkAnchor(link: ResolvedLink, className: string): ReactNode {
  return h('a', { className, href: link.href, rel: 'noreferrer', key: link.id }, [
    linkGlyph(link),
    h('span', { className: 'nh-bm-label', key: 'label' }, link.label),
  ])
}

/**
 * Fixed en-US format so the baked page and the browser agree letter for letter and the no-op
 * publish check holds.
 */
function clockText(now: Date, hour12: boolean, showDate: boolean): string {
  const part = (options: Intl.DateTimeFormatOptions, type: string) =>
    new Intl.DateTimeFormat('en-US', options).formatToParts(now).find((p) => p.type === type)
      ?.value ?? ''
  const hh = part({ hour: '2-digit', hourCycle: hour12 ? 'h12' : 'h23' }, 'hour')
  const mm = part({ minute: '2-digit' }, 'minute').padStart(2, '0')
  const suffix = hour12 ? ` ${part({ hour: 'numeric', hour12: true }, 'dayPeriod')}` : ''
  const time = `${hh}:${mm}${suffix}`
  if (!showDate) return time
  const weekday = part({ weekday: 'short' }, 'weekday')
  const day = part({ day: 'numeric' }, 'day')
  const month = part({ month: 'short' }, 'month')
  return `${time} · ${weekday} ${day} ${month}`
}

function navbar(section: ResolvedNavbarSection, resolved: Resolved, now: Date): ReactNode {
  return h(
    'header',
    { className: 'nh-header', 'data-neo-section': section.id, key: section.id },
    section.items.map((item) => {
      const boxed = 'boxed' in item && item.boxed ? { 'data-neo-boxed': 'true' } : {}
      switch (item.kind) {
        case 'title':
          return h('h1', { className: 'nh-title', ...boxed, key: item.id }, resolved.title)
        case 'text':
          return h('span', { className: 'nh-nav-text', ...boxed, key: item.id }, item.text)
        case 'links':
          return h(
            'nav',
            { className: 'nh-nav-links', 'aria-label': 'Links', ...boxed, key: item.id },
            item.links.map((link) => linkAnchor(link, 'nh-nav-link')),
          )
        case 'clock':
          return h(
            'time',
            {
              className: 'nh-clock',
              dateTime: now.toISOString(),
              'data-neo-clock': item.hour12 ? '12' : '24',
              'data-neo-date': item.showDate ? 'on' : 'off',
              ...boxed,
              key: item.id,
            },
            clockText(now, item.hour12, item.showDate),
          )
        case 'search':
          // A plain GET form works with JavaScript off; the engine comes from a closed table,
          // so config never names where a query goes.
          return h(
            'form',
            {
              className: 'nh-search',
              action: SEARCH_ACTIONS[item.engine],
              method: 'get',
              target: '_blank',
              rel: 'noopener',
              role: 'search',
              key: item.id,
            },
            [
              h('input', {
                className: 'nh-search-input',
                type: 'search',
                name: 'q',
                placeholder: item.placeholder,
                'aria-label': item.placeholder,
                autoComplete: 'off',
                key: 'input',
              }),
              h(
                'button',
                { className: 'nh-search-go', type: 'submit', 'aria-label': 'Search', key: 'go' },
                // The one glyph the page ships itself, so the header is complete before icons load.
                h(
                  'svg',
                  {
                    className: 'nh-glyph',
                    viewBox: '0 0 24 24',
                    width: 18,
                    height: 18,
                    fill: 'none',
                    stroke: 'currentColor',
                    strokeWidth: 2,
                    strokeLinecap: 'round',
                    'aria-hidden': 'true',
                  },
                  [
                    h('circle', { cx: 11, cy: 11, r: 7, key: 'lens' }),
                    h('path', { d: 'm20 20-3.8-3.8', key: 'handle' }),
                  ],
                ),
              ),
            ],
          )
        case 'spacer':
          return h('span', { className: 'nh-spacer', 'aria-hidden': 'true', key: item.id })
        default: {
          const exhaustive: never = item
          throw new Error(`unhandled navbar item ${String(exhaustive)}`)
        }
      }
    }),
  )
}

function sectionTitle(title: string | null): ReactNode {
  return title === null ? null : h('h2', { className: 'nh-section-title', key: 'title' }, title)
}

function gridSection(
  section: ResolvedGridSection,
  page: ResolvedPage,
  widgets: readonly ResolvedWidget[],
  data: WidgetData,
  showEmptyHint: boolean,
): ReactNode {
  const inSection = widgets.filter((widget) => section.widgetIds.includes(widget.id))
  return h('div', { className: 'nh-section nh-section-grid', key: section.id }, [
    sectionTitle(section.title),
    h(
      'div',
      {
        className: 'neo-board',
        'data-neo-page': page.id,
        'data-neo-section': section.id,
        key: 'board',
      },
      inSection.length === 0 && showEmptyHint
        ? h('div', { className: 'nh-board-empty', key: 'empty' }, [
            h('strong', { key: 'title' }, 'No widgets yet'),
            h(
              'span',
              { key: 'hint' },
              'Open the editor with the button in the bottom-left corner to add your first service.',
            ),
          ])
        : inSection.map((widget) => widgetTile(widget, data[widget.id])),
    ),
  ])
}

function bookmarksSection(section: ResolvedBookmarksSection): ReactNode {
  return h(
    'section',
    {
      className: 'nh-section nh-bookmarks',
      'data-neo-section': section.id,
      'data-neo-display': section.display,
      'aria-label': section.title ?? 'Bookmarks',
      key: section.id,
    },
    [
      sectionTitle(section.title),
      h(
        'div',
        { className: 'nh-groups', key: 'groups' },
        section.groups.map((group) =>
          h('div', { className: 'nh-group', key: group.id }, [
            h('h3', { className: 'nh-group-title', key: 'title' }, group.title),
            h(
              'ul',
              { className: 'nh-group-links', key: 'links' },
              group.links.map((link) => h('li', { key: link.id }, linkAnchor(link, 'nh-bm'))),
            ),
          ]),
        ),
      ),
    ],
  )
}

/** One page's sections in order: leading navbars are landmark headers, the rest in one `main`. */
export function board(
  page: ResolvedPage,
  resolved: Resolved,
  data: WidgetData,
  options: RenderOptions = {},
): ReactNode {
  const now = options.now ?? new Date()
  const firstGrid = page.sections.find((section) => section.kind === 'grid')
  const render = (section: ResolvedSection): ReactNode => {
    switch (section.kind) {
      case 'navbar':
        return navbar(section, resolved, now)
      case 'grid':
        return options.renderGrid === undefined
          ? gridSection(
              section,
              page,
              resolved.widgets,
              data,
              section === firstGrid && page.widgetIds.length === 0,
            )
          : options.renderGrid(section)
      case 'bookmarks':
        return bookmarksSection(section)
      default: {
        const exhaustive: never = section
        throw new Error(`unhandled section ${String(exhaustive)}`)
      }
    }
  }

  const leading: ReactNode[] = []
  const rest: ReactNode[] = []
  let inMain = false
  for (const section of page.sections) {
    if (!inMain && section.kind === 'navbar') leading.push(render(section))
    else {
      inMain = true
      rest.push(render(section))
    }
  }
  return [...leading, h('main', { key: 'main', 'data-neo-page': page.id }, rest)]
}

export function defaultPageOf(resolved: Resolved): ResolvedPage | undefined {
  return resolved.pages.find((page) => page.id === resolved.defaultPage) ?? resolved.pages[0]
}

export function dashboard(
  resolved: Resolved,
  data: WidgetData,
  options: RenderOptions = {},
): ReactNode {
  const page = defaultPageOf(resolved)
  return h(
    'div',
    { id: 'neo-root-content' },
    page === undefined
      ? placeholder('No pages configured yet.')
      : board(page, resolved, data, options),
  )
}
