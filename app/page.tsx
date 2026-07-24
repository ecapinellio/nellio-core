import { redirect } from "next/navigation";
import { LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { logout } from "@/lib/auth/actions";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";

export default async function Home()
{
	const supabase = await createClient();
	const { data: { user } } = await supabase.auth.getUser();

	// Belt-and-suspenders: middleware already gates this route, but a Server
	// Component shouldn't assume the caller is authenticated.
	if (!user)
	{
		redirect("/login");
	}

	const { data: profile } = await supabase
		.from("users")
		.select("name, role, tenants(name)")
		.eq("id", user.id)
		.single();

	return (
		<div className="flex min-h-screen flex-col">
			<header className="flex h-13 items-center justify-between border-b border-border px-6">
				<div className="flex items-center text-sm font-bold tracking-tight">
					<span className="mr-2 inline-block size-1.5 rounded-full bg-primary" />
					Nellio Core
				</div>
				<form action={logout}>
					<Button type="submit" variant="ghost" size="sm">
						<LogOut />
						Cerrar sesión
					</Button>
				</form>
			</header>

			<main className="flex flex-1 items-center justify-center bg-background p-8">
				<Card className="w-full max-w-sm">
					<CardHeader>
						<CardTitle>Sesión iniciada</CardTitle>
						<CardDescription>
							{profile?.name ?? user.email} · {profile?.role ?? "sin rol"}
						</CardDescription>
					</CardHeader>
					<CardContent className="text-sm text-muted-foreground">
						{profile?.tenants?.name ?? "—"}
					</CardContent>
				</Card>
			</main>
		</div>
	);
}
