"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { saveProductsRpc, type SaveConflict } from "@/lib/products/catalog";
import { getActiveUser } from "@/lib/auth/active-user";
import { UNAUTHORIZED, saveRpcErrorMessage } from "@/lib/grid/rpc-errors";
import { saveRowError, MAX_SAVE_ROWS, type SaveRow } from "@/lib/products/grid";

export type SaveProductsResult =
	| { status: "saved"; saved: number }
	| { status: "conflicts"; conflicts: SaveConflict[] }
	| { status: "error"; error: string };


/**
 * The catalog grid's only write path. Runs with the caller's own session
 * (no service_role): save_products() is security invoker, so RLS and the
 * RPC's explicit role check both apply. The role check here is the
 * backend boundary for ADR-006; the grid hiding errors is just UX, so the
 * rows are re-validated too.
 */
export async function saveProducts(rows: SaveRow[]): Promise<SaveProductsResult>
{
	const supabase = await createClient();
	const user = await getActiveUser(supabase);
	const role = user?.app_metadata.role;
	if (!user || (role !== "admin" && role !== "operator"))
	{
		return { status: "error", error: UNAUTHORIZED };
	}

	if (!Array.isArray(rows) || rows.length === 0)
	{
		return { status: "error", error: "No hay cambios para guardar." };
	}
	if (rows.length > MAX_SAVE_ROWS)
	{
		return { status: "error", error: `Máximo ${MAX_SAVE_ROWS} productos por guardado.` };
	}
	for (const row of rows)
	{
		const problem = saveRowError(row);
		if (problem)
		{
			return { status: "error", error: problem };
		}
	}

	const { data, error } = await saveProductsRpc(supabase, rows);
	if (error || !data)
	{
		return { status: "error", error: saveRpcErrorMessage(error?.code, error?.message, "Un producto ya no existe. Recarga la página.") };
	}

	if (data.conflicts.length > 0)
	{
		return { status: "conflicts", conflicts: data.conflicts };
	}

	revalidatePath("/products");
	return { status: "saved", saved: data.saved };
}
