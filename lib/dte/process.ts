import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { buildDte, dteProblems, dteTypeFor, type DteOrder } from "@/lib/dte/build";
import { signDte } from "@/lib/dte/sign";
import {
	authenticate, consultDte, rejectionMessage, sendDte, TransientError, type Environment, type HaciendaReply,
} from "@/lib/dte/hacienda";

type Client = SupabaseClient<Database>;
type Doc = Database["public"]["Tables"]["dte_documents"]["Row"];

const MAX_ATTEMPTS = 5;
const BATCH = 20;

export interface DteRunResult
{
	issued: number;
	rejected: number;
	failed: number;
	retrying: number;
}

const TENANT_FIELDS = "nit, nrc, legal_name, commercial_name, cod_actividad, desc_actividad, department_code, " +
	"municipality_code, district_code, address, phone, email, establishment_code, pos_code, prices_include_vat";
const CUSTOMER_FIELDS = "name, legal_name, tax_id, nrc, cod_actividad, desc_actividad, department_code, " +
	"municipality_code, district_code, address, phone, email";
const ORDER_SELECT = `id, tenants(${TENANT_FIELDS}), customers(${CUSTOMER_FIELDS}), ` +
	"order_items(quantity, delivered_quantity, price_at_order, unit_at_order, products(name)), " +
	"order_deliveries(outcome, payment_method, created_at)";

interface OrderRow
{
	tenants: DteOrder["tenant"];
	customers: DteOrder["customer"];
	order_items: { quantity: number; delivered_quantity: number | null; price_at_order: number | null; unit_at_order: string | null; products: { name: string } | null }[];
	order_deliveries: { outcome: string; payment_method: string | null; created_at: string }[];
}

export async function loadDteOrder(supabase: Client, orderId: string): Promise<DteOrder>
{
	const { data, error } = await supabase.from("orders").select(ORDER_SELECT).eq("id", orderId).single();
	if (error)
	{
		throw new TransientError(`order ${orderId}: ${error.message}`);
	}
	const o = data as unknown as OrderRow;
	const delivery = o.order_deliveries
		.filter((d) => d.outcome !== "failed")
		.sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
	return {
		tenant: o.tenants,
		customer: o.customers,
		payment_method: delivery?.payment_method ?? null,
		lines: o.order_items.map((i) => ({
			product: i.products?.name ?? "Producto",
			quantity: Number(i.quantity),
			delivered_quantity: i.delivered_quantity === null ? null : Number(i.delivered_quantity),
			price_at_order: i.price_at_order === null ? null : Number(i.price_at_order),
			unit_at_order: i.unit_at_order,
		})),
	};
}

export interface Credentials
{
	certificate: string;
	key_password: string;
	api_password: string;
	environment: string;
}

export async function loadCredentials(supabase: Client, tenantId: string): Promise<Credentials | null>
{
	const { data, error } = await supabase.rpc("get_dte_credentials", { p_tenant_id: tenantId });
	if (error)
	{
		throw new TransientError(`credentials: ${error.message}`);
	}
	const row = data?.[0];
	return row?.certificate && row.key_password && row.api_password ? (row as Credentials) : null;
}

async function finish(supabase: Client, doc: Doc, status: "issued" | "rejected" | "error", fields: {
	seal?: string | null; response?: HaciendaReply | null; error?: string | null;
})
{
	const { error } = await supabase.rpc("finish_dte", {
		p_doc_id: doc.id,
		p_status: status,
		p_seal: fields.seal ?? undefined,
		p_processed_at: status === "issued" ? new Date().toISOString() : undefined,
		p_response: (fields.response ?? undefined) as Database["public"]["Functions"]["finish_dte"]["Args"]["p_response"],
		p_error: fields.error ?? undefined,
	});
	if (error)
	{
		throw new Error(`finish_dte ${doc.id}: ${error.message}`);
	}
}

/**
 * Sends due rows of the dte_documents queue to Hacienda. `supabase` must be
 * a service_role client. One Hacienda token per tenant and run.
 */
