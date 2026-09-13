"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ListOrdered, PlusCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { isRouteAllowed } from "@/lib/rbac";

const navItems = [
	{ href: "/orders/capture", label: "Capturar pedido", icon: PlusCircle },
];

// role is the JWT-sourced app_metadata.role (see app/(app)/layout.tsx and
// lib/rbac.ts Decision 10) — never the users table column.
export function AppShellNav({ role }: { role: string | null | undefined })
{
	const pathname = usePathname();
	const visibleItems = navItems.filter(({ href }) => isRouteAllowed(href, role));
	const showOrdersPlaceholder = isRouteAllowed("/orders", role);

	return (
		<nav className="flex flex-col gap-0.5">
			{visibleItems.map(({ href, label, icon: Icon }) =>
			{
				const active = pathname === href;
				return (
					<Link
						key={href}
						href={href}
						className={cn(
							"flex items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium",
							active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted",
						)}
					>
						<Icon className="size-3.5" />
						{label}
					</Link>
				);
			})}

			{/* Lands in T6 — shown so the shell doesn't rearrange when it does. */}
			{showOrdersPlaceholder && (
				<div
					aria-disabled
					className="flex cursor-not-allowed items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground/50"
				>
					<ListOrdered className="size-3.5" />
					Pedidos
				</div>
			)}
		</nav>
	);
}
