-- MIKŌ · Supabase schema
--
-- Run this once in the Supabase dashboard → SQL Editor.
--
-- Two things make this work:
--   1. Every table carries `workspace_id`, and every policy checks membership
--      of that workspace. That is the whole access model — there is no
--      "owner" column to forget to check.
--   2. Row Level Security is enabled on every table. Without it the anon key
--      would read the entire database, because that key is public by design.
--      The policies below are the only thing standing between a visitor and
--      everyone's tasks, so do not disable RLS "just to test".
--
-- Ids are text, not uuid: the app generates them offline (`tsk_…`, `prj_…`)
-- before a server has ever seen the row, and has to be able to.

-- ---------------------------------------------------------------- workspaces
create table if not exists public.workspaces (
  id          text primary key,
  name        text not null,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  version     integer not null default 1
);

-- Membership is what every other policy is written against.
create table if not exists public.members (
  id            text primary key,
  workspace_id  text not null references public.workspaces (id) on delete cascade,
  user_id       uuid not null references auth.users (id) on delete cascade,
  role          text not null default 'owner',
  created_at    timestamptz not null default now(),
  unique (workspace_id, user_id)
);

-- Is the caller in this workspace? Used by every policy below.
-- SECURITY DEFINER so the function can read `members` without recursing into
-- the policy that is currently being evaluated.
create or replace function public.is_member(ws text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.members m
    where m.workspace_id = ws and m.user_id = auth.uid()
  );
$$;

-- ------------------------------------------------------------- data tables
create table if not exists public.projects (
  id            text primary key,
  workspace_id  text not null references public.workspaces (id) on delete cascade,
  name          text not null,
  color         text,
  description   text,
  archived      integer default 0,
  position      integer default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  version       integer not null default 1
);

create table if not exists public.labels (
  id            text primary key,
  workspace_id  text not null references public.workspaces (id) on delete cascade,
  name          text not null,
  color         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  version       integer not null default 1
);

-- `jsonb` for the list-shaped columns so the client can keep its own shapes
-- (labels, blockers, checklists) without a migration every time one changes.
create table if not exists public.tasks (
  id             text primary key,
  workspace_id   text not null references public.workspaces (id) on delete cascade,
  title          text not null,
  description    text,
  status         text not null default 'todo',
  priority       text not null default 'none',
  project_id     text,
  parent_id      text,
  due_at         timestamptz,
  start_at       timestamptz,
  completed_at   timestamptz,
  estimate_min   integer,
  actual_min     integer,
  recurrence     text,
  labels         jsonb default '[]'::jsonb,
  blockers       jsonb default '[]'::jsonb,
  checklist      jsonb default '[]'::jsonb,
  assignee_id    text,
  position       double precision default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  version        integer not null default 1
);

create index if not exists tasks_workspace_updated
  on public.tasks (workspace_id, updated_at);

create table if not exists public.comments (
  id            text primary key,
  workspace_id  text not null references public.workspaces (id) on delete cascade,
  task_id       text not null,
  author_id     text,
  body          text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  version       integer not null default 1
);

create table if not exists public.attachments (
  id            text primary key,
  workspace_id  text not null references public.workspaces (id) on delete cascade,
  task_id       text not null,
  name          text not null,
  type          text,
  size          bigint,
  uploaded_by   text,
  -- Where the bytes live in the `attachments` bucket. The row never holds the
  -- file itself: Postgres is the wrong place for an 8 MB blob.
  storage_path  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  version       integer not null default 1
);

create index if not exists attachments_workspace_updated
  on public.attachments (workspace_id, updated_at);

create table if not exists public.saved_views (
  id            text primary key,
  workspace_id  text not null references public.workspaces (id) on delete cascade,
  name          text not null,
  query         jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  version       integer not null default 1
);

create table if not exists public.templates (
  id            text primary key,
  workspace_id  text not null references public.workspaces (id) on delete cascade,
  name          text not null,
  payload       jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  version       integer not null default 1
);

create table if not exists public.automations (
  id            text primary key,
  workspace_id  text not null references public.workspaces (id) on delete cascade,
  name          text,
  enabled       integer default 1,
  trigger       jsonb,
  conditions    jsonb,
  actions       jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  version       integer not null default 1
);

-- -------------------------------------------------------- row level security
alter table public.workspaces  enable row level security;
alter table public.members     enable row level security;
alter table public.projects    enable row level security;
alter table public.labels      enable row level security;
alter table public.tasks       enable row level security;
alter table public.comments    enable row level security;
alter table public.attachments enable row level security;
alter table public.saved_views enable row level security;
alter table public.templates   enable row level security;
alter table public.automations enable row level security;

-- A workspace is visible to its members, and creatable by the person who will
-- own it. The insert check uses owner_id rather than is_member(), because at
-- the moment of creation there is no membership row yet.
drop policy if exists workspaces_select on public.workspaces;
create policy workspaces_select on public.workspaces
  for select using (public.is_member(id));

drop policy if exists workspaces_insert on public.workspaces;
create policy workspaces_insert on public.workspaces
  for insert with check (owner_id = auth.uid());

drop policy if exists workspaces_update on public.workspaces;
create policy workspaces_update on public.workspaces
  for update using (public.is_member(id)) with check (public.is_member(id));

-- You may read the membership of workspaces you belong to, and add yourself.
drop policy if exists members_select on public.members;
create policy members_select on public.members
  for select using (user_id = auth.uid() or public.is_member(workspace_id));

drop policy if exists members_insert on public.members;
create policy members_insert on public.members
  for insert with check (user_id = auth.uid());

-- Every data table: same rule, applied uniformly.
do $$
declare t text;
begin
  foreach t in array array[
    'projects','labels','tasks','attachments','comments','saved_views','templates','automations'
  ] loop
    execute format('drop policy if exists %1$s_rw on public.%1$s', t);
    execute format($p$
      create policy %1$s_rw on public.%1$s
        for all
        using (public.is_member(workspace_id))
        with check (public.is_member(workspace_id))
    $p$, t);
  end loop;
end $$;

-- ------------------------------------------------------------------ storage
-- Attachment bytes live in a private bucket. Objects are named
-- `{workspace_id}/{attachment_id}`, so the first path segment is what the
-- policies read to decide membership — the layout is load-bearing, not
-- cosmetic. Keep the bucket private: a public bucket would serve every file
-- to anyone holding the URL, regardless of the table policies above.
insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do nothing;

drop policy if exists attachments_read on storage.objects;
create policy attachments_read on storage.objects
  for select using (
    bucket_id = 'attachments'
    and public.is_member((storage.foldername(name))[1])
  );

drop policy if exists attachments_write on storage.objects;
create policy attachments_write on storage.objects
  for insert with check (
    bucket_id = 'attachments'
    and public.is_member((storage.foldername(name))[1])
  );

drop policy if exists attachments_update on storage.objects;
create policy attachments_update on storage.objects
  for update using (
    bucket_id = 'attachments'
    and public.is_member((storage.foldername(name))[1])
  );

drop policy if exists attachments_delete on storage.objects;
create policy attachments_delete on storage.objects
  for delete using (
    bucket_id = 'attachments'
    and public.is_member((storage.foldername(name))[1])
  );

-- ------------------------------------------------------------------- notes
-- The client sends `updated_at` itself and pulls with `updated_at >= cursor`,
-- so do NOT add a trigger that rewrites `updated_at` on write. Doing so would
-- stamp server time over client time and make a row either re-sync forever or
-- be skipped, depending on clock skew.
