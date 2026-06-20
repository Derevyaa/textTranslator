# Translation Workbench — multi-user edition (v2)

A web service for translating texts via **DeepSeek V4** or **Anthropic Claude**
(Anthropic-compatible API), with user accounts, a document library, a
"who added / who edited" activity log, a dashboard, and per-page billing.

## Features

- Registration / login (email + password, JWT in an httpOnly cookie, bcrypt-hashed passwords)
- Document library that stores both the original and the translation
- Translation with a live progress bar (paragraph-based chunking)
- In-app translation editing + saving with author attribution of each edit
- Upload `.txt`/`.md`, download the result, re-upload an edited version
- Activity log: who added, who translated, who edited (+ how many characters)
- Dashboard: pages, amount due, personal statistics
- Billing: **30 UAH / 1800 characters with spaces** (configurable)

## Running

Node.js 18+ (no native dependencies — installs anywhere).

```bash
npm install
cp .env.example .env       # fill in the API key and SESSION_SECRET
npm start                  # http://localhost:3000
```

The first screen is /login (registration/login). After signing in — the Workbench and Dashboard.

## Configuration (.env)

Provider — one of the two blocks (DeepSeek or Anthropic).
Be sure to change `SESSION_SECRET` to a long random string:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Billing:
| Variable     | Description                              | Default  |
|--------------|------------------------------------------|----------|
| `RATE_UAH`   | price per page                           | `30`     |
| `PAGE_CHARS` | characters (with spaces) per page        | `1800`   |
| `BILL_ON`    | bill by `source` or `target`             | `source` |

"Characters with spaces" are counted excluding line breaks (like "characters with spaces" in Word).

## Structure

```
server.js      — Express: auth, documents, translation, dashboard routes
auth.js        — registration/login, JWT cookie, protection middleware
db.js          — storage (JSON file at ./data/db.json) + billing
translate.js   — chunking + provider call + progress streaming
public/
  login.html       — login/registration
  index.html       — workbench
  dashboard.html   — dashboard
  assets/app.css   — shared styles
data/db.json   — database (created automatically; do not commit)
```

## Data and backup

The entire database is a single file, `data/db.json`. To back it up, just copy it.
Writes are atomic (via tmp + rename). Suitable for a small team; for high load,
consider migrating to SQLite/Postgres (the logic is isolated in db.js).

## What's next (not part of the MVP)

- **Real payments.** Right now the amount is only calculated and displayed. Live
  payment acceptance (LiqPay / WayForPay / Fondy) is a separate step that needs
  your merchant credentials and confirmation webhooks.
- Roles (admin / translator / client) and per-user document privacy.
- `.docx` support (via `mammoth`).
- Invoice export.
- additional language support

---

## Running in Docker (recommended for a VPS)

Two services via docker-compose:
- **app** — the Node application (port 3000)
- **tokenizer** — a Python service running DeepSeek's official tokenizer (internal, port 8000)

```bash
cp .env.example .env        # fill in the API key, SESSION_SECRET, billing
docker compose up -d --build
```

Open http://localhost:3000 (or proxy it through nginx on the VPS).
The database (`data/db.json`) is mounted as a volume and survives restarts/rebuilds.
`TOKENIZER_URL` is set automatically inside compose — nothing to do.

Logs: `docker compose logs -f app` · Stop: `docker compose down`.

Without Docker it also works (`npm start`); the tokenizer is simply disabled
while `TOKENIZER_URL` is empty.

## DeepSeek balance

The dashboard shows a "DeepSeek balance" card — the app proxies
`GET https://api.deepseek.com/user/balance` (Bearer auth; the key stays on the
server). If the provider is Anthropic, the card shows "via Anthropic".
DeepSeek accepts top-ups via PayPal / card / Alipay / WeChat — for Ukraine,
PayPal is usually the simplest route.

## Tokenizer and API cost

The `tokenizer` service loads the official `tokenizer.json` (via the lightweight
`tokenizers` library — ids identical to the official transformers) and provides an
exact token count. In the Workbench, next to the price in UAH, it shows
"N tokens · ~$X API" — an approximate cost of the request in DeepSeek
(based on `DEEPSEEK_PRICE_IN/OUT`), so you can see the margin between the client
tariff and the API cost.

If you want the official path via transformers (as in `deepseek_tokenizer.py`),
replace the dependency in `tokenizer/requirements.txt` and `tokenizer/app.py`
with `transformers.AutoTokenizer.from_pretrained('.', trust_remote_code=True)`.
