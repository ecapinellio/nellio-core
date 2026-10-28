"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Asks before leaving the page while `active`. App Router has no
 * route-change event to block, so this covers every exit by hand:
 * tab close/reload (beforeunload), in-app links (capture-phase click), and
 * forms marked `data-leave-guard` (the header's "Cerrar sesión" is a Server
 * Action form whose redirect never fires beforeunload). Browser back/forward
 * isn't covered — see TODOS.md.
 */
export function useLeaveGuard(active: boolean, message: string)
{
	const router = useRouter();

	useEffect(() =>
	{
		if (!active)
		{
			return;
		}

		function handleBeforeUnload(e: BeforeUnloadEvent)
		{
			e.preventDefault();
			e.returnValue = "";
		}

		function handleClick(e: MouseEvent)
		{
			// Modified/middle clicks and target=_blank open a new tab — this
			// page stays put, so there's nothing to guard.
			if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
			{
				return;
			}
			const anchor = (e.target as HTMLElement).closest("a");
			if (!anchor || anchor.target === "_blank")
			{
				return;
			}
			const href = anchor.getAttribute("href");
			if (!href || href.startsWith("#"))
			{
				return;
			}
			e.preventDefault();
			e.stopPropagation();
			if (window.confirm(message))
			{
				router.push(href);
			}
		}

		function handleSubmit(e: SubmitEvent)
		{
			// Only forms that leave the page opt in (data-leave-guard, e.g. the
			// header's logout) — otherwise this would also block the page's own
			// save forms, like the catalog's phone edit sheet.
			if (!(e.target as HTMLElement).closest("[data-leave-guard]"))
			{
				return;
			}
			if (!window.confirm(message))
			{
				e.preventDefault();
				e.stopPropagation();
			}
		}

		window.addEventListener("beforeunload", handleBeforeUnload);
		document.addEventListener("click", handleClick, true);
		document.addEventListener("submit", handleSubmit, true);
		return () =>
		{
			window.removeEventListener("beforeunload", handleBeforeUnload);
			document.removeEventListener("click", handleClick, true);
			document.removeEventListener("submit", handleSubmit, true);
		};
	}, [active, message, router]);
}
