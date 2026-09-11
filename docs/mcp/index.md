# Configuring the dashboard with an AI

neohomepage ships an MCP server, so Claude, Codex or any MCP client can add services, move widgets
and publish for you.

## Connecting

```sh
claude mcp add neohomepage -- node /path/to/neohomepage/packages/app/src/cli/neo.ts mcp
```

Then ask for what you want:

> add a Sonarr widget pointing at 10.0.0.20:8989, my key is abc123, and put it top-left

> put a clock and a search box in the header, and a bookmarks section under the grid with my
> router pages in one group and the NAS in another, three groups per row

> copy the colours from apple.com, keep the corners soft, and set it for dark mode too

## The tools

Eighteen, fixed regardless of how big the catalog grows. One tool per widget type was rejected for
measurable reasons: every tool schema is sent on every request, so a large surface is a permanent
token tax, and some clients flatten root-level `anyOf`/`oneOf`, which mangles the obvious
union-over-widget-types design. Every input is a flat object instead, and type safety comes from a
three-step loop the tools advertise: `search_catalog`, `get_widget_schema`, `add_widget`.

| Tool                                             | What it does                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| `describe_dashboard`                             | Pages, widgets, targets, revision, unpublished changes                         |
| `search_catalog`                                 | Find a widget type                                                             |
| `get_widget_schema`                              | The fields a type needs                                                        |
| `list_widgets` / `list_targets`                  | What exists now                                                                |
| `add_target`                                     | Register a service by host and port                                            |
| `add_widget` / `update_widget` / `remove_widget` | Change the board                                                               |
| `set_layout`                                     | Move widgets within one grid section                                           |
| `get_sections` / `set_sections`                  | A page's sections — navbar, grids, bookmarks — read as stored, replaced whole  |
| `add_bookmark`                                   | One link into a bookmarks group, by host and port, creating the group by title |
| `test_target`                                    | Check a service answers                                                        |
| `publish`                                        | Regenerate the static page                                                     |
| `describe_theme`                                 | The current look: palettes, overrides, shape, backdrop, contrast               |
| `search_presets`                                 | The 75 ready-made looks                                                        |
| `set_theme`                                      | Change any of it, in one transaction                                           |

## Designing with an agent

Everything behind the **Design** button is reachable: mode, the 75 presets, the thirteen colour
tokens per scheme, corner radius, border weight, board width, font, tile-title case, backdrop, blur
and dim. So "copy the colours from that site" works — the agent reads the palette with its own
browser and hands over hex; nothing in this server fetches anything.

Two things make that safe to say yes to.

**A palette that arrives from outside is solved, not just stored.** Brand colours are chosen to look
like a brand, not to clear 4.5:1 on an inset grey — Apple's `#86868b` on `#f5f5f7` is 3.33:1. So a
colour change is run against the same WCAG matrix `theme-contrast.test.ts` asserts over the shipped
presets, and any token that fails has its OKLCH _lightness_ walked until it passes. Hue is kept, and
chroma too unless the colour would fall outside sRGB — which is what keeps it recognisably their
blue. Every token that moved comes back in the result with the pair and the ratio that moved it:

```
adjusted: [{ scheme: "light", token: "muted-foreground", from: "#86868b", to: "#707075",
             why: "muted-foreground on muted was 3.33:1, below 4.5:1" }]
```

`fit: "off"` writes the palette exactly as given, `fit: "refuse"` fails rather than write one that
cannot be read, and the contrast verdict comes back either way. `dryRun: true` returns the whole
result — palette, adjustments, verdict — and writes nothing, which is how to try five looks without
spending five generations.

**Light and dark are separate palettes**, and the default mode is `system`, where the page carries
both and each viewer's OS picks. A call sets `colors.light`, `colors.dark`, or both in one
transaction; `describe_theme` reports both and does not pretend to know which one you are looking
at.

## What the AI cannot do

Four absences, and they are the design rather than a permission model:

**It cannot read a secret.** There is no tool at any scope. Tool results land in a model context
that may be sent to a third-party API. An agent can _set_ a credential and reference it; it can
never get one back.

**It cannot name a URL, path, header or method.** It names a widget, or a host and a port. The
request that leaves your network is derived from a manifest — the same rule the browser is held to.

**It cannot author CSS or JavaScript.** Prompt injection reaching a write tool is a real amplifier,
and that is the one sink that would turn it into code execution. The design tools change how the
board looks without ever accepting CSS: every value they write is a member of a closed table this
repository ships, a number in a range, or a colour that was parsed and re-emitted rather than passed
through. That is also why there is no import-a-theme tool — `config/theme.json` round-trips through
the editor's own box, where a person is the one pasting it.

**It cannot add a background image.** It can choose one you uploaded, by the content-addressed id
the server gave it. Uploading is a browser action.

Every change goes through the same transaction the UI uses, is recorded in `config/.audit.jsonl`
attributed to the agent, and cuts a generation — so "the AI rewrote my dashboard" is
`neo generations rollback`, not a support ticket.
