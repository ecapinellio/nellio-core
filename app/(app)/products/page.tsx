import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { listCatalog } from "@/lib/products/catalog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CatalogManager } from "@/components/products/catalog-manager";

export const metadata: Metadata = {
	title: "Productos — Nellio Core",
};

export default async function ProductsPage()
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();

	// Belt-and-suspenders: lib/rbac.ts's /products rule is the route-level
	// gate; RLS + save_products()' role check are the real boundary.
	const role = user?.app_metadata.role;
	if (!user || (role !== "admin" && role !== "operator"))
	{
		redirect("/");
	}

	const { data: products, error } = await listCatalog(supabase);

	if (error || !products)
	{
		// A failed load must not look like an empty catalog (which shows the paste guide).
		return (
			<div className="flex max-w-[1280px] flex-col gap-4">
				<h1 className="text-xl font-semibold tracking-tight">Productos</h1>
				<Alert variant="destructive">
					<AlertTriangle />
					<AlertDescription>No se pudo cargar el catálogo. Recarga la página.</AlertDescription>
				</Alert>
			</div>
		);
	}

	return (
		<div className="max-w-[1280px]">
			<CatalogManager products={products} />
		</div>
	);
}
