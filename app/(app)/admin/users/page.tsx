import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { CreateUserForm } from "@/components/admin/create-user-form";

export const metadata: Metadata = {
	title: "Usuarios — Nellio Core",
};

export default async function AdminUsersPage()
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();

	// Belt-and-suspenders (same pattern as app/(app)/layout.tsx): lib/rbac.ts's
	// /admin route rule is the real route-level gate, but this page doesn't
	// assume the caller already passed it — same principle as the Server
	// Action's own explicit role check (ADR-006).
	if (!user || user.app_metadata.role !== "admin")
	{
		redirect("/");
	}

	return (
		<div className="flex flex-col gap-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Usuarios</h1>
				<p className="text-sm text-muted-foreground">Crea cuentas de operador o driver.</p>
			</div>
			<CreateUserForm />
		</div>
	);
}
