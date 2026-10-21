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

- **Choice:** the Node server relays an explicit list of Pingwarden endpoints (every read of the
  OpenAPI spec, the actions and the live stream), under `/api/i/<instance>/…` (D17), and adds
  two of its own (`/api/me`, `…/history`). Identifiers must match Pingwarden's id rule, query
  parameters are allow-listed and validated, and action bodies are rebuilt from the known,
  type-checked fields before anything is sent. Answers pass through unchanged.
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
  - `token`: no sign-in; the server uses each instance's API token (or none, with Pingwarden's
    `anonymous_read`). **Read-only by default** (`READ_ONLY=true`), because anyone who reaches
    the page could otherwise pause monitors. `READ_ONLY=false` hands the decision to the token's
    scope.
- **Not both at once:** a mixed mode (anonymous viewing, sign-in to act) would need two sets of
  credentials and per-request switching. Two instances (a token one for the wall, an OIDC one for
  the team) give the same result.
- `READ_ONLY=true` works in OIDC mode too, for a view-only deployment.

### D4. Who may act: Pingwarden says so ⚠️

- **At sign-in**, the callback calls `/api/v1/status` of every instance with the new access token
  before creating a session. When every instance refuses (401: issuer or audience; 403: no
  role), the sign-in ends with an explanation, and no session exists. Unreachable instances do
  not block the sign-in.
- **Actions** come from Pingwarden's `GET /api/v1/me` (`scope: read | admin`), asked per instance
  and kept for 5 minutes (per session with OIDC, per instance in token mode). A read scope greys
  the action buttons out, with the reason in the tooltip; `READ_ONLY=true` greys them out
  everywhere.
- **Older Pingwarden** (no `/me`): `canAct` is unknown and the actions are shown; the first
  refused action (403) greys them out for the rest of the session. The first version had an
  `OIDC_ROLES_CLAIM`/`OIDC_ADMIN_ROLES` hint that mirrored Pingwarden's role settings: it is
  gone, and setting it is now a configuration error that says so.

### D5. Sessions in memory ⚠️

- **Choice:** sessions (user name, access, refresh and ID tokens) live in a `Map` keyed by the
  SHA-256 of the cookie value; pending logins expire after 10 minutes and are capped at 10,000.
  Sessions end after `SESSION_TTL_HOURS` (12), or when a refresh fails.
- **Refresh:** an access token within 30 s of its expiry is refreshed before use, one refresh
  per session at a time (refresh tokens may rotate); what the user may do is asked again after
  a refresh.
- **A token Pingwarden refuses (401)** is refreshed once and the request retried. If Pingwarden
  still refuses it, the dashboard shows Pingwarden's reason and keeps the session. The first
  version ended the session, but signing in again only goes through the provider back to the
  same refusal: a loop, and with several instances one misconfigured instance would sign the
  user out of all of them.
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
- **CSP:** `default-src 'self'`, no inline script or style, `frame-ancestors 'none'` unless
  `FRAME_ANCESTORS` (D22) lists origins. React's
  `style={…}` sets styles through the CSSOM, which CSP allows. The few server-rendered pages
  (sign-in errors, signed out) have no script and their own CSP that allows their inline style;
  the browser walk-through caught them being blocked by the main policy.
- **Audit:** every action is logged as `[action] oidc:<user> on <instance>: <what> → HTTP
<status>` (`token` in token mode); Pingwarden logs the caller of admin actions too.

### D7. Pingwarden's API types by hand, checked against its spec

- **Choice:** `src/shared/pingwarden.ts` is written from Pingwarden's `docs/openapi.yaml`, now
  including the additions of D23. Fields and endpoints that came with those are marked "newer"
  and optional, so the UI keeps working against an older Pingwarden. A copy of the spec is in
  `test/fixtures/`; `test/openapi.test.ts` fails when the
  enums (statuses, monitor types, event kinds, notifier types, uptime windows) or the fields the
  UI uses drift from it, or when a relayed path is not in the spec.
