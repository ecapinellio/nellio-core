export const PASSWORD_PATH = "/account/password";
export const MIN_PASSWORD_LENGTH = 10;
// bcrypt (GoTrue) ignores anything past 72 bytes.
export const MAX_PASSWORD_LENGTH = 72;

/**
 * Set in app_metadata whenever an admin hands someone a generated password
 * (create, restore, reactivate) — the admin has seen it, so the person must
 * pick their own before using the app. app_metadata, not users: only the
 * server can write it (ADR-002), and getUser() returns it fresh.
 */
export function mustChangePassword(user: { app_metadata?: Record<string, unknown> } | null | undefined): boolean
{
	return user?.app_metadata?.must_change_password === true;
}

// GoTrue's symbol set for `password_requirements =
// "lower_upper_letters_digits_symbols"` (supabase/config.toml + the hosted
// Auth settings) — same list, so the app and Supabase never disagree.
export const PASSWORD_SYMBOLS = "!@#$%^&*()_+-=[]{};'\\:\"|<>?,./`~";

export interface PasswordRule
{
	id: "length" | "upper" | "lower" | "digit" | "symbol";
	/** Checklist label ("Al menos 10 caracteres"). */
	label: string;
	/** What's missing, for the error sentence ("una mayúscula"). */
	missing: string;
	test: (password: string) => boolean;
}

// ASCII only, like GoTrue: "Ñ" or "á" don't count as upper/lowercase there.
export const PASSWORD_RULES: readonly PasswordRule[] = [
	{ id: "length", label: `Al menos ${MIN_PASSWORD_LENGTH} caracteres`, missing: `${MIN_PASSWORD_LENGTH} caracteres`, test: (p) => p.length >= MIN_PASSWORD_LENGTH },
	{ id: "upper", label: "Una mayúscula (A-Z)", missing: "una mayúscula", test: (p) => /[A-Z]/.test(p) },
	{ id: "lower", label: "Una minúscula (a-z)", missing: "una minúscula", test: (p) => /[a-z]/.test(p) },
	{ id: "digit", label: "Un número", missing: "un número", test: (p) => /[0-9]/.test(p) },
	{ id: "symbol", label: "Un símbolo, como ! # $ % *", missing: "un símbolo", test: (p) => [...p].some((c) => PASSWORD_SYMBOLS.includes(c)) },
];

/** Rules the password doesn't meet yet (empty = all good). */
export function unmetPasswordRules(password: string): PasswordRule[]
{
	return PASSWORD_RULES.filter((rule) => !rule.test(password));
}

/** Spanish message for an invalid new password, or null if it's fine. */
export function newPasswordError(password: unknown, confirm: unknown): string | null
{
	if (typeof password !== "string" || password === "")
	{
		return "Escribe tu contraseña nueva.";
	}
	const unmet = unmetPasswordRules(password);
	if (unmet.length > 0)
	{
		const items = unmet.map((rule) => rule.missing);
		const list = items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} y ${items[items.length - 1]}`;
		return `A tu contraseña le falta: ${list}.`;
	}
	if (new TextEncoder().encode(password).length > MAX_PASSWORD_LENGTH)
	{
		return `Usa como máximo ${MAX_PASSWORD_LENGTH} caracteres.`;
	}
	if (password !== confirm)
	{
		return "Las dos contraseñas no coinciden.";
	}
	return null;
}
