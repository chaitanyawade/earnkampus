/**
 * EarnKampus API — Supabase (Postgres) edition
 *
 * Changes vs the in-memory version:
 * - All data lives in Supabase, so it survives restarts and works on Vercel.
 * - Sessions are a signed JWT in an HttpOnly cookie (express-session's memory
 *   store does not work on serverless).
 * - Signup needs an emailed 6-digit code; the college comes from the email domain (colleges table).
 * - Exact GPS is no longer stored. Only a text address/area is kept.
 * - New: ratings (POST /api/posts/:id/rate) and reports (POST /api/reports).
 *
 * Required env vars: SUPABASE_URL, SUPABASE_SERVICE_KEY, JWT_SECRET, ALLOWED_ORIGINS
 * For OTP email: GMAIL_USER, GMAIL_APP_PASSWORD (if unset in development, codes print in the console)
 */

'use strict';

const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.set('trust proxy', 1); // Vercel sits behind a proxy

// ─── Config ───────────────────────────────────────────────────────────────────

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const BCRYPT_ROUNDS = 12;
const MAX_FAILED_LOGINS = 10;                 // wrong passwords before the account is paused
const LOGIN_LOCK_MS = 15 * 60 * 1000;         // ...for 15 minutes
const DUMMY_HASH = bcrypt.hashSync('earnkampus-timing-dummy', BCRYPT_ROUNDS); // so unknown emails cost the same time as real ones
const COOKIE_NAME = 'earncampus_sid';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  if (IS_PRODUCTION) throw new Error('JWT_SECRET must be set in production.');
  // Development only: a random secret per run, so there is never a guessable default (sessions reset on restart)
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[EarnKampus] JWT_SECRET is not set. Using a temporary random secret; logins reset on restart.');
}
if (IS_PRODUCTION && JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production.');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY must be set.');
}
const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
  .split(',').map(o => o.trim()).filter(Boolean);

// Email (OTP) sending through a Gmail account + App Password.
// If these are not set (local development only), codes are printed in the server console instead.
const MAIL_USER = process.env.GMAIL_USER;
const MAIL_PASS = process.env.GMAIL_APP_PASSWORD;
const mailer = MAIL_USER && MAIL_PASS
  ? nodemailer.createTransport({ service: 'gmail', auth: { user: MAIL_USER, pass: MAIL_PASS } })
  : null;
if (!mailer && IS_PRODUCTION) throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD must be set in production.');

const OTP_TTL_MS = 10 * 60 * 1000;     // code valid for 10 minutes
const OTP_MAX_ATTEMPTS = 5;            // wrong guesses before the signup must be restarted
const OTP_RESEND_MS = 60 * 1000;
const OTP_LOCK_MS = 60 * 60 * 1000;   // wrong guesses carry over to new codes for this long
const DEV_OTP = !mailer && !IS_PRODUCTION && process.env.ALLOW_DEV_OTP === 'true'; // show codes in the API reply: explicit opt-in, local only       // minimum gap between sends to the same email

const LIMITS = {
  name: 80, email: 254, password: { min: 8, max: 72 }, title: 120, details: 2000,
  college: 120, message: 2000, search: 100, price: { max: 100000 },
  comment: 500, reason: 500,
};
const VALID_TYPES = ['need', 'offer'];
const VALID_CATEGORIES = ['Delivery', 'Tutoring', 'Printing', 'Equipment', 'Physical', 'Other'];
const VALID_STATUSES = ['open', 'in_progress', 'completed'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

const genId = (prefix = '') => prefix + crypto.randomBytes(12).toString('hex');

/** Wrap async handlers so rejected promises reach the error handler (Express 4). */
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function containsPollutionKey(val, depth = 0) {
  if (depth > 10 || val === null || typeof val !== 'object') return false;
  for (const key of Object.keys(val)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') return true;
    if (containsPollutionKey(val[key], depth + 1)) return true;
  }
  return false;
}
function rejectPollution(req, res, next) {
  if (req.body && containsPollutionKey(req.body)) {
    return res.status(400).json({ success: false, error: 'Invalid request: malicious property detected.' });
  }
  next();
}

function validateString(val, fieldName, maxLen, required = true) {
  if (val === undefined || val === null || val === '') return required ? `${fieldName} is required.` : null;
  if (typeof val !== 'string') return `${fieldName} must be a string.`;
  if (val.length > maxLen) return `${fieldName} must be at most ${maxLen} characters.`;
  return null;
}

/** "Rahul+x@College.edu" -> "rahul@college.edu" so tricks like +tags can't create extra accounts. */
function canonicalEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return null;
  const local = e.slice(0, at).split('+')[0];
  const domain = e.slice(at + 1);
  if (!local || !domain || !/^[a-z0-9.-]+\.[a-z0-9-]+$/.test(domain)) return null;
  return `${local}@${domain}`;
}

/** College name from the email's domain (also matches subdomains, e.g. students.iitb.ac.in). */
async function collegeForEmail(email) {
  const domain = email.split('@')[1].toLowerCase();
  const parts = domain.split('.');
  const candidates = [];
  for (let i = 0; i < parts.length - 1; i++) candidates.push(parts.slice(i).join('.'));
  const { data, error } = await db.from('colleges').select('domain,name').in('domain', candidates);
  if (error) throw error;
  if (!data.length) return null;
  data.sort((x, y) => y.domain.length - x.domain.length); // most specific domain wins
  return data[0].name;
}

/** Collapse extra spaces so "Rahul   Sharma " and "Rahul Sharma" are the same name. */
const normalizeName = name => String(name || '').trim().replace(/\s+/g, ' ');

/** Is this display name already used by someone else at the same college (ignoring letter case)? */
async function nameTaken(college, name, exceptUserId) {
  const pattern = name.replace(/[\\%_]/g, m => '\\' + m); // match the name literally, not as a wildcard
  let q = db.from('users').select('id').eq('college', college).ilike('name', pattern).limit(1);
  if (exceptUserId) q = q.neq('id', exceptUserId);
  const { data, error } = await q;
  if (error) throw error;
  return data.length > 0;
}

const NAME_TAKEN_MESSAGE = 'That name is already taken at your college. Add your surname or an initial so people can tell you apart.';

/** Wrong guesses carry over to new codes for an hour, so asking for fresh codes cannot reset the limit. */
function otpWindow(pending) {
  const recent = !!pending && (Date.now() - new Date(pending.last_sent_at).getTime()) < OTP_LOCK_MS;
  return { locked: recent && pending.attempts >= OTP_MAX_ATTEMPTS, carry: recent ? pending.attempts : 0 };
}

const hashOtp = (emailKey, code) => crypto.createHmac('sha256', JWT_SECRET).update(`${emailKey}:${code}`).digest('hex');
const newOtp = () => String(crypto.randomInt(100000, 1000000));

async function sendOtpEmail(to, code, purpose = 'verify') {
  if (!mailer) { console.log(`[EarnKampus DEV] ${purpose} code for ${to}: ${code}`); return; }
  const isReset = purpose === 'reset';
  const subject = isReset ? 'Reset your EarnKampus password' : 'Your EarnKampus verification code';
  const intro = isReset ? 'Use this code to reset your EarnKampus password:' : 'Your verification code is:';
  await mailer.sendMail({
    from: `"EarnKampus" <${MAIL_USER}>`,
    to,
    subject,
    text: `${intro} ${code}. It expires in 10 minutes. If you did not request this, ignore this email.`,
    html: `<div style="font-family:sans-serif;max-width:420px"><h2>EarnKampus</h2><p>${intro}</p><p style="font-size:32px;font-weight:800;letter-spacing:6px">${code}</p><p style="color:#666">It expires in 10 minutes. If you did not request this, you can ignore this email and your password stays the same.</p></div>`,
  });
}

function setSessionCookie(res, userId) {
  const token = jwt.sign({ uid: userId }, JWT_SECRET, { expiresIn: '7d', algorithm: 'HS256' });
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: IS_PRODUCTION ? 'strict' : 'lax',
    maxAge: SESSION_MS,
  });
}

const sessionUser = u => ({ id: u.id, name: u.name, email: u.email, college: u.college, avatar: u.avatar });

const toPost = p => ({
  id: p.id, type: p.type, title: p.title, details: p.details, price: p.price,
  college: p.college, category: p.category,
  authorId: p.author_id, author: p.author, status: p.status, createdAt: p.created_at, editedAt: p.edited_at || null,
  interestedUsers: p.interested_users || [],
  selectedUser: p.selected_user, selectedUserId: p.selected_user_id,
});

const toMessage = m => ({
  id: m.id, senderId: m.sender_id, senderName: m.sender_name,
  receiverId: m.receiver_id, receiverName: m.receiver_name, text: m.text, timestamp: m.created_at,
  readAt: m.read_at || null,
});

function publicProfile(u, rating) {
  return {
    id: u.id, name: u.name, college: u.college, avatar: u.avatar,
    // Trust signals instead of GPS
    ratingAvg: rating ? rating.avg : null,
    ratingCount: rating ? rating.count : 0,
    // Times a poster had to replace this person after accepting them (no-shows)
    cancelledCount: rating ? (rating.cancelled || 0) : 0,
    // NOTE: no lat/lng/address is ever returned publicly
  };
}

