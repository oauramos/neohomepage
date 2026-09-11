# Changelog

## Unreleased

### Sections

- **A page is a stack of sections.** Three kinds: a `navbar` composed of items (the title, a line
  of text, a row of links, a clock, a search box, a spacer), a `grid` — the free board as before,
  with its own column counts per breakpoint and its own row cap — and `bookmarks`: named groups of
  links laid out N per row, drawn as a list, cards, icon-and-name or chips. A page that declares
  none resolves to the navbar-and-grid pair every install already had, so nothing on disk
  migrates. Layouts stay one flat file per page; a grid section's board is the entries whose
  widget names it, so every board starts at row zero and placing into one section cannot move a
  tile in another. The validator bounds each entry by its section, refuses a section list that
  would strand a widget, and keeps section, group, link and navbar item ids unique.
- **A Sections tab** in the editor: add, reorder, remove, expand and configure. Links are typed as
  URLs and stored as parts — the browser does the split, so the server still never sees a URL.
  Edits save whole after half a second; a 422 is shown in place with the draft kept. The board
  re-renders from the resolved state as soon as a save lands, columns included, because the page's
  stylesheet is now emitted in the browser from the same function the publish step bakes with.
- **Icons.** A manifest has named its icon by slug since the first widget, and a bookmark can
  now too — the dashboard-icons names gethomepage users already have. The server fetches each one
  once into `state/icons/`, checks the bytes are the image they claim to be, and the page
  references the local copy; a viewed dashboard loads nothing from the internet. Until cached, a
  link shows its initial. Tiles show their type's icon beside the title.
- **MCP**: `get_sections`, `set_sections`, `add_bookmark`; `add_widget`, `update_widget` and
  `set_layout` take a `section`; `describe_dashboard` reports the sections.
- **Readings can be boxed and centred.** Three shape tokens — `stat-bg`, `stat-padding`,
  `stat-align` — set it for the dashboard from the design panel (Type → Readings), a preset can
  carry it, and a widget can choose for itself (`look.stats`, `look.align`) from its row in the
  Widgets tab or through `update_widget`. "Running 10" in a muted box, centred, reads across a
  room; bare and left-aligned is still the default.
- **The Widgets tab is a list you can edit.** One search box at the top adds (type to narrow the
  catalog, or Browse it); at rest the tab is the placed widgets, each row opening into its own
  editor — title, section, readings, the options its manifest declares, where it reads from,
  and a two-step Remove. Edits save half a second after the last change and the row says so.
  Catalog entries show their icon and a badge when a credential is needed. The dialog is wider,
  the tabs carry icons and start on Widgets, and below tablet width the tabs become a row.
- **The page boots from the state it was published with.** The embedded state was written flat
  and read as `{resolved}`, so every load booted from an empty dashboard, painted the default theme
  over the baked one for a frame, then fetched what it already had. Found because a link tile
  rendering as a real button on first paint let axe scan that frame and fail four presets on a
  colour that never exists on screen.
- **An https target addressed by IP is reachable again.** Node refuses an IP literal as the TLS
  ServerName, and the refusal was mapped to "unreachable" — so every Proxmox, Portainer and
  TrueNAS at `https://192.168.x.x` failed in a millisecond, before a packet was sent.
- **A bookmark is a link before it is a liveness check.** A link tile's href is resolved from its
  target and path, not read from a projection that only exists once `GET /` has succeeded; a
  service that answers with a login redirect, a 401 or a self-signed certificate is still a
  bookmark. The probe's verdict stays in the chip.

### Catalog

- **Eight widgets from one homelab's `services.yaml`**: `glances-quicklook` (CPU, memory, swap
  and load of a host), `glances-sensors` (every Celsius reading), `glances-gpu`, `glances-fs`
  (a bar per mount), `nextcloud-server` (who is on, users, files, free space — the serverinfo
  app over Basic auth with an app password), `immich-library` (photos, videos, storage),
  `navidrome-library` (songs, folders, last scan) and `navidrome-playing` (who is listening to
  what). Each written clean-room from the vendor's API documentation, with a recorded fixture
  trimmed to what the projection reads; the Navidrome idle shape — `"nowPlaying": {}`, an object
  where a list is expected — has a unit test of its own because a fixture cannot wait for someone
  to press play.
- **A query or path template can read the target's own fields**, beneath the widget's options.
  Subsonic's username and salt are properties of the server and travel as query parameters, and
  before this the operation could only reach the widget's config, so the request went out with an
  empty user and the tile showed dashes. Secrets are still refused in a URL whichever bag they are
  in.

### The editor

