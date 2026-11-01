/**
 * El Salvador fiscal-field formats — the same rules as the SQL helpers
 * normalize_tax_id() / normalize_nrc() and save_customers()' checks.
 */

/**
 * NIT (14 digits) or DUI (9 digits, homologated as NIT for individuals —
 * customers eng review D6), with or without dashes. Excel drops the leading
 * zero of numeric cells, so 13 and 8 digits get it back (outside voice #3).
 * Returns the canonical dashed form, or null if it isn't a NIT/DUI.
 */
export function normalizeTaxId(text: string): { value: string; padded: boolean } | null
{
	let digits = text.replace(/\D/g, "");
	let padded = false;
	// 8 digits is also a phone pasted into the wrong column — only pad a
	// real DUI (its check digit must match), or "2222-3333" became a DUI.
	if (digits.length === 13 || (digits.length === 8 && isValidDui(`0${digits}`)))
	{
		digits = `0${digits}`;
		padded = true;
	}
	if (digits.length === 14)
	{
		return { value: `${digits.slice(0, 4)}-${digits.slice(4, 10)}-${digits.slice(10, 13)}-${digits.slice(13)}`, padded };
	}
	if (digits.length === 9)
	{
		return { value: `${digits.slice(0, 8)}-${digits.slice(8)}`, padded };
	}
	return null;
}

/** DUI check digit: the first 8 digits weighted 9…2, (10 − sum mod 10) mod 10. */
export function isValidDui(nineDigits: string): boolean
{
	if (!/^[0-9]{9}$/.test(nineDigits))
	{
		return false;
	}
	let sum = 0;
	for (let i = 0; i < 8; i++)
	{
		sum += Number(nineDigits[i]) * (9 - i);
	}
	return (10 - (sum % 10)) % 10 === Number(nineDigits[8]);
}

/** NRC: 2-8 digits, the last a check digit → "123456-7". */
export function normalizeNrc(text: string): string | null
{
	const trimmed = text.trim();
	if (!/^[0-9][0-9 -]*$/.test(trimmed))
	{
		return null;
	}
	const digits = trimmed.replace(/\D/g, "");
	return /^[0-9]{2,8}$/.test(digits) ? `${digits.slice(0, -1)}-${digits.slice(-1)}` : null;
}

export function isValidEmail(text: string): boolean
{
	return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(text.trim());
}

/** Hacienda's economic-activity code (CAT): 5 or 6 digits. */
export function isValidActivityCode(text: string): boolean
{
	return /^[0-9]{5,6}$/.test(text.trim());
}

/**
 * Phones are free text ("2222-3333 / 7777-8888", "ext. 12" — design D10);
 * fewer than 8 digits in total is worth a look, never an error.
 */
export function phoneLooksIncomplete(text: string): boolean
{
	return text.trim() !== "" && text.replace(/\D/g, "").length < 8;
}