async function ratingFor(userId) {
  const { data, error } = await db.from('ratings').select('score').eq('ratee_id', userId);
  if (error) throw error;
  const count = data.length;
  const avg = count ? Math.round((data.reduce((a, r) => a + r.score, 0) / count) * 10) / 10 : null;
  const { count: cancelled, error: e2 } = await db.from('task_cancellations')
    .select('id', { count: 'exact', head: true }).eq('user_id', userId).eq('reason', 'reassigned');
  if (e2) throw e2;
  return { avg, count, cancelled: cancelled || 0 };
}

/** Logged-in user if there is a valid session, otherwise null (never errors). */
async function optionalUser(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const { data } = await db.from('users').select('id,college').eq('id', payload.uid).maybeSingle();
    return data || null;
  } catch { return null; }
}

const requireAuth = ah(async (req, res, next) => {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ success: false, error: 'Authentication required.' });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }); }
  catch { res.clearCookie(COOKIE_NAME); return res.status(401).json({ success: false, error: 'Session invalid. Please log in again.' }); }

  const { data: user, error } = await db.from('users').select('id,name,email,college,avatar,password_changed_at').eq('id', payload.uid).maybeSingle();
  if (error) throw error;
  if (!user) { res.clearCookie(COOKIE_NAME); return res.status(401).json({ success: false, error: 'Session invalid. Please log in again.' }); }
  // A password reset invalidates every session created before it
  if (user.password_changed_at && payload.iat * 1000 < Math.floor(new Date(user.password_changed_at).getTime() / 1000) * 1000) {
    res.clearCookie(COOKIE_NAME);
    return res.status(401).json({ success: false, error: 'Session expired. Please log in again.' });
  }
  const { password_changed_at, ...safeUser } = user; // eslint-disable-line no-unused-vars
  req.user = safeUser;
  next();
});

// ─── Middleware ───────────────────────────────────────────────────────────────

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(IS_PRODUCTION ? ['upgrade-insecure-requests'] : []),
  ].join('; '));
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store'); // never cache account data
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  next();
});
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error('CORS: origin not allowed.'), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));
// CSRF defence in depth (on top of SameSite cookies): refuse state-changing requests from other sites
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  const origin = req.get('origin');
  if (origin) {
    let ok = ALLOWED_ORIGINS.includes(origin);
    if (!ok) { try { ok = new URL(origin).host === req.get('host'); } catch { ok = false; } }
    if (!ok) return res.status(403).json({ success: false, error: 'Cross-site request blocked.' });
  } else if (req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ success: false, error: 'Cross-site request blocked.' });
  }
  next();
});
app.use(express.json({ limit: '32kb' })); // JSON only: HTML form posts are never needed
app.use(cookieParser());
app.use(rejectPollution);
app.disable('x-powered-by');

// Brute-force protection on login/signup
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: IS_PRODUCTION ? 120 : 1000, // backstop only: a whole campus can share one IP. Real limits are per account/email, stored in the database
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many attempts. Try again later.' },
});

// ─── Keep payments on the platform ────────────────────────────────────────────
// Prices are fixed on the post. These checks stop posts and messages from arranging extra money,
// cash, phone numbers or payment apps, which would let people skip the platform (and its fee later).
// A filter cannot catch everything, so it works together with reports ("Asked me to pay outside EarnKampus").

const OFFPLATFORM_LABELS = {
  contact: 'email addresses or payment IDs',
  phone: 'phone numbers',
  link: 'links',
  app: 'chat or payment apps',
  bypass: 'payment arrangements outside EarnKampus',
  amount: 'prices or amounts',
};

const BYPASS_PHRASES = [
  /\boutside\s+(?:the\s+)?(?:app|platform|site|website|earnkampus)\b/i,
  /\boff[\s-]*(?:the[\s-]*)?(?:app|platform)\b/i,
  /\bwithout\s+(?:the\s+)?(?:app|platform|fees?|commission)\b/i,
  /\bpay(?:ing)?\s+(?:me\s+|you\s+)?direct(?:ly)?\b/i,
  /\bdirect\s+pay(?:ment)?\b/i,
  /\bsave\s+(?:the\s+|your\s+)?(?:fees?|commission|charges?)\b/i,
  /\bno\s+(?:fees?|commission|charges?)\b/i,
  /\bcash\b/i,
  /\b(?:extra|more|additional)\s+(?:money|cash|amount|payment|rupees|rs)\b/i,
  /\bmore\s+than\s+(?:the\s+)?(?:price|amount|listed|posted|set|mentioned)\b/i,
  /\b(?:pay|give)\s+(?:you\s+|me\s+)?(?:more|extra)\b/i,
];

/**
 * Returns the kinds of off-platform arrangements found in a text, e.g. ['phone', 'bypass'].
 * strict:true  = posts (also rejects any price written in the text: the price box is the only price)
 * strict:false = chat (a price is only a problem when it is being negotiated)
 */
function offPlatformIssues(text, { strict }) {
  const flat = String(text || '').replace(/[\u200b-\u200f\u2060\ufeff]/g, ''); // zero-width characters used to dodge filters
  const squashed = flat.toLowerCase().replace(/[^a-z0-9]/g, '');               // "w h a t s a p p" -> "whatsapp"
  const found = [];
  if (/(?:\+?91[\s.\-]*)?[6-9](?:[\s.\-()]*\d){9}/.test(flat)) found.push('phone');
  if (/[a-z0-9._%+-]{2,}@[a-z0-9.-]{2,}/i.test(flat)) found.push('contact');
  if (/(?:https?:\/\/|www\.)|\b[a-z0-9-]+\.(?:com|in|me|io|app|co|xyz|link|ly|gl)\b/i.test(flat)) found.push('link');
  // Payment apps are always a problem. Chat apps only when someone is being asked to use them ("WhatsApp me"),
  // so a post like "Instagram reel editing help" is fine.
  const payApp = /(gpay|googlepay|phonepe|paytm)/.test(squashed) || /\b(?:upi|bhim)\b/i.test(flat);
  const chatApp = /(whatsapp|watsapp|whtsapp|telegram|instagram|snapchat)/.test(squashed) || /\binsta\b/i.test(flat);
  const contactIntent = /\b(me|on|at|via|dm|dms|contact|call|text|ping|add|id|handle|number|reach|chat|message|msg|send|use)\b/i.test(flat);
  if (payApp || (chatApp && contactIntent)) found.push('app');
  if (BYPASS_PHRASES.some(rx => rx.test(flat))) found.push('bypass');
  const hasAmount = /(?:₹|\brs\.?|\binr\b|rupees?)\s?\d|\d\s?(?:₹|\brs\b|rupees?)/i.test(flat);
  if (hasAmount && (strict || /\b(extra|more|less|instead|discount|negotiat\w*|bargain|tip|bonus|on top|additional|double|half)\b/i.test(flat))) found.push('amount');
  return found;
}

function offPlatformMessage(issues, where) {
  const list = issues.map(i => OFFPLATFORM_LABELS[i]).join(', ');
  return where === 'post'
    ? `Your post can't include ${list}. Put the price in the price box, and keep contact details and payment arrangements out of the text. Payments must stay on EarnKampus.`
    : `Your message can't include ${list}. Payments must stay on EarnKampus at the price listed on the post.`;
}

/** Phone numbers may be shared in chat once the two people have a booking together. */
async function haveBookingTogether(userA, userB) {
  for (const [provider, customer] of [[userA, userB], [userB, userA]]) {
    const { data: mine, error } = await db.from('assignments').select('post_id').eq('user_id', customer);
    if (error) throw error;
    const ids = mine.map(a => a.post_id).filter(id => /^[A-Za-z0-9_]+$/.test(id)).slice(0, 100);
    if (!ids.length) continue;
    const { data: posts, error: e2 } = await db.from('posts').select('id').in('id', ids).eq('author_id', provider).limit(1);
    if (e2) throw e2;
    if (posts.length) return true;
  }
  return false;
}

/** Per-logged-in-user limit for actions that could be used to spam others. */
function userLimiter(max, windowMs, what) {
  return rateLimit({
    windowMs,
    max: IS_PRODUCTION ? max : max * 20,
    standardHeaders: true,
    legacyHeaders: false,
    validate: false,
    keyGenerator: req => (req.user && req.user.id) || req.ip,
    message: { success: false, error: `Too many ${what}. Please slow down and try again later.` },
  });
}
const messageLimiter = userLimiter(60, 10 * 60 * 1000, 'messages');
const postLimiter = userLimiter(20, 60 * 60 * 1000, 'new posts');
const offerLimiter = userLimiter(60, 60 * 60 * 1000, 'offers');
const reportLimiter = userLimiter(10, 60 * 60 * 1000, 'reports');
const profileLimiter = userLimiter(10, 60 * 60 * 1000, 'profile changes');

