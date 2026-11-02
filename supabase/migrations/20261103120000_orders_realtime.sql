-- Live /orders board (ADR-010): open boards hear about changes and refetch.
-- Realtime checks each subscriber's RLS before sending an event, so these
-- stay isolated by tenant and revoked sessions (ADR-009) stop receiving.
alter publication supabase_realtime add table public.orders, public.order_items;
