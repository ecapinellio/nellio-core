import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { buildCustomerEmail, type NotificationKind } from "@/lib/notifications/email";

type Client = SupabaseClient<Database>;

const MAX_ATTEMPTS = 5;
const BATCH = 50;

export interface SendResult
{
	sent: number;
	failed: number;
}

/** Public base URL for tracking links: APP_URL, else the Vercel production domain. */
export function appUrl(): string
{
	const url = process.env.APP_URL
		?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "http://localhost:3000");
	return url.replace(/\/$/, "");
}

const ORDER_SELECT = "id, tracking_token, delivery_date, delivery_window, " +
	"tenants(name, commercial_name, email), customers(name), " +
	"order_items(quantity, delivered_quantity, products(name)), " +
	"order_deliveries(outcome, receiver_name, created_at)";

interface OrderRow
{
	id: string;
	tracking_token: string;
	delivery_date: string | null;
	delivery_window: string | null;
	tenants: { name: string; commercial_name: string | null; email: string | null } | null;
	customers: { name: string } | null;
	order_items: { quantity: number; delivered_quantity: number | null; products: { name: string } | null }[];
	order_deliveries: { outcome: string; receiver_name: string | null; created_at: string }[];
}

/**
 * Sends due rows of the order_notifications outbox through Resend.
 * `supabase` must be a service_role client. Without RESEND_API_KEY/EMAIL_FROM
 * nothing is claimed, so the rows wait for the configuration.
 */
export async function sendPendingNotifications(supabase: Client): Promise<SendResult>
{
	const apiKey = process.env.RESEND_API_KEY;
	const from = process.env.EMAIL_FROM;
	if (!apiKey || !from)
	{
		console.warn("Customer emails not configured (RESEND_API_KEY / EMAIL_FROM)");
		return { sent: 0, failed: 0 };
	}

	const { data: claimed, error } = await supabase.rpc("claim_order_notifications", { p_limit: BATCH });
	if (error)
	{
		throw new Error(`claim_order_notifications: ${error.message}`);
	}

	const result: SendResult = { sent: 0, failed: 0 };
	for (const n of claimed ?? [])
	{
		try
		{
			await sendOne(supabase, n, apiKey, from);
			await supabase.from("order_notifications")
				.update({ status: "sent", sent_at: new Date().toISOString(), last_error: null })
				.eq("id", n.id);
			result.sent++;
		}
		catch (e)
		{
			// Still pending: the claim already pushed next_attempt_at, so the next run retries it.
			await supabase.from("order_notifications")
				.update({ status: n.attempts >= MAX_ATTEMPTS ? "failed" : "pending", last_error: String(e).slice(0, 500) })
				.eq("id", n.id);
			result.failed++;
		}
	}
	return result;
}

async function sendOne(
	supabase: Client,
	n: Database["public"]["Tables"]["order_notifications"]["Row"],
	apiKey: string,
	from: string,
): Promise<void>
{
	const { data, error } = await supabase.from("orders").select(ORDER_SELECT).eq("id", n.order_id).single();
	if (error)
	{
		throw new Error(`order ${n.order_id}: ${error.message}`);
	}
	const o = data as unknown as OrderRow;
	const company = o.tenants?.commercial_name?.trim() || o.tenants?.name || "Nellio";
	const delivery = [...o.order_deliveries]
		.filter((d) => d.outcome !== "failed")
		.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];

	const email = buildCustomerEmail(n.kind as NotificationKind, {
		company,
		customerName: o.customers?.name ?? "",
		orderRef: o.id.slice(0, 8),
		trackingUrl: `${appUrl()}/t/${o.tracking_token}`,
		invoiceUrl: `${appUrl()}/t/${o.tracking_token}/factura`,
		deliveryDate: o.delivery_date,
		deliveryWindow: o.delivery_window,
		receiverName: delivery?.receiver_name ?? null,
		deliveredAt: delivery?.created_at ?? null,
		missing: o.order_items
			.filter((i) => i.delivered_quantity !== null && i.delivered_quantity < i.quantity)
			.map((i) => ({ product: i.products?.name ?? "", quantity: i.quantity - i.delivered_quantity! })),
	});

	// The DTE file goes to the receptor with the email (Manual Funcional V2.0, IV).
	let attachments: { filename: string; content: string }[] | undefined;
	if (n.kind === "invoice_issued")
	{
		const { data: dte } = await supabase.from("dte_documents").select("generation_code, document, reception_seal")
			.eq("order_id", o.id).eq("status", "issued").order("created_at", { ascending: false }).limit(1).maybeSingle();
		if (!dte?.document)
		{
			// Invalidated meanwhile: nothing to send, and retrying won't change that.
			return;
		}
		const file = JSON.stringify({ ...(dte.document as object), selloRecibido: dte.reception_seal }, null, 2);
		attachments = [{ filename: `${dte.generation_code}.json`, content: Buffer.from(file).toString("base64") }];
	}

	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			"Authorization": `Bearer ${apiKey}`,
			"Content-Type": "application/json",
			// Resend drops a repeat with the same key (24 h): a crash after sending doesn't duplicate.
			"Idempotency-Key": n.id,
		},
		body: JSON.stringify({
			from: `${company.replace(/[<>"\r\n]/g, "")} <${from}>`,
			to: [n.recipient],
			reply_to: o.tenants?.email ?? undefined,
			subject: email.subject,
			text: email.text,
			html: email.html,
			attachments,
		}),
	});
	if (!res.ok)
	{
		throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
	}
}
