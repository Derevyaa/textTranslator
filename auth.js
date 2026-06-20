import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as db from './db.js';

const SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const COOKIE = 'token';
const MAX_AGE = 30 * 24 * 3600 * 1000; // 30 days

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .toLowerCase()
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function isAdminEmail(email) {
  return ADMIN_EMAILS.includes(String(email || '').toLowerCase());
}
export function isAdmin(user) {
  return !!user && isAdminEmail(user.email);
}
export function isApproved(user) {
  return !!user && (isAdmin(user) || user.status === 'approved');
}

export function hashPassword(pw) { return bcrypt.hashSync(pw, 10); }
export function verifyPassword(pw, hash) { return bcrypt.compareSync(pw, hash); }
export function signToken(user) { return jwt.sign({ uid: user.id }, SECRET, { expiresIn: '30d' }); }

function setCookie(res, token) {
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE,
  });
}

export function publicUser(u) {
  return u ? { id: u.id, email: u.email, name: u.name, status: u.status, isAdmin: isAdmin(u) } : null;
}

export function currentUser(req) {
  const t = req.cookies?.[COOKIE];
  if (!t) return null;
  try {
    const { uid } = jwt.verify(t, SECRET);
    return db.findUserById(uid) || null;
  } catch {
    return null;
  }
}

// --- API middlewares ---
export function apiAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Не авторизовано' });
  req.user = u;
  next();
}
export function approvedAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Не авторизовано' });
  if (!isApproved(u)) return res.status(403).json({ error: 'Акаунт очікує підтвердження адміністратором.' });
  req.user = u;
  next();
}
export function adminAuth(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: 'Не авторизовано' });
  if (!isAdmin(u)) return res.status(403).json({ error: 'Доступ лише для адміністратора.' });
  req.user = u;
  next();
}

// --- page guards ---
export function pageAuth(req, res, next) {
  if (!currentUser(req)) return res.redirect('/login');
  next();
}
export function pageApproved(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  if (!isApproved(u)) return res.redirect('/pending');
  next();
}
export function pageAdmin(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  if (!isAdmin(u)) return res.redirect('/');
  next();
}

// --- handlers ---
export function register(req, res) {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Вкажи email і пароль.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Пароль має бути щонайменше 6 символів.' });
  if (db.findUserByEmail(email)) return res.status(409).json({ error: 'Такий email уже зареєстрований.' });
  const status = isAdminEmail(email) ? 'approved' : 'pending';
  const user = db.createUser({ email, name, passwordHash: hashPassword(password), status });
  setCookie(res, signToken(user));
  res.json({ user: publicUser(user) });
}
export function login(req, res) {
  const { email, password } = req.body || {};
  const user = db.findUserByEmail(email || '');
  if (!user || !verifyPassword(password || '', user.passwordHash)) {
    return res.status(401).json({ error: 'Невірний email або пароль.' });
  }
  setCookie(res, signToken(user));
  res.json({ user: publicUser(user) });
}
export function logout(_req, res) { res.clearCookie(COOKIE); res.json({ ok: true }); }
export function me(req, res) { res.json({ user: publicUser(req.user) }); }
