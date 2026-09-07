# Changelog

## Unreleased

### Themes and the design panel

- **Seven theme presets** — Default, Nord, Terminal, Glass, Brutalist, Amber and Synthwave. A
  preset carries a whole look, not just a hue: corner radius, border weight, elevation, the type
  stack, the tile-title treatment and how a bookmark button is painted. `theme.preset` had been in
  the schema since v1 resolving to nothing; it is now a layer in `resolveTokens`, below `cssVars`,
  so picking one never traps you and clearing an override falls back to the preset.
- **Every preset is checked as maths.** `theme-contrast.test.ts` now runs its full matrix over all
  seven presets in both schemes — every text token against every surface, the accent fill, the
  control border and the focus ring. A preset that fails AA cannot be merged.
- **A design panel**, on a second floating button in the bottom-right. Themes, colour, shape, type
  and backgrounds. All thirteen colour tokens are editable with a native picker and a hex field,
  grouped as Brand / Page / Tiles / Status, each with a reset that is live only where an override
  exists. A hex is converted to OKLCH on the way in, because `contrastRatio` parses nothing else —
  so the panel's live ratios, computed by the same function the test suite asserts with, keep
  working on a colour you picked yourself.
- **Eight generated backgrounds** — mesh, aurora, dusk, spotlight, blueprint, dot matrix, scanlines
  and vignette. Written in CSS in terms of the theme's own tokens, so they recolour with the preset
  and still paint with JavaScript disabled.
- **`PATCH /api/theme`**, the first write path for the theme. Merges per bucket and treats a `null`
  token as a delete, so one slider can move one token and "reset to the preset" is expressible.

### Fixes this surfaced

- `gauge-set` and `status-badge` emitted markup that no stylesheet matched, so two of the five
  presentation templates drew nothing — an empty status dot has no width. Both are styled now, and
  gauges take a severity tone at 75% and 90%.
- `data-neo-tone` on stats and `data-neo-state` on tiles were emitted and never painted. A failing
  tile now carries a coloured rule down its edge instead of differing by an 11px chip.
- The runtime applier iterated `THEME_TOKENS` while the publish step baked more, so shape tokens
  would have applied only after a republish. Both now iterate `ALL_TOKENS`, asserted by the parity
  test.
- A board with no widgets rendered as an empty `div`. It now says so and points at the editor.
- The board had no maximum width, so a four-column tile on an ultrawide became a metre of button.
- `pnpm dev` resolved the catalog against `packages/app`, where no catalog exists, so the editor
  reported that the catalog could not be read.
- The font control never showed which stack was active on six of the seven presets. It compared
  whole stacks for exact equality, and a preset may append families and write its list with spaces;
  it now compares the first family, which is what identifies the choice.
- A nudge made just before picking a preset landed after the switch and wrote itself into the new
  theme — radius 6px inside Terminal, whose own radius is 0. Choosing a preset or a scheme now
  discards anything still queued, because it was aimed at the theme you just left.
- Custom values outlive the preset they were made under, which is right and was invisible: the board
  stopped matching the card you clicked with nothing to explain it. The panel now counts them and
  offers one Clear.
- Every control in the design panel was dead to a drag. They were controlled by the theme returned
  from the server, so each frame re-rendered the input with the previous round trip's value and
  pulled the thumb back under the cursor. The panel now holds its own draft, paints it immediately
  and debounces the write — one drag is one request. An e2e test asserts the input tracks and the
  page is already painted on every frame.
- The error and stale chips painted their tone on an 18% wash of itself — 3.82:1, under AA. axe had
  never seen one because the accessibility board carried no widgets. Both now sit on `muted`, the
  pair the contrast test already proves, and carry the tone as a ring.
- axe now scans all seven presets in both schemes on a board with a bookmark tile, which is what
  caught the two presets whose solid accent fill was painting its label in the fill colour.

## 0.1.0 — first release

The first tagged release. Beta: everything below works and has a check that proves it, but this
has not yet run for a month on someone else's hardware.

### What it is

A self-hosted start page you configure in the browser rather than by editing YAML. One Node
process, no database, ~46 MB resident, a 59 MB image. The dashboard is rendered to static HTML and
served from disk, so the page works with JavaScript disabled and the editor is loaded only when
you open it.

### What is in it

- **Sixteen widgets**, covering all five presentation templates, all five authentication kinds and
  all three response decoders — a coverage footer that CI now enforces rather than prints.
  Sonarr, Radarr, Lidarr, Jellyfin, Plex, qBittorrent, SABnzbd, Pi-hole, AdGuard Home, Uptime
  Kuma, Speedtest Tracker, Proxmox (cluster and node), TrueNAS, Portainer, a unified calendar and
  a link tile.
- **The unified calendar**, which binds any mix of *arr instances and iCalendar feeds into one
  agenda. Recurrence expansion, `EXDATE`, moved instances and timezone conversion happen in the
  decoder; all-day events are anchored at UTC so a feed reads the same everywhere.
- **The editor**: drag and drop, a form generated from each widget's manifest, theming, a
  background, and "test connection" against the real service before you save.
- **An MCP server** so an AI can add and configure widgets. It cannot read a credential, write
  custom CSS or JavaScript, or name a URL — those three are permanently absent.
- **Backup as a git repository.** `config/` and `assets/` are committed; `secrets/` and `state/`
  are excluded by a `.gitignore` written on first boot. Restoring is `git clone` plus your
  credentials in the environment, and CI executes exactly that on every push.
- **`neo doctor`**, which explains what is wrong with an install and exits non-zero when it
  matters.

### Running it

```sh
mkdir neohomepage && cd neohomepage
curl -O https://raw.githubusercontent.com/oauramos/neohomepage/main/compose.yaml
docker compose up -d
```

`linux/amd64` and `linux/arm64`, each built on a runner that natively is that architecture.

### Known gaps

- **One page.** The configuration has carried `pages[]` from the start so it will not be a
  migration, but there is no UI for it.
- **Pi-hole v6 is not supported.** The bundled widget targets v5's `/admin/api.php`; v6 replaced
  the API with a session exchange. It returns `http-404` or `bad-json` on v6.
- **iCalendar feeds needing a username and password** are not supported. A token in the URL works,
  because that is part of the path you supply.
- **No catalog auto-update yet.** The widget catalog ships in the image and is served at
  `/catalog/v1/`, but installs do not pull from it on their own.
- **Not soaked on a NAS.** The hour-long memory soak ran on arm64 under a 1 GiB cgroup; real
  hardware over real time is the next thing.

### For anyone reading the history

The commit messages are the design document, and several decisions are only explained there. The
ones worth reading first are the four in F13 about the container, and the two about measurement
gates that were passing for the wrong reasons.
