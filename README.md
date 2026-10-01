# MIKŌ

An offline-first task manager. No build step, no dependencies, no bundler —
ES modules served as-is, with IndexedDB as the source of truth.

## Run it

```bash
python3 serve.py
```

That is the whole thing — <http://localhost:8000>, no install, no dependencies.
Add `--open` to launch a browser, or pass a port: `python3 serve.py 9000`. If
the port is busy it takes the next free one rather than failing.

It uses ES modules and a service worker, so `file://` will not work — it has to
come over HTTP.

**Why not `python3 -m http.server`?** That sends no `Cache-Control` header, so
the browser heuristically caches ES modules: you edit a file, reload, and get
the old one, which looks exactly like a change that did not work. `serve.py`
sends `no-store` for everything, sets the media types the app needs, allows the
service worker to claim the root scope, and falls back to `index.html` for deep
links the way a static host does.

### Deploying

Any static host will do — it is plain files with no build step. Two things the
host must get right:

- **`sw.js` must be served from the root** with `Service-Worker-Allowed: /`
  and no caching. A stale worker pins people to an old build.
- **`index.html` must not be cached**, and unknown paths should fall back to
  it, since routing is hash-based.

## Layout

```
index.html              thin shell — boot screen, then js/main.js takes over
serve.py                the development server; `python3 serve.py`
sw.js                   offline cache (shell + assets); never touches task data
manifest.webmanifest    PWA metadata
css/tokens.css          design tokens; both themes live here and nowhere else
css/app.css             reset, primitives, app chrome, components
css/views.css           list, board, calendar, insights, focus, detail drawer
css/landing.css         the landing page and its demo
assets/fonts/           Locanita.ttf (the display face) and its licence
assets/README.md        how to drop in a real demo recording
icons/                  app icons, favicon, maskable variants
docs/                   the execution checklist this was built against
js/main.js              boot sequence
js/core/
  util.js               ids, UTC time, text, small functional helpers
  db.js                 IndexedDB schema, indexes, versioned migrations
  store.js              the repository — every write goes through here
  search.js             inverted index with prefix matching
  history.js            undo/redo command stack
  sync.js               outbox, cross-tab realtime, presence, conflict merge
js/domain/
  recurrence.js         RRULE subset (parse / describe / next)
  nlp.js                natural-language quick add
  rules.js              automations, reminders, scheduling, time tracking
  analytics.js          completion rate, cycle time, workload, heatmap
  io.js                 CSV / JSON / ICS import and export, backups
  ai.js                 local heuristic engine + optional Claude adapter
js/ui/                  icons, kit (toasts/modals/menus/virtual list), shell,
                        task row + detail drawer, command palette
js/views/               tasks (list/board/calendar), insights, settings
```

### The one rule worth knowing

Every mutation goes through `js/core/store.js`, which does five things in the
same order every time: permission check → validation → version bump → audit
event → outbox + broadcast. Nothing writes to IndexedDB directly. That is what
makes undo, the activity feed, cross-tab sync, and conflict detection fall out
for free rather than needing to be retrofitted per feature.

## Against the execution checklist

### Phase 0 — Foundations

| Item | State |
|---|---|
| `workspace_id` on every table, indexed | Done |
| Roles and permissions | Client-side gate only — **needs a server**, see below |
| `version` column for optimistic concurrency | Done — stale writes throw `ConflictError` |
| Soft deletes (`deleted_at`) | Done, with Trash + restore + purge |
| UTC timestamps + timezone on profile | Done |
| `task_events` audit table | Done — who, what, when, before/after |
| Migrations in version control | Done (`js/core/db.js`, ordered and additive) |
| CI, staging, error tracking, uptime | **Needs infrastructure** |

### Phase 1 — Core product

All done: rich-text descriptions, subtasks and nesting, projects, labels,
checklists, dependencies with cycle detection (both the blocker graph and the
parent tree), Today / Upcoming / List / Board / Calendar, filters, sorting,
saved views, full-text search, virtualised lists, undo/redo, trash, bulk
actions, CSV and JSON import/export, and keyboard navigation with ARIA roles
and visible focus states throughout.

