# Configuring the dashboard with an AI

neohomepage ships an MCP server, so Claude, Codex or any MCP client can add services, move widgets
and publish for you.

## Connecting

```sh
claude mcp add neohomepage -- node /path/to/neohomepage/packages/app/src/cli/neo.ts mcp
```

Then ask for what you want:

> add a Sonarr widget pointing at 10.0.0.20:8989, my key is abc123, and put it top-left

## The tools

Twelve, fixed regardless of how big the catalog grows. One tool per widget type was rejected for
measurable reasons: every tool schema is sent on every request, so a large surface is a permanent
token tax, and some clients flatten root-level `anyOf`/`oneOf`, which mangles the obvious
union-over-widget-types design. Every input is a flat object instead, and type safety comes from a
three-step loop the tools advertise: `search_catalog`, `get_widget_schema`, `add_widget`.

| Tool | What it does |
| --- | --- |
| `describe_dashboard` | Pages, widgets, targets, revision, unpublished changes |
| `search_catalog` | Find a widget type |
| `get_widget_schema` | The fields a type needs |
| `list_widgets` / `list_targets` | What exists now |
| `add_target` | Register a service by host and port |
| `add_widget` / `update_widget` / `remove_widget` | Change the board |
| `set_layout` | Move widgets |
| `test_target` | Check a service answers |
| `publish` | Regenerate the static page |

## What the AI cannot do

Three absences, and they are the design rather than a permission model:

**It cannot read a secret.** There is no tool at any scope. Tool results land in a model context
that may be sent to a third-party API. An agent can *set* a credential and reference it; it can
never get one back.

**It cannot name a URL, path, header or method.** It names a widget, or a host and a port. The
request that leaves your network is derived from a manifest — the same rule the browser is held to.

**It cannot write custom CSS or JavaScript.** Prompt injection reaching a write tool is a real
amplifier, and that is the one sink that would turn it into code execution.

Every change goes through the same transaction the UI uses, is recorded in `config/.audit.jsonl`
attributed to the agent, and cuts a generation — so "the AI rewrote my dashboard" is
`neo generations rollback`, not a support ticket.
