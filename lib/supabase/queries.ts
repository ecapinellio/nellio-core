import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json, Tables } from "@/lib/supabase/database.types";

export type Customer = Tables<"customers">;
export type Product = Tables<"products">;
export type Order = Tables<"orders">;
export type OrderItem = Tables<"order_items">;

type Client = SupabaseClient<Database>;

export interface QueryResult<T>
{
	data: T | null;
	error: PostgrestError | null;
}

// Every helper below takes the Supabase client as its first argument instead
// of constructing one internally, so the same function works from a Client
// Component (browser client) or a Server Component/Action (server client) —
// per the eng-review plan's "shared query helpers" resolution.

/**
 * Accent-insensitive fuzzy search over the caller's own tenant (RLS-scoped
 * inside search_customers()). Empty/blank query returns a browse list
 * instead of no results, so the UI has something to show on focus before
 * the operator types anything.
 */
export async function searchCustomers(supabase: Client, query: string, limit = 10): Promise<QueryResult<Customer[]>>
{
	const { data, error } = await supabase.rpc("search_customers", { p_query: query, p_limit: limit });
	return { data, error };
}

export async function searchProducts(supabase: Client, query: string, limit = 10): Promise<QueryResult<Product[]>>
{
	const { data, error } = await supabase.rpc("search_products", { p_query: query, p_limit: limit });
	return { data, error };
}

/** Inline quick-add when search finds no match. tenant_id is always derived server-side. */
export async function quickAddCustomer(supabase: Client, name: string): Promise<QueryResult<Customer>>
{
	const { data, error } = await supabase.rpc("quick_add_customer", { p_name: name });
	return { data, error };
}

export async function quickAddProduct(supabase: Client, name: string): Promise<QueryResult<Product>>
{
	const { data, error } = await supabase.rpc("quick_add_product", { p_name: name });
	return { data, error };
}

export type DuplicateCheckResult =
	| { status: "ok"; duplicate: Order | null }
	| { status: "check_failed"; error: PostgrestError };

/**
 * Status-aware same-day duplicate check (eng-review decision 5): only a
 * still-`pending` order for the same customer counts as a duplicate: once
 * an order moves to confirmed/dispatched/delivered it's just history.
 *
 * Decision 6: on a DB/network error this must fail OPEN — callers get
 * `status: "check_failed"` explicitly rather than a silent `duplicate: null`,
 * so the UI can show the "couldn't check, verify manually" banner instead of
 * mistaking a broken check for "no duplicate found".
 *
 * `now` defaults to the caller's local clock. This is intentionally the
 * *operator's* local day, not the server's — Alejandra decides what "today"
 * means when she's the one capturing the order. Accepting it as a param
 * also makes the day boundary deterministic for the T7 Vitest suite.
 */
export async function checkPendingDuplicateOrder(supabase: Client, customerId: string, now: Date = new Date()): Promise<DuplicateCheckResult>
{
	const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	const startOfNextDay = new Date(startOfDay);
	startOfNextDay.setDate(startOfNextDay.getDate() + 1);

	const { data, error } = await supabase
		.from("orders")
		.select("*")
		.eq("customer_id", customerId)
		.eq("status", "pending")
		.gte("created_at", startOfDay.toISOString())
		.lt("created_at", startOfNextDay.toISOString())
		.order("created_at", { ascending: false })
		.limit(1)
		.maybeSingle();

	if (error)
	{
		return { status: "check_failed", error };
	}

	return { status: "ok", duplicate: data };
}

export interface CreateOrderItemInput
{
	product_id: string;
	quantity: number;
}

export interface CreateOrderInput
{
	customer_id: string;
	notes: string;
	items: CreateOrderItemInput[];
	channel?: "whatsapp" | "portal";
}

export interface CreateOrderResult
{
	order: Order;
	items: OrderItem[];
}

/**
 * Wraps the create_order() RPC (T3): a single atomic write for the order and
 * its items, never two sequential client inserts.
 */
export async function createOrder(supabase: Client, input: CreateOrderInput): Promise<QueryResult<CreateOrderResult>>
{
	const { data, error } = await supabase.rpc("create_order", {
		p_customer_id: input.customer_id,
		p_notes: input.notes,
		p_items: input.items as unknown as Json,
		p_channel: input.channel ?? "whatsapp",
	});

	if (error)
	{
		return { data: null, error };
	}

	const result = data as unknown as CreateOrderResult;
	return { data: result, error: null };
}
