-- The single demo merchant used while PayPal credentials remain in the
-- application environment rather than in the database.

insert into merchants (id, name, timezone, currency)
values (
  '00000000-0000-0000-0000-000000000001',
  'Pyp Demo Business',
  'America/Los_Angeles',
  'USD'
)
on conflict (id) do nothing;
