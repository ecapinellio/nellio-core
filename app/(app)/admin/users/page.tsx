import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AlertTriangle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { listTenantUsers } from "@/lib/users/list-users";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { UsersManager } from "@/components/admin/users-manager";

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
	// Actions' own explicit role check (ADR-006).
	if (!user || user.app_metadata.role !== "admin")
	{
		redirect("/");
	}

	const { data: users, error } = await listTenantUsers(supabase);

	if (error || !users)
	{
		// D9: the list failing shouldn't look like an empty team.
		return (
			<div className="flex max-w-[1280px] flex-col gap-4">
				<h1 className="text-xl font-semibold tracking-tight">Usuarios</h1>
				<Alert variant="destructive">
					<AlertTriangle />
					<AlertDescription>No se pudo cargar la lista. Recarga la página.</AlertDescription>
				</Alert>
			</div>
		);
	}

	return <UsersManager users={users} currentUserId={user.id} />;
}
