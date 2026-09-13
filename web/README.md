# PocketVerdict — web app (Buy or Wait?)

Full-stack workbench on top of the Python decision engine in `../code`:
**Next.js 16 (App Router) · MySQL · Prisma · Tailwind CSS v4 · NextAuth (credentials)**.

* Dashboard of every request with status, recommendation, safe amount and filters
* Request detail: decision card, 90-day balance forecast chart (minimum-balance floor, payment
  markers, deadline), payment plan, spending changes, seller options, messages and images
* “Ask” form: create an ad-hoc request for any user and get a recommendation from the engine
* Evaluation page: agreement with the 25 solved samples
* Every engine run is stored (`Decision`), so decisions have history and an audit trail

## Run it

```bash
cd web
cp .env.example .env            # edit AUTH_SECRET at least
docker compose up -d            # MySQL 8.4 on localhost:3307
npm install
npx prisma db push              # create the schema
npm run db:seed                 # import ../dataset + ../output.csv, copy images, create demo login
npm run dev                     # http://localhost:3000  (demo@buyorwait.app / demo1234)
```

**No Docker / MySQL at hand?** Set `DATABASE_URL="file:./dev.db"` in `.env` and run
`npm run db:sqlite` instead of the two Prisma steps: it derives a SQLite schema from the MySQL one,
pushes it, regenerates the client and seeds the same data. Switch back with `npm run db:mysql`.

The engine runs as a child process (`python ../code/serve.py`), so Python 3.10+ with the
requirements in `../code/requirements.txt` must be available to the Node process
(`PYTHON_BIN` in `.env`). API keys for the optional VLM/LLM path are read from the environment
by the engine, never stored in the database.

## Layout

```
web/
├── app/
│   ├── page.tsx                 dashboard (server component + client table)
│   ├── requests/[id]/page.tsx   decision, forecast chart, evidence, options, history
│   ├── ask/page.tsx             ad-hoc request form
│   ├── evaluation/page.tsx      sample agreement
│   ├── login/page.tsx           credentials sign-in
│   └── api/
│       ├── decide/route.ts      POST → run engine (existing or ad-hoc request), store decision
│       ├── requests/[id]/route.ts  GET → request + latest decision (JSON)
│       └── auth/[...nextauth]/route.ts
├── components/                  Nav, StatusBadge, BalanceChart (recharts), RequestTable, AskForm, RunEngineButton
├── lib/                         db.ts (Prisma), engine.ts (child-process bridge), format.ts
├── prisma/schema.prisma         MySQL schema (profiles, events, requests, options, messages, images, rates, decisions, users)
├── prisma/seed.ts               CSV importer
└── docker-compose.yml           MySQL
```

## Notes

* Chart colours follow a validated categorical palette (one series, reserved status colour for
  the minimum-balance floor); light and dark mode use their own steps.
* Auth is NextAuth v5 with a bcrypt-hashed credentials user created by the seed. Swap in Clerk or
  an OAuth provider by editing `auth.ts` only.
