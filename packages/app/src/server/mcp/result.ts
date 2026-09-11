/** The MCP result envelope: one shape for a value, one for a refusal a caller can read. */

export const ok = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
})

export const fail = (message: string) => ({
  content: [{ type: 'text' as const, text: message }],
  isError: true,
})

export const revisionOption = (input: {
  baseRevision?: string | undefined
}): { baseRevision?: string } =>
  input.baseRevision === undefined ? {} : { baseRevision: input.baseRevision }
