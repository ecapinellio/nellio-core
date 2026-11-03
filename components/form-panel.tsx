"use client";

import { useRef, useSyncExternalStore } from "react";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetFooter, SheetHeader, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

// Tailwind's `md`, the breakpoint the rest of the shell switches at.
const DESKTOP_QUERY = "(min-width: 768px)";

function subscribe(onChange: () => void)
{
	const query = window.matchMedia(DESKTOP_QUERY);
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}

function useIsDesktop(): boolean
{
	return useSyncExternalStore(subscribe, () => window.matchMedia(DESKTOP_QUERY).matches, () => false);
}

/**
 * The one container for anything you fill in or read at length: creating a
 * user, an order's detail, editing a product or customer (DESIGN.md, 2026-11-03).
 * From the right on desktop with the list still visible behind it, from the
 * bottom on a phone where it's within thumb reach. Short blocking decisions
 * stay a centered Dialog.
 *
 * Children: FormPanelHeader, a `px-4` body, FormPanelFooter. Focus on open goes
 * to `[data-autofocus]`, else the first field on desktop; on a phone it stays
 * on the panel so the keyboard doesn't cover it as it slides up. `trigger`
 * gets focus back on close.
 */
export function FormPanel({
	open,
	onOpenChange,
	trigger,
	children,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	trigger?: React.ReactNode;
	children: React.ReactNode;
})
{
	const desktop = useIsDesktop();
	const content = useRef<HTMLDivElement>(null);

	function focusOnOpen(event: Event)
	{
		event.preventDefault();
		const panel = content.current;
		const target = panel?.querySelector<HTMLElement>("[data-autofocus]")
			?? (desktop ? panel?.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled])") : null);
		(target ?? panel)?.focus();
	}

	return (
		<Sheet open={open} onOpenChange={onOpenChange}>
			{trigger ? <SheetTrigger asChild>{trigger}</SheetTrigger> : null}
			<SheetContent
				ref={content}
				side={desktop ? "right" : "bottom"}
				showCloseButton={false}
				onOpenAutoFocus={focusOnOpen}
				className={cn(
					"gap-0 overflow-y-auto scroll-pt-16 scroll-pb-24 outline-none",
					desktop ? "data-[side=right]:w-full data-[side=right]:sm:max-w-140" : "max-h-[90dvh] rounded-t-lg",
				)}
			>
				{children}
			</SheetContent>
		</Sheet>
	);
}

/** Stays at the top while the body scrolls, with a close button big enough for a thumb. */
export function FormPanelHeader({ className, children, ...props }: React.ComponentProps<typeof SheetHeader>)
{
	return (
		<SheetHeader className={cn("sticky top-0 z-10 bg-popover pr-14", className)} {...props}>
			{children}
			<SheetClose asChild>
				<Button variant="ghost" size="icon" className="absolute top-1.5 right-1.5 size-11 md:top-2.5 md:right-2.5 md:size-8">
					<XIcon />
					<span className="sr-only">Cerrar</span>
				</Button>
			</SheetClose>
		</SheetHeader>
	);
}

/** Stays at the bottom while the body scrolls. Primary action first on a phone, last in a row on desktop. */
export function FormPanelFooter({ className, ...props }: React.ComponentProps<typeof SheetFooter>)
{
	return (
		<SheetFooter
			className={cn("sticky bottom-0 flex-col-reverse border-t border-border bg-popover md:flex-row md:justify-end", className)}
			{...props}
		/>
	);
}
