-- Allow authenticated merchant members to populate and refresh the reporting cache.
-- The sync route still cannot write to PayPal; these policies only cover Supabase rows.

create policy "Members can write PayPal balances"
  on paypal_balances for insert to authenticated
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_balances.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can refresh PayPal balances"
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

create policy "Members can write PayPal transactions"
  on paypal_transactions for insert to authenticated
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_transactions.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can refresh PayPal transactions"
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

create policy "Members can write PayPal invoices"
  on paypal_invoices for insert to authenticated
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_invoices.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can refresh PayPal invoices"
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

create policy "Members can write PayPal disputes"
  on paypal_disputes for insert to authenticated
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_disputes.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can refresh PayPal disputes"
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

create policy "Members can write PayPal orders"
  on paypal_orders for insert to authenticated
  with check (exists (
    select 1 from merchant_members
    where merchant_members.merchant_id = paypal_orders.merchant_id
      and merchant_members.user_id = auth.uid()
  ));

create policy "Members can refresh PayPal orders"
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
