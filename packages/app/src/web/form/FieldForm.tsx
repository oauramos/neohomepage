import { useId, useState } from 'react'
import type { Field } from '@neohomepage/catalog-schema'

/**
 * The form for a widget, generated from its manifest.
 *
 * Hand-rolled over a CLOSED field-kind union with an exhaustive switch, rather than a JSON Schema
 * form library. The union is the point: the same declaration validates the file on disk, types the
 * MCP tool and draws this, and adding a kind without teaching every consumer about it is a type
 * error rather than a blank input nobody notices.
 *
 * The rejected alternatives, briefly: RJSF drags lodash, prop-types and Ajv into the browser
 * bundle and needs a second config surface (uiSchema) that we would generate from the manifest
 * anyway; AutoForm has been frozen since 2024; JSONForms ships no shadcn renderers.
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
 * A secret input is structurally write-only.
 *
 * The value is never sent to the browser, so an already-saved credential shows as "saved" behind
 * a Replace button rather than as a masked string of the right length. A masked value is a lie
 * that leaks the length, and re-submitting it would round-trip a credential through a page.
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
            return (
              <Row field={field} id={id} key={field.name}>
                <input
                  id={id}
                  className="nh-input"
                  type="number"
                  disabled={disabled}
                  step={field.kind === 'integer' ? 1 : 'any'}
                  {...(field.min === undefined ? {} : { min: field.min })}
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

          case 'duration':
            return (
              <Row field={field} id={id} key={field.name}>
                <input
                  id={id}
                  className="nh-input"
                  type="number"
                  min={1}
                  disabled={disabled}
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
            // Adding a field kind without teaching this renderer about it is a compile error, not
            // a silently missing input.
            const exhaustive: never = field.kind
            throw new Error(`unhandled field kind ${String(exhaustive)}`)
          }
        }
      })}
    </div>
  )
}

/** Defaults for a field set, so a fresh form is populated the way the manifest intends. */
export function initialValues(fields: readonly Field[]): FieldValues {
  const values: FieldValues = {}
  for (const field of fields) {
    if (field.default !== undefined) values[field.name] = field.default
  }
  return values
}
