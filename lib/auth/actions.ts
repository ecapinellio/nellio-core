"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { PASSWORD_PATH, mustChangePassword, newPasswordError } from "@/lib/auth/password";

export interface LoginState
{
	error: string | null;
}

/**
 * Only allow redirecting back to a path already inside this app — a
 * user-controlled `next` param passed straight to redirect() would be an
 * open-redirect vector (e.g. `?next=https://evil.com`).
 */
function safeNextPath(next: FormDataEntryValue | null): string
{
	if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//"))
	{
		return "/";
	}
	return next;
}

export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState>
{
	const email = formData.get("email");
	const password = formData.get("password");

	if (typeof email !== "string" || typeof password !== "string" || !email || !password)
	{
		return { error: "Ingresa tu correo y contraseña." };
	}

	const supabase = await createClient();
	const { data, error } = await supabase.auth.signInWithPassword({ email, password });

	if (error)
	{
		return { error: "Correo o contraseña incorrectos." };
	}

	// Straight to the change-password page instead of relying on the proxy:
	// a Server Action redirect is followed client-side and can land on the
	// target page without that hop being re-checked.
	redirect(mustChangePassword(data.user) ? PASSWORD_PATH : safeNextPath(formData.get("next")));
}

export async function logout(): Promise<void>
{
	const supabase = await createClient();
	await supabase.auth.signOut();
	redirect("/login");
}

export interface ChangePasswordState
{
	error: string | null;
}

/**
 * Sets a new password for the signed-in user — both the forced first-login
 * change (after an admin handed them a generated one) and a voluntary one
 * from the menu. The user's own session does the update; only clearing the
 * must_change_password flag needs service_role, because app_metadata is
 * server-only by design (ADR-002).
 */
export async function changePassword(_prevState: ChangePasswordState, formData: FormData): Promise<ChangePasswordState>
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();
	if (!user)
	{
		redirect("/login");
	}

	const password = formData.get("password");
	const problem = newPasswordError(password, formData.get("confirm"));
	if (problem)
	{
		return { error: problem };
	}

	const { error } = await supabase.auth.updateUser({ password: password as string });
	if (error)
	{
		if (error.code === "same_password")
		{
			return { error: "La contraseña nueva tiene que ser distinta a la actual." };
		}
		if (error.code === "weak_password")
		{
			return { error: "Esa contraseña es muy débil. Prueba con una más larga." };
		}
		return { error: "No se pudo cambiar la contraseña. Intenta de nuevo." };
	}

	const forced = mustChangePassword(user);
	if (forced)
	{
		// GoTrue merges app_metadata keys, so tenant_id/role stay intact.
		const { error: clearError } = await createAdminClient().auth.admin.updateUserById(user.id, {
			app_metadata: { must_change_password: false },
		});
		if (clearError)
		{
			return { error: "Tu contraseña se cambió, pero no pudimos terminar. Recarga la página e intenta de nuevo." };
		}
		// Fresh JWT without the flag, so nothing downstream sees a stale claim.
		await supabase.auth.refreshSession();
	}

	redirect(forced ? "/" : `${PASSWORD_PATH}?changed=1`);
}
