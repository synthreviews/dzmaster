/**
 * DZMASTER — free-tier usage limiter
 * =====================================================================
 * The mastering tool itself is still 100% client-side: audio is analyzed,
 * processed and exported entirely in the visitor's browser. This is the
 * ONLY server call the page ever makes, and it never receives or sees the
 * audio file -- it answers a single yes/no question: "has this IP address
 * already used its 1 free mastering this calendar month?"
 *
 * Once a visitor unlocks DZMASTER with a code purchased on Gumroad, the
 * client skips this check entirely (see dzmaster.html) -- there is no
 * limit of any kind after unlocking.
 *
 * Privacy: the visitor's IP address is never stored. It is hashed
 * (HMAC-SHA256 with a server-only secret pepper) the moment the request
 * arrives, and only that hash -- combined with the current month -- is
 * written to Firestore, as the ID of a document holding nothing but a
 * count and two timestamps. There is no way to recover an IP address from
 * the stored hash, and the counter document for a given month is
 * automatically deleted by Firestore's TTL policy about 60 days later
 * (see /firebase/README.md and setup.sh).
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { logger } = require('firebase-functions');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();

// ---------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------

// How many free masterings a single IP address gets per calendar month
// before the client is told to unlock via Gumroad. Only applies while the
// visitor has not unlocked DZMASTER -- unlocked visitors never call this
// function at all.
const FREE_MASTERS_PER_MONTH = 1;

// How long a monthly counter document is kept before Firestore's TTL
// policy deletes it automatically (a little past the month it covers, so
// there's no risk of deleting an in-progress month early).
const COUNTER_TTL_DAYS = 62;

// Browser origins allowed to call this function. Add any other domain you
// ever host DZMASTER on. localhost entries only matter for local testing
// and are harmless to leave in production.
const ALLOWED_ORIGINS = [
  'https://synthreviews.github.io',
  'http://localhost:8080',
  'http://localhost:8791',
  'http://127.0.0.1:8080',
  'http://127.0.0.1:8791'
];

// Secret pepper mixed into the IP hash so the stored hash can't be
// brute-forced back into an IP address even if the Firestore data were
// ever exposed. Set once with:
//   firebase functions:secrets:set USAGE_IP_PEPPER
// (setup.sh does this for you with a random value if you don't set your
// own). Never logged, never returned to the client.
const IP_PEPPER = defineSecret('USAGE_IP_PEPPER');

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function pickClientIp(req) {
  // Cloud Functions (2nd gen) runs behind Google Front End, which sets
  // X-Forwarded-For itself for every request -- it does not simply relay
  // whatever a client sends. The first entry in that header is the
  // connecting client's real IP; any values a client tried to inject
  // before it are appended by GFE, not prepended, so they end up after
  // the real one, not before it.
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.ip || 'unknown';
}

function hashIp(ip, pepper) {
  return crypto.createHmac('sha256', pepper).update(ip).digest('hex');
}

function monthKeyUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  return y + '-' + m;
}

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '3600');
}

// ---------------------------------------------------------------------
// The function
// ---------------------------------------------------------------------

exports.checkMasteringUsage = onRequest(
  { region: 'europe-west3', secrets: [IP_PEPPER], cors: false, maxInstances: 10 },
  async (req, res) => {
    applyCors(req, res);

    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }
    if (req.method !== 'POST') {
      res.status(405).json({ allowed: true, error: 'method_not_allowed' });
      return;
    }

    try {
      const ip = pickClientIp(req);
      const pepper = IP_PEPPER.value() || 'dzmaster-dev-only-pepper';
      const ipHash = hashIp(ip, pepper);
      const now = new Date();
      const monthKey = monthKeyUtc(now);
      const docId = ipHash + '_' + monthKey;
      const ref = admin.firestore().collection('usage').doc(docId);

      const allowed = await admin.firestore().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const current = snap.exists ? (snap.data().count || 0) : 0;
        if (current >= FREE_MASTERS_PER_MONTH) {
          return false;
        }
        const expiresAt = admin.firestore.Timestamp.fromMillis(
          now.getTime() + COUNTER_TTL_DAYS * 24 * 60 * 60 * 1000
        );
        tx.set(
          ref,
          {
            count: current + 1,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: expiresAt
          },
          { merge: true }
        );
        return true;
      });

      res.status(200).json({ allowed: allowed });
    } catch (err) {
      // Fail OPEN: a backend hiccup should never block a legitimate free
      // user from mastering their track. Log it so it's visible in Cloud
      // Functions logs, but let the request through.
      logger.error('checkMasteringUsage failed, failing open', err);
      res.status(200).json({ allowed: true, error: 'internal_error' });
    }
  }
);
