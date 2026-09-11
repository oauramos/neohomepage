import type { Field, Manifest } from '@neohomepage/catalog-schema'
import { isComposite } from '@neohomepage/catalog-schema'

/**
 * Flattens the two manifest shapes into the one description the catalog list, the install form
 * and the MCP schema tool share. Contains no URL, path or header: a client learns a widget needs
 * an API key, never where it is sent.
 */

export type BindableKind = {
  readonly name: string
  readonly label: string
  readonly fields: readonly Field[]
  readonly authKind: string
  readonly needsCredential: boolean
}

export type BindableRole = {
  readonly name: string
  readonly label: string
  readonly help?: string
  readonly min: number
  readonly max: number
  readonly kinds: readonly BindableKind[]
}

export type ManifestView = {
  readonly id: string
  readonly displayName: string
  readonly category: string
  readonly kind: string
  readonly icon: string
  readonly version: string
  readonly template: string
  readonly shape: 'single' | 'composite'
  readonly config: readonly Field[]
  readonly poll: { readonly defaultIntervalMs: number; readonly minIntervalMs: number }
  /** Single-source only: the one target the widget binds, and the operations it will call. */
  readonly target: { readonly fields: readonly Field[]; readonly authKind: string } | null
  readonly operations: readonly string[]
  /** Composite only: the binding slots the installer has to fill. */
  readonly roles: readonly BindableRole[]
  /** True when any bindable surface declares a secret field, so the UI can warn before install. */
  readonly needsCredential: boolean
  /**
   * True when a composite has a kind that needs no credential (e.g. an iCalendar feed), so the UI
   * does not claim an API key is required.
   */
  readonly someKindsNeedNoCredential: boolean
}

const hasSecret = (fields: readonly Field[]) => fields.some((field) => field.kind === 'secret')

export function manifestView(manifest: Manifest): ManifestView {
  const common = {
    id: manifest.id,
    displayName: manifest.displayName,
    category: manifest.category,
    kind: manifest.kind,
    icon: manifest.icon,
    version: manifest.version,
    template: manifest.presentation.template,
    config: manifest.config,
    poll: manifest.poll,
  }

  if (isComposite(manifest)) {
    const roles: BindableRole[] = Object.entries(manifest.roles).map(([name, role]) => ({
      name,
      label: role.label,
      ...(role.help === undefined ? {} : { help: role.help }),
      min: role.min,
      max: role.max,
      kinds: Object.entries(role.kinds).map(([kindName, kind]) => ({
        name: kindName,
        label: kind.label,
        fields: kind.fields,
        authKind: kind.auth.kind,
        needsCredential: hasSecret(kind.fields),
      })),
    }))
    return {
      ...common,
      shape: 'composite',
      target: null,
      operations: [],
      roles,
      needsCredential: roles.some((role) => role.kinds.some((kind) => kind.needsCredential)),
      someKindsNeedNoCredential: roles.some((role) =>
        role.kinds.some((kind) => !kind.needsCredential),
      ),
    }
  }

  return {
    ...common,
    shape: 'single',
    target: { fields: manifest.target.fields, authKind: manifest.target.auth.kind },
    operations: Object.keys(manifest.operations),
    roles: [],
    needsCredential: hasSecret(manifest.target.fields),
    someKindsNeedNoCredential: false,
  }
}
