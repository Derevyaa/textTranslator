import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';
import * as auth from './auth.js';
import { runTranslation, DEFAULTS, hasKey, friendlyError, getBalance } from './translate.js';
import { countTokens, tokenizerEnabled } from './tokens.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(cookieParser());

const page = (name) => (_req, res) => res.sendFile(path.join(PUBLIC_DIR, name));

// ---- public ----
app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));
app.get('/login', page('login.html'));
app.get('/api/config', (_req, res) =>
  res.json({
    ...DEFAULTS,
    billing: db.billingConfig(),
    hasKey,
    tokenizer: tokenizerEnabled,
    balanceSupported: !!process.env.DEEPSEEK_API_KEY,
    deepseekPrice: {
      in: parseFloat(process.env.DEEPSEEK_PRICE_IN || '0.14'),
      out: parseFloat(process.env.DEEPSEEK_PRICE_OUT || '0.28'),
    },
  }));

// ---- auth ----
app.post('/api/auth/register', auth.register);
app.post('/api/auth/login', auth.login);
app.post('/api/auth/logout', auth.logout);
app.get('/api/me', auth.apiAuth, auth.me);

// DeepSeek account balance (proxied; key stays server-side)
app.get('/api/balance', auth.apiAuth, async (_req, res) => {
  try {
    res.json(await getBalance());
  } catch (err) {
    res.status(err?.status || 500).json({ error: 'Не вдалося отримати баланс.', status: err?.status || 500 });
  }
});

// Exact DeepSeek token count for a piece of text (via tokenizer service)
app.post('/api/tokens', auth.apiAuth, async (req, res) => {
  res.json({ tokens: await countTokens(req.body?.text || '') });
});

// ---- gated pages ----
app.get('/', auth.pageApproved, page('index.html'));
app.get('/dashboard', auth.pageApproved, page('dashboard.html'));
app.get('/pending', auth.pageAuth, page('pending.html'));
app.get('/admin', auth.pageAdmin, page('admin.html'));

// ---- helpers ----
function enrich(doc) {
  const billChars = db.billableChars(doc);
  return {
    id: doc.id, title: doc.title, status: doc.status,
    sourceLang: doc.sourceLang, targetLang: doc.targetLang,
    sourceChars: doc.sourceChars, targetChars: doc.targetChars,
    billChars,
    pages: Math.round(db.pagesFor(billChars) * 100) / 100,
    cost: db.costFor(billChars),
    addedBy: db.nameOf(doc.addedBy),
    lastEditedBy: db.nameOf(doc.lastEditedBy),
    createdAt: doc.createdAt, updatedAt: doc.updatedAt,
  };
}

// ---- access control: a user sees only their own documents; an admin sees all ----
const canSee = (doc, user) => !!doc && (auth.isAdmin(user) || doc.ownerId === user.id);
const visibleDocs = (user) => auth.isAdmin(user)
  ? db.listDocuments()
  : db.listDocuments().filter((d) => d.ownerId === user.id);

// ---- documents ----
app.get('/api/documents', auth.approvedAuth, (req, res) => {
  res.json({ documents: visibleDocs(req.user).map(enrich), billing: db.billingConfig() });
});

app.get('/api/documents/:id', auth.approvedAuth, (req, res) => {
  const doc = db.getDocument(req.params.id);
  if (!canSee(doc, req.user)) return res.status(404).json({ error: 'Документ не знайдено.' });
  res.json({ document: { ...enrich(doc), sourceText: doc.sourceText, translatedText: doc.translatedText } });
});

app.post('/api/documents', auth.approvedAuth, (req, res) => {
  const { title, sourceText, sourceLang, targetLang } = req.body || {};
  if (!sourceText || !String(sourceText).trim()) {
    return res.status(400).json({ error: 'Порожній текст оригіналу.' });
  }
  const doc = db.createDocument({ ownerId: req.user.id, title, sourceText, sourceLang, targetLang });
  db.addActivity({ userId: req.user.id, documentId: doc.id, action: 'added', chars: doc.sourceChars });
  res.json({ document: enrich(doc) });
});

// save edited translation
app.put('/api/documents/:id', auth.approvedAuth, (req, res) => {
  const doc = db.getDocument(req.params.id);
  if (!canSee(doc, req.user)) return res.status(404).json({ error: 'Документ не знайдено.' });
  const { translatedText, title } = req.body || {};
  const before = doc.targetChars;
  const updated = db.updateDocument(doc.id, {
    translatedText: translatedText != null ? translatedText : doc.translatedText,
    title: title != null ? title : doc.title,
    status: 'edited',
    lastEditedBy: req.user.id,
  });
  const delta = updated.targetChars - before;
  db.logEditCoalesced(req.user.id, doc.id, delta);
  res.json({ document: enrich(updated) });
});

// translate (streams NDJSON, saves result + logs activity)
app.post('/api/documents/:id/translate', auth.approvedAuth, async (req, res) => {
  const doc = db.getDocument(req.params.id);
  if (!canSee(doc, req.user)) return res.status(404).json({ error: 'Документ не знайдено.' });

  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const send = (o) => res.write(JSON.stringify(o) + '\n');

  const sourceLang = req.body?.sourceLang || doc.sourceLang;
  const targetLang = req.body?.targetLang || doc.targetLang;
  try {
    db.updateDocument(doc.id, { status: 'translating', sourceLang, targetLang });
    const full = await runTranslation(
      { text: doc.sourceText, sourceLang, targetLang, glossary: req.body?.glossary },
      send
    );
    db.updateDocument(doc.id, { translatedText: full, status: 'translated' });
    db.addActivity({ userId: req.user.id, documentId: doc.id, action: 'translated', chars: db.charsWithSpaces(full) });
  } catch (err) {
    console.error('[translate] error:', err?.status, err?.message || err);
    db.updateDocument(doc.id, { status: doc.translatedText ? 'translated' : 'added' });
    send({ type: 'error', message: friendlyError(err) });
  } finally {
    res.end();
  }
});

