-- Smart Wardrobe cloud beta schema.
-- Run this in Supabase Dashboard > SQL Editor. It deliberately keeps device
-- credentials server-side; mobile clients must never receive service_role keys.

create extension if not exists pgcrypto;

create table if not exists app_users (
  id text primary key,
  email text not null unique,
  name text not null,
  password_hash text not null,
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

create table if not exists wardrobes (
  id text primary key,
  user_id text not null unique references app_users(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

create table if not exists gateways (
  gateway_id text primary key,
  wardrobe_id text references wardrobes(id) on delete set null,
  name text not null default '새 옷봉',
  state text,
  last_seen timestamptz,
  channel integer,
  firmware_version text,
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);
create index if not exists gateways_wardrobe_idx on gateways(wardrobe_id);

create table if not exists hangers (
  hanger_id text primary key,
  wardrobe_id text references wardrobes(id) on delete set null,
  gateway_id text references gateways(gateway_id) on delete set null,
  alias text not null default '',
  state text,
  reported_state text,
  tag_uid text,
  last_seen timestamptz,
  last_sequence bigint not null default -1,
  boot_id text,
  channel integer,
  rssi integer,
  error_flags integer,
  firmware_version text,
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);
create index if not exists hangers_wardrobe_idx on hangers(wardrobe_id);
create index if not exists hangers_gateway_idx on hangers(gateway_id);
create index if not exists hangers_tag_idx on hangers(wardrobe_id,tag_uid);

create table if not exists garments (
  id text primary key,
  wardrobe_id text not null references wardrobes(id) on delete cascade,
  created_by text references app_users(id) on delete set null,
  tag_uid text not null,
  name text not null,
  category text not null default '',
  color text not null default '',
  season text not null default '',
  brand text not null default '',
  memo text not null default '',
  image_url text not null default '',
  current_state text not null default 'OUT',
  current_hanger text,
  last_seen timestamptz,
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  unique(wardrobe_id,tag_uid)
);
create index if not exists garments_wardrobe_idx on garments(wardrobe_id);

create table if not exists device_commands (
  id text primary key,
  numeric_id bigint not null unique,
  wardrobe_id text not null references wardrobes(id) on delete cascade,
  requested_by text references app_users(id) on delete set null,
  command text not null,
  targets jsonb not null,
  duration_ms integer not null default 0,
  status text not null,
  acknowledgements jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  sent_at timestamptz,
  payload jsonb not null default '{}'::jsonb
);
create index if not exists device_commands_pending_idx on device_commands(wardrobe_id,status,expires_at);

create table if not exists wardrobe_events (
  id text primary key,
  wardrobe_id text references wardrobes(id) on delete cascade,
  type text not null,
  severity text not null default 'info',
  payload jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index if not exists wardrobe_events_recent_idx on wardrobe_events(wardrobe_id,at desc);

-- Safe when re-running this script after an earlier draft schema.
alter table app_users add column if not exists payload jsonb not null default '{}'::jsonb;
alter table wardrobes add column if not exists payload jsonb not null default '{}'::jsonb;

-- Upgrade an older beta table in place. These are additive only: no existing
-- clothes, accounts, or device records are deleted.
alter table garments add column if not exists category text not null default '';
alter table garments add column if not exists color text not null default '';
alter table garments add column if not exists season text not null default '';
alter table garments add column if not exists brand text not null default '';
alter table garments add column if not exists memo text not null default '';
alter table garments add column if not exists image_url text not null default '';
alter table garments add column if not exists current_state text not null default 'OUT';
alter table garments add column if not exists current_hanger text;
alter table garments add column if not exists last_seen timestamptz;
alter table garments add column if not exists payload jsonb not null default '{}'::jsonb;

-- The API connects with DATABASE_URL only on the server. Do not expose that
-- connection string to Flutter or the browser; app-level JWT authorization
-- remains in Node.
alter table app_users enable row level security;
alter table wardrobes enable row level security;
alter table gateways enable row level security;
alter table hangers enable row level security;
alter table garments enable row level security;
alter table device_commands enable row level security;
alter table wardrobe_events enable row level security;
