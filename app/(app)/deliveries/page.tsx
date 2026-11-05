import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { DriverOrders } from "@/components/deliveries/driver-orders";

export const metadata: Metadata = {
	title: "Mis entregas — Nellio Core",
};

export default async function DeliveriesPage()
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();

	return (
		<div className="mx-auto flex max-w-xl flex-col gap-4">
			<h1 className="text-xl font-semibold tracking-tight">Mis pedidos</h1>
			<DriverOrders tenantId={user?.app_metadata.tenant_id ?? ""} />
		</div>
	);
}
