# Design decisions

Decisions taken while building the Pingwarden UI without asking. Each lists the choice, why, and
what we could do instead. Entries marked ⚠️ are the ones most worth reviewing together.

## Scope & architecture

### D1. Stack

- One npm package; Node 26 runs the TypeScript server directly (type stripping, erasable syntax
  only); `tsc` 7 for typechecking with TypeScript 6 aliased for typescript-eslint; Hono API;
  React 19 / Vite 8 UI; ESLint flat config, Prettier, `node:test`, a release workflow, a
  Dockerfile on Docker Hardened Images, a bundle script and Dependabot. `openid-client` does the
  OIDC login.
- **No new runtime dependency** besides those three (`hono`, `@hono/node-server`,
  `openid-client`). `yaml` is a dev dependency for the OpenAPI drift test (D7).
- **No UI component or chart library**: icons and charts are hand-drawn SVG, with a light and
  a dark palette. The status colours are the reserved status steps of the dataviz
  guidance (good, warning, serious, critical), each always shown with an icon and a label.

### D2. A backend for the frontend: the browser never talks to Pingwarden ⚠️

- **Choice:** the Node server relays an explicit list of Pingwarden endpoints (18: every read of
  the OpenAPI spec and the five actions) and adds two of its own (`/api/me`, `/api/history`).
  Identifiers must match Pingwarden's id rule and query parameters are allow-listed and
  validated before anything is sent. Bodies and status codes pass through unchanged.
- **Why:**
  - _Token mode_ (D3) needs a credential that must not reach the browser. Only a server can hold it.
  - _OIDC_: tokens stay out of browser storage, so an XSS cannot steal them. The browser holds
    an `HttpOnly` cookie.
  - Pingwarden's API can stay internal (its `server.listeners` can serve `api` on an internal
    port only) and needs no `server.cors`.
  - One place for the audit log, the CSRF guard and the history fan-out (D10).
- **Cost:** one more hop; sessions in this process (D5).
- **Alternative:** a static single-page app that signs users in itself (`oidc-client-ts`, PKCE)
  and calls Pingwarden directly through its CORS support, which was added for exactly that. It
  needs no server at all, but it cannot offer token mode without exposing the token, and the
  access token then lives in the browser.

### D3. Two access modes, chosen explicitly ⚠️

- **Choice:** `AUTH_MODE` is required, `oidc` or `token`. There is no default, so a dashboard
  cannot end up open by accident.
  - `oidc`: users sign in; each request to Pingwarden carries **the user's own access token**.
    The UI has no role configuration of its own: Pingwarden's `server.auth.oidc` (`read`,
    `admin`) is the single authority.
  - `token`: no sign-in; the server uses `PINGWARDEN_TOKEN` (or no token with Pingwarden's
    `anonymous_read`). **Read-only by default** (`READ_ONLY=true`), because anyone who reaches
    the page could otherwise pause monitors. `READ_ONLY=false` hands the decision to the token's
    scope.
- **Not both at once:** a mixed mode (anonymous viewing, sign-in to act) would need two sets of
  credentials and per-request switching. Two instances (a token one for the wall, an OIDC one for
  the team) give the same result.
- `READ_ONLY=true` works in OIDC mode too, for a view-only deployment.

### D4. Who may act: Pingwarden decides, the UI only hints ⚠️

- **At sign-in**, the callback calls Pingwarden's `/api/v1/status` with the new access token
  before creating a session. A 401 (issuer, audience) or 403 (no role) ends the sign-in with an
  explanation, and no session exists for a user Pingwarden would refuse.
- **Actions** are shown unless known to be refused. `canAct` is `true`, `false` or `null`
  (unknown); unknown is shown as enabled:
  - optionally, `OIDC_ROLES_CLAIM` + `OIDC_ADMIN_ROLES` mirror Pingwarden's `claim` and `admin`,
    and the access token's claims give the answer at sign-in. This is display only: the token
    came straight from the provider's token endpoint, and Pingwarden checks every action;
  - otherwise the first refused action (403) greys the buttons out for the rest of the session,
    with the reason in the tooltip.
- **Why not ask Pingwarden:** it has no "who am I / what may I do" endpoint. One would remove the
  hint configuration (see "For Pingwarden" below).

### D5. Sessions in memory ⚠️

