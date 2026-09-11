import { createElement as h, type ReactNode } from 'react'
import type { ProjectionEnvelope } from '@neohomepage/catalog-schema'
import type { Resolved, ResolvedPage, ResolvedWidget } from './resolved.ts'

/**
 * The board, rendered identically at publish time and in the browser.
 *
 * One component tree, two entry points: `renderToStaticMarkup` bakes it into a generation and the
 * SPA renders the same thing when it takes over. Two implementations would drift, and the drift
 * would show as the page visibly changing the moment JavaScript loads.
 *
 * Written with `createElement` rather than JSX on purpose. Node executes TypeScript by stripping
 * types, not by transforming code, and it cannot load `.tsx` at all — so any JSX here would force
 * a build step for the server and give up the property that publishing is a function call. The
 * editor is free to use JSX; it only ever runs through Vite.
 *
 * Positioning comes entirely from the emitted stylesheet: no grid library on this page, no
 * measurement pass. Each tile carries `data-neo-i`, which is what that CSS targets.
 */

export type WidgetData = Readonly<Record<string, ProjectionEnvelope | undefined>>

/**
 * A formatted time arrives as `{v, iso}` rather than a string, so a page baked three hours ago
 * does not keep insisting an episode airs "in 5 minutes". The rendered text ships for the no-JS
 * case, and the instant ships beside it for the client to re-render from.
 */
function renderValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object' && value !== null && 'v' in value && 'iso' in value) {
    const time = value as { v: string; iso: string }
    return h('time', { dateTime: time.iso, 'data-neo-rel': '' }, time.v)
  }
  return String(value)
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
            // A gauge whose fill is one colour at every level is a picture of a number, not a
            // warning. The thresholds live here rather than in the manifest because "nearly full"
            // means the same thing for a disk, a pool and a memory bar.
            'data-neo-tone': fraction >= 0.9 ? 'bad' : fraction >= 0.75 ? 'warn' : 'ok',
            style: { width: `${(fraction * 100).toFixed(1)}%` },
          }),
        ),
      ])
    }),
  )
}

/** A status pill: up, degraded, down, or nothing known yet. */
function statusBlock(envelope: ProjectionEnvelope): ReactNode {
  const status = envelope.projection?.status ?? 'unknown'
  const label = status === 'ok' ? 'up' : status === 'down' ? 'down' : status
  return h('div', { className: 'nh-status', 'data-neo-status': status, key: 'status' }, [
    h('span', { className: 'nh-status-dot', key: 'dot', 'aria-hidden': 'true' }),
    h('span', { className: 'nh-status-label', key: 'label' }, label),
  ])
}

/**
 * A plain link to the service, for widgets that are a bookmark rather than a reading.
 *
 * The href comes from the resolved widget, not from the projection: a projection exists only after
 * a probe has succeeded, and a bookmark whose service answers `/` with a login redirect, a 401 or a
 * self-signed certificate is still a bookmark. The probe's verdict goes in the tile's chip.
 */
function linkBlock(widget: ResolvedWidget, envelope: ProjectionEnvelope | undefined): ReactNode {
  const first = envelope?.projection?.items?.[0]
  const href = widget.href ?? first?.href
  const label = first?.subtitle ?? widget.title
  return href === undefined
    ? h('p', { className: 'nh-placeholder' }, label)
    : h('a', { className: 'nh-link', href, rel: 'noreferrer' }, label)
}

/**
 * The five presentation templates.
 *
 * Closed on purpose, with an exhaustive switch: this is what fixes the number of React components
 * while leaving the number of integrations unbounded. A manifest that names a template this build
 * does not compile in is refused when the catalog is loaded, not discovered here as a blank tile.
 */
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
  // No envelope means nothing has been fetched yet; a null projection means it was fetched and
  // failed before ever succeeding. Both render as a placeholder, and the tile's chip carries the
  // error code — reading through either one is what crashed the first paint.
  if (envelope === undefined || envelope.projection === null) {
    return h(
      'p',
      { className: 'nh-placeholder' },
      envelope?.meta.errorCode === undefined ? 'No data yet' : 'Unavailable',
    )
  }

  switch (template) {
    case 'stat-grid':
      return (
        statsBlock(envelope, template) ?? h('p', { className: 'nh-placeholder' }, 'No readings')
      )
    case 'list':
      // A keyed array, not a bare one: React cannot reconcile unkeyed siblings, so a tile that
      // gains or loses its stats block would reuse the wrong DOM node for the list. Each block
      // carries a key fixed to its own kind, which is stable because they are only ever siblings.
      return [statsBlock(envelope, template), itemsBlock(envelope)]
    case 'gauge-set':
      return gaugesBlock(envelope) ?? h('p', { className: 'nh-placeholder' }, 'No gauges')
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
    ? // A widget whose type is missing from the catalog renders as a labelled placeholder.
      // Vanishing would read as data loss; this reads as "install something".
      h('p', { className: 'nh-placeholder' }, `Unknown widget type "${widget.type}"`)
    : isTemplate(widget.template)
      ? renderTemplate(widget.template, widget, envelope)
      : h('p', { className: 'nh-placeholder' }, `Unsupported layout "${widget.template}"`)

  return h(
    'article',
    {
      key: widget.id,
      'data-neo-i': widget.id,
      'data-neo-state': state,
      'data-neo-template': widget.template,
      className: 'nh-tile',
      'aria-labelledby': `${widget.id}-title`,
    },
    [
      h('header', { className: 'nh-tile-head', key: 'head' }, [
        h(
          'h2',
          { id: `${widget.id}-title`, className: 'nh-tile-title', key: 'title' },
          widget.title,
        ),
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

export function board(
  page: ResolvedPage,
  widgets: readonly ResolvedWidget[],
  data: WidgetData,
): ReactNode {
  const onPage = widgets.filter((widget) => widget.page === page.id)
  return h(
    'div',
    { className: 'neo-board', 'data-neo-page': page.id },
    // The most-seen screen in the product's life is the one before anybody has added anything,
    // and it used to render as an empty div: a heading over blank space, with nothing naming the
    // round button in the corner as the way in.
    onPage.length === 0
      ? h('div', { className: 'nh-board-empty', key: 'empty' }, [
          h('strong', { key: 'title' }, 'No widgets yet'),
          h(
            'span',
            { key: 'hint' },
            'Open the editor with the button in the bottom-left corner to add your first service.',
          ),
        ])
      : onPage.map((widget) => widgetTile(widget, data[widget.id])),
  )
}

export function dashboard(resolved: Resolved, data: WidgetData): ReactNode {
  const page =
    resolved.pages.find((candidate) => candidate.id === resolved.defaultPage) ?? resolved.pages[0]
  return h('div', { id: 'neo-root-content' }, [
    h(
      'header',
      { className: 'nh-header', key: 'header' },
      h('h1', { className: 'nh-title' }, resolved.title),
    ),
    page === undefined
      ? h('p', { className: 'nh-placeholder', key: 'empty' }, 'No pages configured yet.')
      : h('main', { key: 'main' }, board(page, resolved.widgets, data)),
  ])
}
