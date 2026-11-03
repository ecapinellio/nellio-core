"use client";

import { useSyncExternalStore } from "react";
import { Sheet, SheetContent, SheetFooter } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

const DESKTOP_QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void)
{
	const query = window.matchMedia(DESKTOP_QUERY);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

/** md and up, the same breakpoint as the rest of the shell. */
function useIsDesktop(): boolean
{
	return useSyncExternalStore(subscribe, () => window.matchMedia(DESKTOP_QUERY).matches, () => false);
}

/**
 * The one container for anything you fill in or read at length: creating a
 * user, an order's detail, editing a product or customer (DESIGN.md, 2026-11-03).
 * From the right on desktop so the list stays in view, from the bottom on a
 * phone where it's within thumb reach. Short blocking decisions stay a
 * centered Dialog.
 *
 * Children use SheetHeader/SheetTitle/SheetDescription, a `px-4` body and
 * FormPanelFooter.
 */
export function FormPanel({
	open,
	onOpenChange,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	children: React.ReactNode;
})
{
	const desktop = useIsDesktop();
	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			<SheetContent
				side={desktop ? "right" : "bottom"}
				className={cn(
					"gap-0 overflow-y-auto",
					desktop ? "data-[side=right]:w-full data-[side=right]:sm:max-w-140" : "max-h-[90vh] rounded-t-lg",
				)}
			>
				{children}
			</SheetContent>
		</Sheet>
	);
}

/** Stays at the bottom of the panel while the body scrolls. */
export function FormPanelFooter({ className, ...props }: React.ComponentProps<typeof SheetFooter>)
{
	return <SheetFooter className={cn("sticky bottom-0 border-t border-border bg-popover", className)} {...props} />;
}
