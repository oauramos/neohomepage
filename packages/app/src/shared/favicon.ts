/**
 * The tab icon, inline.
 *
 * A data URI rather than a file, because every page load was fetching `/favicon.ico` and getting
 * a 404 — a wasted request and a console error on a page whose whole point is being opened fifty
 * times a day. Inline also means the icon survives the fallback path, where no static assets are
 * being served at all.
 *
 * Four tiles on a dark ground: the board, at 16 pixels.
 */
export const FAVICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
  '<rect width="32" height="32" rx="7" fill="#0f172a"/>' +
  '<rect x="6" y="6" width="9" height="9" rx="2.5" fill="#38bdf8"/>' +
  '<rect x="17" y="6" width="9" height="9" rx="2.5" fill="#64748b"/>' +
  '<rect x="6" y="17" width="9" height="9" rx="2.5" fill="#64748b"/>' +
  '<rect x="17" y="17" width="9" height="9" rx="2.5" fill="#38bdf8"/>' +
  '</svg>'

/** Percent-encoded just enough to be a legal attribute value in both HTML and an href. */
export const FAVICON_HREF = `data:image/svg+xml,${FAVICON_SVG.replace(/#/g, '%23').replace(/"/g, "'").replace(/</g, '%3C').replace(/>/g, '%3E')}`

export const FAVICON_LINK = `<link rel="icon" href="${FAVICON_HREF}">`
