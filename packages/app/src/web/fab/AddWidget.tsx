import { useEffect, useState } from 'react'
import type { Field } from '@neohomepage/catalog-schema'
import type { BindableRole, ManifestView } from '../../shared/manifest-view.ts'
import { FieldForm, initialValues, type FieldValues } from '../form/FieldForm.tsx'

/** Add a widget: pick from the catalog, fill in the manifest-generated form, test, save. */

type CatalogEntry = {
  id: string
  displayName: string
  category: string
  /** widget | bookmark | tool. */
  kind: string
  icon: string
  iconUrl?: string | null
  template: string
  shape: 'single' | 'composite'
  needsCredential: boolean
  someKindsNeedNoCredential: boolean
}

export type { CatalogEntry }

/**
 * One source being bound into a role. Held as UI state rather than written to config so no target
 * (and its API key) exists on disk until the whole form is saved.
 */
type DraftSource = {
  readonly uid: string
  kind: string
  host: string
  port: string
  scheme: string
  basePath: string
  values: FieldValues
  test: TestResult | null
}

let nextDraftUid = 0

type Where = { scheme: string; host: string; port: string; basePath: string }

type TestResult = { ok: boolean; durationMs: number; code?: string; message?: string }

const describeTest = (result: TestResult) =>
  result.ok
    ? `Connected in ${result.durationMs}ms`
    : `Could not connect: ${result.code ?? 'unknown'}`

export type AddWidgetProps = {
  /** Fetched once by the panel: null while loading, empty when the catalog could not be read. */
  readonly entries: readonly CatalogEntry[] | null
  readonly onAdded: () => void
  /** Narrow the catalog to one kind; absent shows everything. */
  readonly kind?: string
  /** The search text, owned by the panel so the box can sit above the widget list. */
  readonly query: string
  /** Called when the form opens or closes, so the panel can hide the list behind it. */
  readonly onEditing?: (editing: boolean) => void
  /** Called when the user backs out of the catalog without choosing. */
  readonly onCancel?: () => void
}

