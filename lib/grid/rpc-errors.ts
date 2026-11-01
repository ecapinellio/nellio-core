export const UNAUTHORIZED = "No autorizado.";
export const GENERIC_SAVE_ERROR = "No se pudo guardar. Revisa tu conexión e intenta de nuevo.";

/**
 * The save_* RPCs raise their user-facing messages in Spanish (validation,
 * duplicates); everything else collapses to a fixed string so raw Postgres
 * errors never reach the UI.
 */
export function saveRpcErrorMessage(code: string | undefined, message: string | undefined, missingRowMessage: string): string
{
	switch (code)
	{
		case "28000":
		case "42501":
			return UNAUTHORIZED;
		case "P0002":
			return missingRowMessage;
		case "23505":
		case "22001":
		case "22003":
		case "22004":
		case "22023":
			return message ?? GENERIC_SAVE_ERROR;
		default:
			return GENERIC_SAVE_ERROR;
	}
}
