import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CheckCircle2, LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/lib/auth/actions";
import { mustChangePassword } from "@/lib/auth/password";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { ChangePasswordForm } from "@/components/change-password-form";

export const metadata: Metadata = {
	title: "Contraseña — Nellio Core",
};

/**
 * Outside the (app) shell on purpose: when the change is forced the proxy
 * sends every route here, so a sidebar full of links that bounce back would
 * only confuse. Same quiet layout as /login.
 */
export default async function PasswordPage({
	searchParams,
}: {
	searchParams: Promise<{ changed?: string }>;
})
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();
	if (!user)
	{
		redirect("/login");
	}

	const forced = mustChangePassword(user);
	const { changed } = await searchParams;

	return (
		<div className="flex min-h-screen items-center justify-center bg-background p-4 md:p-8">
			<div className="w-full max-w-sm">
				<div className="mb-8 flex items-center text-sm font-bold tracking-tight">
					<span className="mr-2 inline-block size-1.5 rounded-full bg-primary" />
					Nellio Core
				</div>

				<h1 className="text-xl font-semibold tracking-tight">{forced ? "Crea tu contraseña" : "Cambiar contraseña"}</h1>
				<p className="mb-6 mt-1 text-sm text-muted-foreground">
					{forced
						? "Entraste con una contraseña temporal que te dio tu administrador. Elige una nueva que solo tú conozcas."
						: "Elige una contraseña nueva para tu cuenta."}
				</p>
				<p className="mb-6 text-sm">
					<span className="text-muted-foreground">Cuenta: </span>
					<span className="font-medium">{user.email}</span>
				</p>

				{changed && !forced
					? (
						<Alert className="mb-4">
							<CheckCircle2 />
							<AlertDescription>Tu contraseña se cambió.</AlertDescription>
						</Alert>
					)
					: null}

				<ChangePasswordForm forced={forced} />

				<div className="mt-6 flex items-center justify-between text-sm">
					{forced
						? <span />
						: <Link href="/" className="text-primary underline-offset-4 hover:underline">Volver</Link>}
					<form action={logout}>
						<Button type="submit" variant="ghost" size="sm">
							<LogOut />
							Cerrar sesión
						</Button>
					</form>
				</div>
			</div>
		</div>
	);
}
