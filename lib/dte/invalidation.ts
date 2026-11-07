/**
 * Evento de invalidación (invalidacion-schema-v3), type 2 "rescindir la
 * operación": only the original's codigoGeneracion is referenced
 * (Manual Funcional V2.0, VII). Pure, so the test checks it against the schema.
 */
import { randomUUID } from "node:crypto";

export interface InvalidationInput
{
	environment: "00" | "01";
	tenant: {
		nit: string;
		legal_name: string;
		mh_establishment_code: string;
		mh_pos_code: string;
		establishment_code: string;
		pos_code: string;
		phone: string;
		email: string;
	};
	dte: {
		tipoDte: string;
		codigoGeneracion: string;
		selloRecibido: string;
		numeroControl: string;
		fecEmi: string;
		/** The original's receptor (null for a Factura to an anonymous customer). */
		receptor: { tipoDocumento: string | null; numDocumento: string | null; nombre: string | null; telefono: string | null; correo: string | null };
	};
	reason: string;
	responsible: { name: string; docType: string; docNumber: string };
	requester: { name: string; docType: string; docNumber: string };
}

export function buildInvalidation(input: InvalidationInput, now: Date): Record<string, unknown>
{
	const local = new Date(now.getTime() - 6 * 3600_000).toISOString();
	const t = input.tenant;
	return {
		identificacion: {
			version: 3,
			ambiente: input.environment,
			codigoGeneracion: randomUUID().toUpperCase(),
			fecEmi: local.slice(0, 10),
			horEmi: local.slice(11, 19),
			fusion: null,
		},
		emisor: {
			nit: t.nit.replace(/\D/g, ""),
			nombre: t.legal_name,
			codEstableMH: t.mh_establishment_code,
			codEstable: t.establishment_code,
			codPuntoVentaMH: t.mh_pos_code,
			codPuntoVenta: t.pos_code,
			telefono: t.phone,
			correo: t.email,
		},
		documento: {
			tipoDte: input.dte.tipoDte,
			codigoGeneracion: input.dte.codigoGeneracion,
			selloRecibido: input.dte.selloRecibido,
			numeroControl: input.dte.numeroControl,
			fecEmi: input.dte.fecEmi,
			codigoGeneracionR: null,
			...input.dte.receptor,
		},
		motivo: {
			tipoAnulacion: 2,
			motivoAnulacion: input.reason.trim().slice(0, 200) || null,
			nombreResponsable: input.responsible.name.slice(0, 100),
			tipDocResponsable: input.responsible.docType,
			numDocResponsable: input.responsible.docNumber,
			nombreSolicita: input.requester.name.slice(0, 100),
			tipDocSolicita: input.requester.docType,
			numDocSolicita: input.requester.docNumber,
		},
	};
}
