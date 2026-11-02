#!/bin/bash
# Déploiement de l'API mobile sur LWS, lancé par cPanel (Git Version Control → .cpanel.yml)
# depuis la copie du dépôt (~/repositories/hotelio-mobile-backend). Copie le code dans
# ~/backendhoteliomobile (application Node de cPanel), installe les dépendances et redémarre.
set -euo pipefail

REPO_DIR="$(pwd)"
APP_DIR="$HOME/backendhoteliomobile"
NODE_ENV_ACTIVATE="$HOME/nodevenv/backendhoteliomobile/22/bin/activate"

echo "==> Copie du code"
# Mêmes exclusions que deploy-lws.ps1. Sans --delete : .env, node_modules (lien vers
# l'environnement Node de cPanel) et fichiers envoyés (src/uploads) restent intacts.
rsync -a --no-perms --omit-dir-times \
  --exclude='.env' --exclude='.git' --exclude='.github' --exclude='node_modules' --exclude='.expo' \
  --exclude='/src/uploads/' --exclude='/tmp/' --exclude='/deploy/' --exclude='.cpanel.yml' \
  --exclude='deploy-lws.ps1' --exclude='*.zip' --exclude='*.log' \
  "$REPO_DIR/" "$APP_DIR/"

echo "==> Dépendances"
# shellcheck disable=SC1090
source "$NODE_ENV_ACTIVATE"
cd "$APP_DIR"
# npm install (pas npm ci) : sur cPanel, node_modules est un lien vers l'environnement Node
# de l'application, que npm ci supprimerait.
npm install --omit=dev --no-audit --no-fund

echo "==> Redémarrage (Passenger)"
mkdir -p tmp
touch tmp/restart.txt

echo "==> Déploiement de l'API terminé"
