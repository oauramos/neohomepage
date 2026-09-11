import { useId, useState } from 'react'
import type { Field } from '@neohomepage/catalog-schema'

/**
 * Widget form generated from its manifest. Hand-rolled over the closed field-kind union with an
 * exhaustive switch, so adding a kind without a renderer is a type error.
 */

export type FieldValues = Record<string, string | number | boolean | null>

export type FieldFormProps = {
  readonly fields: readonly Field[]
  readonly values: FieldValues
  /** Names already stored, so a secret can say "saved" without its value being sent here. */
  readonly savedSecrets?: readonly string[]
  readonly onChange: (name: string, value: string | number | boolean | null) => void
  readonly disabled?: boolean
}

function Row({ field, id, children }: { field: Field; id: string; children: React.ReactNode }) {
  return (
    <div className="nh-field">
      <label className="nh-field-label" htmlFor={id}>
        {field.label}
        {field.required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {children}
      {field.help !== undefined ? (
        <p className="nh-field-help" id={`${id}-help`}>
          {field.help}
        </p>
      ) : null}
    </div>
  )
}

/**
 * Write-only: a saved secret's value is never sent to the browser, so it shows as "saved" behind a
 * Replace button. A masked placeholder would leak the length and round-trip the credential.
 */
function SecretInput({
  field,
  id,
  saved,
  disabled,
  onChange,
}: {
  field: Field
  id: string
  saved: boolean
  disabled: boolean
  onChange: (value: string | null) => void
}) {
  const [replacing, setReplacing] = useState(!saved)

  if (saved && !replacing) {
    return (
      <div className="nh-field-saved">
        <span className="nh-field-saved-note">•••• saved</span>
        <button type="button" className="nh-button-quiet" onClick={() => setReplacing(true)}>
          Replace
        </button>
      </div>
    )
  }

  return (
    <input
      id={id}
      className="nh-input"
      type="password"
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
      placeholder={saved ? 'enter a new value' : field.help}
      aria-describedby={field.help === undefined ? undefined : `${id}-help`}
      onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
    />
  )
}

export function FieldForm({
  fields,
  values,
  savedSecrets = [],
  onChange,
  disabled = false,
}: FieldFormProps) {
  const prefix = useId()

  return (
    <div className="nh-form">
      {fields.map((field) => {
        const id = `${prefix}-${field.name}`
        const value = values[field.name]
        const describedBy = field.help === undefined ? undefined : `${id}-help`

        switch (field.kind) {
          case 'secret':
            return (
              <Row field={field} id={id} key={field.name}>
                <SecretInput
                  field={field}
                  id={id}
                  saved={savedSecrets.includes(field.name)}
                  disabled={disabled}
                  onChange={(next) => onChange(field.name, next)}
                />
              </Row>
            )

          case 'boolean':
            return (
              <Row field={field} id={id} key={field.name}>
                <input
                  id={id}
                  className="nh-checkbox"
                  type="checkbox"
                  disabled={disabled}
                  checked={value === true}
                  aria-describedby={describedBy}
                  onChange={(event) => onChange(field.name, event.target.checked)}
                />
              </Row>
            )

          case 'enum':
            return (
              <Row field={field} id={id} key={field.name}>
                <select
                  id={id}
                  className="nh-input"
                  disabled={disabled}
                  value={typeof value === 'string' ? value : ''}
                  aria-describedby={describedBy}
                  onChange={(event) => onChange(field.name, event.target.value)}
                >
                  <option value="">—</option>
                  {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </Row>
            )

          case 'integer':
          case 'number':
          case 'duration': {
            const min = field.kind === 'duration' ? (field.min ?? 1) : field.min
            return (
              <Row field={field} id={id} key={field.name}>
                <input
                  id={id}
                  className="nh-input"
                  type="number"
                  disabled={disabled}
                  step={field.kind === 'number' ? 'any' : 1}
                  {...(min === undefined ? {} : { min })}
                  {...(field.max === undefined ? {} : { max: field.max })}
                  value={typeof value === 'number' ? value : ''}
                  aria-describedby={describedBy}
                  onChange={(event) =>
                    onChange(
                      field.name,
                      event.target.value === '' ? null : Number(event.target.value),
                    )
                  }
                />
              </Row>
            )
          }

          case 'color':
            return (
              <Row field={field} id={id} key={field.name}>
                <input
                  id={id}
                  className="nh-input nh-input-color"
                  type="color"
                  disabled={disabled}
                  value={typeof value === 'string' ? value : '#000000'}
                  aria-describedby={describedBy}
                  onChange={(event) => onChange(field.name, event.target.value)}
                />
              </Row>
            )

          case 'url':
          case 'icon':
          case 'string':
            return (
              <Row field={field} id={id} key={field.name}>
                <input
                  id={id}
                  className="nh-input"
                  type={field.kind === 'url' ? 'url' : 'text'}
                  disabled={disabled}
                  value={typeof value === 'string' ? value : ''}
                  placeholder={field.ui?.placeholder}
                  aria-describedby={describedBy}
                  onChange={(event) => onChange(field.name, event.target.value)}
                />
              </Row>
            )

          default: {
            const exhaustive: never = field.kind
            throw new Error(`unhandled field kind ${String(exhaustive)}`)
          }
        }
      })}
    </div>
  )
}

export function initialValues(fields: readonly Field[]): FieldValues {
  const values: FieldValues = {}
  for (const field of fields) {
    if (field.default !== undefined) values[field.name] = field.default
  }
  return values
}
