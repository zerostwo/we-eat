#!/usr/bin/env bash
set -euo pipefail
umask 077
cd /srv/we-eat
export COMPOSE_PROJECT_NAME=we-eat DOCKER_CONFIG=/srv/we-eat/.docker
exec 9>.update.lock
flock -n 9 || exit 0

# Resolve the production tag once, then use that exact digest for the entire update.
repo=duansq/we-eat
docker pull --quiet "$repo:production" >/dev/null
target=$(docker image inspect "$repo:production" --format '{{range .RepoDigests}}{{println .}}{{end}}' |
  awk '/^(docker.io\/)?duansq\/we-eat@sha256:/ {print; exit}')
[[ "$target" =~ ^(docker\.io/)?duansq/we-eat@sha256:[0-9a-f]{64}$ ]]

container=$(docker compose ps --all --quiet web)
volume_of() {
  docker inspect --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' "$1"
}
# Refuse to start against an empty or unrelated Compose volume.
[[ -n "$container" && "$(volume_of "$container")" == we-eat_meals ]]
previous=$(docker inspect --format '{{.Config.Image}}' "$container")
if [[ "$previous" == "$target" ]] && grep -Fxq "WE_EAT_IMAGE=$target" .env &&
   [[ "$(docker inspect --format '{{.State.Health.Status}}' "$container")" == healthy ]]; then
  exit 0
fi

mkdir -p backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
staging=$(mktemp -d ./backups/.update-XXXXXXXX)
trap 'rm -rf -- "$staging"' EXIT
docker compose exec -T web node --input-type=module - <<'JS' > "$staging/database"
import {DatabaseSync, backup} from 'node:sqlite';
import {readFileSync, unlinkSync, writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const path = '/tmp/we-eat-' + randomUUID() + '.sqlite';
const source = new DatabaseSync(process.env.DB_PATH, {readOnly:true});
try {
  await backup(source, path);
  const copy = new DatabaseSync(path, {readOnly:true});
  try {
    if (copy.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw Error('Invalid backup');
    console.error('Backup inventory', copy.prepare('SELECT count(*) AS catalog, sum(inList) AS wishlist, (SELECT count(*) FROM draws) AS draws, (SELECT count(*) FROM ratings) AS ratings FROM restaurants').get());
  } finally { copy.close(); }
  writeFileSync(1, readFileSync(path));
} finally { source.close(); unlinkSync(path); }
JS
test -s "$staging/database"
mv "$staging/database" "backups/pre-update-$stamp.sqlite"
awk -v image="$target" '/^WE_EAT_IMAGE=/ {next} {print} END {print "WE_EAT_IMAGE=" image}' .env > "$staging/env"

start_image() {
  WE_EAT_IMAGE="$1" docker compose up -d --no-deps --no-build --pull never --wait --wait-timeout 90 web
}

if start_image "$target" &&
   [[ "$(volume_of "$(docker compose ps --quiet web)")" == we-eat_meals ]] &&
   docker compose exec -T web node --input-type=module -e '
     import {DatabaseSync} from "node:sqlite";
     const d = new DatabaseSync(process.env.DB_PATH,{readOnly:true});
     const ok = d.prepare("PRAGMA quick_check").get().quick_check === "ok" && !d.prepare("PRAGMA foreign_key_check").get();
     d.close();
     if (!ok || !(await fetch("http://127.0.0.1:8080/healthz")).ok) process.exit(1);' &&
   mv "$staging/env" .env; then
  echo "Deployed $target"
else
  echo "Update failed. Starting previous image $previous with the same data volume." >&2
  start_image "$previous"
  exit 1
fi
