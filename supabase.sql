-- Lot: Feature 1 schema. Paste this whole file into the Supabase SQL editor
-- (Project -> SQL Editor -> New query) and run it once. Safe to re-run.

-- ---------------------------------------------------------------------------
-- Table: items
-- ---------------------------------------------------------------------------
create table if not exists items (
    id                 text primary key,             -- e.g. "LOT-001"
    captured_at        timestamptz not null,
    image_path         text not null,                 -- storage path within item-images
    image_url          text not null,                 -- public URL
    category           text,
    identified_as      text,
    condition          jsonb,
    grader_confidence  real,
    created_at         timestamptz not null default now()
);

alter table items enable row level security;

-- The Jetson writes with the service_role key, which bypasses RLS entirely,
-- so no INSERT/UPDATE policy is defined here. The website reads with the
-- anon/public key, so it needs an explicit SELECT policy:
drop policy if exists "Public read access" on items;
create policy "Public read access"
    on items for select
    using (true);

-- ---------------------------------------------------------------------------
-- Storage bucket: item-images (public read)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('item-images', 'item-images', true)
on conflict (id) do update set public = true;

-- Public read of objects in this bucket only:
drop policy if exists "Public read for item-images" on storage.objects;
create policy "Public read for item-images"
    on storage.objects for select
    using (bucket_id = 'item-images');

-- No INSERT/UPDATE storage policy is needed here either -- the Jetson uploads
-- with the service_role key, which bypasses storage RLS the same way.
