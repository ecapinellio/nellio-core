import type { Metadata } from "next";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { InvoiceBacklog } from "@/components/orders/invoice-backlog";

export const metadata: Metadata = {
	title: "Facturas pendientes — Nellio Core",
};

export default async function InvoiceBacklogPage()
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();
	const [{ data, error }, { data: tenant }] = await Promise.all([
		supabase.rpc("dte_backlog"),
		supabase.from("tenants").select("dte_enabled, dte_environment").eq("id", user?.app_metadata.tenant_id ?? "").single(),
	]);

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Facturas pendientes</h1>
				<p className="text-sm text-muted-foreground">
					Pedidos entregados cuya factura todavía no tiene el sello de Hacienda.
					{tenant?.dte_environment === "00" ? " Ambiente de Pruebas: sin validez fiscal." : ""}
				</p>
			</div>

			{error
				? (
					<Alert variant="destructive">
						<AlertTriangle />
						<AlertDescription>No se pudieron cargar las facturas. Recarga la página.</AlertDescription>
					</Alert>
				)
				: tenant && !tenant.dte_enabled
					? <p className="text-sm text-muted-foreground">El DTE no está activado para la empresa (Empresa, en el menú).</p>
					: <InvoiceBacklog rows={data ?? []} isAdmin={user?.app_metadata.role === "admin"} />}
		</div>
	);
}