// ─── Auth routes ──────────────────────────────────────────────────────────────

/**
 * Signup is 2 steps. No account exists until the emailed code is verified.
 *   1. POST /api/auth/signup/start   { name, email, password }  -> emails a 6-digit code
 *   2. POST /api/auth/signup/verify  { email, code }            -> creates the account, logs in
 *      POST /api/auth/signup/resend  { email }                  -> new code (60s cooldown)
 * The college name comes from the email domain (colleges table), never from user input.
 */
app.post('/api/auth/signup/start', authLimiter, ah(async (req, res) => {
  const { name, email, password } = req.body;

  for (const [val, label, max] of [[name, 'Name', LIMITS.name], [email, 'Email', LIMITS.email]]) {
    const err = validateString(val, label, max);
    if (err) return res.status(400).json({ success: false, error: err });
  }
  const cleanEmail = email.trim().toLowerCase();
  const emailKey = canonicalEmail(cleanEmail);
  if (!emailKey || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
    return res.status(400).json({ success: false, error: 'Invalid email address.' });
  }
  const pwErr = validateString(password, 'Password', LIMITS.password.max);
  if (pwErr) return res.status(400).json({ success: false, error: pwErr });
  if (password.length < LIMITS.password.min) {
    return res.status(400).json({ success: false, error: `Password must be at least ${LIMITS.password.min} characters.` });
  }

  const college = await collegeForEmail(cleanEmail);
  if (!college) {
    return res.status(400).json({ success: false, error: 'EarnKampus is not open for this email domain yet. Please use your official college email.' });
  }

  const { data: existing, error: e1 } = await db.from('users').select('id').eq('email_canonical', emailKey).maybeSingle();
  if (e1) throw e1;
  if (existing) return res.status(409).json({ success: false, error: 'An account with that email already exists. Please log in.' });

  const cleanName = normalizeName(name);
  if (cleanName.length < 2) return res.status(400).json({ success: false, error: 'Name must be at least 2 characters.' });
  if (await nameTaken(college, cleanName)) return res.status(409).json({ success: false, error: NAME_TAKEN_MESSAGE });

  const { data: pending, error: e2 } = await db.from('email_otps').select('last_sent_at,attempts').eq('email_key', emailKey).maybeSingle();
  if (e2) throw e2;
  if (pending) {
    const wait = OTP_RESEND_MS - (Date.now() - new Date(pending.last_sent_at).getTime());
    if (wait > 0) return res.status(429).json({ success: false, error: `Please wait ${Math.ceil(wait / 1000)} seconds before requesting another code.` });
  }
  const win = otpWindow(pending);
  if (win.locked) return res.status(429).json({ success: false, error: 'Too many wrong attempts for this email. Please try again in an hour.' });

  const code = newOtp();
  const { error: e3 } = await db.from('email_otps').upsert({
    email_key: emailKey,
    email: cleanEmail,
    name: cleanName.slice(0, LIMITS.name),
    password_hash: await bcrypt.hash(password, BCRYPT_ROUNDS),
    code_hash: hashOtp(emailKey, code),
    expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    attempts: win.carry,
    last_sent_at: new Date().toISOString(),
  });
  if (e3) throw e3;

  try { await sendOtpEmail(cleanEmail, code); }
  catch (err) {
    console.error('OTP email failed:', err.message || err);
    await db.from('email_otps').delete().eq('email_key', emailKey);
    return res.status(502).json({ success: false, error: 'Could not send the verification email. Please try again.' });
  }

  const body = { success: true, message: `We sent a 6-digit code to ${cleanEmail}. Check your spam folder too.`, resendAfter: OTP_RESEND_MS / 1000 };
  if (DEV_OTP) body.devCode = code;
  return res.json(body);
}));

app.post('/api/auth/signup/resend', authLimiter, ah(async (req, res) => {
  const emailKey = canonicalEmail(req.body.email);
  if (!emailKey) return res.status(400).json({ success: false, error: 'Invalid email address.' });

  const { data: pending, error } = await db.from('email_otps').select('*').eq('email_key', emailKey).maybeSingle();
  if (error) throw error;
  if (!pending) return res.status(400).json({ success: false, error: 'No pending signup for this email. Please start again.' });

  const wait = OTP_RESEND_MS - (Date.now() - new Date(pending.last_sent_at).getTime());
  if (wait > 0) return res.status(429).json({ success: false, error: `Please wait ${Math.ceil(wait / 1000)} seconds before requesting another code.` });

  const win = otpWindow(pending);
  if (win.locked) return res.status(429).json({ success: false, error: 'Too many wrong attempts for this email. Please try again in an hour.' });

  const code = newOtp();
  const { error: e2 } = await db.from('email_otps').update({
    code_hash: hashOtp(emailKey, code),
    expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    attempts: win.carry,
    last_sent_at: new Date().toISOString(),
  }).eq('email_key', emailKey);
  if (e2) throw e2;

  try { await sendOtpEmail(pending.email, code); }
  catch (err) {
    console.error('OTP email failed:', err.message || err);
    return res.status(502).json({ success: false, error: 'Could not send the verification email. Please try again.' });
  }
  const body = { success: true, message: 'A new code was sent.', resendAfter: OTP_RESEND_MS / 1000 };
  if (DEV_OTP) body.devCode = code;
  return res.json(body);
}));

app.post('/api/auth/signup/verify', authLimiter, ah(async (req, res) => {
  const emailKey = canonicalEmail(req.body.email);
  const code = req.body.code;
  if (!emailKey) return res.status(400).json({ success: false, error: 'Invalid email address.' });
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return res.status(400).json({ success: false, error: 'Enter the 6-digit code.' });

  const { data: pending, error } = await db.from('email_otps').select('*').eq('email_key', emailKey).maybeSingle();
  if (error) throw error;
  if (!pending) return res.status(400).json({ success: false, error: 'No pending signup for this email. Please start again.' });

  if (new Date(pending.expires_at).getTime() < Date.now()) {
    return res.status(400).json({ success: false, error: 'This code has expired. Please request a new one.' });
  }
  if (pending.attempts >= OTP_MAX_ATTEMPTS) {
    return res.status(429).json({ success: false, error: 'Too many wrong attempts for this email. Please try again in an hour.' });
  }

  const given = Buffer.from(hashOtp(emailKey, code.trim()), 'hex');
  const real = Buffer.from(pending.code_hash, 'hex');
  if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
    await db.from('email_otps').update({ attempts: pending.attempts + 1 }).eq('email_key', emailKey);
    const left = OTP_MAX_ATTEMPTS - pending.attempts - 1;
    return res.status(400).json({ success: false, error: `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` });
  }

  // Code is correct: the college is read from the verified email address
  const college = await collegeForEmail(pending.email);
  if (!college) return res.status(400).json({ success: false, error: 'This email domain is no longer supported.' });

  if (await nameTaken(college, pending.name)) return res.status(409).json({ success: false, error: NAME_TAKEN_MESSAGE + ' Please start signup again.' });

  const row = {
    id: genId('u'),
    name: pending.name,
    email: pending.email,
    email_canonical: emailKey,
    password_hash: pending.password_hash,
    college,
    avatar: null,
  };
  const { error: e2 } = await db.from('users').insert(row);
  if (e2) {
    if (e2.code === '23505') {
      const nameClash = /college_name/.test(`${e2.message} ${e2.details || ''}`);
      return res.status(409).json({ success: false, error: nameClash ? NAME_TAKEN_MESSAGE + ' Please start signup again.' : 'An account with that email already exists. Please log in.' });
    }
    throw e2;
  }
  await db.from('email_otps').delete().eq('email_key', emailKey);

  setSessionCookie(res, row.id);
  return res.status(201).json({ success: true, user: sessionUser(row) });
}));

/**
 * Forgot password (2 steps, same email-code idea as signup)
 *   POST /api/auth/forgot/start  { email }                       -> emails a 6-digit code
 *   POST /api/auth/forgot/reset  { email, code, newPassword }    -> sets the new password
 * The reply to /start is identical whether or not the email has an account (no account guessing).
 */
const RESET_MESSAGE = 'If an account exists for that email, we sent a 6-digit code to it. Check your spam folder too.';

app.post('/api/auth/forgot/start', authLimiter, ah(async (req, res) => {
  const emailKey = canonicalEmail(req.body.email);
  if (!emailKey) return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });

  const body = { success: true, message: RESET_MESSAGE, resendAfter: OTP_RESEND_MS / 1000 };

  const { data: user, error } = await db.from('users').select('id,email').eq('email_canonical', emailKey).maybeSingle();
  if (error) throw error;
  if (!user) return res.json(body);

  const { data: pending, error: e2 } = await db.from('password_resets').select('last_sent_at,attempts').eq('email_key', emailKey).maybeSingle();
  if (e2) throw e2;
  if (pending && OTP_RESEND_MS - (Date.now() - new Date(pending.last_sent_at).getTime()) > 0) return res.json(body); // too soon: stay silent
  const win = otpWindow(pending);
  if (win.locked) return res.json(body); // too many wrong guesses recently: stay silent

  const code = newOtp();
  const { error: e3 } = await db.from('password_resets').upsert({
    email_key: emailKey,
    code_hash: hashOtp('reset:' + emailKey, code),
    expires_at: new Date(Date.now() + OTP_TTL_MS).toISOString(),
    attempts: win.carry,
    last_sent_at: new Date().toISOString(),
  });
  if (e3) throw e3;

  try { await sendOtpEmail(user.email, code, 'reset'); }
  catch (err) { console.error('Reset email failed:', err.message || err); }

  if (DEV_OTP) body.devCode = code;
  return res.json(body);
}));

