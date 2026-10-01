# Task Manager: Execution Checklist

A phased plan to build a scalable task manager web application that goes beyond what the market offers. Work top to bottom. Each phase should be shippable on its own.

---

## Phase 0: Foundations (do first, hard to retrofit)

- [ ] `workspace_id` on every table, indexed
- [ ] Roles and permissions (owner, admin, editor, viewer), enforced server-side (Supabase RLS or API middleware)
- [ ] `version` column on tasks for optimistic concurrency
- [ ] Soft deletes (`deleted_at`) on all user-facing tables
- [ ] All timestamps in UTC, plus the user's timezone stored on their profile
- [ ] `task_events` audit table (who, what, when, before/after payload)
- [ ] Migrations in version control; separate dev, staging, and prod environments
- [ ] CI pipeline: lint, type-check, tests, migration check on every PR
- [ ] Error tracking, structured logging, and uptime monitoring

## Phase 1: Core product (parity with the market)

- [ ] Tasks with title, description (rich text), status, priority, due date, assignee
- [ ] Subtasks and parent/child hierarchy
- [ ] Projects, labels/tags, and checklists
- [ ] Dependencies ("blocked by") with a check that prevents cycles
- [ ] Views: Today, Upcoming, List, Kanban, Calendar
- [ ] Filters, sorting, and saved views
- [ ] Full-text search (Postgres `tsvector` to start)
- [ ] Cursor-based pagination and virtualized lists
- [ ] Undo/redo and trash with restore
- [ ] Bulk actions (multi-select, move, complete, reassign)
- [ ] Import/export (CSV, JSON)
- [ ] Accessibility: keyboard navigation, screen reader labels, contrast, focus states

## Phase 2: Reliability and scale

- [ ] Background job queue (BullMQ or pg-boss) for reminders, emails, exports
- [ ] Recurring tasks via an RRULE string, generating the next instance on completion
- [ ] Reminders across push, email, and in-app, with snooze
- [ ] Redis for caching, rate limiting, and pub/sub
- [ ] Stateless API so multiple instances can run behind a load balancer
- [ ] Indexes on `workspace_id`, `project_id`, `assignee_id`, `status`, `due_at`; review slow queries
- [ ] Rate limiting and input validation on every endpoint
- [ ] Load test before launch (k6 or Artillery) against a target such as 1,000 concurrent users
- [ ] Backups with a tested restore
- [ ] Feature flags and staged rollouts

## Phase 3: Collaboration

- [ ] Comments, @mentions, and file attachments
- [ ] Activity feed (from `task_events`)
- [ ] Realtime updates, subscribed only to the project the user has open
- [ ] Presence indicators (who is viewing or editing)
- [ ] Conflict handling: field-level merge, with a clear UI when a conflict occurs
- [ ] Notification preferences per user and per project
- [ ] Workspace invites, guest access, and team management

## Phase 4: Offline-first and PWA

- [ ] Installable PWA with a service worker
- [ ] Local store (IndexedDB) as the primary read source
- [ ] Outbox queue for changes made offline, replayed on reconnect
- [ ] Sync status indicator ("Saved", "Syncing", "Offline")
- [ ] Deterministic conflict resolution when the same task is edited offline on two devices
- [ ] Web push notifications

## Phase 5: Differentiators (where you go above the market)

Pick two or three and do them very well rather than doing all of them.

- [ ] **Natural-language quick add:** "Call supplier tomorrow 3pm #work !high" parses into a full task
- [ ] **AI assistance:** break a goal into subtasks, summarize a project, suggest priorities, draft a daily plan
- [ ] **Keyboard-first design and a command palette** (Cmd/Ctrl+K) for everything
- [ ] **Smart scheduling:** suggest when to do a task based on due dates, estimates, and calendar gaps
- [ ] **Time tracking and estimates** with actual-versus-estimated reports
- [ ] **Two-way calendar sync** (Google Calendar, Outlook)
- [ ] **Automation rules:** "When status becomes Done, notify X and create a follow-up task"
- [ ] **Templates** for projects and recurring workflows
- [ ] **Workload view** showing who is overloaded
- [ ] **Focus mode and daily review** to fight overload
- [ ] **Low-bandwidth performance:** fast on slow mobile networks, small bundle size, optimistic UI
- [ ] **Local payment and locale support** if your market needs it (for example M-Pesa, local currency, multiple languages)

## Phase 6: Platform and growth

- [ ] Public REST API with API keys and docs
- [ ] Webhooks
- [ ] Integrations (Slack, email-to-task, GitHub, Zapier/Make)
- [ ] Analytics dashboards (completion rates, cycle time, overdue trends)
- [ ] Billing and plans, if monetizing
- [ ] Audit log export, SSO, and 2FA for team customers
- [ ] Onboarding flow, empty states, and in-app help
- [ ] Data retention and privacy controls (export my data, delete my account)

---

## Reference: minimal core schema

```sql
workspaces(id, name)
members(workspace_id, user_id, role)
projects(id, workspace_id, name)
tasks(id, workspace_id, project_id, parent_id, title, description,
      status, priority, due_at, recurrence_rule, assignee_id,
      version, created_at, updated_at, deleted_at)
task_events(id, task_id, actor_id, type, payload, created_at)
```

## Reference: target architecture

```
Client (Vue/React PWA)
  └─ local cache + offline queue
        │
   API layer (Node/Express or Supabase edge functions)
        │
   ┌────┴─────────────┬──────────────┐
 Postgres          Redis          Job queue
 (source of truth) (cache, rate   (reminders, emails,
                    limits, pub/sub) recurring tasks, exports)
        │
 Realtime (websockets / Supabase Realtime)
```

## Reference: scale triggers

| Signal | Action |
|---|---|
| Slow queries | Add indexes, then rewrite the query |
| Read load rising | Cache, then add read replicas |
| `task_events` huge | Partition by month, archive old rows |
| One module is the bottleneck | Split out only that module as its own service |
| Background jobs backing up | Add workers, separate queues by priority |

## Definition of done (apply to every feature)

1. Permissions enforced server-side
2. Works offline or degrades gracefully
3. Has an audit event
4. Indexed and paginated
5. Tested and monitored
