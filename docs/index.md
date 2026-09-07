# neohomepage

A self-hosted start page for your homelab that you configure **in the browser** — not by editing
YAML and restarting a container.

- **Edit everything from the UI.** A button in the bottom-left corner opens the editor: drag
  widgets around, change the theme, set a background, add a service from the catalog by filling in
  a form.
- **Your data is a folder of JSON.** `git init` it, push it, and a restore is `git clone`.
- **Small enough for a 1 GB box.** One Node process, no database, no Redis.
- **Configurable by an AI.** A built-in MCP server lets Claude, Codex or any MCP client add
  widgets and targets for you.

## Status

Early development. See [Install](/install) for how to run it today.
