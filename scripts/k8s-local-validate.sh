#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TOTAL_STEPS=4

echo "[k8s-validate] step 1/${TOTAL_STEPS}: check root .env"
"${ROOT}/scripts/k8s-local-check-env.sh"

echo "[k8s-validate] step 2/${TOTAL_STEPS}: ensure local cluster"
"${ROOT}/scripts/k8s-local-cluster.sh"

echo "[k8s-validate] step 3/${TOTAL_STEPS}: apply pages-system"
PAGES_K8S_WAIT="${PAGES_K8S_WAIT:-true}" "${ROOT}/scripts/k8s-local-up.sh"

echo "[k8s-validate] step 4/${TOTAL_STEPS}: smoke control plane"
"${ROOT}/scripts/k8s-local-smoke.sh"

echo "[k8s-validate] all checks passed"