app.post('/api/auth/forgot/reset', authLimiter, ah(async (req, res) => {
  const emailKey = canonicalEmail(req.body.email);
  const { code, newPassword } = req.body;
  if (!emailKey) return res.status(400).json({ success: false, error: 'Invalid email address.' });
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return res.status(400).json({ success: false, error: 'Enter the 6-digit code.' });
  const pwErr = validateString(newPassword, 'Password', LIMITS.password.max);
  if (pwErr) return res.status(400).json({ success: false, error: pwErr });
  if (newPassword.length < LIMITS.password.min) {
    return res.status(400).json({ success: false, error: `Password must be at least ${LIMITS.password.min} characters.` });
  }

  const { data: pending, error } = await db.from('password_resets').select('*').eq('email_key', emailKey).maybeSingle();
  if (error) throw error;
  const invalid = { success: false, error: 'Invalid or expired code. Please request a new one.' };
  if (!pending) return res.status(400).json(invalid);
  if (new Date(pending.expires_at).getTime() < Date.now()) return res.status(400).json(invalid);
  if (pending.attempts >= OTP_MAX_ATTEMPTS) {
    return res.status(429).json({ success: false, error: 'Too many wrong attempts for this email. Please try again in an hour.' });
  }

  const given = Buffer.from(hashOtp('reset:' + emailKey, code.trim()), 'hex');
  const real = Buffer.from(pending.code_hash, 'hex');
  if (given.length !== real.length || !crypto.timingSafeEqual(given, real)) {
    await db.from('password_resets').update({ attempts: pending.attempts + 1 }).eq('email_key', emailKey);
    const left = OTP_MAX_ATTEMPTS - pending.attempts - 1;
    return res.status(400).json({ success: false, error: `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` });
  }

  const { error: e2 } = await db.from('users').update({
    password_hash: await bcrypt.hash(newPassword, BCRYPT_ROUNDS),
    password_changed_at: new Date().toISOString(), // logs out all older sessions
    failed_login_count: 0,
    login_locked_until: null,
  }).eq('email_canonical', emailKey);
  if (e2) throw e2;
  await db.from('password_resets').delete().eq('email_key', emailKey);

  res.clearCookie(COOKIE_NAME);
  return res.json({ success: true, message: 'Password updated. Please log in with your new password.' });
}));

app.post('/api/auth/login', authLimiter, ah(async (req, res) => {
  const { email, password } = req.body;
  if (!email || typeof email !== 'string') return res.status(400).json({ success: false, error: 'Email is required.' });
  if (!password || typeof password !== 'string') return res.status(400).json({ success: false, error: 'Password is required.' });

  const emailKey = canonicalEmail(email);
  let user = null;
  if (emailKey) {
    const { data, error } = await db.from('users').select('*').eq('email_canonical', emailKey).maybeSingle();
    if (error) throw error;
    user = data;
  }

  if (user && user.login_locked_until && new Date(user.login_locked_until).getTime() > Date.now()) {
    const mins = Math.ceil((new Date(user.login_locked_until).getTime() - Date.now()) / 60000);
    return res.status(429).json({ success: false, error: `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}, or reset your password.` });
  }

  const match = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !match) {
    if (user) {
      const fails = (user.failed_login_count || 0) + 1;
      const lock = fails >= MAX_FAILED_LOGINS;
      await db.from('users').update({
        failed_login_count: lock ? 0 : fails,
        login_locked_until: lock ? new Date(Date.now() + LOGIN_LOCK_MS).toISOString() : null,
      }).eq('id', user.id);
    }
    return res.status(401).json({ success: false, error: 'Invalid email or password.' });
  }
  if (user.failed_login_count || user.login_locked_until) {
    await db.from('users').update({ failed_login_count: 0, login_locked_until: null }).eq('id', user.id);
  }

  setSessionCookie(res, user.id);
  return res.json({ success: true, user: sessionUser(user) });
}));

const NAME_CHANGE_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

/** PUT /api/auth/profile { name } — change display name (once every 14 days). */
app.put('/api/auth/profile', requireAuth, profileLimiter, ah(async (req, res) => {
  const nameErr = validateString(req.body.name, 'Name', LIMITS.name);
  if (nameErr) return res.status(400).json({ success: false, error: nameErr });
  const name = normalizeName(req.body.name);
  if (name.length < 2) return res.status(400).json({ success: false, error: 'Name must be at least 2 characters.' });
  if (await nameTaken(req.user.college, name, req.user.id)) return res.status(409).json({ success: false, error: NAME_TAKEN_MESSAGE });
  if (name === req.user.name) return res.json({ success: true, user: sessionUser(req.user) });

  const { data: cur, error: e0 } = await db.from('users').select('name_changed_at').eq('id', req.user.id).maybeSingle();
  if (e0) throw e0;
  if (cur && cur.name_changed_at) {
    const wait = NAME_CHANGE_COOLDOWN_MS - (Date.now() - new Date(cur.name_changed_at).getTime());
    if (wait > 0) return res.status(429).json({ success: false, error: `You can change your name again in ${Math.ceil(wait / 86400000)} day(s).` });
  }

  const id = req.user.id;
  const { error: e1 } = await db.from('users').update({ name, name_changed_at: new Date().toISOString() }).eq('id', id);
  if (e1) throw e1;

  // The name is copied onto posts, volunteer rows and messages, so keep those in sync
  for (const [table, col] of [['posts', 'author'], ['assignments', 'user_name']]) {
    const idCol = table === 'posts' ? 'author_id' : 'user_id';
    const { error } = await db.from(table).update({ [col]: name }).eq(idCol, id);
    if (error) throw error;
  }
  for (const [col, idCol] of [['sender_name', 'sender_id'], ['receiver_name', 'receiver_id']]) {
    const { error } = await db.from('messages').update({ [col]: name }).eq(idCol, id);
    if (error) throw error;
  }
  const { data: offered, error: e2 } = await db.from('posts').select('id,interested_users')
    .contains('interested_users', [{ userId: id }]).limit(200);
  if (e2) throw e2;
  for (const p of offered) {
    const list = (p.interested_users || []).map(u => (u.userId === id ? { ...u, name } : u));
    const { error } = await db.from('posts').update({ interested_users: list }).eq('id', p.id);
    if (error) throw error;
  }

  return res.json({ success: true, user: sessionUser({ ...req.user, name }) });
}));

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  return res.json({ success: true, message: 'Logged out successfully.' });
});

app.get('/api/auth/me', requireAuth, (req, res) => res.json({ success: true, user: req.user }));

// ─── Posts ────────────────────────────────────────────────────────────────────

const MAX_SLOTS = 20;

/** Average rating + count for a set of users (queried in chunks to keep URLs short). */
async function ratingMap(userIds) {
  const ids = [...new Set(userIds)].filter(id => typeof id === 'string' && /^[A-Za-z0-9_]+$/.test(id));
  const sums = {};
  for (let i = 0; i < ids.length; i += 80) {
    const { data, error } = await db.from('ratings').select('ratee_id,score').in('ratee_id', ids.slice(i, i + 80));
    if (error) throw error;
    for (const r of data) {
      const e = (sums[r.ratee_id] = sums[r.ratee_id] || { t: 0, n: 0 });
      e.t += r.score; e.n += 1;
    }
  }
  const out = {};
  for (const id of ids) {
    const e = sums[id];
    out[id] = { avg: e ? Math.round((e.t / e.n) * 10) / 10 : null, count: e ? e.n : 0 };
  }
  return out;
}

/** Attach active volunteers (assignments) and ratings to post rows and convert to the API shape. */
async function postsOut(rows, viewerId) {
  if (!rows.length) return [];
  const { data, error } = await db.from('assignments').select('*')
    .in('post_id', rows.map(r => r.id)).order('created_at', { ascending: true });
  if (error) throw error;
  const byPost = {};
  for (const a of data) (byPost[a.post_id] = byPost[a.post_id] || []).push(a);

  const rm = await ratingMap([
    ...rows.map(r => r.author_id),
    ...rows.flatMap(r => (r.interested_users || []).map(u => u.userId)),
    ...data.map(a => a.user_id),
  ]);
  const rate = id => rm[id] || { avg: null, count: 0 };

  return rows.map(r => {
    const assignees = (byPost[r.id] || []).map(a => ({
      userId: a.user_id, name: a.user_name, status: a.status, paymentStatus: a.payment_status,
      ratingAvg: rate(a.user_id).avg, ratingCount: rate(a.user_id).count,
    }));
    const post = toPost(r);
    post.authorRatingAvg = rate(r.author_id).avg;
    post.authorRatingCount = rate(r.author_id).count;
    post.interestedUsers = (r.interested_users || []).map(u => ({
      ...u, ratingAvg: rate(u.userId).avg, ratingCount: rate(u.userId).count,
    }));
    post.assignees = assignees;
    post.slotsNeeded = r.slots_needed || 1;
    post.slotsFilled = assignees.length;
    // legacy single-volunteer fields = first volunteer
    post.selectedUser = assignees[0] ? assignees[0].name : null;
    post.selectedUserId = assignees[0] ? assignees[0].userId : null;
    return post;
  });
}
const postOut = async (row, viewerId) => (await postsOut([row], viewerId))[0];