- **Why not `openapi-typescript`** (which Pingwarden's docs suggest): it is one more dev
  dependency with a TypeScript 5 peer dependency (this project aliases TypeScript 6 and 7), and
  generated code. The API is small and read-mostly.
- **To update:** copy the new spec into `test/fixtures/`, run the tests, fix what fails.

## UI

### D8. Views and navigation

- **Monitors** is the home page; **Events**, **Reliability**, **Certificates**, **Dependencies**,
  **Notifications**, **Maintenance** and **System** are tabs (a menu below 1440 px); **Board**
  is a separate full-screen view. A monitor's details open in a drawer over
  any view. Groups and tags have no page of their own: they are the grouping and filters of the
  monitor list, and tables on the System page.
- **State in the query string** (`?i=office&view=events&range=30d&m=web`): reload,
  back and shared links work.
- **The tab title counts monitors that are down** (`(2 down) Monitors · Pingwarden`), so a
  background tab shows trouble.

### D9. Live data: Pingwarden's event stream, polling as the fallback

- **Choice:** the browser opens an `EventSource` on `/api/i/<instance>/stream`, which relays
  Pingwarden's `GET /api/v1/stream` with the user's (or the instance's) token. Transitions,
  notifications, acknowledgements, maintenance changes and reloads trigger a reload of the
  monitor list (debounced 300 ms) and of whatever the open view shows. While the stream is
  connected, polling drops to every 2 minutes as a safety net; the header says "live".
- **Relay length:** each relayed stream ends after 15 minutes, or 30 s before the user's access
  token expires. The browser reconnects by itself and the new stream starts with a fresh token,
  so a stream never outlives the token Pingwarden checked when it opened.
- **Fallback:** with an older Pingwarden (404) or when its 64 streams are taken (503), the
  `EventSource` gives up; the UI polls every `REFRESH_SECONDS` (15) and tries the stream again a
  minute later. After a failed reload the last data stays, with "not updating" in the header
  and a banner saying how old it is.
- **One stream per browser tab:** Pingwarden caps streams at 64. Fanning one upstream stream out
  to many browsers would need the same token for all of them, which is only true in token mode.
  _Revisit when_ many wall displays share one dashboard.

### D10. The 24-hour history bars come from one request

- **Choice:** `…/history?hours=24` uses Pingwarden's bulk `GET /api/v1/rollups` (one SQL query for
  every monitor). With an older Pingwarden (404), it falls back to the monitor list and each
  monitor's hourly rollups, 8 at a time; a monitor whose rollups fail is listed in `failed`.
- **No caching across users:** each user's token is checked by Pingwarden every time.

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
- **Per-monitor deliveries** (monitor details) use Pingwarden's `/notifications?monitor=`, and
  are filtered in the browser too, since an older Pingwarden ignores that parameter.
- **Limits:** lists are read with Pingwarden's maximum `limit` (10,000); a full page shows a
  warning to choose a shorter period.

## Development & deployment

### D14. A real Pingwarden for development and the tests ⚠️

- `compose.yaml` runs Pingwarden (the published `edge` image pinned by digest, or any image
  through `PINGWARDEN_IMAGE`, e.g. one built from a checkout), PostgreSQL 18 and
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

- **Verified** (all on zeus, the second round against a Pingwarden image built from its working
  tree, `pingwarden:features`):
  - `npm run check`: typecheck, ESLint, Prettier, 56 tests, twice in a row (the end-to-end
    tests leave nothing behind). 13 run against the compose stack:
    - token mode: every read, a read token refused an action;
    - OIDC through the mock provider: an admin signs in and acts; the access token is
      refreshed; a reader sees actions greyed out (Pingwarden's `/me`) and is refused one; a
      user without a role gets no session; a stolen callback is refused; logout ends the
      provider session;
    - the new features: the bulk history, acknowledge and silence and their undo, a runtime
      maintenance window applied and ended, the effective configuration without secrets, and
      an event arriving on the relayed stream.
  - Against the older `edge` Pingwarden too: everything falls back (polling, per-monitor
    history, no runtime controls, "needs a newer version" for the configuration).
  - Chromium walk-throughs of the production build in OIDC mode: every view, light and dark,
    desktop and phone width (no horizontal overflow), pins and saved views, and every runtime
    control used through the UI (acknowledge with a comment, silence, maintenance from the
    drawer and from the form, end, undo), each in the audit log. A change made directly in
    Pingwarden reached the open page in about 0.3 s through the stream.
  - The walk-throughs found and led to fixes for:
    - the CSP blocking the sign-in pages' inline style (D6);
    - an older Pingwarden's empty 404 being taken for "unreachable", which defeated the
      fallbacks;
    - streams piling up: pages in the back/forward cache kept theirs open until Chromium's six
      connections per host were used up, and the relay to Pingwarden outlived the browser
      (now closed on `pagehide`, and on the Node response's `close`);
    - toasts covering the drawer's actions (moved to the bottom), and menus that stayed open
      over other buttons;
    - MTBF crediting a new monitor with the whole period.
  - The Docker image: built on the `dhi.io` base, runs as uid 1000 with a read-only root
    filesystem and no capability, serves the UI and relays to Pingwarden.
- **Not verified:**
  - a real identity provider (Keycloak, Authentik, Zitadel): only the mock;
  - several instances against real Pingwardens (covered by unit tests with two fake ones);
  - the GitHub workflows (the repository is not on GitHub yet), including whether the runner can
    pull `ghcr.io/sebastka/pingwarden` without a login (it must be public);
  - the desktop notification and the sound themselves (headless Chromium has neither); the
    "went down" detection that triggers them is unit-tested;
  - embedding in another site's frame (only the headers are tested);
  - many monitors: the dev stack has 14. The list is not virtualised; a few hundred monitors
    should be fine, thousands would need paging;
  - a Pingwarden standby (the API answers 503; the UI shows the error);
  - MariaDB behind Pingwarden (it makes no difference to the API).

## Features added in the second round

### D17. Several Pingwarden instances ⚠️

- **Choice:** numbered blocks `PINGWARDEN_<n>_URL`, `_NAME`, `_ID`, `_TOKEN`; `PINGWARDEN_URL`
  (with `PINGWARDEN_NAME` and `PINGWARDEN_TOKEN`) stays as the single-instance shorthand, the
  instance `main`. Every API path names its instance (`/api/i/<id>/…`), and so does the UI's URL
  (`?i=<id>`) when there is more than one.
- **One instance at a time:** a switcher in the header shows each instance's name and how many
  monitors are down there. Views, saved views and pins are per instance. The board can show
  every instance at once (`?view=board&i=all`), problems first; it polls in that mode.
- **OIDC:** the same user token goes to every instance, so each must trust the same provider and
  audience. An instance that refuses the token shows the error; the others keep working (D5).
- **Alternative:** merging every instance into one list. Ids are only unique per instance, and
  groups, maintenance and notifiers are separate configurations: a merged view would mostly
  prefix and disambiguate.

### D18. Acknowledge, silence and ad-hoc maintenance in the UI

- **Acknowledge** (monitors that are down, pending or degraded) asks for an optional comment;
  reminders stop until the monitor is up again. **Silence** offers 15 minutes to 7 days; every
  notification about the monitor is suppressed until then. **Maintenance 1 h** starts a window
  for the monitor from its details; the Maintenance page starts windows for monitors, groups,
  tags or everything, now or later, for 30 minutes to 7 days, and ends API windows early.
- These are runtime actions like pause: admin scope, read-only mode and the audit log apply.
  They only show with a Pingwarden that has them (its monitors carry `acknowledged`).
- The list marks acknowledged and silenced monitors; events show why a change was not notified.

### D19. Reliability, SLOs and reports ⚠️

- **SLO targets come from Pingwarden's configuration** (`slo: 99.9` on monitors, groups or
  defaults, D23), not from the UI: they are configuration as code like everything else, and
  every viewer sees the same targets.
- **Periods:** the last 30 days, or a calendar month **in UTC**, since Pingwarden's daily rollups
  are UTC days.
- **Uptime** comes from the daily rollups (up and degraded over all non-maintenance checks).
  **Error budget used** = (100 − uptime) / (100 − SLO): 100 % means the SLO is just met.
- **Outages** come from the period's events: from a change to down to the monitor's next change
  to anything else. An outage running at the start of the period counts from the start, one still
  running counts until the end. **MTTR** averages outages that started and ended inside the
  period; **MTBF** is the time up divided by the number of outages, counted from the monitor's
  first results in the period (a monitor added mid-month is not credited the time before).
- **Reports:** "CSV" downloads the table (RFC 4180, durations in seconds); "Print" uses a print
  stylesheet (no header or controls), which the browser saves as PDF. No PDF library.

### D20. Per-browser features: saved views, pins, alerts

- **Saved views** (named filter sets) and **pinned monitors** (a "Pinned" section above the
  list; they also stay in their usual place) live in the browser's `localStorage`, per instance.
- **Alerts** (bell menu, header and board): a desktop notification and/or a two-tone sound made
  with WebAudio (no sound file) when a monitor goes down while the page is open. Off by
  default; the browser asks for notification permission when they are switched on. Monitors
  that were already down, or that just appeared, do not alert.
- **Why not on the server:** they are personal and need no account, and the dashboard keeps no
  per-user state besides sessions. _Revisit when_ views should be shared within a team.

### D21. Dependency graph and certificates

- **Dependencies:** monitors that take part in a `depends_on` are laid out in columns, each one
  column to the right of its deepest dependency, rows ordered by the mean row of their
  dependencies (fewer crossings). Edges from a down dependency are red; hovering or focusing a
  monitor highlights its neighbours. Cycles and unknown ids are tolerated. Hand-drawn SVG,
  no graph library.
- **Certificates:** every TLS monitor by expiry date, from `cert_expires_at` (falling back to the
  older `cert_expiry` in seconds).

### D22. Embedding (`FRAME_ANCESTORS`)

- Lists the origins that may frame the dashboard: they go into CSP `frame-ancestors`, and
  `X-Frame-Options` (which cannot name origins) is dropped. Default: no framing.
- Works in token mode. With OIDC, a cross-site frame does not send the `SameSite=Lax` session
  cookie, and providers refuse to be framed for sign-in: only same-site embedding works.
  `SameSite=None` was not chosen, since it would weaken CSRF protection for every user.

### D23. What was added to Pingwarden

Implemented in Pingwarden (its DECISIONS.md has the details), each additive to `/api/v1`:
`GET /me`; bulk `GET /rollups`; `monitor`, `notifier`, `success` and `event` filters on
`/notifications`; `GET /stream` (server-sent events); `cert_expires_at` in milliseconds; the
`slo` setting; acknowledge/unacknowledge and silence/unsilence; runtime maintenance windows
(`POST /maintenance`, `POST /maintenance/{id}/end`); `GET /monitors/{id}/config` without
secrets; and a webhook with `method: GET` no longer sends a body.

## Ideas not implemented

- **Shared saved views** (stored on the server, per team) instead of per browser (D20).
- **One upstream stream for many viewers** in token mode (D9).
- **Group SLOs:** an uptime target for a whole group, computed from its members.
- **Annotations** on outages (cause, ticket link): needs storage, in Pingwarden or here.
- **Persistent sessions** for replicated deployments (D5).
- A public status page is out of scope by design: it is a separate project.
