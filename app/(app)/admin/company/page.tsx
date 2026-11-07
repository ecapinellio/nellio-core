import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { CompanyForm } from "@/components/admin/company-form";

export const metadata: Metadata = {
	title: "Empresa — Nellio Core",
};

export default async function AdminCompanyPage()
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();
	// Same belt-and-suspenders as /admin/users: lib/rbac.ts is the route gate,
	// save_company_fiscal() / set_dte_credentials() the real one.
	if (!user || user.app_metadata.role !== "admin")
	{
		redirect("/");
	}

	const [{ data: tenant, error }, { data: credentials }] = await Promise.all([
		supabase.from("tenants").select("*").eq("id", user.app_metadata.tenant_id).single(),
		supabase.rpc("dte_credentials_status"),
	]);

	if (error || !tenant)
	{
		return (
			<div className="flex max-w-[560px] flex-col gap-4">
				<h1 className="text-xl font-semibold tracking-tight">Empresa</h1>
				<Alert variant="destructive">
					<AlertTriangle />
					<AlertDescription>No se pudieron cargar los datos. Recarga la página.</AlertDescription>
				</Alert>
			</div>
		);
	}

	const status = credentials as { configured: boolean; updated_at: string | null } | null;
	return <CompanyForm tenant={tenant} credentials={status ?? { configured: false, updated_at: null }} />;
}
