#!/bin/sh
# Make the data directory usable, then drop privileges and get out of the way.
#
# The problem this solves is specific to bind mounts, and it is the first thing a new user hits.
# A NAMED volume inherits the ownership of the image's empty /data, so an image that simply runs
# as `node` works. A BIND mount carries the ownership of the host directory — which is whoever ran
# `mkdir data`, usually not uid 1000 — and no `chown` at build time can reach it. The container
# then dies on first boot with `EACCES: permission denied, mkdir '/data/config'`.
#
# Bind mounts are not an edge case here: the entire backup story is "git init your data
# directory", which means a real path on the host that a person can `cd` into. So it has to work
# on first run, with no instructions.
#
# The shape below is the conventional one for self-hosted images, with the conventional trade-off
# stated plainly: the container starts as root just long enough to fix ownership, then `exec`s to
# an unprivileged user. `exec` matters — the shell REPLACES itself, so the server is PID 1 and
# receives SIGTERM directly. Anyone who would rather never have root in the picture can run with
# `--user`, and this script detects that and does nothing but exec.
set -eu

TARGET_UID="${PUID:-1000}"
TARGET_GID="${PGID:-1000}"
DATA_DIR="${NEOHOMEPAGE_DATA_DIR:-/data}"

if [ "$(id -u)" != "0" ]; then
  # Already unprivileged: someone passed `--user`, or `user:` in compose. Nothing to fix, and
  # nothing we COULD fix. Say something useful if the directory is not writable, because the
  # alternative is a stack trace from deep inside the filesystem layer.
  if [ ! -w "$DATA_DIR" ]; then
    echo "neohomepage: $DATA_DIR is not writable by uid $(id -u)." >&2
    echo "  The container was started with an explicit user, so it cannot fix this itself." >&2
    echo "  On the host:  sudo chown -R $(id -u):$(id -g) <the directory bind-mounted at $DATA_DIR>" >&2
    exit 1
  fi
  exec "$@"
fi

# Only touch ownership when it is actually wrong. A recursive chown over a large assets directory
# on a slow NAS disk is not something to do on every single start.
if [ ! -d "$DATA_DIR" ]; then
  mkdir -p "$DATA_DIR"
  chown "$TARGET_UID:$TARGET_GID" "$DATA_DIR"
elif [ "$(stat -c %u "$DATA_DIR")" != "$TARGET_UID" ]; then
  echo "neohomepage: taking ownership of $DATA_DIR for uid $TARGET_UID (once)"
  chown -R "$TARGET_UID:$TARGET_GID" "$DATA_DIR"
fi

# PUID/PGID exist because NAS users need a specific one — Synology and QNAP hand out uids in the
# 1024+ range and the files have to be readable from the file manager afterwards.
if [ "$TARGET_UID" != "1000" ] || [ "$TARGET_GID" != "1000" ]; then
  deluser node 2>/dev/null || true
  addgroup -g "$TARGET_GID" -S app 2>/dev/null || true
  adduser -u "$TARGET_UID" -G app -S -D -H app 2>/dev/null || true
  exec su-exec "$TARGET_UID:$TARGET_GID" "$@"
fi

exec su-exec node "$@"