// ---- dashboard ----
app.get('/api/dashboard', auth.approvedAuth, (req, res) => {
  const visible = visibleDocs(req.user);
  const docs = visible.map(enrich);
  const { pageChars } = db.billingConfig();
  const totals = docs.reduce(
    (t, d) => { t.docs++; t.chars += d.billChars; t.cost += d.cost; return t; },
    { docs: 0, chars: 0, cost: 0 }
  );
  totals.pages = Math.round((totals.chars / pageChars) * 100) / 100;
  totals.cost = Math.round(totals.cost * 100) / 100;

  const isAdm = auth.isAdmin(req.user);
  const visibleIds = new Set(visible.map((d) => d.id));
  const activityRaw = isAdm
    ? db.listActivity(40)
    : db.listActivity(1000).filter((a) => visibleIds.has(a.documentId)).slice(0, 40);
  const activity = activityRaw.map((a) => ({
    action: a.action, chars: a.chars, at: a.at,
    userName: db.nameOf(a.userId),
    docTitle: (db.getDocument(a.documentId) || {}).title || '—',
  }));

  const mine = { added: 0, translated: 0, edited: 0, editedChars: 0 };
  for (const a of db.allActivity()) {
    if (a.userId !== req.user.id) continue;
    if (mine[a.action] != null) mine[a.action]++;
    if (a.action === 'edited') mine.editedChars += Math.abs(a.chars || 0);
  }

  res.json({ documents: docs, totals, activity, mine, billing: db.billingConfig() });
});

// delete a document (owner or admin)
app.delete('/api/documents/:id', auth.apiAuth, (req, res) => {
  const doc = db.getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: 'Документ не знайдено.' });
  if (doc.ownerId !== req.user.id && !auth.isAdmin(req.user)) {
    return res.status(403).json({ error: 'Видаляти може власник або адміністратор.' });
  }
  db.deleteDocument(doc.id);
  res.json({ ok: true });
});

// ---- admin ----
function adminUserView(u) {
  const docs = db.listDocuments().filter((d) => d.ownerId === u.id);
  const chars = docs.reduce((s, d) => s + db.billableChars(d), 0);
  const { pageChars } = db.billingConfig();
  return {
    id: u.id, email: u.email, name: u.name,
    status: u.status, isAdmin: auth.isAdmin(u), createdAt: u.createdAt,
    docs: docs.length,
    pages: Math.round((chars / pageChars) * 100) / 100,
    cost: db.costFor(chars),
  };
}

app.get('/api/admin/overview', auth.adminAuth, async (_req, res) => {
  const users = db.listUsers();
  const docs = db.listDocuments();
  const { pageChars } = db.billingConfig();
  const totalChars = docs.reduce((s, d) => s + db.billableChars(d), 0);
  let balance = null;
  try { balance = await getBalance(); } catch { balance = { error: true }; }
  res.json({
    users: users.length,
    pending: users.filter((u) => u.status === 'pending' && !auth.isAdmin(u)).length,
    documents: docs.length,
    pages: Math.round((totalChars / pageChars) * 100) / 100,
    revenue: Math.round(docs.reduce((s, d) => s + db.costFor(db.billableChars(d)), 0) * 100) / 100,
    balance,
    billing: db.billingConfig(),
  });
});

app.get('/api/admin/users', auth.adminAuth, (_req, res) => {
  res.json({ users: db.listUsers().map(adminUserView) });
});

app.post('/api/admin/users/:id/approve', auth.adminAuth, (req, res) => {
  const u = db.updateUser(req.params.id, { status: 'approved' });
  if (!u) return res.status(404).json({ error: 'Користувача не знайдено.' });
  res.json({ user: adminUserView(u) });
});

app.post('/api/admin/users/:id/suspend', auth.adminAuth, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Не можна призупинити власний акаунт.' });
  const u = db.updateUser(req.params.id, { status: 'suspended' });
  if (!u) return res.status(404).json({ error: 'Користувача не знайдено.' });
  res.json({ user: adminUserView(u) });
});

app.delete('/api/admin/users/:id', auth.adminAuth, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'Не можна видалити власний акаунт.' });
  const target = db.findUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'Користувача не знайдено.' });
  db.deleteUser(req.params.id);
  res.json({ ok: true });
});

app.get('/api/admin/documents', auth.adminAuth, (_req, res) => {
  const { pageChars } = db.billingConfig();
  const docs = db.listDocuments().map((d) => {
    const billChars = db.billableChars(d);
    return {
      id: d.id, title: d.title, status: d.status,
      addedBy: db.nameOf(d.addedBy), lastEditedBy: db.nameOf(d.lastEditedBy),
      sourceChars: d.sourceChars, targetChars: d.targetChars,
      pages: Math.round((billChars / pageChars) * 100) / 100,
      cost: db.costFor(billChars), updatedAt: d.updatedAt,
    };
  });
  res.json({ documents: docs });
});

app.listen(PORT, () => {
  console.log(`Translator running on http://localhost:${PORT}  (model: ${DEFAULTS.model})`);
  console.log(`Provider: ${process.env.DEEPSEEK_BASE_URL || process.env.ANTHROPIC_BASE_URL || 'api.anthropic.com (default)'}`);
  console.log(`Billing: ${db.billingConfig().rate} грн / ${db.billingConfig().pageChars} знаків (за ${db.billingConfig().billOn})`);
  if (!hasKey) console.warn('УВАГА: API-ключ не заданий — переклад не працюватиме (auth/бібліотека працюють).');
});
