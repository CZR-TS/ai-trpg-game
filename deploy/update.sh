#!/usr/bin/env bash
set -euo pipefail

ROOT=/opt/ai-trpg-game
ARCHIVE_URL=https://github.com/CZR-TS/ai-trpg-game/archive/refs/heads/main.tar.gz
RELEASE_ID=$(date -u +%Y%m%d%H%M%S)
RELEASE_DIR="$ROOT/releases/$RELEASE_ID"
TEMP_DIR=$(mktemp -d "$ROOT/.update.XXXXXX")
PREVIOUS_TARGET=$(readlink -f "$ROOT/current" 2>/dev/null || true)

cleanup() { rm -rf -- "$TEMP_DIR"; }
trap cleanup EXIT

test -f "$ROOT/shared/config/config.json" || { echo "缺少共享配置文件" >&2; exit 1; }
mkdir -p "$RELEASE_DIR" "$ROOT/shared/data"
curl -fsSL "$ARCHIVE_URL" -o "$TEMP_DIR/source.tar.gz"
tar -xzf "$TEMP_DIR/source.tar.gz" --strip-components=1 -C "$RELEASE_DIR"
ln -sfn "$ROOT/shared/config/config.json" "$RELEASE_DIR/config/config.json"
ln -sfn "$ROOT/shared/data" "$RELEASE_DIR/data"

cd "$RELEASE_DIR"
/usr/bin/npm ci --omit=dev
/usr/bin/npm test
chown -R trpg:trpg "$RELEASE_DIR" "$ROOT/shared"

ln -sfn "$RELEASE_DIR" "$ROOT/current.new"
mv -Tf "$ROOT/current.new" "$ROOT/current"
systemctl restart ai-trpg-game

for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1/ >/dev/null; then
    echo "更新成功：$RELEASE_DIR"
    exit 0
  fi
  sleep 1
done

echo "健康检查失败，正在回滚" >&2
if test -n "$PREVIOUS_TARGET" && test -d "$PREVIOUS_TARGET"; then
  ln -sfn "$PREVIOUS_TARGET" "$ROOT/current.rollback"
  mv -Tf "$ROOT/current.rollback" "$ROOT/current"
  systemctl restart ai-trpg-game
fi
exit 1
