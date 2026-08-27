#!/usr/bin/env bash
set -Eeuo pipefail

CONTAINER="4stepsvpn-postgres"
DB="vpn"
DB_USER="vpn"
RESTORE_DB="vpn_restore_check"

BACKUP_ROOT="/opt/backups/4stepsvpn/postgres"
DAILY_DIR="$BACKUP_ROOT/daily"
WEEKLY_DIR="$BACKUP_ROOT/weekly"

LOCK_FILE="/var/lock/4stepsvpn-postgres-backup.lock"

umask 077

mkdir -p "$DAILY_DIR" "$WEEKLY_DIR"

exec 9>"$LOCK_FILE"

if ! flock -n 9; then
  echo "BACKUP_ALREADY_RUNNING"
  exit 0
fi

if [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" != "true" ]; then
  echo "ERROR: postgres container is not running" >&2
  exit 1
fi

TS="$(date +%Y%m%d-%H%M%S)"
TMP_FILE="$DAILY_DIR/.vpn-$TS.dump.partial"
FINAL_FILE="$DAILY_DIR/vpn-$TS.dump"

cleanup() {
  rm -f "$TMP_FILE"

  docker exec "$CONTAINER" \
    psql -U "$DB_USER" -d postgres -Atc \
    "SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = '$RESTORE_DB'
       AND pid <> pg_backend_pid();" \
    >/dev/null 2>&1 || true

  docker exec "$CONTAINER" \
    psql -U "$DB_USER" -d postgres \
    -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\";" \
    >/dev/null 2>&1 || true
}

trap cleanup EXIT

echo "BACKUP_START=$TS"

docker exec "$CONTAINER" \
  pg_dump \
    -U "$DB_USER" \
    -d "$DB" \
    -Fc \
  > "$TMP_FILE"

if [ ! -s "$TMP_FILE" ]; then
  echo "ERROR: backup file is empty" >&2
  exit 1
fi

docker exec -i "$CONTAINER" \
  pg_restore --list \
  < "$TMP_FILE" \
  >/dev/null

mv "$TMP_FILE" "$FINAL_FILE"
chmod 600 "$FINAL_FILE"

(
  cd "$(dirname "$FINAL_FILE")"
  sha256sum "$(basename "$FINAL_FILE")"     > "$(basename "$FINAL_FILE").sha256"
)
chmod 600 "$FINAL_FILE.sha256"

docker exec "$CONTAINER" \
  psql -U "$DB_USER" -d postgres \
  -c "DROP DATABASE IF EXISTS \"$RESTORE_DB\";" \
  >/dev/null

docker exec "$CONTAINER" \
  psql -U "$DB_USER" -d postgres \
  -c "CREATE DATABASE \"$RESTORE_DB\" OWNER \"$DB_USER\";" \
  >/dev/null

docker exec -i "$CONTAINER" \
  pg_restore \
    -U "$DB_USER" \
    -d "$RESTORE_DB" \
    --no-owner \
    --no-privileges \
  < "$FINAL_FILE"

RESTORE_COUNTS="$(
  docker exec "$CONTAINER" \
    psql -U "$DB_USER" -d "$RESTORE_DB" -Atc "
      SELECT
        (SELECT count(*) FROM users),
        (SELECT count(*) FROM subscriptions),
        (SELECT count(*) FROM payments),
        (SELECT count(*) FROM notifications);
    "
)"

echo "RESTORE_CHECK_OK=$RESTORE_COUNTS"

if [ "$(date +%u)" = "7" ]; then
  WEEKLY_FILE="$WEEKLY_DIR/vpn-$TS.dump"

  cp -p "$FINAL_FILE" "$WEEKLY_FILE"
  cp -p "$FINAL_FILE.sha256" "$WEEKLY_FILE.sha256"

  echo "WEEKLY_BACKUP_CREATED=$(basename "$WEEKLY_FILE")"
fi

prune_backups() {
  local directory="$1"
  local keep="$2"

  mapfile -t files < <(
    find "$directory" \
      -maxdepth 1 \
      -type f \
      -name 'vpn-*.dump' \
      -printf '%T@ %p\n' \
      | sort -rn \
      | cut -d' ' -f2-
  )

  if [ "${#files[@]}" -le "$keep" ]; then
    return
  fi

  for ((i=keep; i<${#files[@]}; i++)); do
    rm -f \
      "${files[$i]}" \
      "${files[$i]}.sha256"
  done
}

prune_backups "$DAILY_DIR" 7
prune_backups "$WEEKLY_DIR" 4

SIZE="$(stat -c '%s' "$FINAL_FILE")"

echo "BACKUP_OK=$(basename "$FINAL_FILE")"
echo "BACKUP_BYTES=$SIZE"
