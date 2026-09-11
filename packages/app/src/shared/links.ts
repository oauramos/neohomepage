/**
 * Compose the destination of a bookmark from its parts.
 *
 * Config never holds a URL — a link is a scheme, a host, a port and a path, the same decomposition
 * a target uses — so this is the one place those parts become an `href`. Default ports are left
 * out because they would only ever appear in a status bar and read as a mistake there.
 */
export type LinkBase = {
  readonly scheme: 'http' | 'https'
  readonly host: string
  readonly port: number
}

export function composeHref(base: LinkBase, path: string): string {
  const defaultPort = base.scheme === 'https' ? 443 : 80
  const authority = base.port === defaultPort ? base.host : `${base.host}:${String(base.port)}`
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base.scheme}://${authority}${suffix}`
}

/** The search engines a navbar box can send to. Closed: a URL is not something config may name. */
export const SEARCH_ACTIONS = {
  duckduckgo: 'https://duckduckgo.com/',
  google: 'https://www.google.com/search',
  bing: 'https://www.bing.com/search',
  brave: 'https://search.brave.com/search',
  startpage: 'https://www.startpage.com/do/search',
  kagi: 'https://kagi.com/search',
} as const
