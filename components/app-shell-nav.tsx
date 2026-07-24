"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ListOrdered, PlusCircle } from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
	{ href: "/orders/capture", label: "Capturar pedido", icon: PlusCircle },
];

export function AppShellNav()
{
	const pathname = usePathname();

	return (
		<nav className="flex flex-col gap-0.5">
			{navItems.map(({ href, label, icon: Icon }) =>
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
			<div
				aria-disabled
				className="flex cursor-not-allowed items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground/50"
			>
				<ListOrdered className="size-3.5" />
				Pedidos
			</div>
		</nav>
	);
}
