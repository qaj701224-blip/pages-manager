#!/usr/bin/env bash
set -euo pipefail

CMD="${1:-}"
API="${PAGES_API:-https://api.workers.xd.team}"
TOKEN_HEADER=()
if [ -n "${PAGES_TOKEN:-}" ]; then
  TOKEN_HEADER=(-H "X-Pages-Token: ${PAGES_TOKEN}")
fi

case "$CMD" in
  list)
    curl -s "${TOKEN_HEADER[@]}" "${API}/list" | python3 -m json.tool 2>/dev/null || curl -s "${TOKEN_HEADER[@]}" "${API}/list"
    ;;

  info)
    NAME="${2:-}"
    if [ -z "$NAME" ]; then
      echo "用法: manage.sh info <name>"
      exit 1
    fi
    RESPONSE=$(curl -s "${TOKEN_HEADER[@]}" -w "\n%{http_code}" "${API}/site/${NAME}")
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    if [ "$HTTP_CODE" = "200" ]; then
      echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
    else
      echo "站点 '${NAME}' 不存在"
      exit 1
    fi
    ;;

  delete)
    NAME="${2:-}"
    if [ -z "$NAME" ]; then
      echo "用法: manage.sh delete <name>"
      exit 1
    fi
    if [ "${3:-}" != "--yes" ]; then
      read -r -p "确认删除站点 '${NAME}'? (y/N) " confirm
      if [ "$confirm" != "y" ] && [ "$confirm" != "Y" ]; then
        echo "已取消"
        exit 0
      fi
    fi
    RESPONSE=$(curl -s "${TOKEN_HEADER[@]}" -w "\n%{http_code}" -X DELETE "${API}/site/${NAME}")
    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    if [ "$HTTP_CODE" = "200" ]; then
      echo "✅ 站点 '${NAME}' 已删除"
    else
      echo "❌ 删除失败 (HTTP ${HTTP_CODE})"
      echo "$BODY"
      exit 1
    fi
    ;;

  *)
    echo "用法: manage.sh <command> [args]"
    echo ""
    echo "命令:"
    echo "  list              列出所有站点"
    echo "  info <name>       查看站点详情"
    echo "  delete <name>     删除站点"
    exit 1
    ;;
esac
