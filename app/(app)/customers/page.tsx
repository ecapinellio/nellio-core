import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { listCustomers } from "@/lib/customers/catalog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CustomersManager } from "@/components/customers/customers-manager";

export const metadata: Metadata = {
	title: "Clientes — Nellio Core",
};

export default async function CustomersPage()
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();

	// Belt-and-suspenders: lib/rbac.ts's /customers rule is the route-level
	// gate; RLS + save_customers()' role check are the real boundary.
	const role = user?.app_metadata.role;
	if (!user || (role !== "admin" && role !== "operator"))
	{
		redirect("/");
	}

	const { data: customers, error } = await listCustomers(supabase);

	if (error || !customers)
	{
		// A failed load must not look like an empty list (which shows the paste guide).
		return (
			<div className="flex max-w-[1280px] flex-col gap-4">
				<h1 className="text-xl font-semibold tracking-tight">Clientes</h1>
				<Alert variant="destructive">
					<AlertTriangle />
					<AlertDescription>No se pudo cargar la lista de clientes. Recarga la página.</AlertDescription>
				</Alert>
			</div>
		);
	}

	return (
		<div className="max-w-[1280px]">
			<CustomersManager customers={customers} />
		</div>
	);
}
