-- line名片王 — Supabase 資料表與權限設定
-- 在 Supabase SQL Editor 貼上執行即可完成建表

create table if not exists public.card_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  slug text unique not null,
  email text not null,
  status text not null default 'active' check (status in ('active', 'suspended')),
  is_admin boolean not null default false,

  -- 影片額度控管（預設每人 1 支，上限 10MB）
  video_quota int not null default 1,
  video_key text not null default '',
  video_size_bytes bigint not null default 0,
  logo_key text not null default '',
  photo_key text not null default '',

  -- 名片完整設定 JSON（版型、莫蘭迪主色、Logo/影片/照片網址、聯絡資訊、社群膠囊開關）
  config jsonb not null default '{
    "style": "dark",
    "color": "#C5AE6E",
    "logoMono": true,
    "showPhoto": false,
    "logoUrl": "",
    "videoUrl": "",
    "photoUrl": "",
    "company": "",
    "name": "",
    "enName": "",
    "mobile": "",
    "email": "",
    "tel": "",
    "address": "",
    "website": "",
    "oaOn": false,
    "oaId": "",
    "mailBtnOn": false,
    "igOn": false,
    "igId": "",
    "fbOn": false,
    "fbId": "",
    "thOn": false,
    "thId": ""
  }'::jsonb,

  send_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_card_profiles_slug on public.card_profiles (slug);

-- 自動更新 updated_at
create or replace function public.touch_card_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_card_profiles_updated on public.card_profiles;
create trigger trg_card_profiles_updated
  before update on public.card_profiles
  for each row execute function public.touch_card_updated_at();

-- 啟用 RLS（Row Level Security）
alter table public.card_profiles enable row level security;

-- 自己可讀取、建立、更新自己的名片（但不能自改 is_admin / status / video_quota）
create policy "user_read_own" on public.card_profiles
  for select using (auth.uid() = id);

create policy "user_insert_own" on public.card_profiles
  for insert with check (auth.uid() = id and is_admin = false and status = 'active');

create policy "user_update_own" on public.card_profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

-- 公開透過 slug 讀取單張啟用中名片（供 LINE LIFF 轉傳頁使用，不暴露隱私欄位）
create or replace function public.get_public_card(p_slug text)
returns jsonb
language plpgsql
security definer
as $$
declare
  rec record;
begin
  select slug, status, config into rec
  from public.card_profiles
  where slug = lower(trim(p_slug))
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'reason', '找不到名片');
  end if;
  if rec.status <> 'active' then
    return jsonb_build_object('ok', false, 'reason', '名片已停用');
  end if;
  return jsonb_build_object('ok', true, 'slug', rec.slug, 'config', rec.config);
end;
$$;

-- 累計名片發送次數（公開可呼叫，僅 +1）
create or replace function public.ping_card_send(p_slug text)
returns void
language plpgsql
security definer
as $$
begin
  update public.card_profiles
  set send_count = send_count + 1
  where slug = lower(trim(p_slug)) and status = 'active';
end;
$$;
