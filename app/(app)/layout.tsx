import { redirect } from "next/navigation";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { AppShellNav } from "@/components/app-shell-nav";

export default async function AppLayout({ children }: { children: React.ReactNode })
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();

	// Belt-and-suspenders: proxy.ts already gates this route, but a Server
	// Component shouldn't assume the caller is authenticated.
	if (!user)
	{
		redirect("/login");
	}

	// role for access/nav decisions comes from the JWT (app_metadata), never
	// from this query — see lib/rbac.ts and Decision 10 in the T8 plan.
	const { data: profile } = await supabase
		.from("users")
		.select("name, tenants(name)")
		.eq("id", user.id)
		.single();

	return (
		<div className="flex min-h-screen">
			<aside className="flex w-52 shrink-0 flex-col border-r border-border bg-card p-2">
				<div className="flex items-center px-2 pb-4 pt-1 text-sm font-bold tracking-tight">
					<span className="mr-2 inline-block size-1.5 rounded-full bg-primary" />
					Nellio Core
				</div>
				<AppShellNav role={user.app_metadata.role} />
			</aside>

			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex h-13 items-center justify-between border-b border-border px-6">
					<div className="text-sm text-muted-foreground">{profile?.tenants?.name ?? "—"}</div>
					<div className="flex items-center gap-3">
						<span className="text-sm text-muted-foreground">{profile?.name ?? user.email}</span>
						<form action={logout}>
							<Button type="submit" variant="ghost" size="sm">
								<LogOut />
								Cerrar sesión
							</Button>
						</form>
					</div>
				</header>

				<main className="flex-1 bg-background p-6">{children}</main>
			</div>
		</div>
	);
}
