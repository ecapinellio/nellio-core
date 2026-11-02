"use client";

import { useEffect } from "react";

/**
 * Runs `refresh` when the user comes back: `visibilitychange` for tabs and
 * phone apps, `focus` for a window that was visible beside another one. Both
 * fire on a tab switch, so a run in progress drops the second. `refresh` must
 * be stable (useCallback).
 */
export function useRefreshOnReturn(refresh: () => Promise<void>): void
{
	useEffect(() =>
	{
		let running = false;

		async function run()
		{
			if (running || document.visibilityState !== "visible")
			{
				return;
			}
			running = true;
			try
			{
				await refresh();
			}
			finally
			{
				running = false;
			}
		}

		window.addEventListener("focus", run);
		document.addEventListener("visibilitychange", run);
		return () =>
		{
			window.removeEventListener("focus", run);
			document.removeEventListener("visibilitychange", run);
		};
	}, [refresh]);
}
