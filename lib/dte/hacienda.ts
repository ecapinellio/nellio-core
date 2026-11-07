/**
 * Hacienda's transmission API (Sistema de Transmisión). Endpoints from the
 * Manual Técnico's links; request/response shapes from the public firmador
 * and integrations, not from the (scanned) manual.
 * shortcut: shapes unverified; confirm in apitest before production (spec §7).
 */

export type Environment = "00" | "01";

export function apiBase(environment: Environment): string
{
	return environment === "01" ? "https://api.dtes.mh.gob.sv" : "https://apitest.dtes.mh.gob.sv";
}

/** Public lookup page (the representación gráfica's QR). */
export function publicLookupUrl(environment: Environment, generationCode: string, issueDate: string): string
{
	return `https://webapp.dtes.mh.gob.sv/consultaPublica?ambiente=${environment}&codGen=${generationCode}&fechaEmi=${issueDate}`;
}

export interface HaciendaReply
{
	estado?: string;
	selloRecibido?: string | null;
	fhProcesamiento?: string | null;
	codigoMsg?: string | null;
	descripcionMsg?: string | null;
	observaciones?: string[] | null;
	[key: string]: unknown;
}

/** Transient (network, 5xx, 401): retry later. Anything else is Hacienda's answer. */
export class TransientError extends Error {}

async function call(url: string, init: RequestInit): Promise<{ status: number; body: unknown }>
{
	let res: Response;
	try
	{
		res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
	}
	catch (e)
	{
		throw new TransientError(`Sin respuesta de Hacienda: ${String(e)}`);
	}
	const text = await res.text();
	if (res.status >= 500 || res.status === 401 || res.status === 403)
	{
		throw new TransientError(`Hacienda ${res.status}: ${text.slice(0, 300)}`);
	}
	try
	{
		return { status: res.status, body: JSON.parse(text) };
	}
	catch
	{
		throw new TransientError(`Hacienda ${res.status}, respuesta no JSON: ${text.slice(0, 300)}`);
	}
}

/** POST /seguridad/auth → the token to send as Authorization. */
export async function authenticate(environment: Environment, nit: string, apiPassword: string): Promise<string>
{
	const { body } = await call(`${apiBase(environment)}/seguridad/auth`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({ user: nit, pwd: apiPassword }),
	});
	const token = (body as { body?: { token?: string } }).body?.token;
	if (!token)
	{
		// Wrong NIT/password is not transient: retrying won't fix it.
		throw new Error(`Hacienda no aceptó las credenciales: ${JSON.stringify(body).slice(0, 300)}`);
	}
	return token;
}

/** POST /fesv/recepciondte. */
export async function sendDte(
	environment: Environment,
	token: string,
	dte: { version: number; tipoDte: string; codigoGeneracion: string; signed: string; idEnvio: number },
): Promise<HaciendaReply>
{
	const { body } = await call(`${apiBase(environment)}/fesv/recepciondte`, {
		method: "POST",
		headers: { "Authorization": token, "Content-Type": "application/json" },
		body: JSON.stringify({
			ambiente: environment,
			idEnvio: dte.idEnvio,
			version: dte.version,
			tipoDte: dte.tipoDte,
			documento: dte.signed,
			codigoGeneracion: dte.codigoGeneracion,
		}),
	});
	return body as HaciendaReply;
}

/** POST /fesv/recepcion/consultadte/: was this DTE already received? */
export async function consultDte(
	environment: Environment, token: string, nit: string, tipoDte: string, generationCode: string,
): Promise<HaciendaReply>
{
	const { body } = await call(`${apiBase(environment)}/fesv/recepcion/consultadte/`, {
		method: "POST",
		headers: { "Authorization": token, "Content-Type": "application/json" },
		body: JSON.stringify({ nitEmisor: nit, tdte: tipoDte, codigoGeneracion: generationCode }),
	});
	return body as HaciendaReply;
}

/** POST /fesv/anulardte (invalidation event, schema version 3). */
export async function invalidateDte(
	environment: Environment, token: string, signed: string, idEnvio: number,
): Promise<HaciendaReply>
{
	const { body } = await call(`${apiBase(environment)}/fesv/anulardte`, {
		method: "POST",
		headers: { "Authorization": token, "Content-Type": "application/json" },
		body: JSON.stringify({ ambiente: environment, idEnvio, version: 3, documento: signed }),
	});
	return body as HaciendaReply;
}

export function rejectionMessage(reply: HaciendaReply): string
{
	const notes = (reply.observaciones ?? []).filter(Boolean);
	return [reply.descripcionMsg, ...notes].filter(Boolean).join(" · ").slice(0, 1000) || "Hacienda rechazó el documento.";
}
