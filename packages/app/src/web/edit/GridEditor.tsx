import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { getCompactor } from 'react-grid-layout/core'
import type { EventCallback, Layout } from 'react-grid-layout'
import type { LayoutItem } from '../../shared/grid-geometry.ts'
import { normaliseLayout } from '../../shared/placement.ts'
import type { ResolvedGridSection, ResolvedWidget } from '../../shared/resolved.ts'

/**
 * Edit mode. react-grid-layout is lazy-loaded only here so the published page ships no grid
 * library; only the breakpoint being edited is written (marked `authored`), the rest stay derived.
 */

/**
 * Sizes a tile can be set to from its bar (columns × rows), the only way to size a tile without a
 * pointer; widths past the tier's column count are clamped.
 */
const SIZES: readonly (readonly [number, number])[] = [
  [1, 1],
  [2, 1],
  [2, 2],
  [3, 2],
  [3, 3],
  [4, 2],
  [4, 3],
  [4, 4],
  [6, 3],
  [6, 4],
  [8, 3],
  [12, 3],
]

function sizeOptions(
  cols: number,
  current: readonly [number, number],
): (readonly [number, number])[] {
  const seen = new Set<string>()
  const options: (readonly [number, number])[] = []
  for (const [w, h] of [...SIZES, current]) {
    const clamped = [Math.min(w, cols), h] as const
    const key = `${String(clamped[0])}x${String(clamped[1])}`
    if (seen.has(key)) continue
    seen.add(key)
    options.push(clamped)
  }
  return options.sort((a, b) => a[0] - b[0] || a[1] - b[1])
}

const ResponsiveGrid = lazy(async () => {
  const module = await import('react-grid-layout')
  return { default: module.Responsive }
})

export type GridEditorProps = {
  readonly section: ResolvedGridSection
  /** Draft layouts held by the page, not what is saved. */
  readonly layouts: Readonly<Record<string, readonly LayoutItem[]>>
  readonly widgets: readonly ResolvedWidget[]
  readonly renderWidget: (widget: ResolvedWidget) => React.ReactNode
  /** Called on drag-stop and resize-stop with the tier's new geometry. Saving is the page's call. */
  readonly onChange: (breakpoint: string, items: LayoutItem[]) => void
  readonly onRemove?: (widgetId: string) => void
}

export function GridEditor({
  section,
  layouts: draft,
  widgets,
  renderWidget,
  onChange,
  onRemove,
}: GridEditorProps) {
  const container = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [breakpoint, setBreakpoint] = useState(section.grid.authoritative)

  // RGL v2 requires an explicit width; mounting with a guessed one makes every item jump on the
  // first real measurement.
  useEffect(() => {
    const element = container.current
    if (element === null) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry !== undefined) setWidth(Math.round(entry.contentRect.width))
    })
    observer.observe(element)
    setWidth(Math.round(element.getBoundingClientRect().width))
    return () => observer.disconnect()
  }, [])

  const breakpoints = Object.fromEntries(
    section.grid.breakpoints.map((entry) => [entry.id, entry.minWidth]),
  )
  const cols = Object.fromEntries(section.grid.breakpoints.map((entry) => [entry.id, entry.cols]))
  const layouts = Object.fromEntries(
    Object.entries(draft).map(([id, items]) => [id, items.map((item) => ({ ...item }))]),
  )

  // In RGL v2 `Layout` is the array and `LayoutItem` one entry, inverted from v1.
  const commit: EventCallback = (layout: Layout) => {
    onChange(
      breakpoint,
      layout.map((item) => ({ i: item.i, x: item.x, y: item.y, w: item.w, h: item.h })),
    )
  }

  const inSection = widgets.filter((widget) => section.widgetIds.includes(widget.id))
  const tier = draft[breakpoint] ?? []
  const tierCols = cols[breakpoint] ?? 12

  const resize = (id: string, w: number, h: number) => {
    const next = tier.map((item) => (item.i === id ? { ...item, w, h } : { ...item }))
    onChange(breakpoint, normaliseLayout(next, tierCols))
  }

  return (
    <div
      ref={container}
      className="nh-editor"
      data-neo-editing={breakpoint}
      data-neo-section={section.id}
    >
      <div className="nh-editor-bar">
        <span className="nh-editor-note">
          {section.title === null ? 'Grid' : section.title}: editing <strong>{breakpoint}</strong> (
          {cols[breakpoint] ?? '?'} columns)
        </span>
        {section.grid.maxRows !== null ? (
          <span className="nh-editor-note">max {section.grid.maxRows} rows</span>
        ) : null}
      </div>

      {width === 0 ? (
        <div className="nh-editor-measuring" aria-hidden="true" />
      ) : (
        <Suspense fallback={<div className="nh-editor-measuring">Loading the editor…</div>}>
          <ResponsiveGrid
            width={width}
            breakpoints={breakpoints}
            cols={cols}
            layouts={layouts}
            rowHeight={section.grid.rowHeight}
            margin={[...section.grid.margin]}
            containerPadding={[...section.grid.containerPadding]}
            {...(section.grid.maxRows === null ? {} : { maxRows: section.grid.maxRows })}
            // v2: `compactor` object from getCompactor; the v1 `compactType` string is silently ignored.
            compactor={getCompactor('vertical')}
            // v2 replaced isDraggable/isResizable/draggableHandle with config objects; the v1 props
            // are silently ignored.
            dragConfig={{ enabled: true, bounded: false, threshold: 3, handle: '.nh-drag-handle' }}
            resizeConfig={{ enabled: true, handles: ['se'] }}
            onBreakpointChange={(next: string) => setBreakpoint(next)}
            // Not onLayoutChange: RGL emits that for self-generated layouts on every window resize.
            onDragStop={commit}
            onResizeStop={commit}
          >
            {inSection.map((widget) => {
              const item = tier.find((entry) => entry.i === widget.id)
              const current = [item?.w ?? 4, item?.h ?? 3] as const
              return (
                <div key={widget.id} data-neo-i={widget.id} className="nh-editor-cell">
                  <div className="nh-editor-cell-bar">
                    {/* Handle, not whole tile: react-draggable preventDefaults touchstart, so a
                        full-tile handle would block page scrolling on touch. */}
                    <button
                      type="button"
                      className="nh-drag-handle"
                      aria-label={`Move ${widget.title}`}
                      title="Drag to move"
                    >
                      <span aria-hidden="true">⠿</span>
                    </button>
                    <span className="nh-editor-cell-title">{widget.title}</span>
                    <select
                      className="nh-editor-size"
                      aria-label={`Size of ${widget.title}, columns by rows`}
                      title="Size, columns × rows"
                      value={`${String(current[0])}x${String(current[1])}`}
                      onChange={(event) => {
                        const [w, h] = event.target.value.split('x').map(Number)
                        if (w !== undefined && h !== undefined) resize(widget.id, w, h)
                      }}
                    >
                      {sizeOptions(tierCols, current).map(([w, h]) => (
                        <option
                          key={`${String(w)}x${String(h)}`}
                          value={`${String(w)}x${String(h)}`}
                        >
                          {w}×{h}
                        </option>
                      ))}
                    </select>
                    {onRemove === undefined ? null : (
                      <button
                        type="button"
                        className="nh-editor-remove"
                        aria-label={`Remove ${widget.title}`}
                        onClick={() => onRemove(widget.id)}
                      >
                        <span aria-hidden="true">×</span>
                      </button>
                    )}
                  </div>
                  <div className="nh-editor-cell-body">{renderWidget(widget)}</div>
                </div>
              )
            })}
          </ResponsiveGrid>
        </Suspense>
      )}
    </div>
  )
}