async function getPost(id) {
  if (typeof id !== 'string' || id.length > 100) return null;
  const { data, error } = await db.from('posts').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function getAssignments(postId) {
  const { data, error } = await db.from('assignments').select('*').eq('post_id', postId).order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

/** Single source of truth for post status, derived from its volunteers. */
async function syncPostStatus(postId) {
  const post = await getPost(postId);
  const asg = await getAssignments(postId);
  const slots = post.slots_needed || 1;
  let status = 'open';
  if (asg.length >= slots) status = asg.every(a => a.status === 'completed') ? 'completed' : 'in_progress';
  if (status !== post.status) {
    const { error } = await db.from('posts').update({ status }).eq('id', postId);
    if (error) throw error;
  }
  return getPost(postId);
}

/** Pick the volunteer a poster means: explicit id, or the only one if there is just one. */
function pickAssignment(asg, volunteerUserId) {
  if (volunteerUserId && typeof volunteerUserId === 'string') return asg.find(a => a.user_id === volunteerUserId);
  return asg.length === 1 ? asg[0] : undefined;
}

app.get('/api/posts', ah(async (req, res) => {
  const { type, college, category, status, search } = req.query;

  if (type && type !== 'all' && !VALID_TYPES.includes(type)) return res.status(400).json({ success: false, error: 'Invalid type value.' });
  if (category && category !== 'All Categories' && !VALID_CATEGORIES.includes(category)) return res.status(400).json({ success: false, error: 'Invalid category value.' });
  if (status && status !== 'all' && !VALID_STATUSES.includes(status)) return res.status(400).json({ success: false, error: 'Invalid status value.' });
  if (search && typeof search === 'string' && search.length > LIMITS.search) return res.status(400).json({ success: false, error: `Search query too long (max ${LIMITS.search} chars).` });
  if (college && typeof college !== 'string') return res.status(400).json({ success: false, error: 'Invalid college parameter.' });

  // Each campus has its own feed: students only see posts from their own college.
  const viewer = await optionalUser(req);
  if (!viewer) return res.json({ success: true, count: 0, posts: [], loginRequired: true });

  let q = db.from('posts').select('*').order('created_at', { ascending: false }).limit(150)
    .eq('college', viewer.college);
  if (type && type !== 'all') q = q.eq('type', type);
  if (category && category !== 'All Categories') q = q.eq('category', category);
  // Public feed hides finished tasks by default; they live on in each person's "My Tasks".
  if (status === 'all') { /* explicit: include everything */ }
  else if (status) q = q.eq('status', status);
  else q = q.neq('status', 'completed');

  const { data, error } = await q;
  if (error) throw error;

  let posts = await postsOut(data, viewer.id);
  if (search && typeof search === 'string' && search.trim()) {
    const s = search.toLowerCase().trim();
    // Filtered in JS on purpose: avoids building PostgREST filter strings from user input
    posts = posts.filter(p => p.title.toLowerCase().includes(s) || (p.details || '').toLowerCase().includes(s) || p.author.toLowerCase().includes(s));
  }
  return res.json({ success: true, count: posts.length, posts });
}));

/**
 * GET /api/my-tasks — everything the logged-in user posted or was assigned to,
 * including finished tasks (so they can still rate, report and confirm payment).
 */
app.get('/api/my-tasks', requireAuth, ah(async (req, res) => {
  const me = req.user.id;
  const { category, search } = req.query;
  if (category && category !== 'All Categories' && !VALID_CATEGORIES.includes(category)) return res.status(400).json({ success: false, error: 'Invalid category value.' });
  if (search && typeof search === 'string' && search.length > LIMITS.search) return res.status(400).json({ success: false, error: `Search query too long (max ${LIMITS.search} chars).` });

  const { data: mine, error: e1 } = await db.from('assignments').select('post_id').eq('user_id', me);
  if (e1) throw e1;
  // ids are server-generated (hex), but validate before building the filter string
  const ids = mine.map(a => a.post_id).filter(id => /^[A-Za-z0-9_]+$/.test(id)).slice(0, 100);

  let q = db.from('posts').select('*').order('created_at', { ascending: false }).limit(100);
  q = ids.length ? q.or(`author_id.eq.${me},id.in.(${ids.join(',')})`) : q.eq('author_id', me);
  if (category && category !== 'All Categories') q = q.eq('category', category);

  const { data, error } = await q;
  if (error) throw error;

  let posts = await postsOut(data, req.user.id);
  if (search && typeof search === 'string' && search.trim()) {
    const s = search.toLowerCase().trim();
    posts = posts.filter(p => p.title.toLowerCase().includes(s) || (p.details || '').toLowerCase().includes(s));
  }
  // Unfinished tasks first, finished ones after (newest first within each group)
  posts.sort((a, b) => (a.status === 'completed') - (b.status === 'completed'));
  return res.json({ success: true, count: posts.length, posts });
}));

app.post('/api/posts', requireAuth, postLimiter, ah(async (req, res) => {
  const { title, details, price, type, category, slotsNeeded } = req.body;
  const cleanType = typeof type === 'string' && VALID_TYPES.includes(type) ? type : 'need';

  const titleErr = validateString(title, 'Title', LIMITS.title);
  if (titleErr) return res.status(400).json({ success: false, error: titleErr });
  const detailsErr = validateString(details, 'Details', LIMITS.details, false);
  if (detailsErr) return res.status(400).json({ success: false, error: detailsErr });
  const postIssues = offPlatformIssues(`${title}\n${details || ''}`, { strict: true });
  if (postIssues.length) return res.status(400).json({ success: false, error: offPlatformMessage(postIssues, 'post') });

  const cleanCategory = typeof category === 'string' && VALID_CATEGORIES.includes(category) ? category : 'Other';
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum < 0 || priceNum > LIMITS.price.max) {
    return res.status(400).json({ success: false, error: `Price must be a number between 0 and ${LIMITS.price.max}.` });
  }
  const slotsNum = slotsNeeded === undefined || slotsNeeded === '' ? 1 : Number(slotsNeeded);
  if (!Number.isInteger(slotsNum) || slotsNum < 1 || slotsNum > MAX_SLOTS) {
    return res.status(400).json({ success: false, error: `Volunteers needed must be a whole number from 1 to ${MAX_SLOTS}.` });
  }

  const row = {
    id: genId('p'),
    type: cleanType,
    title: title.trim().slice(0, LIMITS.title),
    details: (details || '').trim().slice(0, LIMITS.details),
    price: Math.round(priceNum),   // reward PER volunteer
    slots_needed: slotsNum,
    college: req.user.college,
    category: cleanCategory,
    author_id: req.user.id,
    author: req.user.name,
    status: 'open',
    interested_users: [],
  };
  const { data, error } = await db.from('posts').insert(row).select('*').single();
  if (error) throw error;
  return res.status(201).json({ success: true, post: await postOut(data, req.user.id) });
}));

/**
 * PUT /api/posts/:id — the author edits their own post.
 *  - Completed posts are read-only.
 *  - Once volunteers are assigned, reward and category are locked (they agreed to those),
 *    but title, details and "volunteers needed" (never below the number assigned) can change.
 *  - Changing the reward clears pending offers, so nobody is accepted at a price they did not see.
 */
app.put('/api/posts/:id', requireAuth, ah(async (req, res) => {
  const post = await getPost(req.params.id);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });
  if (post.author_id !== req.user.id) return res.status(403).json({ success: false, error: 'You can only edit your own posts.' });
  if (post.status === 'completed') return res.status(409).json({ success: false, error: 'Completed posts cannot be edited.' });

  const asg = await getAssignments(post.id);
  const locked = asg.length > 0;
  const { title, details, category, price, slotsNeeded } = req.body;
  const updates = {};

  if (title !== undefined) {
    const err = validateString(title, 'Title', LIMITS.title);
    if (err) return res.status(400).json({ success: false, error: err });
    updates.title = title.trim();
  }
  if (details !== undefined) {
    const err = validateString(details, 'Details', LIMITS.details, false);
    if (err) return res.status(400).json({ success: false, error: err });
    updates.details = (details || '').trim();
  }
  if (category !== undefined) {
    if (typeof category !== 'string' || !VALID_CATEGORIES.includes(category)) return res.status(400).json({ success: false, error: 'Invalid category.' });
    if (locked && category !== post.category) return res.status(409).json({ success: false, error: 'Category cannot change after volunteers are assigned.' });
    updates.category = category;
  }
  if (price !== undefined) {
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0 || priceNum > LIMITS.price.max) {
      return res.status(400).json({ success: false, error: `Price must be a number between 0 and ${LIMITS.price.max}.` });
    }
    if (locked && Math.round(priceNum) !== post.price) return res.status(409).json({ success: false, error: 'The reward cannot change after volunteers are assigned.' });
    updates.price = Math.round(priceNum);
  }
  if (slotsNeeded !== undefined) {
    const slotsNum = Number(slotsNeeded);
    if (!Number.isInteger(slotsNum) || slotsNum < 1 || slotsNum > MAX_SLOTS) {
      return res.status(400).json({ success: false, error: `Volunteers needed must be a whole number from 1 to ${MAX_SLOTS}.` });
    }
    if (slotsNum < asg.length) return res.status(400).json({ success: false, error: `${asg.length} volunteer(s) are already assigned, so you need at least ${asg.length}.` });
    updates.slots_needed = slotsNum;
  }
  const editIssues = offPlatformIssues(`${updates.title || ''}\n${updates.details || ''}`, { strict: true });
  if (editIssues.length) return res.status(400).json({ success: false, error: offPlatformMessage(editIssues, 'post') });
  if (!Object.keys(updates).length) return res.status(400).json({ success: false, error: 'Nothing to change.' });

  const offersCleared = updates.price !== undefined && updates.price !== post.price && (post.interested_users || []).length > 0;
  if (offersCleared) updates.interested_users = [];
  updates.edited_at = new Date().toISOString();

  const { error } = await db.from('posts').update(updates).eq('id', post.id).neq('status', 'completed');
  if (error) throw error;

  const fresh = await syncPostStatus(post.id); // a changed slot count can reopen or fill the post
  return res.json({
    success: true,
    message: offersCleared ? 'Post updated. Earlier offers were cleared because the reward changed.' : 'Post updated.',
    offersCleared,
    post: await postOut(fresh, req.user.id),
  });
}));

