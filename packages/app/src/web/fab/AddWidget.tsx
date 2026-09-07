import { useEffect, useState } from 'react'
import type { Field } from '@neohomepage/catalog-schema'
import { FieldForm, initialValues, type FieldValues } from '../form/FieldForm.tsx'

/**
 * Add a widget: browse the catalog, fill in a generated form, test the connection, save.
 *
 * The whole point of the project is that this is the only way anyone needs to add a service. No
 * file is edited, and the form is not written per widget — it comes from the manifest.
 */

type CatalogEntry = {
  id: string
  displayName: string
  category: string
  /** widget | bookmark | tool. Absent on a catalog older than the field, hence the fallback. */
  kind?: string
  icon: string
  template: string
  shape: 'single' | 'composite'
  needsCredential: boolean
  someKindsNeedNoCredential: boolean
}

type BindableKind = {
  name: string
  label: string
  fields: Field[]
  authKind: string
  needsCredential: boolean
}

type BindableRole = {
  name: string
  label: string
  help?: string
  min: number
  max: number
  kinds: BindableKind[]
}

type WidgetSchema = {
  id: string
  displayName: string
  shape: 'single' | 'composite'
  target: { fields: Field[]; authKind: string } | null
  roles: BindableRole[]
  config: Field[]
  operations: string[]
}

/**
 * One source a person is binding into a role: where it is, what shape it is, and its own fields.
 *
 * Held as UI state rather than written straight to config because a calendar with four sources is
 * four targets and one widget, and none of them should exist on disk until the whole form is
 * saved. A half-saved calendar would leave orphan targets carrying API keys.
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

type TestResult = { ok: boolean; durationMs: number; code?: string; message?: string }

export function AddWidget({ onAdded, kind }: { onAdded: () => void; kind?: string }) {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<WidgetSchema | null>(null)
  const [target, setTarget] = useState({ host: '', port: '', scheme: 'http', basePath: '' })
  const [targetValues, setTargetValues] = useState<FieldValues>({})
  const [configValues, setConfigValues] = useState<FieldValues>({})
  const [test, setTest] = useState<TestResult | null>(null)
  const [sources, setSources] = useState<Record<string, DraftSource[]>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetch('/api/catalog')
      .then((response) => response.json() as Promise<{ manifests: CatalogEntry[] }>)
      .then((payload) => setEntries(payload.manifests))
      .catch(() => setEntries([]))
  }, [])

  const select = async (id: string) => {
    setError(null)
    setTest(null)
    const response = await fetch(`/api/catalog/${id}/schema`)
    if (!response.ok) {
      setError('that widget type is not available')
      return
    }
    const schema = (await response.json()) as WidgetSchema
    setSelected(schema)
    setTargetValues(initialValues(schema.target?.fields ?? []))
    setConfigValues(initialValues(schema.config))
    // A composite opens with one empty source per role, because a role with `min: 1` that showed
    // nothing until you found the "Add" button reads as a broken form.
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

  const runTest = async () => {
    if (selected === null || selected.target === null) return
    setBusy(true)
    setError(null)
    try {
      const { secrets, plain } = splitValues(selected.target.fields, targetValues)
      const response = await fetch('/api/targets/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: selected.id,
          base: { ...target, port: Number(target.port) },
          config: configValues,
          fields: plain,
          secrets,
        }),
      })
      setTest((await response.json()) as TestResult)
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
      const { secrets, plain } = splitValues(kind.fields, source.values)
      const response = await fetch('/api/targets/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: selected.id,
          // The kind is what tells the server which source to probe. The browser still names no
          // path and no method — it names a widget type and a shape, exactly as elsewhere.
          kind: source.kind,
          base: {
            scheme: source.scheme,
            host: source.host,
            port: Number(source.port),
            basePath: source.basePath,
          },
          config: configValues,
          fields: plain,
          secrets,
        }),
      })
      patchSource(role.name, source.uid, { test: (await response.json()) as TestResult })
    } finally {
      setBusy(false)
    }
  }

  /** Create one target and return its id, or null with the error already reported. */
  const createTarget = async (
    label: string,
    widgetType: string,
    where: { scheme: string; host: string; port: string; basePath: string },
    values: FieldValues,
  ): Promise<string | null> => {
    const response = await fetch('/api/targets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label,
        widgetType,
        // Named explicitly, never spread from a wider object. Spreading a draft source here once
        // put its API key into config/ in plaintext, because `base` accepted unknown keys.
        base: {
          scheme: where.scheme,
          host: where.host,
          port: Number(where.port),
          basePath: where.basePath,
        },
        // One bag; the server splits it by what the manifest declares a secret. The browser has
        // no business deciding which of these values is a credential.
        values,
      }),
    })
    if (!response.ok) {
      setError(((await response.json()) as { error?: string }).error ?? 'could not save the target')
      return null
    }
    return ((await response.json()) as { id: string }).id
  }

  const createWidget = async (body: Record<string, unknown>) => {
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
      // maxRows refused a tier. Saying so beats a widget that silently exists on some screen
      // sizes and not others.
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
            // Stop on the first failure rather than pressing on: a widget bound to three of the
            // four sources someone entered is worse than none, because it looks like it worked.
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
    } finally {
      setBusy(false)
    }
  }

  if (entries === null) return <p className="nh-panel-note">Loading the catalog…</p>

  if (selected === null) {
    // The kind narrows the catalog to what the open tab is for; the search then narrows that.
    // A manifest with no kind counts as a widget, so an older catalog still offers everything
    // somewhere rather than disappearing.
    const visible = entries.filter(
      (entry) =>
        (kind === undefined || (entry.kind ?? 'widget') === kind) &&
        `${entry.displayName} ${entry.category}`.toLowerCase().includes(query.toLowerCase()),
    )
    return (
      <div className="nh-catalog">
        <input
          className="nh-input"
          type="search"
          // A placeholder is not a label: it disappears the moment you type, and a screen reader
          // announcing "edit text" with no name leaves the one control on this panel unnamed.
          aria-label="Search widgets"
          placeholder="Search widgets"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {visible.length === 0 ? (
          <p className="nh-panel-note">
            {entries.length === 0
              ? 'No widgets available. The catalog could not be read.'
              : // "Nothing matches that search" is wrong when the search is empty and the KIND is
                // what excluded everything — it blames the reader for a filter they did not set.
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
                  <span className="nh-catalog-name">{entry.displayName}</span>
                  <span className="nh-catalog-meta">
                    {entry.category}
                    {entry.needsCredential
                      ? entry.someKindsNeedNoCredential
                        ? ' · some sources need an API key'
                        : ' · needs an API key'
                      : ''}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }

  return (
    <div className="nh-add">
      <div className="nh-add-head">
        <button type="button" className="nh-button-quiet" onClick={() => setSelected(null)}>
          ← Back
        </button>
        <strong>{selected.displayName}</strong>
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
                            // The fields belong to the kind, so switching kind resets them rather
                            // than carrying a Sonarr API key over to an ICS feed that has none.
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
                            {draft.test.ok
                              ? `Connected in ${draft.test.durationMs}ms`
                              : `Could not connect: ${draft.test.code ?? 'unknown'}`}
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
          {test.ok
            ? `Connected in ${test.durationMs}ms`
            : `Could not connect: ${test.code ?? 'unknown'}`}
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
