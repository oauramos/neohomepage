# Widgets

The widget reference is generated from the catalog manifests, so it cannot drift from the form you
see in the editor. It appears here once the catalog lands.

## Adding one

A widget is three files and no code:

```
catalog/<slug>/manifest.json                  # the whole integration
catalog/<slug>/fixtures/<op>.upstream.json    # a recorded real response
catalog/<slug>/fixtures/<op>.expected.json    # the projection it must produce
```

```sh
pnpm catalog:validate    # schema, limits, and the derived-vs-declared `requires` check
pnpm catalog:test        # runs every projection against its fixtures, with no network
```

`catalog:test` does not merely avoid the network — it makes `fetch` throw. A widget whose test only
passes while your LAN is up is a broken widget, and the difference is invisible otherwise.

`requires` is **derived from the manifest and compared to what you declared**; a hand-maintained
requirement list drifts within weeks, and that drift is exactly the "installs fine, then renders
nothing" bug. Run `pnpm --filter @neohomepage/app catalog requires` to see the derived value.

One service per pull request. A thirty-widget PR cannot have been written from thirty sets of
vendor documentation, and it cannot be reviewed.
