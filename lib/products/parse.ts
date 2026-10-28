export type PriceParse =
	| { ok: true; value: number }
	| { ok: false; reason: "empty" | "invalid" | "nonpositive" | "decimals" }
	| { ok: false; reason: "ambiguous"; suggestions: number[] };

/**
 * El Salvador format (eng review D6): "." is the decimal point, "," groups
 * thousands. Clear input converts ("$1,250.00" → 1250, "12.5" → 12.5);
 * anything a Spanish-locale Excel could mean differently is NOT converted —
 * the grid shows it red with the possible readings instead of guessing.
 */
export function parsePrice(text: string): PriceParse
{
	const s = text.trim().replace(/^\$\s*/, "").replace(/\s*(usd|\$)$/i, "").replace(/\s+/g, "");

	if (s === "")
	{
		return { ok: false, reason: "empty" };
	}

	if (/^-\d/.test(s))
	{
		return { ok: false, reason: "nonpositive" };
	}

	// "12,50" / "12,5" — comma decimal (Spain) → 12.50; in SV it isn't valid at all.
	if (/^\d+,\d{1,2}$/.test(s))
	{
		return { ok: false, reason: "ambiguous", suggestions: [Number(s.replace(",", "."))] };
	}

	// "1.250" — 1.25 here, 1250 with dot-grouped thousands. Readings with
	// more than 2 decimals ("12.555" as 12.555) aren't valid prices anyway.
	if (/^\d{1,3}\.\d{3}$/.test(s))
	{
		const asThousands = Number(s.replace(".", ""));
		return { ok: false, reason: "ambiguous", suggestions: s.endsWith("0") ? [Number(s), asThousands] : [asThousands] };
	}

	// "1.250,00" / "1.250.000" — dot-grouped thousands.
	if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s))
	{
		return { ok: false, reason: "ambiguous", suggestions: [Number(s.replace(/\./g, "").replace(",", "."))] };
	}

	let normalized: string;
	if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s))
	{
		normalized = s.replace(/,/g, "");
	}
	else if (/^\d+(\.\d+)?$/.test(s) || /^\.\d+$/.test(s))
	{
		normalized = s;
	}
	else
	{
		return { ok: false, reason: "invalid" };
	}

	if ((normalized.split(".")[1] ?? "").length > 2)
	{
		return { ok: false, reason: "decimals" };
	}

	const value = Number(normalized);
	if (!(value > 0))
	{
		return { ok: false, reason: "nonpositive" };
	}
	return { ok: true, value };
}

/** Short reason shown under a red price cell. */
export function priceErrorMessage(result: Exclude<PriceParse, { ok: true }>): string
{
	switch (result.reason)
	{
		case "empty":
			return "Falta el precio";
		case "ambiguous":
			return `¿Quisiste decir ${result.suggestions.map((n) => n.toFixed(2)).join(" o ")}?`;
		case "decimals":
			return "Máximo 2 decimales";
		case "nonpositive":
			return "Debe ser mayor que 0";
		case "invalid":
			return "No es un precio";
	}
}