- **Widgets have a kind** — widget, bookmark or tool — declared on the manifest and defaulted, so no
  existing manifest changes. The Widgets tab is tabbed by it, with counts, and adding is scoped to
  the tab you are in: the bookmark tab offers bookmarks.
- **Theme import and export.** The box holds `config/theme.json` exactly as it is on disk, so
  pasting one here and pulling the folder from git are the same operation done two ways. An import
  replaces rather than merges, because "make it look like this" should not leave a colour behind.
- **Config**, a new tab for optional behaviour. The first is auto-hiding the floating buttons after
  a delay you set, with the pointer nearing either bottom corner — or any keyboard interaction, or
  focus landing inside them — bringing them back. It only ever changes opacity, so nothing becomes
  untabbable. Leaving takes 1.8s on an even S-curve and adds a little blur and shrink so the button
  reads as receding; coming back takes 120ms, because that one is a response to intent.
- **About** now carries the widget count, uptime, any resolver diagnostics, and links to the
  project, the wiki, the author and the issue form.
- **Regenerate is a refresh icon in the header**, next to the close button and beside the state it
  acts on, rather than a footer you had to scroll to. It carries a dot when there is something
  unpublished.
- **Backgrounds moved to the design panel** and gained an upload. This finally serves
  `data/assets/`, which had been created, backed up and walked by doctor since v1 with no route
  behind it — setting a background by hand produced a 404. Images are stored content-addressed
  under a name the SERVER derives from the bytes, and the type is sniffed from magic numbers rather
  than believed from a header, so an upload cannot name a path or be served back as something
  executable. The write gate now also admits image content types, which costs nothing: the property
  it relies on is not "JSON" but "a type a cross-site form cannot produce", and a test asserts the
  three that a form CAN produce never appear in that list.

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

### A gallery, and a board that keeps up

- **Sixty-four ready-made palettes** in a Presets tab, with search and a finish filter: sixteen hues
  around the wheel in four finishes (Flat, Soft, Sharp, Glow), so the grid varies in shape as well
  as hue. Generated by solving each colour's lightness against `contrast.ts` rather than by picking
  values that looked right, which makes AA a property of how they are built. All seventy-five
  presets are now re-proved by the contrast matrix in both schemes — 2,135 unit tests.
- **Board width is four icons rather than a dropdown** — a viewport frame with the board inside it,
  the margin closing as the cap widens. The choice is spatial, so the control is too.
- **The board no longer stutters while you drag.** A theme change is a custom property on `:root`,
  which invalidates style for the whole document; with 32 tiles that measured 13ms median and 63ms
  at the 95th percentile, against 1.8ms with four tiles. Tiles now carry `contain: layout paint` and
  `content-visibility: auto`, and the preview is coalesced to one animation frame, so a drag cannot
  build a backlog of repaints. Median is 2.5ms.

### Four console eras

- **8-bit, 16-bit, 32-bit and 64-bit** — the Game Boy DMG, the Super Nintendo, the Neo Geo and the
  N64/PS1 generation. Each carries its era in shape as much as in colour: the DMG is one hue with a
  hard sprite shadow and zero radius, the SNES has moulded-plastic buttons with an inner highlight,
  the Neo Geo is a black cabinet with marquee lettering in Impact, and the 64-bit theme is the one
  where the edges finally soften — a translucent teal plastic with a diffuse glow.
- **A preset may now nominate a background**, applied when it is picked. Four era backgrounds came
  with them: a Game Boy LCD dot grid, a 16-bit diagonal weave, hard arcade scanlines and the fogged
  gradient early 3D used to hide its draw distance. All still written in the theme's own tokens.
- Eleven presets are now checked in both schemes by the contrast maths, and scanned by axe on a
  board carrying a bookmark tile. No pixel font ships: there is no system one, and a webfont is a
  request the offline mode cannot make, so the eras are carried by weight, tracking and case.

### The design surface, over MCP

- **An agent can change the look now**, not just the board. Three tools — `describe_theme`,
  `search_presets`, `set_theme` — cover everything behind the Design button: mode, all 75 presets,
  the thirteen colour tokens in either scheme, corner radius, border weight, board width, font,
  tile-title case, backdrop, blur and dim. Fifteen tools in the surface, still fixed. So "copy the
  colours from apple.com" works: the agent reads the palette with its own browser and hands over
  hex, and nothing in the server fetches anything.