app.post('/api/posts/:id/offer', requireAuth, offerLimiter, ah(async (req, res) => {
  const post = await getPost(req.params.id);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });
  if (post.status !== 'open') return res.status(409).json({ success: false, error: 'Post is not open for offers.' });
  if (post.author_id === req.user.id) return res.status(400).json({ success: false, error: 'You cannot offer on your own post.' });
  if (post.college !== req.user.college) return res.status(403).json({ success: false, error: 'You can only help with tasks from your own college.' });

  const { data: prev, error: pe } = await db.from('task_cancellations').select('id').eq('post_id', post.id).eq('user_id', req.user.id).limit(1);
  if (pe) throw pe;
  if (prev && prev.length) return res.status(409).json({ success: false, error: 'You can no longer offer help on this task.' });

  const asg = await getAssignments(post.id);
  if (asg.some(a => a.user_id === req.user.id)) return res.status(400).json({ success: false, error: 'You are already assigned to this task.' });

  const list = post.interested_users || [];
  if (list.some(u => u.userId === req.user.id)) return res.status(400).json({ success: false, error: 'You have already offered help for this post.' });
  list.push({ userId: req.user.id, name: req.user.name });

  const { data, error } = await db.from('posts').update({ interested_users: list }).eq('id', post.id).eq('status', 'open').select('*').single();
  if (error) throw error;
  return res.json({ success: true, message: 'Offer submitted successfully.', post: await postOut(data, req.user.id) });
}));

/** Accept one volunteer. Repeat for each slot. The post becomes in_progress when all slots are filled. */
app.post('/api/posts/:id/assign', requireAuth, ah(async (req, res) => {
  const post = await getPost(req.params.id);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });
  if (post.author_id !== req.user.id) return res.status(403).json({ success: false, error: 'Only the post author can assign a volunteer.' });
  if (post.status !== 'open') return res.status(409).json({ success: false, error: 'All volunteer slots are already filled.' });

  const { volunteerUserId } = req.body;
  if (!volunteerUserId || typeof volunteerUserId !== 'string') return res.status(400).json({ success: false, error: 'volunteerUserId is required.' });
  const volunteer = (post.interested_users || []).find(u => u.userId === volunteerUserId);
  if (!volunteer) return res.status(400).json({ success: false, error: 'That user has not offered help on this post.' });

  const asg = await getAssignments(post.id);
  if (asg.length >= (post.slots_needed || 1)) return res.status(409).json({ success: false, error: 'All volunteer slots are already filled.' });
  if (asg.some(a => a.user_id === volunteer.userId)) return res.status(409).json({ success: false, error: 'That volunteer is already assigned.' });

  const { error } = await db.from('assignments').insert({
    id: genId('a'), post_id: post.id, user_id: volunteer.userId, user_name: volunteer.name,
    status: 'assigned', payment_status: 'unpaid',
  });
  if (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'That volunteer is already assigned.' });
    throw error;
  }
  const fresh = await syncPostStatus(post.id);
  return res.json({ success: true, message: `${volunteer.name} assigned.`, post: await postOut(fresh, req.user.id) });
}));

/** Poster stops recruiting and starts with the volunteers already accepted. */
app.post('/api/posts/:id/start', requireAuth, ah(async (req, res) => {
  const post = await getPost(req.params.id);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });
  if (post.author_id !== req.user.id) return res.status(403).json({ success: false, error: 'Only the post author can do this.' });
  if (post.status !== 'open') return res.status(409).json({ success: false, error: 'Task is not recruiting.' });
  const asg = await getAssignments(post.id);
  if (!asg.length) return res.status(409).json({ success: false, error: 'Accept at least one volunteer first.' });

  const { error } = await db.from('posts').update({ slots_needed: asg.length }).eq('id', post.id);
  if (error) throw error;
  const fresh = await syncPostStatus(post.id);
  return res.json({ success: true, message: `Started with ${asg.length} volunteer(s).`, post: await postOut(fresh, req.user.id) });
}));

/** Mark ONE volunteer's work as done. The post completes when every volunteer is done. */
app.post('/api/posts/:id/complete', requireAuth, ah(async (req, res) => {
  const post = await getPost(req.params.id);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });
  if (post.author_id !== req.user.id) return res.status(403).json({ success: false, error: 'Only the post author can mark work complete.' });
  if (post.type === 'offer') return res.status(409).json({ success: false, error: 'For service posts the customer confirms delivery.' });

  const asg = await getAssignments(post.id);
  const a = pickAssignment(asg, req.body.volunteerUserId);
  if (!a) return res.status(400).json({ success: false, error: 'volunteerUserId is required.' });
  if (a.status !== 'assigned') return res.status(409).json({ success: false, error: 'This volunteer is already marked complete.' });

  const { data, error } = await db.from('assignments').update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('id', a.id).eq('status', 'assigned').select('id');
  if (error) throw error;
  if (!data.length) return res.status(409).json({ success: false, error: 'Task changed. Please refresh.' });

  const fresh = await syncPostStatus(post.id);
  return res.json({ success: true, message: `${a.user_name}'s work marked complete.`, post: await postOut(fresh, req.user.id) });
}));

/**
 * Service posts ("I offer a service") work the other way round from help requests:
 * the poster is the provider and gets paid; each responder is a customer.
 *   1. provider:  deliver           ("Mark delivered")
 *   2. customer:  payment-sent      ("Mark payment as sent": also confirms the service was received)
 *   3. provider:  payment-received  ("Confirm payment received": finishes the booking)
 * Each step belongs to the other person, so nobody can mark a booking delivered, paid and finished on their own.
 */
async function getServicePost(req, res) {
  const post = await getPost(req.params.id);
  if (!post) { res.status(404).json({ success: false, error: 'Post not found.' }); return null; }
  if (post.type !== 'offer') { res.status(409).json({ success: false, error: 'This step is only for service posts.' }); return null; }
  return post;
}

app.post('/api/posts/:id/deliver', requireAuth, ah(async (req, res) => {
  const post = await getServicePost(req, res); if (!post) return;
  if (post.author_id !== req.user.id) return res.status(403).json({ success: false, error: 'Only the service provider can mark a service delivered.' });
  const a = pickAssignment(await getAssignments(post.id), req.body.customerUserId);
  if (!a) return res.status(400).json({ success: false, error: 'customerUserId is required.' });
  if (a.status !== 'assigned') return res.status(409).json({ success: false, error: 'This booking is not waiting for delivery.' });

  const { data, error } = await db.from('assignments').update({ status: 'delivered', delivered_at: new Date().toISOString() })
    .eq('id', a.id).eq('status', 'assigned').select('id');
  if (error) throw error;
  if (!data.length) return res.status(409).json({ success: false, error: 'Booking changed. Please refresh.' });
  return res.json({ success: true, message: `Marked as delivered. ${a.user_name} will be asked to confirm.`, post: await postOut(await syncPostStatus(post.id), req.user.id) });
}));

