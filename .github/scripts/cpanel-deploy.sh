#!/bin/bash
# Déclenche un déploiement cPanel (Git Version Control) par l'API UAPI, puis attend son issue.
#   1. VersionControl/update                 → la copie du dépôt sur le serveur récupère la branche
#   2. VersionControlDeployment/create       → cPanel exécute le .cpanel.yml du dépôt
#   3. VersionControlDeployment/retrieve     → suivi jusqu'à succès ou échec
# Usage : cpanel-deploy.sh <repository_root sur le serveur> <branche>
# Variables d'environnement : CPANEL_HOST, CPANEL_USER, CPANEL_API_TOKEN.
set -euo pipefail

REPO_ROOT="$1"
BRANCH="${2:-main}"
: "${CPANEL_HOST:?secret CPANEL_HOST manquant}" "${CPANEL_USER:?secret CPANEL_USER manquant}" "${CPANEL_API_TOKEN:?secret CPANEL_API_TOKEN manquant}"

api() { # api <Module/fonction> [paramètres --data-urlencode ...]
  local fn="$1"; shift
  curl -sS --fail-with-body -G "https://${CPANEL_HOST}:2083/execute/${fn}" \
    -H "Authorization: cpanel ${CPANEL_USER}:${CPANEL_API_TOKEN}" "$@"
}
check() { # check <réponse JSON> <étape>
  if [ "$(echo "$1" | jq -r '.status')" != "1" ]; then
    echo "Échec ($2) : $(echo "$1" | jq -c '.errors // .messages // .')"
    exit 1
  fi
}

echo "==> Récupération de la branche $BRANCH dans $REPO_ROOT"
res=$(api VersionControl/update --data-urlencode "repository_root=$REPO_ROOT" --data-urlencode "branch=$BRANCH")
check "$res" "mise à jour du dépôt"
echo "    commit : $(echo "$res" | jq -r '.data.last_update.identifier // "?"')"

echo "==> Lancement du déploiement"
res=$(api VersionControlDeployment/create --data-urlencode "repository_root=$REPO_ROOT")
check "$res" "lancement"
deploy_id=$(echo "$res" | jq -r '.data.deploy_id')
echo "    déploiement n° $deploy_id"

echo "==> Suivi"
for _ in $(seq 1 60); do
  sleep 10
  res=$(api VersionControlDeployment/retrieve)
  dep=$(echo "$res" | jq -c --arg id "$deploy_id" '.data[] | select((.deploy_id|tostring) == $id)')
  if [ -n "$(echo "$dep" | jq -r '.timestamps.succeeded // empty')" ]; then
    echo "    réussi"
    exit 0
  fi
  if [ -n "$(echo "$dep" | jq -r '.timestamps.failed // empty')" ]; then
    echo "    ÉCHEC — journal sur le serveur : $(echo "$dep" | jq -r '.log_path')"
    exit 1
  fi
  echo "    en cours…"
done
echo "Délai dépassé (10 min) — voir cPanel → Git Version Control → Historique des déploiements"
exit 1
