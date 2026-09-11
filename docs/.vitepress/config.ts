import { defineConfig } from 'vitepress'

// Served from a project page, so asset URLs need the prefix or the page loads with no assets.
// DOCS_BASE lets a custom domain override it from the workflow.
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
