import { redirect } from "next/navigation";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { AppShellNav } from "@/components/app-shell-nav";
import { MobileNav } from "@/components/mobile-nav";

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

	const role = user.app_metadata.role;
	const tenantName = profile?.tenants?.name ?? "—";
	const userName = profile?.name ?? user.email ?? "";

	// Below md the sidebar is replaced by MobileNav's drawer, so content gets
	// the full phone width (DESIGN.md — Shell).
	return (
		<div className="flex min-h-screen">
			<aside className="hidden w-52 shrink-0 flex-col border-r border-border bg-card p-2 md:flex">
				<div className="flex items-center px-2 pb-4 pt-1 text-sm font-bold tracking-tight">
					<span className="mr-2 inline-block size-1.5 rounded-full bg-primary" />
					Nellio Core
				</div>
				<AppShellNav role={role} />
			</aside>

			<div className="flex min-w-0 flex-1 flex-col">
				<header className="flex h-13 items-center justify-between gap-2 border-b border-border pl-1 pr-2 md:px-6">
					<div className="flex min-w-0 items-center gap-1">
						<MobileNav role={role} tenantName={tenantName} userName={userName} />
						<span className="text-sm font-bold tracking-tight md:hidden">Nellio Core</span>
						<span className="hidden text-sm text-muted-foreground md:inline">{tenantName}</span>
					</div>
					<div className="flex items-center gap-3">
						<span className="hidden text-sm text-muted-foreground md:inline">{userName}</span>
						<form action={logout}>
							<Button type="submit" variant="ghost" size="sm" className="max-md:size-11" aria-label="Cerrar sesión">
								<LogOut />
								<span className="hidden md:inline">Cerrar sesión</span>
							</Button>
						</form>
					</div>
				</header>

				<main className="flex-1 bg-background p-4 md:p-6">{children}</main>
			</div>
		</div>
	);
}
