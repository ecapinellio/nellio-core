import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { CatalogProduct, SaveRow } from "@/lib/products/grid";

type Client = SupabaseClient<Database>;

/** Whole catalog, active and inactive — the grid needs every name for duplicate checks. */
export async function listCatalog(supabase: Client): Promise<{ data: CatalogProduct[] | null; error: PostgrestError | null }>
{
	const { data, error } = await supabase
		.from("products")
		.select("id, name, price_per_unit, unit, active, updated_at")
		.order("active", { ascending: false })
		.order("name", { ascending: true });
	return { data, error };
}

/** A row someone else saved after the grid loaded it (eng review D5). */
export interface SaveConflict
{
	id: string;
	name: string;
	price_per_unit: number | null;
	unit: string | null;
	active: boolean;
	updated_at: string;
	updated_by_name: string | null;
}

export interface SaveProductsResponse
{
	saved: number;
	conflicts: SaveConflict[];
}

export async function saveProductsRpc(
	supabase: Client,
	rows: SaveRow[],
): Promise<{ data: SaveProductsResponse | null; error: PostgrestError | null }>
{
	const { data, error } = await supabase.rpc("save_products", { p_rows: rows as unknown as Json });
	return { data: data as unknown as SaveProductsResponse | null, error };
}
