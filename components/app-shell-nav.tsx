"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Boxes, Building2, FileWarning, History, Landmark, ListOrdered, Package, PlusCircle, Truck, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { isRouteAllowed } from "@/lib/rbac";

const navItems = [
	{ href: "/deliveries", label: "Entregas", icon: Truck },
	{ href: "/orders/capture", label: "Capturar pedido", icon: PlusCircle },
	{ href: "/orders", label: "Pedidos", icon: ListOrdered },
	{ href: "/orders/historial", label: "Mis pedidos", icon: History },
	{ href: "/orders/facturas", label: "Facturas pendientes", icon: FileWarning },
	{ href: "/products", label: "Productos", icon: Package },
	{ href: "/inventory", label: "Inventario", icon: Boxes },
	{ href: "/customers", label: "Clientes", icon: Building2 },
	{ href: "/admin/users", label: "Usuarios", icon: Users },
	{ href: "/admin/company", label: "Empresa", icon: Landmark },
];

// role is the JWT-sourced app_metadata.role (see app/(app)/layout.tsx and
// lib/rbac.ts Decision 10) — never the users table column.
//
// "drawer" is the phone menu (components/mobile-nav.tsx): 44px rows so each
// item is a comfortable thumb target, and onNavigate closes the drawer.
export function AppShellNav({
	role,
	variant = "sidebar",
	onNavigate,
}: {
	role: string | null | undefined;
	variant?: "sidebar" | "drawer";
	onNavigate?: () => void;
})
{
	const pathname = usePathname();
	const visibleItems = navItems.filter(({ href }) => isRouteAllowed(href, role));

	return (
		<nav className="flex flex-col gap-0.5">
			{visibleItems.map(({ href, label, icon: Icon }) =>
			{
				const active = pathname === href;
				return (
					<Link
						key={href}
						href={href}
						onClick={onNavigate}
						aria-current={active ? "page" : undefined}
						className={cn(
							"flex items-center gap-2 rounded-md px-2 text-sm font-medium",
							variant === "drawer" ? "h-11" : "py-1.5",
							active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-muted",
						)}
					>
						<Icon className={variant === "drawer" ? "size-4" : "size-3.5"} />
						{label}
					</Link>
				);
			})}
		</nav>
	);
}
