-- Read-only PayPal reporting cache. Webhooks and reconciliation can update
-- these rows later; the dashboard never writes to PayPal from these tables.

create table paypal_balances (
  merchant_id uuid not null references merchants(id) on delete cascade,
  currency text not null,
  available numeric(20, 2) not null,
  withheld numeric(20, 2) not null,
  synced_at timestamptz not null default now(),
  primary key (merchant_id, currency)
);

create table paypal_transactions (
  merchant_id uuid not null references merchants(id) on delete cascade,
  paypal_id text not null,
  order_id text,
  occurred_at timestamptz,
  type_code text not null,
  type_label text not null,
  status_code text not null,
  status_label text not null,
  subject text,
  amount numeric(20, 2),
  currency text,
  fee numeric(20, 2),
  net numeric(20, 2),
  synced_at timestamptz not null default now(),
  primary key (merchant_id, paypal_id)
);

create table paypal_invoices (
  merchant_id uuid not null references merchants(id) on delete cascade,
  paypal_id text not null,
  invoice_number text,
  status_code text not null,
  status_label text not null,
  issued_at date,
  due_at date,
  recipient text,
  amount numeric(20, 2),
  due_amount numeric(20, 2),
  currency text,
  synced_at timestamptz not null default now(),
  primary key (merchant_id, paypal_id)
);

create table paypal_disputes (
  merchant_id uuid not null references merchants(id) on delete cascade,
  paypal_id text not null,
  status_code text not null,
  status_label text not null,
  reason_code text not null,
  reason_label text not null,
  created_at timestamptz,
  updated_at timestamptz,
  response_due_at timestamptz,
  amount numeric(20, 2),
  currency text,
  transaction_id text,
  synced_at timestamptz not null default now(),
  primary key (merchant_id, paypal_id)
);

create table paypal_orders (
  merchant_id uuid not null references merchants(id) on delete cascade,
  paypal_id text not null,
  status text not null,
  intent text,
  created_at timestamptz,
  updated_at timestamptz,
  amount numeric(20, 2),
  currency text,
  payer_email text,
  synced_at timestamptz not null default now(),
  primary key (merchant_id, paypal_id)
);

create index paypal_transactions_merchant_date_idx
  on paypal_transactions (merchant_id, occurred_at desc);
create index paypal_invoices_merchant_due_idx
  on paypal_invoices (merchant_id, due_at desc);
create index paypal_disputes_merchant_created_idx
  on paypal_disputes (merchant_id, created_at desc);

alter table paypal_balances enable row level security;
alter table paypal_transactions enable row level security;
alter table paypal_invoices enable row level security;
alter table paypal_disputes enable row level security;
alter table paypal_orders enable row level security;

create policy "Members can view PayPal balances"
  on paypal_balances for select to authenticated
  using (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_balances.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can view PayPal transactions"
  on paypal_transactions for select to authenticated
  using (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_transactions.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can view PayPal invoices"
  on paypal_invoices for select to authenticated
  using (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_invoices.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can view PayPal disputes"
  on paypal_disputes for select to authenticated
  using (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_disputes.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can view PayPal orders"
  on paypal_orders for select to authenticated
  using (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_orders.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can sync PayPal balances"
  on paypal_balances for insert to authenticated
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_balances.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can update PayPal balances"
  on paypal_balances for update to authenticated
  using (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_balances.merchant_id
      and merchant_members.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_balances.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can sync PayPal transactions"
  on paypal_transactions for insert to authenticated
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_transactions.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can update PayPal transactions"
  on paypal_transactions for update to authenticated
  using (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_transactions.merchant_id
      and merchant_members.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_transactions.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can sync PayPal invoices"
  on paypal_invoices for insert to authenticated
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_invoices.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can update PayPal invoices"
  on paypal_invoices for update to authenticated
  using (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_invoices.merchant_id
      and merchant_members.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_invoices.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can sync PayPal disputes"
  on paypal_disputes for insert to authenticated
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_disputes.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can update PayPal disputes"
  on paypal_disputes for update to authenticated
  using (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_disputes.merchant_id
      and merchant_members.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_disputes.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can sync PayPal orders"
  on paypal_orders for insert to authenticated
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_orders.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can update PayPal orders"
  on paypal_orders for update to authenticated
  using (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_orders.merchant_id
      and merchant_members.user_id = auth.uid()
  ))
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_orders.merchant_id
      and merchant_members.user_id = auth.uid()
  ));
