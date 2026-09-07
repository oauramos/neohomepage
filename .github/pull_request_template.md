<!--
Widget PRs: one service each, with the vendor API documentation cited in the widget's README.
Everything else: what changed and why, with the reasoning in the commit message too.
-->

## What this changes

## Why

<!-- What broke, or what was not possible before. If this fixes something, what would have caught it. -->

## Checks

- [ ] `pnpm lint && pnpm typecheck && pnpm test`
- [ ] `pnpm catalog:test` (if any manifest or the DSL changed)
- [ ] `pnpm catalog:docs` re-run and committed (if a manifest changed)
- [ ] `pnpm e2e` (if the editor, the templates or the theme changed)
