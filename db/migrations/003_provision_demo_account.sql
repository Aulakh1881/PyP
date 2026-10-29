-- Provision a signed-in Supabase user for the prototype demo merchant.

create or replace function public.provision_demo_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
begin
  if current_user_id is null then
    raise exception 'Authentication is required';
  end if;

  if not exists (
    select 1
    from public.merchants
    where id = '00000000-0000-0000-0000-000000000001'
  ) then
    raise exception 'Demo merchant has not been seeded';
  end if;

  insert into public.profiles (user_id)
  values (current_user_id)
  on conflict (user_id) do nothing;

  insert into public.merchant_members (merchant_id, user_id, role)
  values (
    '00000000-0000-0000-0000-000000000001',
    current_user_id,
    'owner'
  )
  on conflict (merchant_id, user_id) do nothing;
end;
$$;

revoke all on function public.provision_demo_account() from public;
grant execute on function public.provision_demo_account() to authenticated;