### Phase 2 — Reliability

Recurring tasks (RRULE, next instance generated on completion), reminders with
snooze, input validation on every write, indexes matching the hot queries,
and an outbox with ordered retry and exponential backoff. Job queues, Redis,
load balancing and load testing are **server concerns**.

### Phase 3 — Collaboration

Comments with @mentions, attachments, activity feed, realtime updates and
presence across tabs and windows via `BroadcastChannel`, and field-level
conflict resolution with a merge UI. Multi-user collaboration itself
**needs a server**.

### Phase 4 — Offline-first and PWA

Done: installable, service worker, IndexedDB as the primary read source,
outbox queue, sync status indicator, deterministic conflict resolution.
Local notifications work; **push to a closed device needs a server**.

### Phase 5 — Differentiators

Natural-language quick add, keyboard-first design with a command palette,
smart scheduling against working hours and capacity, time tracking with
estimate-vs-actual reporting, automation rules, templates, workload view,
focus mode, daily review, and an assistant that answers from your own data
(with optional Claude). Calendar export is ICS; two-way sync **needs a server**.

### Phase 6 — Platform

Outgoing webhooks, analytics dashboards, onboarding, empty states, in-app
help, audit-log export, full data export, and account deletion. A public REST
API, SSO, 2FA and billing **need a server**.

## What genuinely needs a backend

Not "was skipped" — cannot exist in a static site, and why:

1. **Server-enforced permissions.** The role matrix in `store.js` stops the UI
   from offering or issuing writes a role may not make. It is not a security
   boundary: a determined user controls their own browser. Real enforcement
   means Supabase RLS or API middleware.
2. **Multi-user anything.** Invites, shared workspaces, real presence between
   people. There is nowhere for two browsers to meet.
3. **Web push to a closed device.** Requires somewhere to hold the push
   subscription and sign messages with VAPID keys.
4. **Two-way calendar sync.** OAuth refresh tokens cannot live in a browser.
5. **Public REST API, SSO, 2FA, billing.** All need a server to host and
   authenticate.
6. **Job queues, Redis, load balancing, load testing, CI.** Infrastructure.

The data layer is shaped so these drop in rather than requiring a rewrite:
`sync.adapter` is a null object today. Implement `push` and `pull` against it
and the outbox starts draining to your API, in order, with retries, with no
other change anywhere in the app.

## The assistant

Two engines behind one interface. By default it answers from your own data —
priorities, a plan for the day, what is overdue, what is blocked — with no key,
no network, and no invented numbers.

Adding an Anthropic API key in Settings enables open-ended questions. Note what
that means: **a key held in a browser is readable by anything running in that
browser profile, including extensions.** Use a key scoped to a workspace you
can revoke. The durable fix is a small proxy that holds the key server-side;
`js/domain/ai.js` is written so that pointing it at a proxy is a URL change.

## Landing page and sign-in

`/` shows a landing page in two columns but on **one surface** — same
background, no dividing rule, and a single wash spanning both — so the fold
reads as one composition rather than two sections bolted together. The pitch
sits left, the sign-in row and the demo sit right, and the detail is below the
fold.

Below the fold is **not a panel**. It continues the same surface — no
background, no border, indented to the same left margin as the pitch — in three
columns: a heading held sticky on the left, a numbered list in the middle, and
a detail card on the right. Hairline rules and vertical space carry the rhythm
instead of six cards in a grid.

The section has no max-width: the right of the page was sitting empty and the
card is what should be using it. The heading column is held narrow and the gaps
tight for the same reason — 579px of card at 1440, reaching to within 53px of
the viewport edge. Inside it the
content stacks rather than splitting into two, which lets the visual run the
card's full width (408px, wider than any side-by-side arrangement managed).
Type runs at 29px/22px/16px, with the body on a 49ch measure.

