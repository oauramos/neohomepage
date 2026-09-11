#!/bin/sh
# Makes the data directory writable, then drops privileges. A bind mount carries the host
# directory's ownership, which no build-time chown can reach, so the container starts as root,
# fixes it, and `exec`s the server unprivileged as PID 1. Started with `--user`, it only execs.
set -eu

TARGET_UID="${PUID:-1000}"
TARGET_GID="${PGID:-1000}"
DATA_DIR="${NEOHOMEPAGE_DATA_DIR:-/data}"

if [ "$(id -u)" != "0" ]; then
  # Started with `--user`: nothing can be fixed here, so fail with a clear message instead of an
  # EACCES stack trace.
  if [ ! -w "$DATA_DIR" ]; then
    echo "neohomepage: $DATA_DIR is not writable by uid $(id -u)." >&2
    echo "  The container was started with an explicit user, so it cannot fix this itself." >&2
    echo "  On the host:  sudo chown -R $(id -u):$(id -g) <the directory bind-mounted at $DATA_DIR>" >&2
    exit 1
  fi
  exec "$@"
fi

# Only chown when ownership is wrong; a recursive chown over a large assets tree on a NAS is slow.
if [ ! -d "$DATA_DIR" ]; then
  mkdir -p "$DATA_DIR"
  chown "$TARGET_UID:$TARGET_GID" "$DATA_DIR"
elif [ "$(stat -c %u "$DATA_DIR")" != "$TARGET_UID" ]; then
  echo "neohomepage: taking ownership of $DATA_DIR for uid $TARGET_UID (once)"
  chown -R "$TARGET_UID:$TARGET_GID" "$DATA_DIR"
fi

# PUID/PGID: NAS systems (Synology, QNAP) hand out uids of 1024+ and the files must stay readable
# from their file manager.
if [ "$TARGET_UID" != "1000" ] || [ "$TARGET_GID" != "1000" ]; then
  deluser node 2>/dev/null || true
  addgroup -g "$TARGET_GID" -S app 2>/dev/null || true
  adduser -u "$TARGET_UID" -G app -S -D -H app 2>/dev/null || true
  exec su-exec "$TARGET_UID:$TARGET_GID" "$@"
fi

exec su-exec node "$@"
