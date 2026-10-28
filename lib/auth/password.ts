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

/** Spanish message for an invalid new password, or null if it's fine. */
export function newPasswordError(password: unknown, confirm: unknown): string | null
{
	if (typeof password !== "string" || password === "")
	{
		return "Escribe tu contraseña nueva.";
	}
	if (password.length < MIN_PASSWORD_LENGTH)
	{
		return `Usa al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
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
