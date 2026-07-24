"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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
	const { error } = await supabase.auth.signInWithPassword({ email, password });

	if (error)
	{
		return { error: "Correo o contraseña incorrectos." };
	}

	redirect(safeNextPath(formData.get("next")));
}

export async function logout(): Promise<void>
{
	const supabase = await createClient();
	await supabase.auth.signOut();
	redirect("/login");
}
