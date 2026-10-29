-- Supabase Auth account relationships.
-- auth.users is managed by Supabase; these tables hold Pyp-specific data.

create table profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table merchant_members (
  merchant_id uuid not null references merchants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'member'
    check (role in ('owner', 'admin', 'member', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (merchant_id, user_id)
);

create index merchant_members_user_idx
  on merchant_members (user_id, merchant_id);

alter table profiles enable row level security;
alter table merchant_members enable row level security;
alter table merchants enable row level security;

create policy "Users can view their profile"
  on profiles for select
  to authenticated
  using (user_id = auth.uid());

create policy "Users can create their profile"
  on profiles for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "Users can update their profile"
  on profiles for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "Users can view their memberships"
  on merchant_members for select
  to authenticated
  using (user_id = auth.uid());

create policy "Members can view their merchants"
  on merchants for select
  to authenticated
  using (
    exists (
      select 1
      from merchant_members
      where merchant_members.merchant_id = merchants.id
        and merchant_members.user_id = auth.uid()
    )
  );