export function AddWidget({ entries, onAdded, kind, query, onEditing, onCancel }: AddWidgetProps) {
  const [selected, setSelected] = useState<ManifestView | null>(null)
  const [target, setTarget] = useState({ host: '', port: '', scheme: 'http', basePath: '' })
  const [targetValues, setTargetValues] = useState<FieldValues>({})
  const [configValues, setConfigValues] = useState<FieldValues>({})
  const [test, setTest] = useState<TestResult | null>(null)
  const [sources, setSources] = useState<Record<string, DraftSource[]>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    onEditing?.(selected !== null)
  }, [selected, onEditing])

  const select = async (id: string) => {
    setError(null)
    setTest(null)
    let schema: ManifestView
    try {
      const response = await fetch(`/api/catalog/${id}/schema`)
      if (!response.ok) {
        setError('that widget type is not available')
        return
      }
      schema = (await response.json()) as ManifestView
    } catch {
      setError('The server did not answer.')
      return
    }
    setSelected(schema)
    setTargetValues(initialValues(schema.target?.fields ?? []))
    setConfigValues(initialValues(schema.config))
    // A required role opens with one empty source so the form does not read as broken.
    setSources(
      Object.fromEntries(
        schema.roles.map((role) => [role.name, role.min > 0 ? [emptySource(role)] : []]),
      ),
    )
  }

  function emptySource(role: BindableRole): DraftSource {
    const kind = role.kinds[0]
    return {
      uid: `s${nextDraftUid++}`,
      kind: kind?.name ?? '',
      host: '',
      port: '',
      scheme: 'http',
      basePath: '',
      values: initialValues(kind?.fields ?? []),
      test: null,
    }
  }

  const patchSource = (role: string, uid: string, patch: Partial<DraftSource>) => {
    setSources((prev) => ({
      ...prev,
      [role]: (prev[role] ?? []).map((one) => (one.uid === uid ? { ...one, ...patch } : one)),
    }))
  }

  const splitValues = (fields: readonly Field[], values: FieldValues) => {
    const secrets: Record<string, string> = {}
    const plain: Record<string, string | number | boolean> = {}
    for (const field of fields) {
      const value = values[field.name]
      if (value === null || value === undefined) continue
      if (field.kind === 'secret') secrets[field.name] = String(value)
      else plain[field.name] = value
    }
    return { secrets, plain }
  }

  // Fields are named explicitly: spreading a draft source here once leaked its API key into
  // config/ in plaintext, because `base` accepted unknown keys.
  const baseOf = (where: Where) => ({
    scheme: where.scheme,
    host: where.host,
    port: Number(where.port),
    basePath: where.basePath,
  })

  const probe = async (
    type: string,
    where: Where,
    fields: readonly Field[],
    values: FieldValues,
    kind?: string,
  ): Promise<TestResult> => {
    const { secrets, plain } = splitValues(fields, values)
    const response = await fetch('/api/targets/test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type,
        ...(kind === undefined ? {} : { kind }),
        base: baseOf(where),
        config: configValues,
        fields: plain,
        secrets,
      }),
    })
    return (await response.json()) as TestResult
  }

  const runTest = async () => {
    if (selected === null || selected.target === null) return
    setBusy(true)
    setError(null)
    try {
      setTest(await probe(selected.id, target, selected.target.fields, targetValues))
    } catch {
      setError('The server did not answer.')
    } finally {
      setBusy(false)
    }
  }

  const testSource = async (role: BindableRole, source: DraftSource) => {
    if (selected === null) return
    const kind = role.kinds.find((one) => one.name === source.kind)
    if (kind === undefined) return
    setBusy(true)
    try {
      patchSource(role.name, source.uid, {
        test: await probe(selected.id, source, kind.fields, source.values, source.kind),
      })
    } catch {
      setError('The server did not answer.')
    } finally {
      setBusy(false)
    }
  }

  /** Create one target and return its id, or null with the error already reported. */
  const createTarget = async (
    label: string,
    widgetType: string,
    where: Where,
    values: FieldValues,
  ): Promise<string | null> => {
    const response = await fetch('/api/targets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label,
        widgetType,
        base: baseOf(where),
        // Unsplit: the server decides which values are secrets from the manifest.
        values,
      }),
    })
    if (!response.ok) {
      setError(((await response.json()) as { error?: string }).error ?? 'could not save the target')
      return null
    }
    return ((await response.json()) as { id: string }).id
  }

  const createWidget = async (body: {
    type: string
    targetId?: string | null
    bindings?: Record<string, string[]>
    config: FieldValues
  }) => {
    const created = await fetch('/api/widgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!created.ok) {
      setError(((await created.json()) as { error?: string }).error ?? 'could not add the widget')
      return false
    }
    const result = (await created.json()) as { refusedBreakpoints?: string[] }
    if (result.refusedBreakpoints !== undefined && result.refusedBreakpoints.length > 0) {
      // maxRows refused a tier; say so rather than let the widget be missing on some screen sizes.
      setError(`added, but there was no room on: ${result.refusedBreakpoints.join(', ')}`)
    }
    return true
  }

  const save = async () => {
    if (selected === null) return
    setBusy(true)
    setError(null)
    try {
      if (selected.shape === 'composite') {
        const bindings: Record<string, string[]> = {}
        for (const role of selected.roles) {
          const drafts = (sources[role.name] ?? []).filter(
            (one) => one.host !== '' && one.port !== '',
          )
          if (drafts.length < role.min) {
            setError(`${role.label} needs at least ${role.min} source`)
            return
          }
          const ids: string[] = []
          for (const draft of drafts) {
            const kind = role.kinds.find((one) => one.name === draft.kind)
            if (kind === undefined) continue
            const id = await createTarget(kind.label, draft.kind, draft, draft.values)
            // A widget bound to only some of the entered sources would look like it worked.
            if (id === null) return
            ids.push(id)
          }
          bindings[role.name] = ids
        }
        if (!(await createWidget({ type: selected.id, bindings, config: configValues }))) return
        setSelected(null)
        onAdded()
        return
      }

      let targetId: string | null = null
      if (target.host !== '' && target.port !== '') {
        targetId = await createTarget(selected.displayName, selected.id, target, targetValues)
        if (targetId === null) return
      }

      if (!(await createWidget({ type: selected.id, targetId, config: configValues }))) return
      setSelected(null)
      onAdded()
    } catch {
      setError('The server did not answer.')
    } finally {
      setBusy(false)
    }
  }

  if (entries === null) return <p className="nh-panel-note">Loading the catalog…</p>

  if (selected === null) {
    const visible = entries.filter(
      (entry) =>
        (kind === undefined || entry.kind === kind) &&
        `${entry.displayName} ${entry.category}`.toLowerCase().includes(query.toLowerCase()),
    )
    return (
      <div className="nh-catalog">
        {error !== null ? (
          <p className="nh-test-result" data-neo-ok={false}>
            {error}
          </p>
        ) : null}
        {visible.length === 0 ? (
          <p className="nh-panel-note">
            {entries.length === 0
              ? 'No widgets available. The catalog could not be read.'
              : // With an empty search it is the kind filter, not the search, that excluded
                // everything.
                query.trim() === '' && kind !== undefined
                ? `The catalog has no ${kind}s yet.`
                : 'Nothing matches that search.'}
          </p>
        ) : (
          <ul className="nh-catalog-list">
            {visible.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="nh-catalog-item"
                  onClick={() => void select(entry.id)}
                >
                  {entry.iconUrl ? (
                    <img
                      className="nh-catalog-icon"
                      src={entry.iconUrl}
                      alt=""
                      width={28}
                      height={28}
                    />
                  ) : (
                    <span className="nh-catalog-icon nh-catalog-glyph" aria-hidden="true">
                      {entry.displayName.charAt(0)}
                    </span>
                  )}
                  <span className="nh-catalog-text">
                    <span className="nh-catalog-name">{entry.displayName}</span>
                    <span className="nh-catalog-meta">{entry.category}</span>
                  </span>
                  {entry.needsCredential ? (
                    <span className="nh-badge" title="Needs an API key or a password">
                      {entry.someKindsNeedNoCredential ? 'key · some' : 'key'}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        )}
        {onCancel === undefined ? null : (
          <button type="button" className="nh-button-quiet" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="nh-add">
      <div className="nh-add-head">
        <button
          type="button"
          className="nh-button-quiet"
          onClick={() => {
            setSelected(null)
            setError(null)
          }}
        >
          ← Back
        </button>
        <span className="nh-add-title">
          <strong>Add {selected.displayName}</strong>
          <span className="nh-panel-dim">
            Step 2 of 2 ·{' '}
            {selected.target === null && selected.shape === 'single' ? 'options' : 'connect it'}
          </span>
        </span>
      </div>

      {selected.shape === 'composite'
        ? selected.roles.map((role) => {
            const drafts = sources[role.name] ?? []
            return (
              <fieldset className="nh-fieldset" key={role.name}>
                <legend>{role.label}</legend>
                {role.help === undefined ? null : <p className="nh-field-help">{role.help}</p>}

                {drafts.map((draft, index) => {
                  const kind = role.kinds.find((one) => one.name === draft.kind)
                  return (
                    <div className="nh-source" key={draft.uid}>
                      <div className="nh-source-head">
                        <span className="nh-source-index">{index + 1}</span>
                        <select
                          className="nh-input"
                          aria-label={`Source ${index + 1} type`}
                          disabled={busy}
                          value={draft.kind}
                          onChange={(event) => {
                            const next = role.kinds.find((one) => one.name === event.target.value)
                            // Fields belong to the kind, so switching kind resets them.
                            patchSource(role.name, draft.uid, {
                              kind: event.target.value,
                              values: initialValues(next?.fields ?? []),
                              test: null,
                            })
                          }}
                        >
                          {role.kinds.map((one) => (
                            <option key={one.name} value={one.name}>
                              {one.label}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="nh-button-quiet"
                          disabled={busy || drafts.length <= role.min}
                          onClick={() =>
                            setSources((prev) => ({
                              ...prev,
                              [role.name]: (prev[role.name] ?? []).filter(
                                (one) => one.uid !== draft.uid,
                              ),
                            }))
                          }
                        >
                          Remove
                        </button>
                      </div>

                      <div className="nh-form">
                        <div className="nh-field">
                          <label className="nh-field-label" htmlFor={`${draft.uid}-host`}>
                            Host
                          </label>
                          <input
                            id={`${draft.uid}-host`}
                            className="nh-input"
                            value={draft.host}
                            placeholder="10.0.0.20"
                            disabled={busy}
                            onChange={(event) =>
                              patchSource(role.name, draft.uid, { host: event.target.value })
                            }
                          />
                        </div>
                        <div className="nh-field">
                          <label className="nh-field-label" htmlFor={`${draft.uid}-port`}>
                            Port
                          </label>
                          <input
                            id={`${draft.uid}-port`}
                            className="nh-input"
                            type="number"
                            value={draft.port}
                            placeholder="8989"
                            disabled={busy}
                            onChange={(event) =>
                              patchSource(role.name, draft.uid, { port: event.target.value })
                            }
                          />
                        </div>
                        <div className="nh-field">
                          <label className="nh-field-label" htmlFor={`${draft.uid}-path`}>
                            Path
                          </label>
                          <input
                            id={`${draft.uid}-path`}
                            className="nh-input"
                            value={draft.basePath}
                            placeholder="/calendar.ics"
                            disabled={busy}
                            aria-describedby={`${draft.uid}-path-help`}
                            onChange={(event) =>
                              patchSource(role.name, draft.uid, { basePath: event.target.value })
                            }
                          />
                          <p className="nh-field-help" id={`${draft.uid}-path-help`}>
                            The feed path for an iCalendar source; leave empty for the others.
                          </p>
                        </div>
                      </div>

                      {kind === undefined || kind.fields.length === 0 ? null : (
                        <FieldForm
                          fields={kind.fields}
                          values={draft.values}
                          disabled={busy}
                          onChange={(name, value) =>
                            patchSource(role.name, draft.uid, {
                              values: { ...draft.values, [name]: value },
                              test: null,
                            })
                          }
                        />
                      )}

                      <div className="nh-source-actions">
                        <button
                          type="button"
                          className="nh-button-quiet"
                          disabled={busy || draft.host === '' || draft.port === ''}
                          onClick={() => void testSource(role, draft)}
                        >
                          Test this source
                        </button>
                        {draft.test === null ? null : (
                          <span className="nh-test-result" data-neo-ok={draft.test.ok}>
                            {describeTest(draft.test)}
                          </span>
                        )}
                      </div>
                    </div>
                  )
                })}

                <button
                  type="button"
                  className="nh-button-quiet"
                  disabled={busy || drafts.length >= role.max}
                  onClick={() =>
                    setSources((prev) => ({
                      ...prev,
                      [role.name]: [...(prev[role.name] ?? []), emptySource(role)],
                    }))
                  }
                >
                  {drafts.length >= role.max ? `Up to ${role.max} sources` : '+ Add a source'}
                </button>
              </fieldset>
            )
          })
        : null}

      {selected.shape === 'single' && selected.target !== null ? (
        <fieldset className="nh-fieldset">
          <legend>Where it lives</legend>
          <div className="nh-form">
            <div className="nh-field">
              <label className="nh-field-label" htmlFor="neo-add-host">
                Host
              </label>
              <input
                id="neo-add-host"
                className="nh-input"
                value={target.host}
                placeholder="10.0.0.20"
                disabled={busy}
                onChange={(event) => setTarget({ ...target, host: event.target.value })}
              />
            </div>
            <div className="nh-field">
              <label className="nh-field-label" htmlFor="neo-add-port">
                Port
              </label>
              <input
                id="neo-add-port"
                className="nh-input"
                type="number"
                value={target.port}
                placeholder="8989"
                disabled={busy}
                onChange={(event) => setTarget({ ...target, port: event.target.value })}
              />
            </div>
          </div>
          <FieldForm
            fields={selected.target.fields}
            values={targetValues}
            disabled={busy}
            onChange={(name, value) => setTargetValues((prev) => ({ ...prev, [name]: value }))}
          />
        </fieldset>
      ) : null}

      {selected.config.length > 0 ? (
        <fieldset className="nh-fieldset">
          <legend>Options</legend>
          <FieldForm
            fields={selected.config}
            values={configValues}
            disabled={busy}
            onChange={(name, value) => setConfigValues((prev) => ({ ...prev, [name]: value }))}
          />
        </fieldset>
      ) : null}

      {test !== null ? (
        <p className="nh-test-result" data-neo-ok={test.ok}>
          {describeTest(test)}
        </p>
      ) : null}
      {error !== null ? (
        <p className="nh-test-result" data-neo-ok={false}>
          {error}
        </p>
      ) : null}

      <div className="nh-add-actions">
        {selected.shape === 'single' ? (
          <button
            type="button"
            className="nh-button-quiet"
            disabled={busy}
            onClick={() => void runTest()}
          >
            Test connection
          </button>
        ) : null}
        <button type="button" className="nh-button" disabled={busy} onClick={() => void save()}>
          Add widget
        </button>
      </div>
    </div>
  )
}
