import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { Database, Json } from "@/lib/supabase/database.types";
import type { CustomerRecord, CustomerSaveRow } from "@/lib/customers/grid";

type Client = SupabaseClient<Database>;

/** Every customer, active and inactive — the grid needs every name and NIT for its checks. */
export async function listCustomers(supabase: Client): Promise<{ data: CustomerRecord[] | null; error: PostgrestError | null }>
{
	const { data, error } = await supabase
		.from("customers")
		.select("id, name, phone, address, tax_id, legal_name, nrc, cod_actividad, desc_actividad, email, department_code, municipality_code, district_code, active, updated_at")
		.order("active", { ascending: false })
		.order("name", { ascending: true });
	return { data, error };
}

/** A customer someone else saved after the grid loaded it. */
export interface CustomerConflict extends CustomerRecord
{
	updated_by_name: string | null;
}

export async function saveCustomersRpc(
	supabase: Client,
	rows: CustomerSaveRow[],
): Promise<{ data: { saved: number; conflicts: CustomerConflict[] } | null; error: PostgrestError | null }>
{
	const { data, error } = await supabase.rpc("save_customers", { p_rows: rows as unknown as Json });
	return { data: data as unknown as { saved: number; conflicts: CustomerConflict[] } | null, error };
}
