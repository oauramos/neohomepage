#!/bin/sh
# Publish wiki/ to the GitHub wiki. GitHub creates the wiki's git repository only when a first
# page is saved through the web interface, so the very first run needs that one manual step.
set -eu

REPO="${WIKI_REPO:-oauramos/neohomepage}"
REMOTE="https://github.com/${REPO}.wiki.git"
SOURCE="$(pwd)/wiki"
HEAD_SHA="$(git rev-parse --short HEAD)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if ! git ls-remote "$REMOTE" >/dev/null 2>&1; then
  cat >&2 <<MESSAGE
The wiki for ${REPO} has no git repository yet.

GitHub creates it when the first page is saved through the web interface, and offers no API for
it. Create any page once — the content does not matter, this overwrites it:

  https://github.com/${REPO}/wiki/_new

Then run this again.
MESSAGE
  exit 1
fi

git clone --quiet --depth 1 "$REMOTE" "$WORK/wiki"

# Delete first, so a page removed here actually disappears there.
find "$WORK/wiki" -maxdepth 1 -name '*.md' -delete
cp "$SOURCE"/*.md "$WORK/wiki/"

cd "$WORK/wiki"
if [ -z "$(git status --porcelain)" ]; then
  echo "wiki is already up to date"
  exit 0
fi

git add -A
git commit --quiet -m "Publish wiki from ${HEAD_SHA}"
git push --quiet origin HEAD
echo "published $(ls -1 ./*.md | wc -l | tr -d ' ') pages to https://github.com/${REPO}/wiki"
