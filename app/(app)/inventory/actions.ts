"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getActiveUser } from "@/lib/auth/active-user";
import { UNAUTHORIZED, GENERIC_SAVE_ERROR } from "@/lib/grid/rpc-errors";
import type { StockInput } from "@/lib/inventory/stock";
import type { Json } from "@/lib/supabase/database.types";

/** Receipts and counts. Admin only (save_stock_movements() checks it too). */
export async function saveStock(rows: StockInput[]): Promise<{ error: string | null }>
{
	const supabase = await createClient();
	const user = await getActiveUser(supabase);
	if (!user || user.app_metadata.role !== "admin")
	{
		return { error: UNAUTHORIZED };
	}
	if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1000)
	{
		return { error: "Nada que guardar." };
	}

	const { error } = await supabase.rpc("save_stock_movements", { p_rows: rows as unknown as Json });
	if (error)
	{
		if (error.code === "42501" || error.code === "28000")
		{
			return { error: UNAUTHORIZED };
		}
		if (error.code === "P0002")
		{
			return { error: "Un producto ya no existe. Recarga la página." };
		}
		if (error.code === "22023")
		{
			return { error: "Revisa las cantidades: sin negativos y hasta 2 decimales." };
		}
		return { error: GENERIC_SAVE_ERROR };
	}

	revalidatePath("/inventory");
	return { error: null };
}
