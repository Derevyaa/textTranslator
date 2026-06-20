import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const RATE_UAH = parseFloat(process.env.RATE_UAH || '30');
const PAGE_CHARS = parseInt(process.env.PAGE_CHARS || '1800', 10);
const BILL_ON = (process.env.BILL_ON || 'source').toLowerCase(); // 'source' | 'target'

let cache = null;

function ensure() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users: [], documents: [], activity: [] }, null, 2));
  }
}
function load() {
  if (cache) return cache;
  ensure();
  cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  for (const k of ['users', 'documents', 'activity']) if (!cache[k]) cache[k] = [];
  return cache;
}
function save() {
  ensure();
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DB_FILE); // atomic on same filesystem
}

// --- billing helpers ---
export function charsWithSpaces(text) {
  if (!text) return 0;
  return text.replace(/\r/g, '').replace(/\n/g, '').length; // spaces count, line breaks don't
}
export function pagesFor(chars) { return chars / PAGE_CHARS; }
export function costFor(chars) { return Math.round((chars / PAGE_CHARS) * RATE_UAH * 100) / 100; }
export function billingConfig() { return { rate: RATE_UAH, pageChars: PAGE_CHARS, billOn: BILL_ON }; }
export function billableChars(doc) {
  return BILL_ON === 'target' ? (doc.targetChars || 0) : (doc.sourceChars || 0);
}

// --- users ---
export function createUser({ email, name, passwordHash, status = 'pending' }) {
  const db = load();
  const user = {
    id: crypto.randomUUID(),
    email: String(email).toLowerCase(),
    name: name || String(email).split('@')[0],
    passwordHash,
    status, // 'pending' | 'approved' | 'suspended'
    createdAt: new Date().toISOString(),
  };
  db.users.push(user); save(); return user;
}
export function updateUser(id, patch) {
  const db = load();
  const u = db.users.find((x) => x.id === id);
  if (!u) return null;
  Object.assign(u, patch);
  save();
  return u;
}
export function deleteUser(id) {
  const db = load();
  db.users = db.users.filter((u) => u.id !== id);
  const docIds = db.documents.filter((d) => d.ownerId === id).map((d) => d.id);
  db.documents = db.documents.filter((d) => d.ownerId !== id);
  db.activity = db.activity.filter((a) => a.userId !== id && !docIds.includes(a.documentId));
  save();
  return true;
}
export function listUsers() {
  return load().users.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export function findUserByEmail(email) {
  return load().users.find((u) => u.email === String(email).toLowerCase());
}
export function findUserById(id) { return load().users.find((u) => u.id === id); }
export function nameOf(id) { const u = id && findUserById(id); return u ? u.name : null; }
export function publicUser(u) { return u ? { id: u.id, email: u.email, name: u.name } : null; }

// --- documents ---
export function createDocument({ ownerId, title, sourceText, sourceLang, targetLang }) {
  const db = load();
  const now = new Date().toISOString();
  const doc = {
    id: crypto.randomUUID(),
    ownerId,
    title: title || 'Без назви',
    sourceText: sourceText || '',
    translatedText: '',
    sourceLang: sourceLang || '',
    targetLang: targetLang || '',
    status: 'added', // added | translating | translated | edited
    sourceChars: charsWithSpaces(sourceText),
    targetChars: 0,
    addedBy: ownerId,
    lastEditedBy: null,
    createdAt: now,
    updatedAt: now,
  };
  db.documents.push(doc); save(); return doc;
}
export function getDocument(id) { return load().documents.find((d) => d.id === id); }
export function listDocuments() {
  return load().documents.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export function updateDocument(id, patch) {
  const db = load();
  const doc = db.documents.find((d) => d.id === id);
  if (!doc) return null;
  Object.assign(doc, patch, { updatedAt: new Date().toISOString() });
  doc.sourceChars = charsWithSpaces(doc.sourceText);
  doc.targetChars = charsWithSpaces(doc.translatedText);
  save();
  return doc;
}
export function deleteDocument(id) {
  const db = load();
  const existed = db.documents.some((d) => d.id === id);
  db.documents = db.documents.filter((d) => d.id !== id);
  db.activity = db.activity.filter((a) => a.documentId !== id);
  save();
  return existed;
}

// --- activity ---
export function addActivity({ userId, documentId, action, chars }) {
  const db = load();
  const entry = {
    id: crypto.randomUUID(),
    userId, documentId, action,
    chars: chars || 0,
    at: new Date().toISOString(),
  };
  db.activity.push(entry); save(); return entry;
}
// Coalesce a run of edits by the same user on the same document into one entry.
export function logEditCoalesced(userId, documentId, chars) {
  const db = load();
  const last = db.activity[db.activity.length - 1];
  if (last && last.action === 'edited' && last.userId === userId && last.documentId === documentId) {
    last.chars = (last.chars || 0) + (chars || 0);
    last.at = new Date().toISOString();
    save();
    return last;
  }
  return addActivity({ userId, documentId, action: 'edited', chars });
}
export function listActivity(limit = 100) {
  return load().activity.slice().sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}
export function allActivity() { return load().activity; }
