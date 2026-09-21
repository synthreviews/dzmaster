#!/usr/bin/env bash
# DZMASTER — one-shot setup for the free-tier usage-limit backend
# (1 mastering/month per IP address, only while the visitor hasn't
# unlocked DZMASTER with a purchased code).
#
# This script automates every step that CAN be automated from the command
# line: installing firebase-tools, logging in, selecting or creating your
# Firebase project, generating and storing the IP-hashing secret, deploying
# the Cloud Function + Firestore rules/indexes, and writing the deployed
# function's URL straight into public/dzmaster.html for you.
#
# Two things Google requires a human to click through -- there is no CLI
# for either, by design on Google's side:
#   1. Enabling the Blaze (pay-as-you-go) billing plan on your project.
#      Cloud Functions simply does not run on the free Spark plan. Blaze
#      still has a large free-of-charge monthly quota (2M function calls,
#      50k Firestore reads/20k writes per day) -- for a tool like this
#      you are very unlikely to ever be charged anything, but Google does
#      require a card on file to enable it.
#   2. The very first `firebase login` (a one-time browser sign-in).
# The script pauses and tells you exactly when to do each of these.
#
# Safe to re-run any time (e.g. after editing functions/index.js) --
# everything here is idempotent.

set -euo pipefail
cd "$(dirname "$0")"

DZMASTER_HTML="../public/dzmaster.html"

echo "== DZMASTER usage-limit backend setup =="
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is required but wasn't found. Install Node 20+ first: https://nodejs.org"
  exit 1
fi

if ! command -v firebase >/dev/null 2>&1; then
  echo "firebase-tools not found globally -- using 'npx firebase-tools' instead (no global install needed)."
  FIREBASE_CMD="npx --yes firebase-tools"
else
  FIREBASE_CMD="firebase"
fi

echo ""
echo "Step 1/7 -- Login"
echo "A browser window will open the first time; firebase-tools remembers you on this machine after that."
$FIREBASE_CMD login --no-localhost 2>/dev/null || $FIREBASE_CMD login

echo ""
echo "Step 2/7 -- Select or create your Firebase project"
if [ -f ".firebaserc" ] && grep -q '"default"' .firebaserc && ! grep -q "YOUR-FIREBASE-PROJECT-ID" .firebaserc; then
  PROJECT_ID=$(node -e "console.log(require('./.firebaserc').projects.default)")
  echo "Using existing .firebaserc -> project: $PROJECT_ID"
else
  read -r -p "Firebase project ID (existing project, or a new one to create -- lowercase letters/digits/hyphens): " PROJECT_ID
  if $FIREBASE_CMD use "$PROJECT_ID" --add >/dev/null 2>&1; then
    echo "Linked to existing project $PROJECT_ID."
  else
    echo "Project not found under your account -- creating it..."
    $FIREBASE_CMD projects:create "$PROJECT_ID" --display-name "DZMASTER"
    $FIREBASE_CMD use "$PROJECT_ID" --add
  fi
fi

echo ""
echo "Step 3/7 -- Blaze (pay-as-you-go) billing plan"
echo "Cloud Functions requires the Blaze plan. If you haven't enabled it yet for"
echo "$PROJECT_ID, open:"
echo "  https://console.firebase.google.com/project/$PROJECT_ID/usage/details"
echo "and click 'Modify plan' -> Blaze. It has a large free monthly quota; a small"
echo "tool like DZMASTER is very unlikely to ever cost anything."
read -r -p "Press Enter once Blaze is enabled for $PROJECT_ID (or if it already is): " _unused

echo ""
echo "Step 4/7 -- Firestore database"
if $FIREBASE_CMD firestore:databases:create '(default)' --location=eur3 --type=firestore-native --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "Created the (default) Firestore database (eur3 / Native mode)."
else
  echo "Could not create it automatically (most likely it already exists, which is fine)."
  echo "If deploy fails below with a 'database does not exist' error, create it once manually:"
  echo "  Firebase console -> Firestore Database -> Create database -> Production mode -> a region near your users."
fi

echo ""
echo "Step 5/7 -- IP-hashing secret"
if $FIREBASE_CMD functions:secrets:access USAGE_IP_PEPPER --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "USAGE_IP_PEPPER secret already set -- leaving it as is (changing it would let everyone's monthly counter reset early)."
else
  PEPPER=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  if printf '%s' "$PEPPER" | $FIREBASE_CMD functions:secrets:set USAGE_IP_PEPPER --project "$PROJECT_ID" --data-file=-; then
    echo "Generated and stored a random secret pepper (used to hash IP addresses -- never logged, never stored in Firestore or in this repo)."
  else
    echo "Could not set the secret automatically. Set it once manually:"
    echo "  firebase functions:secrets:set USAGE_IP_PEPPER --project $PROJECT_ID"
    echo "  (paste any long random string when prompted)"
  fi
fi

echo ""
echo "Step 6/7 -- Install function dependencies"
(cd functions && npm install --omit=dev)

echo ""
echo "Step 7/7 -- Deploy Firestore rules/indexes + the Cloud Function"
DEPLOY_LOG="$(mktemp)"
$FIREBASE_CMD deploy --only firestore:rules,firestore:indexes,functions --project "$PROJECT_ID" 2>&1 | tee "$DEPLOY_LOG"

FN_URL="$(grep -oE 'https://[A-Za-z0-9.-]+\.(run\.app|cloudfunctions\.net)[A-Za-z0-9/_-]*' "$DEPLOY_LOG" | head -1 || true)"

echo ""
if [ -n "${FN_URL:-}" ]; then
  echo "Deployed function URL: $FN_URL"
  if [ -f "$DZMASTER_HTML" ]; then
    sed -i.bak -E "s#var USAGE_API_URL = '[^']*';#var USAGE_API_URL = '$FN_URL';#" "$DZMASTER_HTML"
    rm -f "${DZMASTER_HTML}.bak"
    echo "Updated $DZMASTER_HTML with this URL automatically. Nothing else to edit."
  else
    echo "Could not find $DZMASTER_HTML from here -- open public/dzmaster.html yourself,"
    echo "search for USAGE_API_URL and paste this URL as its value."
  fi
else
  echo "Couldn't auto-detect the function URL from the deploy output above."
  echo "Open the Firebase console -> Functions -> checkMasteringUsage, copy its Trigger URL,"
  echo "then open public/dzmaster.html, search for USAGE_API_URL and paste it in as the value."
fi
rm -f "$DEPLOY_LOG"

echo ""
echo "== Done =="
echo "The free tier (Smart Auto, before unlocking) is now capped at 1 mastering/month"
echo "per IP address. Once a visitor unlocks with a purchased code, this check is"
echo "skipped entirely -- no limit of any kind. The audio file itself is still never"
echo "sent anywhere; this function only ever answers yes/no."
echo ""
echo "If you ever host DZMASTER on another domain, add it to ALLOWED_ORIGINS in"
echo "functions/index.js and re-run this script (or just 'firebase deploy --only functions')."
echo ""
echo "Note on limits: like the password unlock, this is a best-effort anti-abuse"
echo "measure, not a hard guarantee -- a visitor on a VPN or with a dynamic IP can"
echo "get more than one free mastering a month. That's an accepted trade-off, not a bug."