- **A palette that arrives from outside is solved, not just stored.** Brand colours are picked to
  look like a brand, not to clear 4.5:1 on an inset grey — Apple's `#86868b` on `#f5f5f7` is
  3.33:1 — so a colour change is run against the same matrix `theme-contrast.test.ts` asserts, and
  any token that fails has its OKLCH lightness walked until it passes. Hue is kept, chroma too
  unless the colour would fall outside sRGB. This is the walk the sixty-four gallery palettes were
  generated with, extracted into `palette-fit.ts` and made callable. Every token it moves is
  reported with the pair and the ratio that moved it; `fit: "off"` writes the palette as given and
  `fit: "refuse"` fails rather than write one nobody can read. A candidate is scored by how many of
  its pairs FAIL before how close the worst one is: maximising the minimum alone is free to drag a
  pair that was passing at 6.1:1 down to 2.3:1, which on a palette with incompatible surfaces
  repaired nothing, broke something, and reported eight moves as fixes.
- **`dryRun` returns the whole result and writes nothing** — palette, adjustments, contrast verdict
  — through the same code path as the write, so trying five looks costs no generations.
- **Colours are set per scheme in one transaction.** Light and dark are separate palettes and the
  default mode is `system`, where the page carries both and the viewer's OS chooses; a tool that
  guessed "light" would have reported success on a change half the viewers could not see.
- **The absences hold, and one is new.** No tool authors CSS: every value written is a member of a
  closed table this repository ships, a number in a range, or a colour parsed and re-emitted. There
  is no import-a-theme tool, because `cssVars` there is free-form CSS. And an agent can choose a
  background image by id but can never add one — uploading stays a browser action.
- **`design-options.ts` is one table for two readers.** The fonts, board widths, title treatments
  and colour groups lived inside the design panel, and `src/server` may not import `src/web`. A
  test asserts the shape and type resets partition `SHAPE_TOKENS` exactly, which the old
  four-token-by-hand Shape reset did not.

### Fixes this surfaced

- `parseOklch` matched `[\d.]+` per component, so `oklch(0.5.5 0.1 200)` parsed to NaN rather than
  failing. Ratios then read "NaN:1" instead of "—", `toHex` returned `#NaNNaNNaN`, and the contrast
  solver — for which every candidate scored equally hopeless — certified the first one it tried as
  a fix. The pattern is now `\d+(\.\d+)?` with ranges checked, and a value that is not a colour is
  reported as one it cannot fit rather than silently repaired.
- The solver skipped a rule whose surface could not be read, which was right for one unreadable
  surface and wrong for all of them: a theme with a hex `muted` came back "nothing needed
  adjusting" beside eight failures. Anything the matrix names that is not a colour is now listed.
- Contrast was computed by clipping sRGB channels while a browser gamut-maps by reducing chroma, so
  a vivid fitted colour could be certified at 4.5:1 and rendered at 3.7:1. Every colour these tools
  write is brought inside sRGB first, which is what makes the number reported the number painted.
- `cssVars.theme` resolves above both schemes, so a colour pinned there — which the theme-import box
  can do — made every later colour write a silent no-op. Setting a colour now clears the pin and
  says it did.
- The contrast solver's near-miss branch scored a candidate by its worst pair alone, so on a palette
  whose surfaces cannot both carry text it dragged a pair passing at 6.1:1 down to 2.3:1 to raise
  that one number — repairing nothing and reporting eight moves as fixes. It now counts failing
  pairs first, runs to a fixed point rather than once, and a test asserts over a sweep of random
  palettes that a fit never leaves more pairs failing than it found.
- `parseOklch` rejected a hue above 360. CSS hue is modular, so `oklch(0.5 0.1 400)` is a colour a
  browser paints — and the panel read "—" for it while the board showed it fine.
- The published stylesheet interpolated token names and values with no guard, and `cssUrl` escaped
  quotes and parentheses but not `<` or `>`. Neither is reachable from the app's own writes, but a
  hand-edited `theme.json` is a real thing and this is where an agent-writable path ends up. The
  emitter now holds a value to a grammar rather than a blacklist — the characters the shipped
  values use, every bracket and quote closed, and no `url(` — because the quiet escapes are the
  dangerous ones: a single unclosed quote in one token swallowed four rules in Chromium, including
  the grid CSS that positions every tile. An unusable override falls back to the preset rather than
  leaving a hole.
- `TOOL_NAMES` — what `neo mcp --print-tools` reports and the docs are written from — was checked
  against nothing. Adding a tool and forgetting the array left the CLI naming a surface that did not
  exist; the test suite now asserts the two agree.
- `neo mcp` ignored `NEOHOMEPAGE_PUBLISH_MODE`, so an install that turned auto-publish off to keep
  one process in charge of the generation directory still got renders from the second one.

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