app.post('/api/posts/:id/payment-sent', requireAuth, ah(async (req, res) => {
  const post = await getServicePost(req, res); if (!post) return;
  const a = (await getAssignments(post.id)).find(x => x.user_id === req.user.id);
  if (!a) return res.status(403).json({ success: false, error: 'You are not a customer on this post.' });
  if (a.status === 'assigned') return res.status(409).json({ success: false, error: 'Wait until the provider marks the service as delivered.' });
  if (a.payment_status !== 'unpaid') return res.status(409).json({ success: false, error: 'A payment is already recorded for this booking.' });

  const { data, error } = await db.from('assignments').update({
    payment_status: 'paid', paid_at: new Date().toISOString(),
  }).eq('id', a.id).eq('payment_status', 'unpaid').select('id');
  if (error) throw error;
  if (!data.length) return res.status(409).json({ success: false, error: 'Booking changed. Please refresh.' });
  return res.json({ success: true, message: 'Marked as paid. The provider will confirm it.', post: await postOut(await getPost(post.id), req.user.id) });
}));

app.post('/api/posts/:id/payment-received', requireAuth, ah(async (req, res) => {
  const post = await getServicePost(req, res); if (!post) return;
  if (post.author_id !== req.user.id) return res.status(403).json({ success: false, error: 'Only the service provider can confirm a payment.' });
  const a = pickAssignment(await getAssignments(post.id), req.body.customerUserId);
  if (!a) return res.status(400).json({ success: false, error: 'customerUserId is required.' });
  if (a.payment_status !== 'paid') return res.status(409).json({ success: false, error: 'No payment is waiting to be confirmed.' });

  const received = req.body.received !== false; // false = "I did not receive this": the booking goes back to unpaid
  const now = new Date().toISOString();
  const update = received
    ? { payment_status: 'confirmed', confirmed_at: now, ...(a.status === 'delivered' ? { status: 'completed', completed_at: now } : {}) } // confirming the payment finishes the booking
    : { payment_status: 'unpaid', paid_at: null };
  const { data, error } = await db.from('assignments').update(update).eq('id', a.id).eq('payment_status', 'paid').select('id');
  if (error) throw error;
  if (!data.length) return res.status(409).json({ success: false, error: 'Booking changed. Please refresh.' });
  return res.json({
    success: true,
    message: received ? 'Payment confirmed.' : 'Marked as not received. The customer has been asked to pay again.',
    post: await postOut(received ? await syncPostStatus(post.id) : await getPost(post.id), req.user.id),
  });
}));

/** Remove ONE active volunteer (their slot reopens) and record why. */
async function releaseVolunteer(post, assignment, reason) {
  const { data, error } = await db.from('assignments').delete().eq('id', assignment.id).eq('status', 'assigned').select('id');
  if (error) throw error;
  if (!data.length) return null; // changed by someone else
  const remaining = (post.interested_users || []).filter(u => u.userId !== assignment.user_id);
  const { error: e2 } = await db.from('posts').update({ interested_users: remaining }).eq('id', post.id);
  if (e2) throw e2;
  const { error: e3 } = await db.from('task_cancellations').insert({ id: genId('c'), post_id: post.id, user_id: assignment.user_id, reason });
  if (e3) throw e3;
  return syncPostStatus(post.id);
}

/** Poster replaces a volunteer at any time (e.g. no-show). Other volunteers and offers stay. */
app.post('/api/posts/:id/reassign', requireAuth, ah(async (req, res) => {
  const post = await getPost(req.params.id);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });
  if (post.author_id !== req.user.id) return res.status(403).json({ success: false, error: 'Only the post author can reassign this task.' });

  const asg = await getAssignments(post.id);
  const a = pickAssignment(asg, req.body.volunteerUserId);
  if (!a) return res.status(400).json({ success: false, error: 'volunteerUserId is required.' });
  if (a.status !== 'assigned') return res.status(409).json({ success: false, error: 'This volunteer already finished; they cannot be replaced.' });
  if (a.payment_status !== 'unpaid') return res.status(409).json({ success: false, error: 'A payment has already been marked, so this cannot be cancelled here. Report the problem instead.' });

  const fresh = await releaseVolunteer(post, a, 'reassigned');
  if (!fresh) return res.status(409).json({ success: false, error: 'Task changed. Please refresh.' });
  return res.json({ success: true, message: 'Slot reopened. Choose another volunteer.', post: await postOut(fresh, req.user.id) });
}));

/** A volunteer backs out honestly. Not counted against them. */
app.post('/api/posts/:id/withdraw', requireAuth, ah(async (req, res) => {
  const post = await getPost(req.params.id);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });
  const asg = await getAssignments(post.id);
  const a = asg.find(x => x.user_id === req.user.id);
  if (!a || a.status !== 'assigned') return res.status(403).json({ success: false, error: 'You are not an active volunteer on this task.' });
  if (a.payment_status !== 'unpaid') return res.status(409).json({ success: false, error: 'A payment has already been marked, so you cannot withdraw. Report the problem instead.' });

  const fresh = await releaseVolunteer(post, a, 'withdrawn');
  if (!fresh) return res.status(409).json({ success: false, error: 'Task changed. Please refresh.' });
  return res.json({ success: true, message: 'You withdrew from this task.', post: await postOut(fresh, req.user.id) });
}));

/**
 * Payment ledger (no money moves through EarnKampus).
 * Poster marks a volunteer paid after paying them directly;
 * the volunteer then confirms they received it.
 */
app.post('/api/posts/:id/pay', requireAuth, ah(async (req, res) => {
  const post = await getPost(req.params.id);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });
  if (post.author_id !== req.user.id) return res.status(403).json({ success: false, error: 'Only the post author can mark payment.' });
  if (post.type === 'offer') return res.status(409).json({ success: false, error: 'For service posts the customer marks payment and you confirm it.' });

  const asg = await getAssignments(post.id);
  const a = pickAssignment(asg, req.body.volunteerUserId);
  if (!a) return res.status(400).json({ success: false, error: 'volunteerUserId is required.' });
  if (a.status !== 'completed') return res.status(409).json({ success: false, error: 'Mark the work complete before marking payment.' });
  if (a.payment_status !== 'unpaid') return res.status(409).json({ success: false, error: 'Payment already marked.' });

  const { data, error } = await db.from('assignments').update({ payment_status: 'paid', paid_at: new Date().toISOString() })
    .eq('id', a.id).eq('payment_status', 'unpaid').select('id');
  if (error) throw error;
  if (!data.length) return res.status(409).json({ success: false, error: 'Task changed. Please refresh.' });
  return res.json({ success: true, message: `Marked ${a.user_name} as paid ₹${post.price}.`, post: await postOut(await getPost(post.id), req.user.id) });
}));

app.post('/api/posts/:id/confirm-payment', requireAuth, ah(async (req, res) => {
  const post = await getPost(req.params.id);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });
  if (post.type === 'offer') return res.status(409).json({ success: false, error: 'For service posts the provider confirms the payment.' });
  const asg = await getAssignments(post.id);
  const a = asg.find(x => x.user_id === req.user.id);
  if (!a) return res.status(403).json({ success: false, error: 'You are not a volunteer on this task.' });
  if (a.payment_status !== 'paid') return res.status(409).json({ success: false, error: 'The poster has not marked you as paid yet.' });

  const { data, error } = await db.from('assignments').update({ payment_status: 'confirmed', confirmed_at: new Date().toISOString() })
    .eq('id', a.id).eq('payment_status', 'paid').select('id');
  if (error) throw error;
  if (!data.length) return res.status(409).json({ success: false, error: 'Task changed. Please refresh.' });
  return res.json({ success: true, message: 'Payment confirmed. Thanks!', post: await postOut(await getPost(post.id), req.user.id) });
}));

app.delete('/api/posts/:id', requireAuth, ah(async (req, res) => {
  const post = await getPost(req.params.id);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });
  if (post.author_id !== req.user.id) return res.status(403).json({ success: false, error: 'You are not authorized to delete this post.' });
  const asg = await getAssignments(post.id);
  if (asg.length > 0) return res.status(409).json({ success: false, error: 'Posts that have volunteers cannot be deleted, because ratings and payment records depend on them.' });
  const { error } = await db.from('posts').delete().eq('id', post.id);
  if (error) throw error;
  return res.json({ success: true, message: 'Post deleted successfully.' });
}));

/**
 * POST /api/posts/:id/rate
 * Poster rates a volunteer who finished (body.rateeId), or a finished volunteer rates the poster.
 */
