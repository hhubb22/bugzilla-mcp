#!/usr/bin/env bash
set -euo pipefail

echo "[bugzilla] Waiting for MariaDB at db:3306..."
for i in $(seq 1 60); do
  if mariadb -h db -u bugs -pbugs_test_pass -e "SELECT 1;" bugs >/dev/null 2>&1; then
    echo "[bugzilla] MariaDB is ready."
    break
  fi
  sleep 1
done

cd /var/www/bugzilla
mkdir -p /var/www/bugzilla/data /var/www/bugzilla/graphs

if [ ! -f /var/www/bugzilla/localconfig ]; then
  echo "[bugzilla] Running initial checksetup.pl..."
  perl checksetup.pl answers.txt
fi

echo "[bugzilla] Ensuring DB schema & permissions via checksetup.pl..."
perl checksetup.pl answers.txt

echo "[bugzilla] Seeding E2E fixtures..."
perl seed.pl

chown -R www-data:www-data /var/www/bugzilla/data /var/www/bugzilla/graphs 2>/dev/null || true

echo "[bugzilla] Starting Apache..."
exec apache2ctl -D FOREGROUND