The card has **no resting state** — it exists only while a row is hovered or
holds focus, and the grid column keeps its width so nothing shifts when it
goes. A 110ms grace period lets the pointer cross the gap from the list to the
panel without it blinking away.

Hovering or focusing a row fills it with a longer explanation, a small visual,
and three specifics, and tints the lot with that row's hue. The visuals show
the idea rather than restating the sentence: a palette field with a live caret,
a three-node graph with the cycle edge crossed out, a date strip with the
generated instance highlighted, a trigger-to-action flow, estimate-against-
actual bars, and an undo stack. All built from the same tokens as the app. **The hues are palette
tokens, not literals** — `--accent`, `--danger`, `--ok`, `--warn`, `--info`,
`--p-low` — so all six follow the light and dark themes without a second set of
values. Colour is mixed down to 9–13% for the washes, so it tints rather than
shouts. The active row picks up the same hue in its index, icon, focus ring and
a short left gradient, which is what ties the list to the panel.

Rows are tabbable and `focus` drives the panel exactly as `mouseenter` does; the
panel is `aria-live="polite"`. The entrance animation is disabled under
`prefers-reduced-motion`.

Once the columns stack under 940px the card goes — the rows keep their own
one-line descriptions, so nothing essential lives only in the card.

The two columns are **staggered, not balanced**. The pitch sits high — just
under the nav — and the demo drops about 170px down the page, so the headline
has finished before the demo's top edge begins. Read as a diagonal: text high
and left, product low and right.

The pitch runs on a 44ch measure so the headline sets in two long lines rather
than stacking into a narrow column — it should read horizontally, across the
top. `text-wrap` is `pretty`, not `balance`: evening the lines up is what made
it stack into three short ones. The demo is also pulled back across where the
seam would be, so it starts where the text ends and takes the air on the right,
putting its centre roughly 115px right of the page's rather than parked in the
middle of its own column.

Above it is a row that **reads as a sign-in form and is the front of one**: an
email field and a button. Submitting carries the address into the real panel —
a dialog that owns Google, validation and the privacy note. Keeping those out
of the page is what stops the fold turning back into a second section.

A three-state theme control sits in the **top-right corner of the page** —
light, dark, or match the device. It is a child of the page rather than the
nav, because the nav lives inside the left pane and its right edge is the
pane's, not the viewport's.
It writes the same `theme` setting the app uses and calls the same
`applyTheme()` in `js/views/settings.js`, so there is one place that touches the
document and the choice made on the landing page survives signing in. "Match
device" removes the attribute entirely rather than resolving it, which is what
lets the existing `prefers-color-scheme` listener keep working.

**Go to dashboard** opens the real app without an account:
`index.html?preview=1`. Same seeded data as the demo, on the same throwaway
`miko-demo` database, but `store.setReadOnly(true)` makes every mutation throw.

That guarantee is enforced at the write path, not by hiding buttons — every
mutation in the app already funnels through `assertCan()`, so one check there
covers tasks, projects, labels, comments, bulk edits and anything added later.
A refused write is caught globally and surfaces as *"Preview only — sign in to
keep your work"* with a Sign in action, rather than an error. A standing bar at
the foot of the screen says the same thing.

Preferences are the one exception, deliberately: `setSetting` still applies in
memory so the theme and density controls work, but skips the write. Blocking
them would make the appearance panel look broken; persisting them would make
"nothing is saved" untrue.

Once signed in the app mounts in place with no reload; signing out returns the
same way. The session lives in IndexedDB, so returning visitors go straight to
their tasks.

The page carries about 50 words of copy on purpose — the demo is the argument,
not the prose.