app.post('/api/posts/:id/rate', requireAuth, ah(async (req, res) => {
  const post = await getPost(req.params.id);
  if (!post) return res.status(404).json({ success: false, error: 'Post not found.' });

  const asg = await getAssignments(post.id);
  let rateeId;
  if (post.author_id === req.user.id) {
    const a = pickAssignment(asg, req.body.rateeId);
    if (!a) return res.status(400).json({ success: false, error: 'rateeId is required.' });
    if (a.status !== 'completed') return res.status(409).json({ success: false, error: 'You can only rate volunteers who finished their work.' });
    rateeId = a.user_id;
  } else {
    const mine = asg.find(x => x.user_id === req.user.id);
    if (!mine) return res.status(403).json({ success: false, error: 'Only people on this task can rate it.' });
    if (mine.status !== 'completed') return res.status(409).json({ success: false, error: 'You can rate after your work is marked complete.' });
    rateeId = post.author_id;
  }

  const score = Number(req.body.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) return res.status(400).json({ success: false, error: 'Score must be a whole number from 1 to 5.' });
  const commentErr = validateString(req.body.comment, 'Comment', LIMITS.comment, false);
  if (commentErr) return res.status(400).json({ success: false, error: commentErr });

  const { error } = await db.from('ratings').insert({
    id: genId('r'), post_id: post.id, rater_id: req.user.id, ratee_id: rateeId,
    score, comment: req.body.comment ? req.body.comment.trim() : null,
  });
  if (error) {
    if (error.code === '23505') return res.status(409).json({ success: false, error: 'You already rated this person for this task.' });
    throw error;
  }
  return res.status(201).json({ success: true, message: 'Thanks for rating.' });
}));

const REPORT_CATEGORIES = ['scam', 'no_show', 'harassment', 'fake_post', 'inappropriate', 'off_platform', 'other'];

/** POST /api/reports — report a user, with a cause (and details, required for 'other') */
app.post('/api/reports', requireAuth, reportLimiter, ah(async (req, res) => {
  const { targetUserId, postId, category, reason } = req.body;
  if (!targetUserId || typeof targetUserId !== 'string') return res.status(400).json({ success: false, error: 'targetUserId is required.' });
  if (targetUserId === req.user.id) return res.status(400).json({ success: false, error: 'You cannot report yourself.' });
  if (typeof category !== 'string' || !REPORT_CATEGORIES.includes(category)) return res.status(400).json({ success: false, error: 'Please choose a reason for the report.' });
  const reasonErr = validateString(reason, 'Details', LIMITS.reason, category === 'other');
  if (reasonErr) return res.status(400).json({ success: false, error: reasonErr });

  const { data: target, error: e1 } = await db.from('users').select('id').eq('id', targetUserId).maybeSingle();
  if (e1) throw e1;
  if (!target) return res.status(404).json({ success: false, error: 'User not found.' });

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: recent, error: e2 } = await db.from('reports').select('id')
    .eq('reporter_id', req.user.id).eq('target_user_id', targetUserId).gte('created_at', since).limit(1);
  if (e2) throw e2;
  if (recent.length) return res.status(429).json({ success: false, error: 'You already reported this person today. Our team will review it.' });

  const { error } = await db.from('reports').insert({
    id: genId('rep'), reporter_id: req.user.id, target_user_id: targetUserId, category,
    post_id: typeof postId === 'string' ? postId.slice(0, 100) : null, reason: reason ? reason.trim() : '',
  });
  if (error) throw error;
  return res.status(201).json({ success: true, message: 'Report submitted. We will review it.' });
}));

// ─── Messages ─────────────────────────────────────────────────────────────────

app.get('/api/messages', requireAuth, ah(async (req, res) => {
  const myId = req.user.id;
  const { withUserId } = req.query;
  const { data, error } = await db.from('messages').select('*')
    .or(`sender_id.eq.${myId},receiver_id.eq.${myId}`) // myId is server-generated, not user input
    .order('created_at', { ascending: true }).limit(1000);
  if (error) throw error;

  let result = data.map(toMessage);
  if (withUserId && typeof withUserId === 'string') {
    result = result.filter(m => (m.senderId === myId && m.receiverId === withUserId) || (m.senderId === withUserId && m.receiverId === myId));
  }
  return res.json({ success: true, count: result.length, messages: result });
}));

/** Mark every message from one person to me as read (called when I open that conversation). */
app.post('/api/messages/read', requireAuth, ah(async (req, res) => {
  const { withUserId } = req.body;
  if (!withUserId || typeof withUserId !== 'string' || withUserId.length > 100) {
    return res.status(400).json({ success: false, error: 'withUserId is required.' });
  }
  const { error } = await db.from('messages').update({ read_at: new Date().toISOString() })
    .eq('receiver_id', req.user.id).eq('sender_id', withUserId).is('read_at', null);
  if (error) throw error;
  return res.json({ success: true });
}));

app.post('/api/messages', requireAuth, messageLimiter, ah(async (req, res) => {
  const { receiverId, text } = req.body;
  if (!receiverId || typeof receiverId !== 'string') return res.status(400).json({ success: false, error: 'receiverId is required.' });
  const textErr = validateString(text, 'Message text', LIMITS.message);
  if (textErr) return res.status(400).json({ success: false, error: textErr });
  let chatIssues = offPlatformIssues(text, { strict: false });
  if (chatIssues.includes('phone') && await haveBookingTogether(req.user.id, receiverId)) chatIssues = chatIssues.filter(i => i !== 'phone');
  if (chatIssues.length) {
    const extra = chatIssues.includes('phone') ? ' Phone numbers can be shared once a booking is accepted.' : '';
    return res.status(400).json({ success: false, error: offPlatformMessage(chatIssues, 'chat') + extra });
  }
  if (receiverId === req.user.id) return res.status(400).json({ success: false, error: 'Cannot send a message to yourself.' });

  const { data: receiver, error: e1 } = await db.from('users').select('id,name,college').eq('id', receiverId).maybeSingle();
  if (e1) throw e1;
  if (!receiver) return res.status(404).json({ success: false, error: 'Receiver not found.' });
  if (receiver.college !== req.user.college) return res.status(403).json({ success: false, error: 'You can only message students from your college.' });

  const { data, error } = await db.from('messages').insert({
    id: genId('m'), sender_id: req.user.id, sender_name: req.user.name,
    receiver_id: receiver.id, receiver_name: receiver.name, text: text.trim().slice(0, LIMITS.message),
  }).select('*').single();
  if (error) throw error;
  return res.status(201).json({ success: true, message: toMessage(data) });
}));

// ─── Users / profile ──────────────────────────────────────────────────────────

app.get('/api/users', requireAuth, ah(async (req, res) => {
  const { data: users, error } = await db.from('users').select('id,name,college,avatar').eq('college', req.user.college).limit(500);
  if (error) throw error;
  const rm = await ratingMap(users.map(u => u.id)); // ratings for these users only, never the whole table
  return res.json({
    success: true,
    users: users.map(u => publicProfile(u, { avg: rm[u.id].avg, count: rm[u.id].count, cancelled: 0 })),
  });
}));

/** Profiles are visible only to logged-in students of the same college. */
app.get('/api/users/profile', requireAuth, ah(async (req, res) => {
  const { id, name } = req.query;
  let q = db.from('users').select('id,name,college,avatar').eq('college', req.user.college);
  if (id && typeof id === 'string') q = q.eq('id', id);
  else if (name && typeof name === 'string' && name.length <= LIMITS.name) q = q.ilike('name', name.trim().replace(/[%_,()\\]/g, ''));
  else return res.status(400).json({ success: false, error: 'Provide id or name query parameter.' });

  const { data, error } = await q.limit(1);
  if (error) throw error;
  if (!data || !data.length) return res.status(404).json({ success: false, error: 'User not found.' });
  return res.json({ success: true, profile: publicProfile(data[0], await ratingFor(data[0].id)) });
}));

// ─── Stats (cached for a minute so it cannot be used to hammer the database) ──

let statsCache = { at: 0, value: null };

app.get('/api/stats', ah(async (req, res) => {
  if (statsCache.value && Date.now() - statsCache.at < 60 * 1000) return res.json({ success: true, stats: statsCache.value });
  const { data, error } = await db.from('posts').select('id,status,price,interested_users');
  if (error) throw error;
  const { data: asg, error: e2 } = await db.from('assignments').select('post_id,status');
  if (e2) throw e2;
  const price = Object.fromEntries(data.map(p => [p.id, p.price]));
  const volunteers = new Set(data.flatMap(p => (p.interested_users || []).map(u => u.userId)));
  const stats = {
    openTasks: data.filter(p => p.status === 'open').length,
    completedTasks: data.filter(p => p.status === 'completed').length,
    totalEarned: asg.filter(a => a.status === 'completed').reduce((t, a) => t + (price[a.post_id] || 0), 0),
    activeVolunteers: volunteers.size,
    totalPosts: data.length,
  };
  statsCache = { at: Date.now(), value: stats };
  return res.json({ success: true, stats });
}));

// ─── Error handler ────────────────────────────────────────────────────────────

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: 'Invalid JSON in request body.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ success: false, error: 'Request payload too large.' });
  if (err.message && err.message.startsWith('CORS')) return res.status(403).json({ success: false, error: 'CORS: origin not allowed.' });
  console.error('Unhandled error:', err.message || err);
  return res.status(500).json({ success: false, error: 'Internal server error.' });
});

module.exports = app;