- **Choice:** sessions (user name, access, refresh and ID tokens) live in a `Map` keyed by the
  SHA-256 of the cookie value; pending logins expire after 10 minutes and are capped at 10,000.
  Sessions end after `SESSION_TTL_HOURS` (12), when a refresh fails, or when Pingwarden stops
  accepting the token (a relayed 401 drops the session; the UI then signs in again).
- **Refresh:** an access token within 30 s of its expiry is refreshed before use, one refresh
  per session at a time (refresh tokens may rotate), and the new token's roles update the hint.
- **Cost:** a restart signs everyone out; the next page load goes through the provider, which
  usually signs the user in without a prompt. Several replicas need sticky sessions.
- **Alternatives:**
  - an encrypted cookie holding the tokens: stateless and restart-proof, but Keycloak access,
    refresh and ID tokens together exceed the 4 KB cookie limit, so it would need cookie chunking;
  - a shared store (Redis, or a database): worth it once the UI runs replicated.

### D6. Security measures

- **CSRF:** writes need same-origin Fetch Metadata or `Origin`, plus an `X-Pingwarden-UI`
  header. The logout form is the one exception to the header (a plain
  same-origin form).
- **DNS rebinding:** a Host allow-list (localhost, `PUBLIC_URL`'s host, `ALLOWED_HOSTS`, the
  listen address). It matters for token mode, which has no login: without it, a malicious page
  could read an internal dashboard through a rebinding name. `/api/health` is exempt, since
  container and Kubernetes probes use the pod IP. `ALLOWED_HOSTS=*` switches the guard off.
- **CSP:** `default-src 'self'`, no inline script or style, `frame-ancestors 'none'`. React's
  `style={…}` sets styles through the CSSOM, which CSP allows. The few server-rendered pages
  (sign-in errors, signed out) have no script and their own CSP that allows their inline style;
  the browser walk-through caught them being blocked by the main policy.
- **Audit:** every action is logged as `[action] oidc:<user>: <what> → HTTP <status>`
  (`token:` in token mode); Pingwarden logs the caller of admin actions too.

### D7. Pingwarden's API types by hand, checked against its spec

- **Choice:** `src/shared/pingwarden.ts` is written from Pingwarden's `docs/openapi.yaml` (commit
  `3d31819`). A copy of the spec is in `test/fixtures/`; `test/openapi.test.ts` fails when the
  enums (statuses, monitor types, event kinds, notifier types, uptime windows) or the fields the
  UI uses drift from it, or when a relayed path is not in the spec.
