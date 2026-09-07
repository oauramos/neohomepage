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
  const stats = envelope.projection.stats
  if (stats === undefined || stats.length === 0) return null
  return h(
    'dl',
    { className: 'nh-stats', 'data-neo-template': template },
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
  const items = envelope.projection.items
  if (items === undefined || items.length === 0) return null
  return h(
    'ul',
    { className: 'nh-items' },
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
  const gauges = envelope.projection.gauges
  if (gauges === undefined || gauges.length === 0) return null
  return h(
    'div',
    { className: 'nh-gauges' },
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
            style: { width: `${(fraction * 100).toFixed(1)}%` },
          }),
        ),
      ])
    }),
  )
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
    : envelope === undefined
      ? h('p', { className: 'nh-placeholder' }, 'No data yet')
      : [statsBlock(envelope, widget.template), gaugesBlock(envelope), itemsBlock(envelope)]

  return h(
    'article',
    {
      key: widget.id,
      'data-neo-i': widget.id,
      'data-neo-state': state,
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
    onPage.map((widget) => widgetTile(widget, data[widget.id])),
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
