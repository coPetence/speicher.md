#!/usr/bin/env bash
# End-to-end tests for a stack that deploy/install.sh started in local mode
#
# Usage: test/e2e/install.sh <install dir> <image tag>

set -euo pipefail

DIR=$(cd "$1" && pwd)
TAG=$2
INSTALLER="$(cd "$(dirname "$0")/../.." && pwd)/deploy/install.sh"
PORT=$(sed -n 's|^SPEICHER_PUBLIC_URL=http://localhost:||p' "$DIR/.env")
URL="http://localhost:$PORT"

compose() { docker compose --project-directory "$DIR" "$@"; }
step() { printf '\n== %s\n' "$*"; }
fail() {
  echo "FAIL: $*" >&2
  exit 1
}
env_get() { sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1; }
env_put() {
  grep -v "^$1=" "$DIR/.env" >"$DIR/.env.tmp" || true
  printf '%s=%s\n' "$1" "$2" >>"$DIR/.env.tmp"
  mv "$DIR/.env.tmp" "$DIR/.env"
}
reinstall() {
  NO_COLOR=1 bash "$INSTALLER" --yes --overwrite --dir "$DIR" --mode local --port "$PORT" \
    --image-tag "$TAG" </dev/null
}
db_marker_exists() {
  compose exec -T db psql -U speicher -d speicher -tAc "select to_regclass('e2e_marker') is not null" |
    grep -q '^t$'
}

step "Services keep running"
# a crashing service is restarted by Docker, so give it time to show up in the restart count
sleep 5
for service in web worker; do
  id=$(compose ps -q "$service")
  [ "$(docker inspect -f '{{.State.Status}}' "$id")" = running ] || fail "$service is not running"
  [ "$(docker inspect -f '{{.RestartCount}}' "$id")" = 0 ] || fail "$service restarted"
done
id=$(compose ps -a -q migrate)
[ "$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$id")" = "exited 0" ] ||
  fail "migrate did not exit with 0"
# exits with 1 while migrations are pending, whatever the log format
status=$(compose exec -T web speicher migrate status 2>&1) || fail "migrations are pending: $status"
echo "web and worker running, migrate exited 0, no pending migrations"

step "Claim page and its assets"
page=$(curl -fsS "$URL/")
grep -q '<title>Claim your instance</title>' <<<"$page" || fail "/ is not the claim page"
assets=$(grep -oE '/-/static/[^"]+' <<<"$page" | sort -u)
[ -n "$assets" ] || fail "the claim page links no assets"
for asset in $assets; do
  size=$(curl -fsS -o /dev/null -w '%{size_download}' "$URL$asset") || fail "$asset is not served"
  [ "$size" -gt 0 ] || fail "$asset is empty"
  echo "$asset ($size bytes)"
done

step "Claim with the code from the page"
code=$(grep -oE 'speicher claim [A-Z]+-[A-Z]+-[0-9]+' <<<"$page" | head -n 1 | cut -d' ' -f3)
[ -n "$code" ] || fail "the claim page shows no code"
compose exec -T -e SPEICHER_LOG_LEVEL=warn web speicher claim "$code"

step "Web and worker can write to the data volume"
for service in web worker; do
  compose exec -T "$service" touch "/var/lib/speicher/e2e-$service" || fail "$service cannot write"
done
compose exec -T db psql -U speicher -d speicher -qc 'create table e2e_marker ()'
echo "wrote marker files and a marker table"

step "Rerun the installer on the running stack"
password=$(env_get POSTGRES_PASSWORD)
reinstall || fail "rerunning the installer failed"
[ "$(env_get POSTGRES_PASSWORD)" = "$password" ] || fail "the rerun changed the database password"
db_marker_exists || fail "the rerun lost the database"
compose exec -T web test -f /var/lib/speicher/e2e-worker || fail "the rerun lost the data volume"
curl -fsS -o /dev/null "$URL/-/readyz" || fail "not ready after the rerun"
echo "kept the password, the database and the data volume"

step "A wrong password in .env stops the installer without deleting the database"
env_put POSTGRES_PASSWORD wrong
if output=$(reinstall 2>&1); then fail "the installer accepted a wrong database password"; fi
grep -q 'different password' <<<"$output" || fail "unexpected installer error: $output"
env_put POSTGRES_PASSWORD "$password"
db_marker_exists || fail "the installer deleted the database"
echo "refused, and the database is still there"

step "All end-to-end tests passed"
