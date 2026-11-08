import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { appUrl } from "@/lib/notifications/send";

/**
 * Daily email to each tenant's admins when delivered orders have no issued
 * DTE (dte_backlog_alerts()). `supabase` must be a service_role client.
 */
export async function sendDteAlerts(supabase: SupabaseClient<Database>, today = new Date().toISOString().slice(0, 10)): Promise<{ sent: number }>
{
	const apiKey = process.env.RESEND_API_KEY;
	const from = process.env.EMAIL_FROM;
	if (!apiKey || !from)
	{
		console.warn("DTE alerts not sent: RESEND_API_KEY / EMAIL_FROM missing");
		return { sent: 0 };
	}
	const { data, error } = await supabase.rpc("dte_backlog_alerts");
	if (error)
	{
		throw new Error(`dte_backlog_alerts: ${error.message}`);
	}

	let sent = 0;
	for (const t of data ?? [])
	{
		if (!t.admin_emails?.length)
		{
			continue;
		}
		const what = t.stuck === 1 ? "1 pedido entregado no tiene" : `${t.stuck} pedidos entregados no tienen`;
		const url = `${appUrl()}/orders/facturas`;
		const res = await fetch("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				"Authorization": `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				// One alert per tenant and day even if the cron runs twice.
				"Idempotency-Key": `dte-alert-${t.tenant_id}-${today}`,
			},
			body: JSON.stringify({
				from: `Nellio <${from}>`,
				to: t.admin_emails,
				subject: `${t.tenant_name}: ${what} factura emitida`,
				text: `${what} factura emitida en Hacienda. Revísalos y usa Reintentar o corrige los datos que falten:\n${url}`,
			}),
		});
		if (!res.ok)
		{
			console.error(`DTE alert for ${t.tenant_id}: Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
			continue;
		}
		sent++;
	}
	return { sent };
}
