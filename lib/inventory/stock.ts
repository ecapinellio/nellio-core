import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { normalizeName, parseTsv } from "@/lib/grid/core";

type Client = SupabaseClient<Database>;

export interface StockRow
{
	id: string;
	name: string;
	unit: string | null;
	active: boolean;
	stock: number;
}

export type MovementKind = "receipt" | "count" | "order";

export interface Movement
{
	id: string;
	quantity: number;
	kind: MovementKind;
	note: string | null;
	created_at: string;
	order_id: string | null;
	author: string | null;
	customer: string | null;
}

/** What save_stock_movements() takes. */
export interface StockInput
{
	product_id: string;
	kind: "receipt" | "count";
	quantity: number;
	note?: string;
}

export async function listStock(supabase: Client): Promise<{ data: StockRow[] | null; error: PostgrestError | null }>
{
	const { data, error } = await supabase
		.from("product_stock")
		.select("id, name, unit, active, stock")
		.order("active", { ascending: false })
		.order("name");
	return { data: data?.map((r) => ({ id: r.id!, name: r.name!, unit: r.unit, active: r.active!, stock: Number(r.stock) })) ?? null, error };
}

export async function getStock(supabase: Client, productIds: string[]): Promise<Record<string, number>>
{
	if (productIds.length === 0)
	{
		return {};
	}
	const { data } = await supabase.from("product_stock").select("id, stock").in("id", productIds);
	return Object.fromEntries((data ?? []).map((r) => [r.id!, Number(r.stock)]));
}

export async function listMovements(supabase: Client, productId: string): Promise<{ data: Movement[] | null; error: PostgrestError | null }>
{
	const { data, error } = await supabase
		.from("inventory_movements")
		.select("id, quantity, kind, note, created_at, order_id, users(name), orders(customers(name))")
		.eq("product_id", productId)
		.order("created_at", { ascending: false })
		.limit(100);
	return {
		data: data?.map((m) => ({
			id: m.id,
			quantity: Number(m.quantity),
			kind: m.kind as MovementKind,
			note: m.note,
			created_at: m.created_at,
			order_id: m.order_id,
			author: m.users?.name ?? null,
			customer: m.orders?.customers?.name ?? null,
		})) ?? null,
		error,
	};
}

/** "12", "1,250.5", "0" → number; anything else (comma decimals, 3 decimals, negatives) → null. */
export function parseQuantity(text: string): number | null
{
	const s = text.trim().replace(/\s+/g, "");
	const plain = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(s) ? s.replace(/,/g, "") : s;
	if (!/^\d+(\.\d{1,2})?$/.test(plain))
	{
		return null;
	}
	const value = Number(plain);
	return value < 1_000_000_000 ? value : null;
}

export type CountLine =
	| { ok: true; line: number; productId: string; name: string; quantity: number }
	| { ok: false; line: number; text: string; reason: string };

/** Excel paste "Producto <tab> Cantidad" → counts, matched by name the way the catalog dedupes. */
export function parseCountPaste(text: string, products: { id: string; name: string }[]): CountLine[]
{
	const byName = new Map(products.map((p) => [normalizeName(p.name), p]));
	const rows = parseTsv(text)
		.map((cells, i) => ({ name: cells[0]?.trim() ?? "", qty: cells[1]?.trim() ?? "", line: i + 1 }))
		.filter((r) => r.name || r.qty);
	// A header row ("Producto | Cantidad") isn't an error.
	if (rows[0] && !byName.has(normalizeName(rows[0].name)) && parseQuantity(rows[0].qty) === null)
	{
		rows.shift();
	}
	return rows.map(({ name, qty, line }): CountLine =>
	{
		const product = byName.get(normalizeName(name));
		const quantity = parseQuantity(qty);
		if (!product)
		{
			return { ok: false, line, text: name, reason: "Producto no encontrado" };
		}
		if (quantity === null)
		{
			return { ok: false, line, text: `${name}: ${qty}`, reason: "Cantidad inválida" };
		}
		return { ok: true, line, productId: product.id, name: product.name, quantity };
	});
}
