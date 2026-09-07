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
  icon: string
  template: string
  needsCredential: boolean
}

type WidgetSchema = {
  id: string
  displayName: string
  target: { fields: Field[]; authKind: string }
  config: Field[]
  operations: string[]
}

type TestResult = { ok: boolean; durationMs: number; code?: string; message?: string }

export function AddWidget({ onAdded }: { onAdded: () => void }) {
  const [entries, setEntries] = useState<CatalogEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<WidgetSchema | null>(null)
  const [target, setTarget] = useState({ host: '', port: '', scheme: 'http', basePath: '' })
  const [targetValues, setTargetValues] = useState<FieldValues>({})
  const [configValues, setConfigValues] = useState<FieldValues>({})
  const [test, setTest] = useState<TestResult | null>(null)
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
    setTargetValues(initialValues(schema.target.fields))
    setConfigValues(initialValues(schema.config))
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
    if (selected === null) return
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

  const save = async () => {
    if (selected === null) return
    setBusy(true)
    setError(null)
    try {
      const { secrets, plain } = splitValues(selected.target.fields, targetValues)
      const needsTarget = target.host !== '' && target.port !== ''

      let targetId: string | null = null
      if (needsTarget) {
        const response = await fetch('/api/targets', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            label: selected.displayName,
            widgetType: selected.id,
            base: { ...target, port: Number(target.port) },
            fields: plain,
            secrets,
          }),
        })
        if (!response.ok) {
          setError(
            ((await response.json()) as { error?: string }).error ?? 'could not save the target',
          )
          return
        }
        targetId = ((await response.json()) as { id: string }).id
      }

      const created = await fetch('/api/widgets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: selected.id, targetId, config: configValues }),
      })
      if (!created.ok) {
        setError(((await created.json()) as { error?: string }).error ?? 'could not add the widget')
        return
      }

      const result = (await created.json()) as { refusedBreakpoints?: string[] }
      if (result.refusedBreakpoints !== undefined && result.refusedBreakpoints.length > 0) {
        // maxRows refused a tier. Saying so beats a widget that silently exists on some screen
        // sizes and not others.
        setError(`added, but there was no room on: ${result.refusedBreakpoints.join(', ')}`)
      }
      setSelected(null)
      onAdded()
    } finally {
      setBusy(false)
    }
  }

  if (entries === null) return <p className="nh-panel-note">Loading the catalog…</p>

  if (selected === null) {
    const visible = entries.filter((entry) =>
      `${entry.displayName} ${entry.category}`.toLowerCase().includes(query.toLowerCase()),
    )
    return (
      <div className="nh-catalog">
        <input
          className="nh-input"
          type="search"
          placeholder="Search widgets"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {visible.length === 0 ? (
          <p className="nh-panel-note">
            {entries.length === 0
              ? 'No widgets available. The catalog could not be read.'
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
                    {entry.needsCredential ? ' · needs an API key' : ''}
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
        <button
          type="button"
          className="nh-button-quiet"
          disabled={busy}
          onClick={() => void runTest()}
        >
          Test connection
        </button>
        <button type="button" className="nh-button" disabled={busy} onClick={() => void save()}>
          Add widget
        </button>
      </div>
    </div>
  )
}
