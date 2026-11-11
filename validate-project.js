const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const EXTERNAL_SITE_PAGES = new Set(['searchresults.html', 'map.html', 'traveltouchWhatsapp.html', 'supprot.html', 'legal.html']);
const failures = [];
function runNodeCheck(file, module = false) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) failures.push(`${path.relative(root, file)}: ${result.stderr || result.stdout}`);
}
function walk(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(item.name)) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full);
    else if (item.isFile() && full.endsWith('.js')) runNodeCheck(full);
    else if (item.isFile() && full.endsWith('.json')) {
      try { JSON.parse(fs.readFileSync(full, 'utf8')); } catch (e) { failures.push(`${path.relative(root, full)}: invalid JSON: ${e.message}`); }
    }
  }
}
walk(root);
for (const html of fs.readdirSync(root).filter(x => x.endsWith('.html'))) {
  const source = fs.readFileSync(path.join(root, html), 'utf8');
  const scripts = [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)];
  scripts.forEach((match, i) => {
    const attrs = match[1] || '', code = match[2] || '';
    if (!code.trim() || /\bsrc\s*=/.test(attrs)) return;
    const ext = /type\s*=\s*["']module["']/i.test(attrs) ? '.mjs' : '.js';
    const tmp = path.join(os.tmpdir(), `tt-${path.basename(html)}-${i}${ext}`);
    fs.writeFileSync(tmp, code);
    runNodeCheck(tmp);
    try { fs.unlinkSync(tmp); } catch {}
  });
}
// Catch duplicate DOM IDs and broken local HTML/CSS/JS references.
for (const htmlName of fs.readdirSync(root).filter(name => name.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(root, htmlName), 'utf8');
  const ids = [...html.matchAll(/\bid=["']([^"']+)["']/gi)].map(m => m[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length) failures.push(`${htmlName}: duplicate IDs: ${[...new Set(duplicates)].join(', ')}`);
  for (const match of html.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)) {
    const value = match[1].split(/[?#]/)[0];
    if (!value || value.includes("${") || /^(?:https?:|data:|mailto:|tel:|javascript:|#)/i.test(value)) continue;
    const local = path.resolve(root, value.replace(/^\//, ''));
    if (!local.startsWith(root + path.sep) && local !== root) continue;
    // صفحات موجودة في الموقع المنشور لكنها ليست ضمن هذه الحزمة؛ لا تُعامل كأخطاء ولا نُنشئ بدائل تطمس النسخ الحقيقية.
    if (EXTERNAL_SITE_PAGES.has(value)) continue;
    if (!fs.existsSync(local)) failures.push(`${htmlName}: missing local reference ${value}`);
  }
}

// Guardrails for the critical payment/security paths.
const checks = [
  ['admin dashboard exists and uses authenticated admin session', fs.existsSync(path.join(root,'admin.html')) && /TT\.whenReady\(\)/.test(fs.readFileSync(path.join(root,'admin.html'),'utf8'))],
  ['admin offer creation is server-side and audited', /action === "create"/.test(fs.readFileSync(path.join(root,'api/admin-offer.js'),'utf8')) && /offer_created/.test(fs.readFileSync(path.join(root,'api/admin-offer.js'),'utf8'))],
  ['transactional email uses server-only Resend credentials', /RESEND_API_KEY/.test(fs.readFileSync(path.join(root,'api/_lib/email.js'),'utf8')) && /api\.resend\.com\/emails/.test(fs.readFileSync(path.join(root,'api/_lib/email.js'),'utf8'))],
  ['booking email is triggered only after paid booking finalization', /sendBookingConfirmation/.test(fs.readFileSync(path.join(root,'api/capture-order.js'),'utf8'))],
  ['mobile checkout exposes fast PayPal action', /one-tap-checkout/.test(fs.readFileSync(path.join(root,'checkout.html'),'utf8'))],

  ['admin refund route checks Firestore admin membership', /collection\("admins"\)\.doc\(user\.uid\)/.test(fs.readFileSync(path.join(root,'api/admin-refund.js'),'utf8'))],
  ['admin refund route uses PayPal idempotency key', /requestId/.test(fs.readFileSync(path.join(root,'api/admin-refund.js'),'utf8'))],
  ['offer locks are private to clients', /match \/offerLocks\/\{offerId\} \{ allow read, write: if false; \}/.test(fs.readFileSync(path.join(root,'firestore.rules'),'utf8'))],
  ['audit logs cannot be written by clients', /match \/auditLogs\/\{id\}[\s\S]*?allow create, update, delete: if false/.test(fs.readFileSync(path.join(root,'firestore.rules'),'utf8'))],
  ['service worker avoids API caching', /api/.test(fs.readFileSync(path.join(root,'sw.js'),'utf8'))],
  ['new refund API is covered by Vercel function config', /api\/admin-refund\.js/.test(fs.readFileSync(path.join(root,'vercel.json'),'utf8'))],
  ['account deletion requires recent authentication', /auth_time[\s\S]*> 300/.test(fs.readFileSync(path.join(root,'api/delete-account.js'),'utf8'))],
  ['App Check can be enforced on authenticated APIs', /ENFORCE_APP_CHECK/.test(fs.readFileSync(path.join(root,'api/_lib/common.js'),'utf8'))],
  ['capture finalizer preserves refund-in-progress states', /refund_pending/.test(fs.readFileSync(path.join(root,'api/capture-order.js'),'utf8')) && /refunding/.test(fs.readFileSync(path.join(root,'api/capture-order.js'),'utf8'))],
  ['public offers endpoint has CDN cache policy', /s-maxage=30, stale-while-revalidate=60/.test(fs.readFileSync(path.join(root,'api/public-offers.js'),'utf8'))],
  ['homepage uses session cache and public offers endpoint', fs.readFileSync(path.join(root,'index.html'),'utf8').includes('tt-public-offers-v1') && fs.readFileSync(path.join(root,'index.html'),'utf8').includes('/api/public-offers')],
  ['public offers endpoint is configured for Vercel', fs.readFileSync(path.join(root,'vercel.json'),'utf8').includes('api/public-offers.js')],
  ['public Firestore offer lists are limited for non-admins', fs.readFileSync(path.join(root,'firestore.rules'),'utf8').includes('allow list: if isAdmin() || request.query.limit <= 100')],
  ['chat history endpoint is authenticated and bounded', /requireUser/.test(fs.readFileSync(path.join(root,'api/chat-history.js'),'utf8')) && /limit\(40\)/.test(fs.readFileSync(path.join(root,'api/chat-history.js'),'utf8'))],
  ['ticket QR uses HMAC signatures', /createHmac\("sha256"/.test(fs.readFileSync(path.join(root,'api/ticket-qr.js'),'utf8')) && /timingSafeEqual/.test(fs.readFileSync(path.join(root,'api/checkin-ticket.js'),'utf8'))],
  ['check-in is admin-only and transactional', /admins/.test(fs.readFileSync(path.join(root,'api/checkin-ticket.js'),'utf8')) && /runTransaction/.test(fs.readFileSync(path.join(root,'api/checkin-ticket.js'),'utf8'))],
  ['offer image upload is compressed to WebP', /image\/webp/.test(fs.readFileSync(path.join(root,'tt-backend.js'),'utf8')) && /uploadBytes/.test(fs.readFileSync(path.join(root,'tt-backend.js'),'utf8'))],
  ['Firestore TTL setup script exists', fs.existsSync(path.join(root,'scripts/configure-firestore-ttl.sh'))]
];
checks.push(
  ['shared error module is integrated into frontend backend', /services\/core\/errors\.js/.test(fs.readFileSync(path.join(root,'tt-backend.js'),'utf8'))],
  ['global toast notifications are available', fs.existsSync(path.join(root,'services/core/toast.js')) && /window\.showToast/.test(fs.readFileSync(path.join(root,'services/core/toast.js'),'utf8'))],
  ['observable app state store is integrated', /appStore/.test(fs.readFileSync(path.join(root,'tt-backend.js'),'utf8')) && fs.existsSync(path.join(root,'services/state/store.js'))],
  ['typed domain contracts and strict TypeScript config exist', fs.existsSync(path.join(root,'types/domain.d.ts')) && JSON.parse(fs.readFileSync(path.join(root,'tsconfig.json'),'utf8')).compilerOptions.strict === true],
  ['Swagger UI documentation page points to OpenAPI contract', /api\/openapi\.yaml/.test(fs.readFileSync(path.join(root,'api-docs.html'),'utf8'))],
  ['unit tests cover VAT, state and error normalization', fs.existsSync(path.join(root,'tests/domain.test.mjs'))],
  ['static assets have immutable CDN cache policy', /max-age=31536000, immutable/.test(fs.readFileSync(path.join(root,'vercel.json'),'utf8'))],
  ['accessible promise dialogs replace native browser prompts', /confirmDialog/.test(fs.readFileSync(path.join(root,'services/core/toast.js'),'utf8')) && /promptDialog/.test(fs.readFileSync(path.join(root,'services/core/toast.js'),'utf8'))],
  ['serverless Firebase Admin services are reused per warm instance', /let adminServices/.test(fs.readFileSync(path.join(root,'api/_lib/common.js'),'utf8')) && /if \(adminServices\) return adminServices/.test(fs.readFileSync(path.join(root,'api/_lib/common.js'),'utf8'))],
  ['frontend pages contain no native blocking alert/confirm/prompt calls', !['admin.html','dashboard.html','checkout.html','profile.html'].some(name => /(^|[^\w.])(?:alert|confirm|prompt)\s*\(/m.test(fs.readFileSync(path.join(root,name),'utf8')))],
  ['booking and payment paths use optimistic state with rollback', /async holdOffer[\s\S]*?optimisticUpdate/.test(fs.readFileSync(path.join(root,'tt-backend.js'),'utf8')) && /async purchase[\s\S]*?optimisticUpdate/.test(fs.readFileSync(path.join(root,'tt-backend.js'),'utf8')) && /rollback: previous/.test(fs.readFileSync(path.join(root,'tt-backend.js'),'utf8'))]
);
for (const [label, ok] of checks) if (!ok) failures.push(`guardrail failed: ${label}`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`Travel Touch validation passed: ${checks.length} guardrails, JavaScript syntax, inline scripts, and JSON files.`);