One variable, `--lp-pull`, sets how far the demo reaches back across where the
seam would be, and the pitch's measure is derived from it (`min(44ch, 100% -
var(--lp-pull))`). Neither can be tuned into the other: the text always stops a
column-padding short of wherever the demo starts, at every width.

Under 940px the columns stack — pitch, sign-in row, demo — still with no rule
between them.

### The demo

**The demo is the application itself.** The landing page embeds `index.html?demo=1`
in an iframe and drives it through its own controls — the same buttons a visitor
would click. Nothing about it is a drawing of the product: if a view breaks, the
landing page shows it broken.

`?demo=1` changes three things, and nothing else:

| | |
|---|---|
| `js/core/db.js` | `DB_NAME` becomes `miko-demo`. Same schema, same migrations, separate database — the demo can never read or write real tasks. |
| `js/main.js` | Skips the sign-in gate, the splash hold, durable-storage, onboarding and the service worker. There is no one to sign in as and nothing to install. `?preview=1` shares all of this and adds the read-only gate. |
| `js/core/store.js` | `seedDemoContent()` writes a dozen realistic tasks across the two starter projects — through `createTask()`, so the demo exercises the same validation, audit and indexing the real app does. It runs once; a demo database that already has tasks is left alone. |

**It leads with three lines.** The frame is blank for a second or two while the
app boots inside it, so that gap carries them:

> A task manager that files itself. · Boards, calendar, insights,
> automations. · Works offline, start to finish.

One line per card, no heading and no paragraph, at `clamp(24px, 7cqw, 58px)`.
Each has its own entrance and its own wash so they read as beats rather than a
slideshow of the same card: the first rises out of a blur over an accent
gradient, the second closes in from wide letter-spacing over a cool one, the
third is wiped on left-to-right over a green one. All of it is confined to the
demo frame — the page around it does not change. The sizing uses `cqw` against
the stage, which is a size container; a percentage would have resolved against
the parent font size instead.

**A drawn pointer does the clicking.** It travels to a control, presses it, and
the app responds — so the demo reads as someone using the product rather than
views changing by themselves. The iframe sits at the stage origin and is scaled
from its top-left, so a point inside it maps to stage coordinates by a single
multiply.

The tour: Today, the same tasks as a board, a theme switch, the calendar,
Upcoming, a switch back, Insights, and ⌘K with a search typed into it. Every
step clicks a real control or sets a real route — the theme steps genuinely walk
into Settings → Appearance and press the buttons there. A step that cannot find
its control polls briefly, then gives up quietly: a missing control should cost
one step, not the loop.

**It opens in your theme, and shows the other one.** The landing page passes its
own theme down on the iframe URL, so the demo applies it before first paint
rather than flashing whatever the last tour left behind, and a `MutationObserver`
keeps it in step if you change the page theme mid-visit. The two theme steps are
*relative*, not fixed: switch to the other mode, spend a few views there, then
come back to yours. A dark-mode visitor sees dark → light → dark; a light-mode
visitor sees the mirror. Captions and icons resolve at step time to match.

At 1440 the frame is 844×475. It lays the app out at **920px** and scales the whole iframe to fit, so
the app renders its desktop layout whatever size the frame is. Below a 560px
frame it lays out at **430px** instead and the app shows its real mobile
layout — there is no scale that keeps a desktop layout readable in a phone-width
frame, and shrinking one to five-pixel text is worse than showing the mobile UI
that actually exists.

It is inert: `pointer-events: none` and `aria-hidden`, so it is a moving
screenshot rather than something to fight with on the way to the sign-in button.
It pauses when scrolled out of view or when the tab is in the background.

**Fallbacks, in order.** If `assets/demo.mp4` exists it plays that. Otherwise
the live app. If the iframe fails to produce a built shell within 8 seconds —
storage blocked, private browsing, a boot error — it falls back to a scripted
recreation of the interface, which is still in `js/ui/landing.js` for exactly
that reason. A dead frame on the landing page is the one outcome worth
engineering against.

### What sign-in is, and is not

Sign-in **names your work** — your name, email and avatar on tasks, comments
and the activity feed instead of a generic "You". It also gives the app a front
door rather than dropping people into an empty list.

It is **not a security boundary**, and the UI says so rather than implying
otherwise. MIKŌ has no server, so nothing can verify an identity or withhold
data from whoever is using the browser: tasks live in IndexedDB on the device
and are reachable from devtools regardless of who signed in.

| Method | Status |
|---|---|
| **Google** | The real Google Identity Services flow. Returns a genuinely signed ID token. We decode it for name, email and avatar — we do not verify the signature, because that is a server's job. |
| **Email** | Not verified. Sending a magic link needs a mail server. It records who is using the app on this device. |

Because email sign-in is instant and works offline, requiring sign-in can never
lock you out of data already on your device.

**To enable Google sign-in**, create an OAuth 2.0 Web client ID in
[Google Cloud → Credentials](https://console.cloud.google.com/apis/credentials),
add your origin (e.g. `http://localhost:8899`) under *Authorised JavaScript
origins*, and paste the client ID into **Settings → Account**. Without one, the
Google button is shown disabled with the reason, and email sign-in still works.

