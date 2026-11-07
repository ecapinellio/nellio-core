// Customer emails (spec §5, §6, §10). Pure: the sender fills EmailData, this only writes text.

export type NotificationKind =
	| "received" | "confirmed" | "rescheduled" | "on_the_way"
	| "delivered" | "partially_delivered" | "failed" | "cancelled" | "invoice_issued";

export interface EmailData
{
	company: string;
	customerName: string;
	orderRef: string;
	trackingUrl: string;
	deliveryDate: string | null;
	deliveryWindow: string | null;
	receiverName: string | null;
	deliveredAt: string | null;
	/** Lines delivered short, for partially_delivered. */
	missing: { product: string; quantity: number }[];
	/** invoice_issued: the representación gráfica (/t/<token>/factura). */
	invoiceUrl?: string | null;
}

export interface Email
{
	subject: string;
	text: string;
	html: string;
}

// shortcut: one time zone for every tenant (ECTEC, El Salvador); move to tenants when a second country signs.
export const TENANT_TIME_ZONE = "America/El_Salvador";

/** "martes 10 de noviembre" from a yyyy-mm-dd date (no time zone shift). */
export function formatDeliveryDay(date: string): string
{
	return new Intl.DateTimeFormat("es", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
		.format(new Date(`${date}T12:00:00Z`)).replace(",", "");
}

/** "10/11/2026 14:05" in the tenant's time zone. */
export function formatLocalTime(iso: string): string
{
	return new Intl.DateTimeFormat("es", {
		day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
		timeZone: TENANT_TIME_ZONE,
	}).format(new Date(iso)).replace(",", "");
}

// assign_order requires the date, so confirmed/rescheduled always have it.
function when(d: EmailData): string
{
	const day = formatDeliveryDay(d.deliveryDate!);
	return d.deliveryWindow ? `el ${day}, ${d.deliveryWindow}` : `el ${day}`;
}

function body(kind: NotificationKind, d: EmailData): { subject: string; lines: string[] }
{
	const ref = `#${d.orderRef}`;
	const received = d.receiverName && d.deliveredAt
		? `Lo recibió ${d.receiverName} el ${formatLocalTime(d.deliveredAt)}.`
		: null;
	switch (kind)
	{
		case "received":
			return { subject: `Recibimos tu pedido ${ref}`, lines: ["Recibimos tu pedido. Te avisaremos cuando esté confirmado."] };
		case "confirmed":
			return { subject: `Tu pedido ${ref} está confirmado`, lines: [`Tu pedido está confirmado y llega ${when(d)}.`] };
		case "rescheduled":
			return { subject: `Nueva fecha de entrega para tu pedido ${ref}`, lines: [`Nueva fecha de entrega: ${when(d)}.`] };
		case "on_the_way":
			return { subject: `Tu pedido ${ref} va en camino`, lines: ["Tu pedido salió de bodega y va en camino."] };
		case "delivered":
			return { subject: `Tu pedido ${ref} fue entregado`, lines: ["Tu pedido fue entregado.", ...(received ? [received] : [])] };
		case "partially_delivered":
			return {
				subject: `Tu pedido ${ref} fue entregado parcialmente`,
				lines: [
					"Tu pedido fue entregado parcialmente.",
					...(received ? [received] : []),
					...(d.missing.length ? ["No se entregó:", ...d.missing.map((m) => `- ${m.quantity} × ${m.product}`)] : []),
				],
			};
		case "failed":
			return { subject: `No pudimos entregar tu pedido ${ref}`, lines: ["Hoy no pudimos entregar tu pedido. Te contactaremos para coordinar una nueva entrega."] };
		case "cancelled":
			return { subject: `Tu pedido ${ref} fue cancelado`, lines: ["Tu pedido fue cancelado. Si tienes dudas, responde a este correo."] };
		case "invoice_issued":
			return {
				subject: `Factura electrónica de tu pedido ${ref}`,
				lines: [
					"Te enviamos la factura electrónica (DTE) de tu pedido. El archivo JSON va adjunto.",
					...(d.invoiceUrl ? [`Puedes verla e imprimirla aquí: ${d.invoiceUrl}`] : []),
				],
			};
	}
}

const escapeHtml = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function buildCustomerEmail(kind: NotificationKind, d: EmailData): Email
{
	const { subject, lines } = body(kind, d);
	const all = [`Hola, ${d.customerName}:`, ...lines];
	const text = [...all, "", `Sigue tu pedido aquí: ${d.trackingUrl}`, "", d.company].join("\n");
	const html = [
		...all.map((l) => `<p>${escapeHtml(l)}</p>`),
		`<p><a href="${escapeHtml(d.trackingUrl)}">Ver el estado de tu pedido</a></p>`,
		`<p>${escapeHtml(d.company)}</p>`,
	].join("\n");
	return { subject: `${d.company}: ${subject}`, text, html };
}
