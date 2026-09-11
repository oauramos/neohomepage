# Calendar

One agenda from every calendar you own: Sonarr episodes, Radarr releases, Lidarr albums and any
number of iCalendar feeds, merged, de-duplicated and sorted by date.

This is the catalog's only **composite** widget, and the reason the manifest schema has a second
shape. Four things it demonstrates that a single-target manifest cannot:

- **Several targets, several shapes, one tile.** A role declares which target shapes it accepts;
  the target's own `widgetType` picks the source kind, so a Sonarr bound into a calendar is fetched
  as a Sonarr and there is nothing for the user to get wrong.
- **Fan-out without a `flatMap` opcode.** A film has up to three dated events — in cinemas,
  physical, digital — and none of them is _the_ date. Radarr is therefore three `emits` over ONE
  `/api/v3/calendar` response: three item streams, one HTTP request, one scheduler entry.
- **A decoder the DSL could not be.** RFC 5545 recurrence expansion, `EXDATE`, `RECURRENCE-ID`
  overrides and VTIMEZONE conversion happen in the `ics` decoder, before any projection runs. The
  DSL then sees a plain array of occurrences with UTC instants.
- **Partial rendering.** `compose.partial` is what keeps a household calendar useful: one Radarr
  restarting must not blank out the four sources that answered. The tile renders what it has and
  reports `degraded`.

## Provenance

Written clean-room from each vendor's API documentation. No code, descriptor or fixture was taken
from another dashboard project.

- Sonarr/Radarr/Lidarr API: https://sonarr.tv/docs/api/, https://radarr.video/docs/api/,
  https://lidarr.audio/docs/api/
- iCalendar: RFC 5545, https://www.rfc-editor.org/rfc/rfc5545

## Binding an iCalendar feed

The feed's path lives in the **target's base path**, not in widget config: a config hole is
percent-encoded, which would turn `/dav/calendars/user/home.ics` into one escaped segment. The
operation path is a bare `/`, which means "the target's base path, exactly".

## Fixtures

One per source kind, including a real `.ics` file — `ics-feed.upstream.ics` is decoded by the
actual ICS decoder during `neo catalog test`, with the network made impossible, so the recurrence
and timezone handling is covered offline rather than assumed.