`js/core/auth.js` exposes `verify()` as the single seam where a backend check
goes. Implement it server-side and nothing else in the app changes.

## Mobile

The dashboard is usable on a phone, not just technically reachable:

- **Horizontal strips** — the view toolbar and the settings sections are wider
  than a phone and were already scrolling, but silently: the last control sat
  half-cut with nothing to say it could move. They now snap, and a mask fades
  the trailing edge so there is visibly more.
- **The board** pages properly — columns take 84vw with scroll snapping, so the
  next one peeks instead of being sliced.
- **Touch targets** — every control in the content area is at least 40px tall.
  The completion checkbox keeps its 16px ring and grows its hit area with a
  pseudo-element instead, so the design does not change to suit the thumb.

Verified across nine routes at 375px: no horizontal page scroll, no container
clipped without an affordance, no control under 36px.

## Branding

The wordmark is set in **Locanita** (`assets/fonts/Locanita.ttf`), exposed to
CSS as the `Miko Display` family. It appears in exactly two places — the splash on open,
and the sidebar header — so the rest of the interface stays in Inter and the
display face keeps its impact.

**The `Ō` is drawn, not typed.** Locanita has 120 glyphs and does not include
`Ō` (nor does the Transformers face — 250 glyphs, also missing it). Writing
`MIKŌ` in either font silently drops the last letter into a fallback typeface
mid-word, which is why the old wordmark looked slightly off. Both the splash
and the sidebar render `MIK` plus an `O` with the macron drawn as a CSS
pseudo-element, so the whole wordmark stays in one face and the bar picks up
the accent colour.

**The splash writes the wordmark rather than fading it in.** A nib travels left
to right, the letters appear in its wake via an animated `clip-path`, and the
nib then lifts and settles as the macron over the Ō. Since that bar was always
ours to draw, the splash shows it being drawn. The landing nav logo carries the
same gesture on a long idle loop — the action is squeezed into the first eighth
of a nine-second cycle, so it flourishes every few seconds without needing a
hover. All of it is off under `prefers-reduced-motion`.

> ⚠️ **Licence.** `assets/fonts/Locanita-LICENCE.txt` states Locanita is
> *"free for PERSONAL USE
> only"* and that commercial use requires a licence from Creative Fabrica. The
> Transformers face is a film-branded fan font with its own restrictions. If
> MIKŌ goes public or commercial, either buy the Locanita licence or swap the
> display face — it is one `@font-face` in `css/tokens.css` and nothing else
> changes.

## Sidebar

It previously showed sixteen destinations at once, collapsed to unlabelled
icons by default. Now:

- It opens **labelled** by default; icon-only is a deliberate choice, not the
  starting state.
- **Templates, Automations, Trash and Settings** moved into the account menu at
  the foot of the rail. They are visited rarely and were competing with the
  daily views.
- **Projects** and **Workspace** collapse, and remember it per person.

Eleven items visible instead of sixteen, and foldable from there.

## Notes

- The service worker caches aggressively. While developing, bump `VERSION` in
  `sw.js`, or unregister it in DevTools → Application → Service Workers.
- Attachments are capped at 8 MB each because they are stored on-device.
- Everything is in your browser. Clearing site data deletes it. Settings →
  Data & privacy has one-click export and a full backup.
