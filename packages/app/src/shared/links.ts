export type LinkBase = {
  readonly scheme: 'http' | 'https'
  readonly host: string
  readonly port: number
}

/**
 * Composes a bookmark href. Config never holds a whole URL, only scheme, host, port and path;
 * default ports are omitted from the result.
 */
export function composeHref(base: LinkBase, path: string): string {
  const defaultPort = base.scheme === 'https' ? 443 : 80
  const authority = base.port === defaultPort ? base.host : `${base.host}:${String(base.port)}`
  const suffix = path.startsWith('/') ? path : `/${path}`
  return `${base.scheme}://${authority}${suffix}`
}

/** Closed set: config may name an engine, never a URL. */
export const SEARCH_ENGINES = [
  'duckduckgo',
  'google',
  'bing',
  'brave',
  'startpage',
  'kagi',
] as const
export type SearchEngine = (typeof SEARCH_ENGINES)[number]

export const SEARCH_ACTIONS: Readonly<Record<SearchEngine, string>> = {
  duckduckgo: 'https://duckduckgo.com/',
  google: 'https://www.google.com/search',
  bing: 'https://www.bing.com/search',
  brave: 'https://search.brave.com/search',
  startpage: 'https://www.startpage.com/do/search',
  kagi: 'https://kagi.com/search',
}