export async function processPendingDtes(supabase: Client, now: () => Date = () => new Date()): Promise<DteRunResult>
{
	const { data: claimed, error } = await supabase.rpc("claim_dte_documents", { p_limit: BATCH });
	if (error)
	{
		throw new Error(`claim_dte_documents: ${error.message}`);
	}

	const result: DteRunResult = { issued: 0, rejected: 0, failed: 0, retrying: 0 };
	const tokens = new Map<string, string>();

	for (const claimedDoc of claimed ?? [])
	{
		let doc: Doc = claimedDoc;
		try
		{
			const order = await loadDteOrder(supabase, doc.order_id);

			// 1. Build once; a retry after fixing data rebuilds (document cleared by retry_dte).
			if (!doc.document)
			{
				const dteType = dteTypeFor(order.customer);
				const problems = dteProblems(order, dteType);
				if (problems.length)
				{
					await finish(supabase, doc, "error", { error: problems.join(" ") });
					result.failed++;
					continue;
				}
				const { data: numbered, error: numberError } = await supabase.rpc("assign_dte_number", { p_doc_id: doc.id, p_dte_type: dteType });
				if (numberError || !numbered)
				{
					throw new TransientError(`assign_dte_number: ${numberError?.message}`);
				}
				const document = buildDte(order, {
					dteType,
					environment: numbered.environment as Environment,
					controlNumber: numbered.control_number!,
					generationCode: numbered.generation_code!,
				}, now());
				const { data: saved, error: saveError } = await supabase.from("dte_documents")
					.update({ document: document as Database["public"]["Tables"]["dte_documents"]["Update"]["document"] })
					.eq("id", doc.id).select().single();
				if (saveError)
				{
					throw new TransientError(`save document: ${saveError.message}`);
				}
				doc = saved;
			}

			const credentials = await loadCredentials(supabase, doc.tenant_id);
			if (!credentials)
			{
				await finish(supabase, doc, "error", { error: "Faltan las credenciales de Hacienda de la empresa." });
				result.failed++;
				continue;
			}
			const env = doc.environment as Environment;
			if (credentials.environment !== env)
			{
				await finish(supabase, doc, "error", {
					error: `Las credenciales guardadas son del ambiente de ${env === "01" ? "Pruebas" : "Producción"}. Sube las de ${env === "01" ? "Producción" : "Pruebas"} en Empresa y reintenta.`,
				});
				result.failed++;
				continue;
			}
			const nit = (order.tenant.nit ?? "").replace(/\D/g, "");
			const tokenKey = `${doc.tenant_id}:${env}`;
			if (!tokens.has(tokenKey))
			{
				tokens.set(tokenKey, await authenticate(env, nit, credentials.api_password));
			}
			const token = tokens.get(tokenKey)!;

			// 2. These codes may have reached Hacienda before (lost response, retry): ask first.
			if (claimedDoc.generation_code)
			{
				const known = await consultDte(env, token, nit, doc.dte_type!, doc.generation_code!).catch(() => null);
				if (known?.estado === "PROCESADO" && known.selloRecibido)
				{
					await finish(supabase, doc, "issued", { seal: known.selloRecibido, response: known });
					result.issued++;
					continue;
				}
			}

			// 3. Sign and send.
			const document = doc.document as { identificacion: { version: number } };
			const reply = await sendDte(env, token, {
				version: document.identificacion.version,
				tipoDte: doc.dte_type!,
				codigoGeneracion: doc.generation_code!,
				signed: signDte(document, credentials.certificate, credentials.key_password),
				idEnvio: Math.floor(Date.now() / 1000),
			});
			if (reply.estado === "PROCESADO" && reply.selloRecibido)
			{
				await finish(supabase, doc, "issued", { seal: reply.selloRecibido, response: reply });
				result.issued++;
			}
			else
			{
				await finish(supabase, doc, "rejected", { response: reply, error: rejectionMessage(reply) });
				result.rejected++;
			}
		}
		catch (e)
		{
			const message = e instanceof Error ? e.message : String(e);
			if (e instanceof TransientError && doc.attempts < MAX_ATTEMPTS)
			{
				// Still queued: the claim already pushed next_attempt_at.
				await supabase.from("dte_documents").update({ last_error: message.slice(0, 1000) }).eq("id", doc.id);
				result.retrying++;
			}
			else
			{
				await finish(supabase, doc, "error", { error: message.slice(0, 1000) }).catch(() => undefined);
				result.failed++;
			}
		}
	}
	return result;
}
