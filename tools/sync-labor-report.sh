#!/bin/sh
# 把勞報單產生器的公開版（同一層資料夾的 labor-report/dist/index.html）複製進工具箱的 labor-report/。
# 只複製公開版；確認裡面的預填值是 null（不含任何個資）才放行。用法：sh tools/sync-labor-report.sh
set -e
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HERE/../labor-report/dist/index.html"
DST="$HERE/labor-report/index.html"
[ -f "$SRC" ] || { echo "找不到 $SRC（先在 labor-report 跑 python3 build.py）"; exit 1; }
n=$(grep -c 'window.LR_SEED = /\*__SEED__\*/null;' "$SRC" || true)
[ "$n" = "1" ] || { echo "中止：公開版的預填值不是 null，可能混進了私人版"; exit 2; }
if grep -q 'data:image/jpeg;base64,/9j' "$SRC"; then echo "中止：公開版裡有內嵌照片，可能混進了私人版"; exit 3; fi
cp "$SRC" "$DST" && cmp "$SRC" "$DST" && echo "已同步：labor-report/index.html（$(wc -c < "$DST" | tr -d ' ') bytes）"
