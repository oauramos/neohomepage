# Sections

A page is a stack of sections, top to bottom. Open the editor with the button in the bottom-left
corner and pick **Sections** to add, reorder, remove and configure them. Every edit saves on its
own after a moment; the board updates as soon as it lands.

There are three kinds.

## Navbar

The header. It is built from items, in the order you list them:

| Item   | What it shows                                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title  | The dashboard title, as set in the header of the editor.                                                                                            |
| Text   | A line of your own — a room, a rack, a reminder.                                                                                                    |
| Links  | A row of links, each with an optional icon.                                                                                                         |
| Clock  | The local time, updated every minute; optionally the date, optionally 12-hour.                                                                      |
| Search | A box that sends the query to DuckDuckGo, Google, Bing, Brave, Startpage or Kagi in a new tab. It is a plain form, so it works with JavaScript off. |
| Spacer | Pushes everything after it to the far edge.                                                                                                         |

A page that has never opened the Sections tab has a navbar with just the title — the header every
dashboard started with.

## Grid

A board of widgets, the same free grid as before: drag a tile by its handle, resize by the corner.
Each grid section has its own **columns** per breakpoint (blank means the page's default: 12, 6
and 2) and its own **max rows**. With a row limit set, a widget that does not fit is refused with a
message rather than pushed below the fold, which is the behaviour a wall display wants.

A page can have several grids, each with a title. Widgets live in exactly one; the **Widgets** tab
shows a section select per tile once there is more than one grid to choose from.

## Bookmarks

Named groups of links — Router, NAS, Tools — laid out in columns. **Groups per row** is set per
breakpoint; blank means a third of the grid's columns, so 4, 2 and 1 by default. Every link is a
label, a URL and an optional icon.

Four displays, chosen per section:

- **List** — the name as a link, one per line. The most compact.
- **Cards** — a button per link, in a wrapping grid.
- **Icons** — icon and name, one per line.
- **Chips** — pills side by side, wrapping.

### Icons

An icon is a name, never a link. Five sets, told apart by prefix — the same spelling gethomepage
uses:

| Reference               | Set                                                                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nextcloud`             | [dashboard-icons](https://github.com/homarr-labs/dashboard-icons): full-colour logos of self-hosted things                                            |
| `si-nextcloud`          | [Simple Icons](https://simpleicons.org): one-colour brand marks, served in the brand colour                                                           |
| `si-claude-#D97757`     | Simple Icons in a colour you chose — for a brand whose colour is black on a dark theme                                                                |
| `lucide-search`         | [Lucide](https://lucide.dev): the interface glyphs shadcn and [ReUI](https://reui.io/icons) ship — search, router, house — painted in the text colour |
| `tabler-search`         | [Tabler Icons](https://tabler.io/icons), the same way                                                                                                 |
| `mdi-router-network`    | [Material Design Icons](https://pictogrammers.com/library/mdi/), the same way                                                                         |
| `lucide-router-#ff6900` | any glyph set, in a colour you chose                                                                                                                  |

The server fetches each one once into `state/icons/` and the page references that local copy, so
a published dashboard loads nothing from the internet when viewed. Until the icon is cached, or
when there is no icon of that name, the link shows its initial in a rounded square. Widgets show
their type's icon beside the title the same way.

Set the network mode to `offline` in `config/network.json` and nothing is fetched; cached icons
are still served.

## Where it lives

`config/pages/<page>.json` carries a `sections` array; a page that declares none is rendered as
the navbar-and-grid pair, so nothing has to be migrated. A link is stored as scheme, host, port and
path — never as a URL string — for the same reason a widget's target is: nothing in the
configuration, the API or an MCP tool call names a URL.

Layouts stay one file per page. A grid section's board is the entries whose widget names that
section, so each board starts at row zero and moving a tile in one section cannot disturb another.
