"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getActiveUser } from "@/lib/auth/active-user";
import { buildInvalidation } from "@/lib/dte/invalidation";
import { signDte } from "@/lib/dte/sign";
import { authenticate, invalidateDte, rejectionMessage, type Environment } from "@/lib/dte/hacienda";
import { loadCredentials } from "@/lib/dte/process";

export interface InvalidateInput
{
	orderId: string;
	reason: string;
	responsibleName: string;
	responsibleDoc: string;
	requesterName: string;
	requesterDoc: string;
}

/** NIT (14 digits) → "36"; DUI (9) → "13" with its dash; null if neither. */
function personDoc(text: string): { type: string; number: string } | null
{
	const d = text.replace(/\D/g, "");
	if (d.length === 9)
	{
		return { type: "13", number: `${d.slice(0, 8)}-${d.slice(8)}` };
	}
	return d.length === 14 ? { type: "36", number: d } : null;
}

/**
 * Admin only: sends the invalidation event (type 2, rescind) for the order's
 * issued DTE and marks it invalidated. The admin check is the backend
 * boundary (ADR-006): everything after uses service_role. Tenant from the JWT.
 */
export async function invalidateOrderDte(input: InvalidateInput): Promise<{ error: string | null }>
{
	const user = await getActiveUser(await createClient());
	const tenantId: string | undefined = user?.app_metadata.tenant_id;
	if (!user || user.app_metadata.role !== "admin" || !tenantId)
	{
		return { error: "No autorizado." };
	}

	const responsible = personDoc(input.responsibleDoc);
	const requester = personDoc(input.requesterDoc);
	if (!input.responsibleName.trim() || !responsible || !input.requesterName.trim() || !requester)
	{
		return { error: "Falta el nombre o el DUI/NIT del responsable o de quien lo solicita." };
	}

	const admin = createAdminClient();
	const { data: doc } = await admin.from("dte_documents").select("*")
		.eq("order_id", input.orderId).eq("tenant_id", tenantId).eq("status", "issued").maybeSingle();
	if (!doc?.document || !doc.reception_seal)
	{
		return { error: "El pedido no tiene una factura emitida." };
	}
	const { data: tenant } = await admin.from("tenants").select("*").eq("id", tenantId).single();
	if (!tenant?.mh_establishment_code || !tenant.mh_pos_code)
	{
		return { error: "Faltan los códigos de establecimiento y punto de venta asignados por Hacienda (Empresa)." };
	}
	const credentials = await loadCredentials(admin, tenantId);
	if (!credentials)
	{
		return { error: "Faltan las credenciales de Hacienda de la empresa." };
	}

	const original = doc.document as {
		identificacion: { fecEmi: string };
		receptor: Record<string, string | null> | null;
	};
	const r = original.receptor;
	// CCF receptor has nit; Factura has tipoDocumento/numDocumento (or no receptor).
	const receptorDoc = r?.nit ? personDoc(r.nit) : r?.numDocumento ? { type: r.tipoDocumento!, number: r.numDocumento } : null;

	const env = doc.environment as Environment;
	const event = buildInvalidation({
		environment: env,
		tenant: {
			nit: tenant.nit!,
			legal_name: tenant.legal_name!,
			mh_establishment_code: tenant.mh_establishment_code,
			mh_pos_code: tenant.mh_pos_code,
			establishment_code: tenant.establishment_code,
			pos_code: tenant.pos_code,
			phone: tenant.phone!,
			email: tenant.email!,
		},
		dte: {
			tipoDte: doc.dte_type!,
			codigoGeneracion: doc.generation_code!,
			selloRecibido: doc.reception_seal,
			numeroControl: doc.control_number!,
			fecEmi: original.identificacion.fecEmi,
			receptor: {
				tipoDocumento: receptorDoc?.type ?? null,
				numDocumento: receptorDoc?.number ?? null,
				nombre: r?.nombre ?? null,
				telefono: r?.telefono ?? null,
				correo: r?.correo ?? null,
			},
		},
		reason: input.reason,
		responsible: { name: input.responsibleName.trim(), docType: responsible.type, docNumber: responsible.number },
		requester: { name: input.requesterName.trim(), docType: requester.type, docNumber: requester.number },
	}, new Date());

	try
	{
		const nit = tenant.nit!.replace(/\D/g, "");
		const token = await authenticate(env, nit, credentials.api_password);
		const reply = await invalidateDte(env, token, signDte(event, credentials.certificate, credentials.key_password),
			Math.floor(Date.now() / 1000));
		if (reply.estado !== "PROCESADO" || !reply.selloRecibido)
		{
			return { error: `Hacienda no aceptó la invalidación: ${rejectionMessage(reply)}` };
		}
		const { error } = await admin.rpc("mark_dte_invalidated", { p_doc_id: doc.id, p_seal: reply.selloRecibido });
		if (error)
		{
			return { error: `Hacienda invalidó el DTE (sello ${reply.selloRecibido}) pero no se pudo guardar: ${error.message}` };
		}
	}
	catch (e)
	{
		return { error: e instanceof Error ? e.message : String(e) };
	}
	revalidatePath("/orders");
	return { error: null };
}
