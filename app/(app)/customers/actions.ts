"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { saveCustomersRpc, type CustomerConflict } from "@/lib/customers/catalog";
import { getActiveUser } from "@/lib/auth/active-user";
import { UNAUTHORIZED, saveRpcErrorMessage } from "@/lib/grid/rpc-errors";
import { customerSaveRowError, MAX_CUSTOMER_SAVE_ROWS, type CustomerSaveRow } from "@/lib/customers/grid";

export type SaveCustomersResult =
	| { status: "saved"; saved: number }
	| { status: "conflicts"; conflicts: CustomerConflict[] }
	| { status: "error"; error: string };

/**
 * The customers grid's only write path — same shape as saveProducts():
 * the caller's own session (save_customers() is security invoker, so RLS
 * and its role check apply), an explicit role check here (ADR-006), and the
 * rows re-validated because the grid can't be trusted.
 */
export async function saveCustomers(rows: CustomerSaveRow[]): Promise<SaveCustomersResult>
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
	if (rows.length > MAX_CUSTOMER_SAVE_ROWS)
	{
		return { status: "error", error: `Máximo ${MAX_CUSTOMER_SAVE_ROWS} clientes por guardado.` };
	}
	for (const row of rows)
	{
		const problem = customerSaveRowError(row);
		if (problem)
		{
			return { status: "error", error: problem };
		}
	}

	const { data, error } = await saveCustomersRpc(supabase, rows);
	if (error || !data)
	{
		return { status: "error", error: saveRpcErrorMessage(error?.code, error?.message, "Un cliente ya no existe. Recarga la página.") };
	}

	if (data.conflicts.length > 0)
	{
		return { status: "conflicts", conflicts: data.conflicts };
	}

	revalidatePath("/customers");
	return { status: "saved", saved: data.saved };
}
