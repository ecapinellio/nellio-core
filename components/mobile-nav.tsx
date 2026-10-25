"use client";

import { useState } from "react";
import { Menu } from "lucide-react";
import { AppShellNav } from "@/components/app-shell-nav";
import { Button } from "@/components/ui/button";
import {
	Sheet,
	SheetContent,
	SheetDescription,
	SheetFooter,
	SheetHeader,
	SheetTitle,
	SheetTrigger,
} from "@/components/ui/sheet";

/**
 * Phone-width replacement for the fixed sidebar (below md, 768px): a ☰
 * button that slides the same nav in from the left. Closes on navigation
 * so the new page isn't hidden behind it.
 */
export function MobileNav({
	role,
	tenantName,
	userName,
}: {
	role: string | null | undefined;
	tenantName: string;
	userName: string;
})
{
	const [open, setOpen] = useState(false);

	return (
		<Sheet open={open} onOpenChange={setOpen}>
			<SheetTrigger asChild>
				<Button type="button" variant="ghost" size="icon" className="size-11 md:hidden" aria-label="Abrir menú">
					<Menu />
				</Button>
			</SheetTrigger>
			<SheetContent side="left" className="gap-0 p-2">
				<SheetHeader className="px-2 pb-4 pt-3">
					<SheetTitle className="flex items-center text-sm font-bold tracking-tight">
						<span className="mr-2 inline-block size-1.5 rounded-full bg-primary" />
						Nellio Core
					</SheetTitle>
					<SheetDescription className="sr-only">Menú de navegación</SheetDescription>
				</SheetHeader>
				<AppShellNav role={role} variant="drawer" onNavigate={() => setOpen(false)} />
				<SheetFooter className="gap-0.5 border-t border-border px-2 pt-3">
					<div className="text-sm font-medium">{userName}</div>
					<div className="text-sm text-muted-foreground">{tenantName}</div>
				</SheetFooter>
			</SheetContent>
		</Sheet>
	);
}
