import { defineConfig } from 'vitepress'

/**
 * The site is served from a project page — `oauramos.github.io/neohomepage/` — so every asset URL
 * needs that prefix or the page loads with no stylesheet and no script. It does not fail loudly:
 * the HTML returns 200 and the browser 404s each asset separately.
 *
 * Overridable, so pointing a custom domain at this later is an environment variable in one
 * workflow rather than an edit here.
 */
const base = process.env.DOCS_BASE ?? '/neohomepage/'

export default defineConfig({
  base,
  title: 'neohomepage',
  description: 'A self-hosted homepage dashboard you edit in the browser, not in YAML.',
  lang: 'en-US',
  cleanUrls: true,
  // localhost URLs in the install guide are instructions, not links to check.
  ignoreDeadLinks: [/^https?:\/\/localhost/],
  lastUpdated: true,
  themeConfig: {
    nav: [
      { text: 'Install', link: '/install' },
      { text: 'Guide', link: '/guide/' },
      { text: 'Widgets', link: '/widgets/' },
      { text: 'MCP', link: '/mcp/' },
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'What it is', link: '/' },
          { text: 'Install', link: '/install' },
        ],
      },
      {
        text: 'Guide',
        items: [
          { text: 'Sections', link: '/guide/sections' },
          { text: 'Backup and restore', link: '/guide/backup' },
          { text: 'Signing in', link: '/guide/auth' },
          { text: 'Configuring with an AI', link: '/mcp/' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Memory', link: '/architecture/memory' },
          { text: 'The container', link: '/architecture/container' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/oauramos/neohomepage' }],
    footer: { message: 'Released under the MIT License.' },
  },
})
