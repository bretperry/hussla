-- The prototype's SQLite schema (plain-JS Hussla prototype, server/db.js), for
-- TestMigratesPrototypeDB and as the reference shape. Later migration: emails.companySlug TEXT.
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL DEFAULT '',
  companySlug TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'review',
  score INTEGER,
  url TEXT, location TEXT, workType TEXT,
  salaryMin INTEGER, salaryMax INTEGER, payText TEXT,
  source TEXT, resume TEXT, resumeSent TEXT,
  foundAt TEXT, appliedAt TEXT,
  nextAction TEXT, nextActionDue TEXT,
  data TEXT NOT NULL DEFAULT '{}',
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS companies (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data TEXT NOT NULL DEFAULT '{}',
  updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jobId TEXT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS events_job ON events(jobId, at);
CREATE TABLE IF NOT EXISTS answers (
  id TEXT PRIMARY KEY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  jobIds TEXT NOT NULL DEFAULT '[]',
  createdAt TEXT NOT NULL,
  answeredAt TEXT
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  jobId TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file',
  mime TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  actor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hash TEXT NOT NULL UNIQUE,
  createdAt TEXT NOT NULL,
  lastUsedAt TEXT,
  revokedAt TEXT
);
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  jobId TEXT,
  toAddrs TEXT NOT NULL,
  ccAddrs TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'follow-up',
  status TEXT NOT NULL DEFAULT 'draft',
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  approvedBy TEXT, approvedAt TEXT,
  sentAt TEXT, messageId TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
ALTER TABLE emails ADD COLUMN companySlug TEXT;
