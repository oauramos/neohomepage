import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { getCompactor } from 'react-grid-layout/core'
import type { EventCallback, Layout } from 'react-grid-layout'
import type { LayoutItem } from '../../shared/grid-geometry.ts'
import type { ResolvedGridSection, ResolvedWidget } from '../../shared/resolved.ts'

/**
 * Edit mode.
 *
 * react-grid-layout is loaded lazily and ONLY here. The published page positions itself with CSS
 * and ships no grid library at all; pulling ~40 KB of drag machinery into a dashboard that is
 * usually just being looked at would be paying for the editor on every page view.
 *
 * Two rules keep the git history clean, and both are about what NOT to persist:
 *
 * Geometry is saved on drag-stop and resize-stop, never from `onLayoutChange`. RGL fires that for
 * machine-generated layouts on every window resize, so persisting it would rewrite a git-tracked
 * file each time someone opened the dashboard on a phone.
 *
 * Only the breakpoint being edited is written, and it is marked `authored`. The others stay
 * derived and are regenerated from the authoritative tier.
 */

const ResponsiveGrid = lazy(async () => {
  const module = await import('react-grid-layout')
  return { default: module.Responsive }
})

export type GridEditorProps = {
  /** One grid section: its own columns and row cap, edited as a board of its own. */
  readonly section: ResolvedGridSection
  /** The layouts being edited — a draft the page holds, not what is saved. */
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
  const page = section
  const container = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  const [breakpoint, setBreakpoint] = useState(page.grid.authoritative)

  /**
   * Measure before mounting.
   *
   * RGL v2 requires an explicit width, and mounting with a guessed one makes every item jump on
   * the first real measurement — which reads as the board rearranging itself the moment you enter
   * edit mode.
   */
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
    page.grid.breakpoints.map((entry) => [entry.id, entry.minWidth]),
  )
  const cols = Object.fromEntries(page.grid.breakpoints.map((entry) => [entry.id, entry.cols]))
  const layouts = Object.fromEntries(
    Object.entries(draft).map(([id, items]) => [id, items.map((item) => ({ ...item }))]),
  )

  // RGL's `Layout` is the ARRAY and `LayoutItem` is one entry — inverted from v1, and a
  // muscle-memory mistake that types silently wrong.
  const commit: EventCallback = (layout: Layout) => {
    onChange(
      breakpoint,
      layout.map((item) => ({ i: item.i, x: item.x, y: item.y, w: item.w, h: item.h })),
    )
  }

  const onPage = widgets.filter((widget) => section.widgetIds.includes(widget.id))

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
        {page.grid.maxRows !== null ? (
          <span className="nh-editor-note">max {page.grid.maxRows} rows</span>
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
            rowHeight={page.grid.rowHeight}
            margin={[...page.grid.margin]}
            containerPadding={[...page.grid.containerPadding]}
            {...(page.grid.maxRows === null ? {} : { maxRows: page.grid.maxRows })}
            // v2 renamed compactType to `compactor` and made it an object from getCompactor.
            // The old string prop is silently ignored, which reads as "compaction is broken".
            compactor={getCompactor('vertical')}
            // v2 groups behaviour into config objects. The v1 props — isDraggable, isResizable,
            // draggableHandle, compactType — are not merely renamed, they are gone, and passing
            // them is silently ignored rather than a type error at every call site.
            dragConfig={{ enabled: true, bounded: false, threshold: 3, handle: '.nh-drag-handle' }}
            resizeConfig={{ enabled: true, handles: ['se'] }}
            onBreakpointChange={(next: string) => setBreakpoint(next)}
            // Deliberately not onLayoutChange: RGL emits that for layouts it generated itself on
            // every window resize, and persisting those dirties a git-tracked file for nothing.
            onDragStop={commit}
            onResizeStop={commit}
          >
            {onPage.map((widget) => (
              <div key={widget.id} data-neo-i={widget.id} className="nh-editor-cell">
                <div className="nh-editor-cell-bar">
                  {/*
                    Drag by a handle, not by the whole tile. react-draggable preventDefaults
                    touchstart, so a full-tile handle means a finger on a widget cannot scroll the
                    page — which makes the dashboard unusable on the phone it is meant for.
                  */}
                  <button
                    type="button"
                    className="nh-drag-handle"
                    aria-label={`Move ${widget.title}`}
                    title="Drag to move"
                  >
                    <span aria-hidden="true">⠿</span>
                  </button>
                  <span className="nh-editor-cell-title">{widget.title}</span>
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
            ))}
          </ResponsiveGrid>
        </Suspense>
      )}
    </div>
  )
}
