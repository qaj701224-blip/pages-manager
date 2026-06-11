#!/usr/bin/env bash
set -euo pipefail

NAME="${1:-}"
DIR="${2:-}"
PRESET="static"
API="${PAGES_API:-https://api.workers.xd.team}"

while [[ $# -gt 2 ]]; do
  case "$3" in
    --preset) PRESET="${4:-static}"; shift 2 ;;
    *) shift ;;
  esac
done

if [ -z "$NAME" ] || [ -z "$DIR" ]; then
  echo "用法: deploy.sh <name> <dir> [--preset static|spa|worker]"
  echo ""
  echo "参数:"
  echo "  name      站点名称 (小写字母、数字、连字符，2-50 字符)"
  echo "  dir       要部署的本地目录"
  echo "  --preset  站点类型: static (默认)、spa 或 worker"
  echo ""
  echo "preset 说明:"
  echo "  static  按路径匹配文件，404 返回 404 页面"
  echo "  spa     路径未匹配时回退到 index.html"
  echo "  worker  使用目录中的 _worker.js 作为自定义 Worker 入口"
  echo ""
  echo "环境变量:"
  echo "  PAGES_TOKEN  部署者 token (格式: pages_你的邮箱)"
  echo "  PAGES_API    管理服务地址 (默认 https://api.workers.xd.team)"
  exit 1
fi

if [ ! -d "$DIR" ]; then
  echo "错误: 目录 '$DIR' 不存在"
  exit 1
fi

DIR="$(cd "$DIR" && pwd)"

if [ -z "${PAGES_TOKEN:-}" ]; then
  echo "错误: 请先设置 PAGES_TOKEN=pages_你的邮箱"
  exit 1
fi

CURL_ARGS=(-s -w "\n%{http_code}" -X POST -H "X-Pages-Token: ${PAGES_TOKEN}")
CURL_ARGS+=(-F "name=${NAME}")
CURL_ARGS+=(-F "preset=${PRESET}")

COUNT=0
while IFS= read -r -d '' file; do
  rel="${file#"$DIR"/}"
  CURL_ARGS+=(-F "file-${COUNT}=@${file};filename=${rel}")
  COUNT=$((COUNT + 1))
done < <(find "$DIR" -type f -print0)

if [ "$COUNT" -eq 0 ]; then
  echo "错误: 目录为空"
  exit 1
fi

echo "正在部署 ${DIR} → ${NAME} (${PRESET}, ${COUNT} 个文件)..."

RESPONSE=$(curl "${CURL_ARGS[@]}" "${API}/deploy")
HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

if [ "$HTTP_CODE" = "200" ]; then
  URL=$(echo "$BODY" | grep -o '"url":"[^"]*"' | cut -d'"' -f4)
  echo ""
  echo "✅ 已发布: ${URL}"
  echo "   文件数: ${COUNT}"
  echo "   类型: ${PRESET}"
else
  echo ""
  echo "❌ 部署失败 (HTTP ${HTTP_CODE})"
  echo "$BODY"
  exit 1
fi
