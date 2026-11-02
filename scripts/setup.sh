#!/usr/bin/env bash
# Install the headless preview cartridge + metadata on an instance using the b2c CLI.
#
#   ./scripts/setup.sh <instance-name> [preview-url]   (preview-url defaults to http://localhost:$PORT/)
#
# Expects ../.env (see .env.example). Instance name refers to your dw.json / b2c config.
set -euo pipefail
cd "$(dirname "$0")/.."

INSTANCE=${1:?usage: setup.sh <instance> [preview-url]}
set -a; source .env; set +a
PREVIEW_URL=${2:-http://localhost:${PORT:-3000}/}
: "${SCAPI_SHORT_CODE:?}" "${SCAPI_ORG_ID:?}" "${SITE_ID:?}" "${PREVIEW_SLAS_CLIENT_ID:?}" "${PREVIEW_SLAS_CLIENT_SECRET:?}"

# instance flags must follow the subcommand
FLAGS=(-i "$INSTANCE")
[ -n "${B2C_CONFIG:-}" ] && FLAGS+=(--config "$B2C_CONFIG")
b2cx() { b2c "$@" "${FLAGS[@]}"; }

# 1. metadata: site prefs + service with real credential values (never committed)
WORK=$(mktemp -d); trap 'rm -rf "$WORK"' EXIT
ARCHIVE="$WORK/headless_preview"
mkdir -p "$ARCHIVE/meta"
cp metadata/meta/*.xml "$ARCHIVE/meta/"
xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
URL="https://${SCAPI_SHORT_CODE}.api.commercecloud.salesforce.com/shopper/auth/v1/organizations/${SCAPI_ORG_ID}/"
SECRET_ESC=$(printf '%s' "$PREVIEW_SLAS_CLIENT_SECRET" | xml_escape)
awk -v url="$URL" -v user="$PREVIEW_SLAS_CLIENT_ID" -v pass="$SECRET_ESC" '
  /<url>/      { sub(/<url>.*<\/url>/, "<url>" url "</url>") }
  /<user-id>/  { sub(/<user-id>.*<\/user-id>/, "<user-id>" user "</user-id>") }
  /<password>/ { sub(/<password>.*<\/password>/, "<password>" pass "</password>") }
  { print }' metadata/services.xml > "$ARCHIVE/services.xml"

echo "==> Importing metadata + service"
b2cx job import "$ARCHIVE" --wait --show-log

# 2. code
echo "==> Deploying cartridge to the active code version"
b2cx code deploy cartridges -c app_headless_preview --reload

# 3. cartridge path: first, so it sits on top of anything else (SFRA, older preview cartridges)
echo "==> Adding app_headless_preview to front of $SITE_ID cartridge path"
if b2cx sites cartridges list --site-id "$SITE_ID" | grep -q 'app_headless_preview'; then
  b2cx sites cartridges remove app_headless_preview --site-id "$SITE_ID"
fi
b2cx sites cartridges add app_headless_preview --site-id "$SITE_ID" --position first

# 4. preference
echo "==> Setting headlessPreviewURL=$PREVIEW_URL"
b2cx preferences site update HeadlessPreview --site-id "$SITE_ID" "c_headlessPreviewURL=$PREVIEW_URL"

# 5. optional demo data: "Big Spenders" campaign + 50% off promotion (RefArchGlobal / storefront-catalog-m-non-en)
if [ "${DEMO_DATA:-0}" = "1" ]; then
  echo "==> Importing demo promotion + reindexing $SITE_ID"
  b2cx job import demo-data --wait --show-log
  b2cx job run sfcc-search-index-product-full-update --wait --body "{\"site_scope\":[\"$SITE_ID\"]}"
fi

echo "Done. Remember: Site Preferences > Hybrid Auth Settings > enable Shopper Context for $SITE_ID (if not already)."
