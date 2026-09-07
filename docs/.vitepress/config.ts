import { defineConfig } from 'vitepress'

export default defineConfig({
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
    ],
    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'What it is', link: '/' },
          { text: 'Install', link: '/install' },
        ],
      },
      { text: 'Guide', items: [{ text: 'Backup and restore', link: '/guide/backup' }] },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/oauramos/neohomepage' }],
    footer: { message: 'Released under the MIT License.' },
  },
})
