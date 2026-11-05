import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { listStock } from "@/lib/inventory/stock";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InventoryManager } from "@/components/inventory/inventory-manager";

export const metadata: Metadata = {
	title: "Inventario — Nellio Core",
};

export default async function InventoryPage()
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();

	// Belt-and-suspenders: lib/rbac.ts gates the route; RLS + the RPC's role check are the boundary.
	const role = user?.app_metadata.role;
	if (!user || (role !== "admin" && role !== "operator"))
	{
		redirect("/");
	}

	const { data: rows, error } = await listStock(supabase);

	if (error || !rows)
	{
		return (
			<div className="flex max-w-[1280px] flex-col gap-4">
				<h1 className="text-xl font-semibold tracking-tight">Inventario</h1>
				<Alert variant="destructive">
					<AlertTriangle />
					<AlertDescription>No se pudo cargar el inventario. Recarga la página.</AlertDescription>
				</Alert>
			</div>
		);
	}

	return <InventoryManager rows={rows} canEdit={role === "admin"} />;
}