- **Why not `openapi-typescript`** (which Pingwarden's docs suggest): it is one more dev
  dependency with a TypeScript 5 peer dependency (this project aliases TypeScript 6 and 7), and
  generated code. The API is small and read-mostly.
- **To update:** copy the new spec into `test/fixtures/`, run the tests, fix what fails.

## UI

### D8. Views and navigation

- **Monitors** is the home page; **Events**, **Notifications**, **Maintenance** and **System**
  are tabs; **Board** is a separate full-screen view. A monitor's details open in a drawer over
  any view. Groups and tags have no page of their own: they are the grouping and filters of the
  monitor list, and tables on the System page.
- **State in the query string** (`?view=events&range=30d&m=web`): reload,
  back and shared links work.
- **The tab title counts monitors that are down** (`(2 down) Monitors · Pingwarden`), so a
  background tab shows trouble.

### D9. Live data by polling

- **Choice:** the monitor list (and the views' data) reload every `REFRESH_SECONDS` (15) while the
  page is visible, and at once when it becomes visible again. History bars reload every minute.
  After a failed reload the last data stays, with "not updating" in the header and a banner
  saying how old it is.
- **Why:** Pingwarden has no push channel (SSE, WebSocket), and its monitor list is one cheap
  request.
- **Alternative:** the server polls Pingwarden once and pushes changes to every browser over
  SSE. Worth it for many simultaneous viewers; Pingwarden emitting SSE itself would be better
  still.

### D10. The 24-hour history bars come from one composite request ⚠️

- **Choice:** `/api/history?hours=24` reads the monitor list, then each monitor's hourly
  rollups, 8 at a time, and returns them together. A monitor whose rollups fail is listed in
  `failed` rather than failing the whole answer.
- **Cost:** N + 1 requests to Pingwarden per viewer per minute (cheap: rollups are pre-aggregated
  tables). No caching across users: each user's token is checked by Pingwarden every time.
- **Alternative:** a Pingwarden endpoint returning recent rollups of every monitor at once.

### D11. Status semantics

- **Colours:** down = critical, pending = serious (failing, not yet down), degraded = warning,
  up = good, maintenance = blue, paused and unknown = neutral grey. Always icon + label.
- **History slots** (bars and the chart strip) are classified as: all up, degraded, _partly
  down_ (serious), down, maintenance only, or no data (an empty grey slot, so gaps stay visible).
- **Uptime** counts up and degraded results and leaves maintenance out, as Pingwarden does, so
  the UI's own figures (history bars) agree with Pingwarden's uptime windows.
- **Pending results count as failures** in slots built from raw checks: Pingwarden stores raw
  outcomes, and the service _was_ failing (Pingwarden's D7).
- **A disabled monitor** shows as paused (Pingwarden reports no status for it), with a
  "disabled" chip.

### D12. The latency chart

- **One series:** average latency per slot as a 2 px line, the fastest–slowest range as a light
  band of the same hue, and the status strip under the plot. No legend box (the heading names
  the series); a crosshair tooltip on hover and with the arrow keys; a data table below.
- **Scale:** to the averages with 25 % headroom, not to the maximum. One slow check would
  otherwise flatten the line; the band is clipped at the top and the tooltip gives the exact
  maximum.
- **Resolution:** 24 h from raw checks in 15-minute slots (raw checks give the latest minutes
  too); 7 days from hourly rollups; 30 days from hourly rollups in 4-hour slots; 1 year from
  daily rollups.

### D13. Events and notifications derive what Pingwarden does not compute

- **Durations:** how long a status lasted is the time to the monitor's next event; the latest
  event of a monitor still in that status is "ongoing". Outages and summed downtime of the
  period are computed from these. A change whose end lies outside the loaded period shows "–".
- **Notifier health:** deliveries, success rate, last result and last error per notifier are
  computed from the delivery log of the period. The page also lists **monitors that notify
  nobody** and notifiers no monitor uses.
- **Per-monitor deliveries** (monitor details) are filtered from the period's log in the browser:
  Pingwarden's `/notifications` cannot filter by monitor.
- **Limits:** lists are read with Pingwarden's maximum `limit` (10,000); a full page shows a
  warning to choose a shorter period.

## Development & deployment

### D14. A real Pingwarden for development and the tests ⚠️

- `compose.yaml` runs Pingwarden (the published `edge` image, pinned by digest: the first one
  with OIDC support), PostgreSQL 18 and
  [mock-oauth2-server](https://github.com/navikt/mock-oauth2-server).
  `dev/pingwarden/` holds monitors in every state: up, degraded (a 1 ms latency budget), down
  with a dependency, pending/down push monitors, maintenance, disabled, nested groups, external
  TLS and DNS targets, and one notifier that delivers and two that cannot connect.
- **Pingwarden runs in the mock provider's network namespace.** Pingwarden accepts `http://`
  issuer and JWKS URLs only for `localhost`, and the issuer in the tokens must be what the
  browser and the UI server use. Sharing the namespace makes the provider `localhost:8080` for
  Pingwarden (JWKS) while everyone else uses the published `http://localhost:8090/default`
  (the issuer).
- **Ports are published on 127.0.0.1, not on `CONTAINER_HOST_ADDRESS`**,
  because the issuer has to be `localhost`. On zeus that variable is `169.254.1.2`, where the
  issuer would not match.
- **The mock's tokens** get `aud: [pingwarden-ui, pingwarden]` and `azp: pingwarden-ui`, like
  Keycloak with an audience mapper. With `aud: pingwarden` alone, openid-client rightly refused
  the ID token. Roles come from the mock's login form (`{"roles": [...]}`), so the tests sign in
  as admin, reader and stranger.
- **The delivering notifier** posts to Pingwarden's own push endpoint (monitor
  `webhook-receiver`). A GET webhook to the mock provider failed: the mock appears to hang on a
  GET that carries a body (a manual `curl -X GET -d …` hung too).

### D15. CI and releases

- `release.yaml`: the check job (typecheck, lint, format, unit tests and the end-to-end tests
  against the compose stack started with `npm run dev:pingwarden`, build), then a signed release
  archive (cosign keyless, SHA-256), then a multi-arch image on GHCR with SBOM and provenance,
  signed. Dependabot covers Actions, npm, the Dockerfile's DHI images and `compose.yaml` (so
  the pinned Pingwarden `edge` digest is refreshed weekly); minor and patch updates auto-merge.
- **Branch:** the workflow runs on `master`, this repository's current branch.
- **Repository settings** to apply: a ruleset on `master` with the
  "Check (tsc + eslint + prettier + tests) & build" job required, squash merges only,
  "Allow auto-merge" and "Allow GitHub Actions to approve pull requests" on, the
  `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` variable and secrets for Actions and Dependabot. Not done: the
  repository does not exist on GitHub yet.

### D16. What I verified, and what not ⚠️

- **Verified** (all on zeus):
  - `npm run check`: typecheck, ESLint, Prettier, 39 tests. 8 of them run against the compose
    stack: every read in token mode, a read token refused an action, and OIDC through the mock
    provider (an admin signs in and acts; the access token is refreshed; a reader is refused an
    action and sees actions greyed out; a user without a role gets no session; a stolen callback
    is refused; logout ends the provider session).
  - A Chromium walk-through of the production build in OIDC mode: sign-in through the mock's
    form, every view, tooltips, check now, light and dark, desktop and phone width, sign-out.
    It caught the CSP blocking the sign-in pages' inline style (D6), which is fixed.
  - The Docker image: built on the `dhi.io` base, runs as uid 1000 with a read-only root
    filesystem and no capability, serves the UI and relays to Pingwarden.
- **Not verified:**
  - a real identity provider (Keycloak, Authentik, Zitadel): only the mock;
  - the GitHub workflows (the repository is not on GitHub yet), including whether the runner can
    pull `ghcr.io/sebastka/pingwarden` without a login (it must be public);
  - many monitors: the dev stack has 14. The list is not virtualised; a few hundred monitors
    should be fine, thousands would need paging;
  - a Pingwarden standby (the API answers 503; the UI shows the error);
  - MariaDB behind Pingwarden (it makes no difference to the API).

## For Pingwarden

Things noticed while building against its API, which would simplify the UI or fix a rough edge:

- **A "who am I" endpoint** (`GET /api/v1/me` → name, scope): would replace the roles hint and
  the learn-from-403 logic (D4).
- **Bulk recent history** (rollups of every monitor in one request) would replace the fan-out
  of D10.
- **Filter the delivery log by monitor** (`/notifications?monitor=`), like the events.
- **Server-sent events** for status changes would replace polling (D9).
- **`cert_expiry` is in seconds** while every other timestamp is in milliseconds.
- **Does a `method: GET` webhook send the JSON body?** The mock provider hung on such a request
  (D14); a GET with a body is unusual and some servers reject or stall on it. To check.

## Ideas not implemented

Possible next features, roughly by value for the effort:

- **Browser notifications and sound** when a monitor goes down, for the board (UI only).
- **Incidents and reliability figures:** outages grouped per monitor with their duration, MTTR
  and MTBF, per month (UI only, from the events).
- **SLOs and error budgets** per monitor or group: an uptime target, the budget left and the burn
  rate (UI only, from rollups).
- **A dependency graph** of `depends_on` and groups, coloured by status (UI only).
- **A certificates page:** every TLS monitor by expiry date (UI only; today a banner and chips).
- **Saved views:** favourite filters and pinned monitors, per user (browser storage).
- **Reports:** a monthly uptime report per group, as CSV or PDF.
- **Embedding the board** in an iframe (Home Assistant, a wiki): a `FRAME_ANCESTORS` setting.
- **Several Pingwarden instances** in one dashboard.
- **Acknowledge or silence** an outage from the UI, and **ad-hoc maintenance** ("in maintenance
  for 1 h"): these need Pingwarden runtime APIs. They are also in tension with configuration as
  code, so they are a design decision for Pingwarden first.
- **Show a monitor's effective configuration** (thresholds, timeout, keyword) without
  secrets: needs Pingwarden to expose it.
- A public status page is out of scope by design: it is a separate project.
