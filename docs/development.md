# Development

Setup, local testing and deployment instructions for Argus. See [README](../README.md) for the product overview and sample traces.

## Run locally

Install Node.js 24 or later and Poppler (`pdfinfo` and `pdftoppm`). On Debian or Ubuntu, install Poppler with `sudo apt-get install poppler-utils`.

```bash
git clone https://github.com/puneet-chandna/ARGUS.git
cd ARGUS
npm ci
cp .env.example .env
```

Create a Supabase project with Auth and Storage enabled. Apply the SQL files in [supabase/migrations](../supabase/migrations) once each, in filename order. For an existing project, apply only migrations that have not already been applied. The migrations create the private PDF bucket, account-scoped tables, OCR budgets, upload fencing and retry controls. The completed-OCR retry requires `202611190003_ocr_retry.sql`.

Set these values in `.env`:

- `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` from the same Supabase project. The secret stays on the server.
- `ARGUS_PUBLIC_ORIGIN=http://localhost:3000` for local use.
- `NVIDIA_API_KEY` for the independent vision reader and `SARVAM_API_KEY` for the primary OCR reader. If NVIDIA is unavailable, the independent lane can use `deepseekv4.1-flash-1017` through Sarvam with the same Sarvam key. Each model retains its own evidence identity. Both Sarvam routes require account credits; HTTP 402 means billing/quota must be restored. Optional fallbacks and page limits are listed in [.env.example](../.env.example).

In Supabase Auth, allow the app origin and its `/auth/confirm` redirect. Create a reviewer through the app's sign-up flow or Supabase Auth. For production mode, run:

```bash
npm run build
npm run start
```

Open <http://localhost:3000>. Use `npm run dev` for development. Upload synthetic or de-identified PDFs and approve cloud OCR for each new document. A cache hit can reuse verified readings without a new cloud call.

## Verify the source corpus and tests

Download the [official starter ZIP](https://solvetojoin.vaatun.com/downloads/insurance-rater-agent-challenge.zip). Place its `challenge.md`, `MANIFEST.json`, `raters/` and `sample-policies/` under `vaatun-starter-bundle/`, retaining the original files and paths. Runtime rating uses the checked-in tables in `lib/rating/cards.json`; source verification and fixture tests also need the original bundle.

```bash
npm run verify:corpus
npm test
npm run typecheck
npm run build
```

Storage and browser tests require a running production app and a separate, disposable local Supabase instance with all migrations applied. Set `ARGUS_TEST_URL`, `ARGUS_TEST_SUPABASE_URL`, `ARGUS_TEST_SUPABASE_SECRET` and `ARGUS_TEST_SUPABASE_PUBLISHABLE_KEY` to that local stack. The app must use the same Supabase project. These suites create and delete test accounts and reject non-loopback test endpoints.

```bash
npm run test:integration
npm run test:e2e
```

Run `npx playwright install chromium` if the browser is missing. OCR unit tests use stubbed responses. Live-provider verification requires separate authorization and available provider credits; a passing local suite does not establish live-provider or hosted deployment behavior.

### Runtime coverage

With the four `ARGUS_TEST_*` variables above set to the disposable local stack,
run `npm run test:coverage`. It builds and starts its own production app at
`ARGUS_TEST_URL`; that port must be free. The command combines unit, database/API
and Chromium coverage and fails unless overall line coverage is **above 80%**.
It forces the app to use that local database and disables live OCR credentials.

The report includes every runtime `.ts`/`.tsx` file under `app/` and `lib/`,
including untested files. Pure type declarations, tests, build/test tooling,
third-party dependencies and static assets are outside the runtime denominator.
Branch, function and statement coverage are reported separately. Read
`.local/coverage/report/index.html` or `coverage-report.json` for file-level gaps.
Source maps are enabled only for this local coverage build; normal production
builds keep browser source maps off.

### Known source limits

Go Digit's `4W New Business 1+3!B2:I3` labels CD2 payouts but does not establish
the OD/TP component premium basis. Argus leaves those component rates unresolved;
it does not apply a package percentage to OD or TP by assumption.

Tata's `General Guidelines!C10` requires the relevant RTO cluster. Unlisted
office-to-city mappings and missing vehicle Type mappings remain grid blockers.
They are reported as Needs review, with the available source citations, rather
than treated as documented exclusions. When SATP Type rows disagree, the trace
cites their competing payout cells. A genuine source exclusion still produces
Unsupported; an explicitly applicable zero rate remains `0%`.

## Deploy

Use the included [Dockerfile](../Dockerfile) on Render or another container host. It builds the Next.js standalone server, installs Poppler and runs the app as the `node` user. Docker-based hosts use the Dockerfile's build and start instructions.

```bash
docker build -t argus .
docker run --rm --env-file .env -p 3000:3000 argus
```

Apply outstanding Supabase migrations before releasing code that depends on them. Set the same Supabase and OCR variables on the host, and set `ARGUS_PUBLIC_ORIGIN` to the exact public HTTPS origin, including the custom domain when used. A mismatched origin rejects sign-in and upload requests. Update Supabase Auth's allowed redirects to that origin's `/auth/confirm` URL.

Configure the host's health check at `/api/health`. Saved PDFs and reports live in Supabase and require no container volume. The optional local OCR cache is an optimization, so losing it does not delete saved history. For automatic retention, configure [supabase/retention-schedule.sql](../supabase/retention-schedule.sql) with the actual host after applying the migrations.

After deployment, upload a synthetic PDF outside the supplied samples and check the result, evidence and original PDF across refresh, sign-out/sign-in and a container restart or replacement. Compare the downloaded PDF bytes with the upload. These hosted lifecycle checks remain a submission gate.
