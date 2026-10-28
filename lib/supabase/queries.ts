import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json, Tables } from "@/lib/supabase/database.types";
import type { OrderStatus } from "@/lib/order-math";
import type { ProductUnit } from "@/lib/products/units";

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

export type { ProductUnit };

export interface QuickAddProductOptions
{
	pricePerUnit?: number;
	unit?: ProductUnit;
}

/**
 * pricePerUnit/unit are optional (slice 1 of the product-pricing block):
 * the capture screen still only sends a name today, and making these
 * mandatory here would break it until the UI that collects them exists.
 */
export async function quickAddProduct(
	supabase: Client,
	name: string,
	options?: QuickAddProductOptions,
): Promise<QueryResult<Product>>
{
	const { data, error } = await supabase.rpc("quick_add_product", {
		p_name: name,
		p_price_per_unit: options?.pricePerUnit,
		p_unit: options?.unit,
	});
	return { data, error };
}

/**
 * Slice 2's inline "+ precio" flow: a product quick-added without a price
 * (allowed since slice 1) gets one added after the fact, without a modal
 * blocking creation. The table-level check constraint on price_per_unit
 * (slice 1) already guards the value — this doesn't re-validate.
 */
export async function updateProductPricing(
	supabase: Client,
	productId: string,
	options: QuickAddProductOptions,
): Promise<QueryResult<Product>>
{
	const { data, error } = await supabase
		.from("products")
		.update({ price_per_unit: options.pricePerUnit, unit: options.unit })
		.eq("id", productId)
		.select()
		.single();
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
	/** Optional since slice 2 — the RPC itself now accepts null/blank. */
	notes: string | null;
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
		// The generated Args type has p_notes as a required `string` — it
		// doesn't know the RPC itself normalizes null/blank to NULL (slice 2).
		// Cast is safe: we're deliberately passing what the generated type
		// can't express, not working around real required-ness.
		p_notes: input.notes as string,
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

export interface OrderListItem
{
	id: string;
	status: string;
	channel: string;
	createdAt: string;
	customerName: string;
	itemCount: number;
}

/** Opaque keyset cursor (created_at, id) — see listOrders() for why. */
export interface OrdersCursor
{
	createdAt: string;
	id: string;
}

export interface ListOrdersResult
{
	orders: OrderListItem[];
	nextCursor: OrdersCursor | null;
}

export const ORDERS_PAGE_SIZE = 50;

interface OrderListRow
{
	id: string;
	status: string;
	channel: string;
	created_at: string;
	customers: { name: string } | null;
	order_items: { count: number }[];
}

/**
 * T6: paginated orders list (eng-review Decision 9 — ~50/page, "load more").
 *
 * Uses a (created_at, id) keyset cursor rather than offset/page-number
 * pagination: offset pagination re-shifts every row when a new order lands
 * mid-scroll (a real risk here — orders arrive continuously during the
 * workday), silently skipping or duplicating rows across "load more" calls.
 * The compound cursor (not created_at alone) is required for correctness:
 * two orders can share the same created_at down to the microsecond under
 * bursty capture, and a single-column cursor would silently drop one of
 * them. RLS (is_operator_or_admin() + tenant match) already scopes which
 * rows are visible — this only orders and slices what RLS has let through.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * cursor is client-held state fed back into a hand-built PostgREST `.or()`
 * filter string — RLS (tenant + role) is the real access boundary and
 * already bounds every row this can return, so a malformed cursor can't
 * escalate access. This validates anyway: an untrusted-shaped string here
 * would otherwise reach PostgREST as a malformed filter and surface as a
 * confusing 400, instead of a clean, caught error.
 */
function invalidCursorError(): PostgrestError
{
	return {
		name: "PostgrestError",
		message: "Invalid pagination cursor",
		details: "",
		hint: "",
		code: "22023",
	} as PostgrestError;
}

export async function listOrders(
	supabase: Client,
	{ cursor, limit = ORDERS_PAGE_SIZE }: { cursor?: OrdersCursor; limit?: number } = {},
): Promise<QueryResult<ListOrdersResult>>
{
	let query = supabase
		.from("orders")
		.select("id, status, channel, created_at, customers(name), order_items(count)")
		.order("created_at", { ascending: false })
		.order("id", { ascending: false })
		.limit(limit);

	if (cursor)
	{
		const createdAt = new Date(cursor.createdAt);
		if (Number.isNaN(createdAt.getTime()) || !UUID_RE.test(cursor.id))
		{
			return { data: null, error: invalidCursorError() };
		}

		const isoCreatedAt = createdAt.toISOString();
		query = query.or(
			`created_at.lt.${isoCreatedAt},and(created_at.eq.${isoCreatedAt},id.lt.${cursor.id})`,
		);
	}

	const { data, error } = await query;

	if (error)
	{
		return { data: null, error };
	}

	const rows = data as unknown as OrderListRow[];

	const orders: OrderListItem[] = rows.map((row) => ({
		id: row.id,
		status: row.status,
		channel: row.channel,
		createdAt: row.created_at,
		customerName: row.customers?.name ?? "—",
		itemCount: row.order_items[0]?.count ?? 0,
	}));

	// Fewer rows than requested means this was the last page — the standard
	// keyset heuristic, avoids a guaranteed-empty extra round trip.
	const last = rows.at(-1);
	const nextCursor = rows.length === limit && last
		? { createdAt: last.created_at, id: last.id }
		: null;

	return { data: { orders, nextCursor }, error: null };
}

export interface KanbanOrderItem
{
	quantity: number;
	priceAtOrder: number | null;
	productName: string;
}

export interface KanbanOrder
{
	id: string;
	status: string;
	createdAt: string;
	customerName: string;
	items: KanbanOrderItem[];
}

/** Terminal state (delivered) accumulates forever — the historial page (listOrders()) covers anything beyond this cap. */
const DELIVERED_KANBAN_LIMIT = 50;

const KANBAN_SELECT = "id, status, created_at, customers(name), order_items(quantity, price_at_order, products(name))";

interface KanbanOrderRow
{
	id: string;
	status: string;
	created_at: string;
	customers: { name: string } | null;
	order_items: { quantity: number; price_at_order: number | null; products: { name: string } | null }[];
}

/**
 * Slice 3's kanban feed — a different shape than listOrders() (embedded line
 * items + an active/delivered split, not flat itemCount + cursor pagination),
 * so this is its own query rather than a listOrders() variant.
 *
 * Eng-review Decision 6: active statuses (pending/confirmed/dispatched) are
 * fetched unbounded since they're actionable and self-limiting in practice —
 * only `delivered` (a terminal state that accumulates forever) is capped, so
 * it can't crowd out the columns a kanban exists to surface problems in.
 */
export async function listOrdersForKanban(supabase: Client): Promise<QueryResult<KanbanOrder[]>>
{
	const [activeResult, deliveredResult] = await Promise.all([
		supabase
			.from("orders")
			.select(KANBAN_SELECT)
			.in("status", ["pending", "confirmed", "dispatched"])
			.order("created_at", { ascending: false }),
		supabase
			.from("orders")
			.select(KANBAN_SELECT)
			.eq("status", "delivered")
			.order("created_at", { ascending: false })
			.limit(DELIVERED_KANBAN_LIMIT),
	]);

	if (activeResult.error)
	{
		return { data: null, error: activeResult.error };
	}
	if (deliveredResult.error)
	{
		return { data: null, error: deliveredResult.error };
	}

	const rows = [...activeResult.data, ...deliveredResult.data] as unknown as KanbanOrderRow[];

	const orders: KanbanOrder[] = rows.map((row) => ({
		id: row.id,
		status: row.status,
		createdAt: row.created_at,
		customerName: row.customers?.name ?? "—",
		items: row.order_items.map((item) => ({
			quantity: item.quantity,
			priceAtOrder: item.price_at_order,
			productName: item.products?.name ?? "—",
		})),
	}));

	return { data: orders, error: null };
}

/**
 * Drag-or-"Confirmar" status change. Direct update, not a new RPC — RLS
 * already permits admin/operator to update orders (T8's role matrix), and
 * there's no multi-table write here that would need create_order()'s
 * atomicity guarantees.
 */
export async function updateOrderStatus(supabase: Client, orderId: string, status: OrderStatus): Promise<QueryResult<Order>>
{
	const { data, error } = await supabase
		.from("orders")
		.update({ status })
		.eq("id", orderId)
		.select()
		.single();
	return { data, error };
}

export interface OrderDetailItem
{
	id: string;
	quantity: number;
	priceAtOrder: number | null;
	unitAtOrder: string | null;
	productName: string;
	/** Null means this line's price has never been edited since create_order()'s initial snapshot. */
	priceOverriddenBy: string | null;
	priceOverriddenByName: string | null;
	priceOverriddenAt: string | null;
}

export interface OrderDetail
{
	id: string;
	status: string;
	channel: string;
	notes: string | null;
	createdAt: string;
	updatedAt: string;
	customerName: string;
	customerPhone: string | null;
	items: OrderDetailItem[];
}

const ORDER_DETAIL_SELECT = "id, status, channel, notes, created_at, updated_at, " +
	"customers(name, phone), " +
	"order_items(id, quantity, price_at_order, unit_at_order, price_overridden_by, price_overridden_at, " +
	"products(name), users!order_items_price_overridden_by_fkey(name))";

interface OrderDetailRow
{
	id: string;
	status: string;
	channel: string;
	notes: string | null;
	created_at: string;
	updated_at: string;
	customers: { name: string; phone: string | null } | null;
	order_items: {
		id: string;
		quantity: number;
		price_at_order: number | null;
		unit_at_order: string | null;
		price_overridden_by: string | null;
		price_overridden_at: string | null;
		products: { name: string } | null;
		users: { name: string } | null;
	}[];
}

/**
 * Slice 4's detail dialog — a dedicated, on-demand fetch (not folded into
 * listOrdersForKanban(), per the design review's Decision 7) so the
 * board's initial load stays lean. .single() surfaces "not found /
 * cross-tenant / RLS-blocked" uniformly as a PostgrestError, same as every
 * other single-row fetch in this file.
 */
export async function getOrderDetail(supabase: Client, orderId: string): Promise<QueryResult<OrderDetail>>
{
	const { data, error } = await supabase
		.from("orders")
		.select(ORDER_DETAIL_SELECT)
		.eq("id", orderId)
		.single();

	if (error)
	{
		return { data: null, error };
	}

	const row = data as unknown as OrderDetailRow;

	const detail: OrderDetail = {
		id: row.id,
		status: row.status,
		channel: row.channel,
		notes: row.notes,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		customerName: row.customers?.name ?? "—",
		customerPhone: row.customers?.phone ?? null,
		items: row.order_items.map((item) => ({
			id: item.id,
			quantity: item.quantity,
			priceAtOrder: item.price_at_order,
			unitAtOrder: item.unit_at_order,
			productName: item.products?.name ?? "—",
			priceOverriddenBy: item.price_overridden_by,
			priceOverriddenByName: item.users?.name ?? null,
			priceOverriddenAt: item.price_overridden_at,
		})),
	};

	return { data: detail, error: null };
}

export interface PriceUpdate
{
	orderItemId: string;
	priceAtOrder: number;
}

export interface UpdateOrderDetailInput
{
	notes: string | null;
	priceUpdates: PriceUpdate[];
}

export interface UpdateOrderDetailResult
{
	order: Order;
	items: OrderItem[];
}

/** Wraps the update_order_detail() RPC (S4a) — the single atomic write path for the dialog's notes+price edits. */
export async function updateOrderDetail(
	supabase: Client,
	orderId: string,
	input: UpdateOrderDetailInput,
): Promise<QueryResult<UpdateOrderDetailResult>>
{
	const { data, error } = await supabase.rpc("update_order_detail", {
		p_order_id: orderId,
		// The generated Args type has p_notes as a required `string` — it
		// doesn't know the RPC itself normalizes null/blank to NULL, same
		// cast pattern as createOrder() uses for the same reason.
		p_notes: input.notes as string,
		p_price_updates: input.priceUpdates.map((p) => ({
			order_item_id: p.orderItemId,
			price_at_order: p.priceAtOrder,
		})) as unknown as Json,
	});

	if (error)
	{
		return { data: null, error };
	}

	const result = data as unknown as UpdateOrderDetailResult;
	return { data: result, error: null };
}

export interface TodayStats
{
	ordersToday: number;
	pendingToday: number;
	deliveredToday: number;
	salesToday: number;
	unpricedCount: number;
}

interface TodayStatsRow
{
	orders_today: number;
	pending_today: number;
	delivered_today: number;
	sales_today: number;
	unpriced_count: number;
}

/**
 * Wraps the get_today_stats() RPC (S5a). dayStart/dayEnd are the CALLER's
 * local day boundary (mirrors checkPendingDuplicateOrder()'s pattern) —
 * this function doesn't compute "today" itself, so a server-rendered
 * caller can't accidentally use the server's timezone instead of the
 * viewer's.
 */
export async function getTodayStats(supabase: Client, dayStart: Date, dayEnd: Date): Promise<QueryResult<TodayStats>>
{
	const { data, error } = await supabase.rpc("get_today_stats", {
		p_day_start: dayStart.toISOString(),
		p_day_end: dayEnd.toISOString(),
	});

	if (error)
	{
		return { data: null, error };
	}

	const row = data as unknown as TodayStatsRow;

	return {
		data: {
			ordersToday: row.orders_today,
			pendingToday: row.pending_today,
			deliveredToday: row.delivered_today,
			salesToday: row.sales_today,
			unpricedCount: row.unpriced_count,
		},
		error: null,
	};
}
