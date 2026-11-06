# Outlook Attachment Pipeline

A scheduled Node job. Every run it reads unread Outlook mail through the
Microsoft Graph API, extracts payment-advice data from attachments and
email bodies with LangChain + OpenAI, and submits it to the AR API.

## Setup

```sh
cp .env.example .env   # fill in the values
npm install
npm start
```

`npm start` runs `node --expose-gc src/server.js`. The server listens on
`PORT` and only then starts the cron job, so a second instance can't run
it in parallel.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | Liveness check |
| GET | `/api/cron/status` | Schedule, running flag, last run |
| POST | `/api/cron/run-now` | Trigger a run outside the schedule |
| GET | `/api-docs` | Swagger UI (spec at `/api-docs.json`) |

`/api/cron/*` requires the `x-api-key` header when `API_KEY` is set.

## Shutdown

`SIGTERM`/`SIGINT` stop the schedule, close the HTTP server and wait up to
30 s for a run in progress before exiting. Set `EXIT_ON_UNCAUGHT=true` to
exit on an uncaught exception so PM2/systemd restarts the process.

## Flow

`server.js` (`startServer`) -> `cronJob.js` -> `emailProcessingService.js`
(`runEmailProcessingJob`):

1. **Connect** to Outlook (OAuth2 client credentials).
2. **Search** unread messages (up to `CRON_MAX_RESULTS`), skipping
   payroll senders, skipped subjects and ledger files.
3. **Download + extract** each attachment (Excel, CSV, PDF, image, ZIP)
   and the email body (`pipeline.js`).
4. **Map and submit** each email's payment advice to the AR API when
   confidence >= `MIN_AUTO_SUBMIT_CONFIDENCE`; otherwise record it as
   skipped.

Failures after a message was marked read go to the review log
(`utils/reviewLog.js`) for manual re-submission.

## Layout

```
src/
  server.js                   Express: /api-docs, /api/health, /api/cron/*; starts cron
  openapi.json                OpenAPI spec for the endpoints above
  cronJob.js                  schedule, run lock, watchdog
  emailProcessingService.js   validate, map and submit results
  pipeline.js                 search -> download -> extract
  outlookService.js           Microsoft Graph client
  parsers/                    Excel/PDF/ZIP parsing (pdfWorker.js is forked)
  services/                   OpenAI extraction, AR API, keyword/subject APIs
  utils/                      UTR/amount helpers, review log
  logger.js                   file logger
```
