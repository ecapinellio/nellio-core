"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Loader2, Plus, Search } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import type { QueryResult } from "@/lib/supabase/queries";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface EntitySearchProps<T>
{
	supabase: SupabaseClient<Database>;
	placeholder: string;
	searchFn: (supabase: SupabaseClient<Database>, query: string, limit?: number) => Promise<QueryResult<T[]>>;
	quickAddFn: (supabase: SupabaseClient<Database>, name: string) => Promise<QueryResult<T>>;
	getLabel: (item: T) => string;
	getId: (item: T) => string;
	onSelect: (item: T) => void;
	quickAddNoun: string;
	autoFocus?: boolean;
}

/**
 * Debounced remote search with inline quick-add (eng-review decision 2, 4,
 * 8). Always behaves as a repeatable picker — clears itself after a
 * selection and fires onSelect — so both single-select (customer) and
 * repeat-add (line items) call sites can reuse the same search/fetch/
 * keyboard logic and just differ in what they do with onSelect.
 */
export function EntitySearch<T>({
	supabase,
	placeholder,
	searchFn,
	quickAddFn,
	getLabel,
	getId,
	onSelect,
	quickAddNoun,
	autoFocus,
}: EntitySearchProps<T>)
{
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const [results, setResults] = useState<T[]>([]);
	const [status, setStatus] = useState<"idle" | "loading" | "error" | "done">("idle");
	const [adding, setAdding] = useState(false);
	const [retryNonce, setRetryNonce] = useState(0);
	const requestToken = useRef(0);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const [panelRect, setPanelRect] = useState<{ top: number; left: number; width: number } | null>(null);

	const debouncedQuery = useDebouncedValue(query.trim());

	useEffect(() =>
	{
		// Nothing to reset here: showPanel already hides stale results/status
		// while the query is empty, and the next non-empty query overwrites
		// both anyway — so there's no setState to fire on this branch.
		if (!debouncedQuery)
		{
			return;
		}

		const token = ++requestToken.current;
		// The "set loading, then fetch, then set result in the callback" shape
		// is the documented React pattern for effect-driven data fetching —
		// this rule flags the synchronous half of it regardless.
		// eslint-disable-next-line react-hooks/set-state-in-effect
		setStatus("loading");

		searchFn(supabase, debouncedQuery, 8).then(({ data, error }) =>
		{
			if (token !== requestToken.current)
			{
				return;
			}
			if (error)
			{
				setStatus("error");
				return;
			}
			setResults(data ?? []);
			setStatus("done");
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [debouncedQuery, supabase, retryNonce]);

	const showPanel = open && debouncedQuery.length > 0;

	// The dropdown is portaled to document.body (see the render below) — Card
	// (components/ui/card.tsx) has `overflow-hidden` baked into its default
	// className, which clipped this panel whenever it extended past the
	// card's bottom edge (both call sites — customer search and the product
	// search inside LineItems — render inside a Card). Portaling means this
	// effect has to track the input's position itself instead of relying on
	// `position: absolute` within a `position: relative` ancestor.
	useEffect(() =>
	{
		if (!showPanel)
		{
			return;
		}

		function updateRect()
		{
			const rect = wrapperRef.current?.getBoundingClientRect();
			if (rect)
			{
				setPanelRect({ top: rect.bottom, left: rect.left, width: rect.width });
			}
		}

		updateRect();
		window.addEventListener("scroll", updateRect, true);
		window.addEventListener("resize", updateRect);
		return () =>
		{
			window.removeEventListener("scroll", updateRect, true);
			window.removeEventListener("resize", updateRect);
		};
	}, [showPanel]);

	async function handleQuickAdd()
	{
		const name = query.trim();
		if (!name || adding)
		{
			return;
		}
		setAdding(true);
		const { data, error } = await quickAddFn(supabase, name);
		setAdding(false);
		if (error || !data)
		{
			setStatus("error");
			return;
		}
		select(data);
	}

	function select(item: T)
	{
		onSelect(item);
		setQuery("");
		setResults([]);
		setStatus("idle");
		setOpen(false);
	}

	function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>)
	{
		if (e.key === "Escape")
		{
			setOpen(false);
			return;
		}
		if (e.key === "Enter")
		{
			e.preventDefault();
			if (results.length > 0)
			{
				select(results[0]);
			}
			else if (status === "done" && query.trim())
			{
				handleQuickAdd();
			}
		}
	}

	return (
		<div ref={wrapperRef} className="relative">
			<Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
			<Input
				value={query}
				onChange={(e) =>
				{
					setQuery(e.target.value);
					setOpen(true);
				}}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
				onKeyDown={handleKeyDown}
				placeholder={placeholder}
				autoFocus={autoFocus}
				className="pl-8"
			/>
			{status === "loading" || adding
				? <Loader2 className="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground" />
				: null}

			{showPanel && panelRect
				? createPortal(
					<div
						className="fixed z-20 mt-1 rounded-md border border-border bg-popover p-1 shadow-md"
						style={{ top: panelRect.top, left: panelRect.left, width: panelRect.width }}
					>
						{status === "error"
							? (
								<div className="flex items-center justify-between gap-2 p-2 text-xs">
									<span className="text-destructive">No se pudo buscar.</span>
									<button
										type="button"
										onMouseDown={(e) => e.preventDefault()}
										onClick={() => setRetryNonce((n) => n + 1)}
										className="font-medium text-primary hover:underline"
									>
										Reintentar
									</button>
								</div>
							)
							: null}

						{status === "done" && results.length === 0
							? (
								<button
									type="button"
									onMouseDown={(e) => e.preventDefault()}
									onClick={handleQuickAdd}
									disabled={adding}
									className="flex w-full items-center gap-2 rounded-sm p-2 text-left text-xs font-medium text-accent-foreground hover:bg-accent"
								>
									<Plus className="size-3.5 shrink-0" />
									Agregar &ldquo;{query.trim()}&rdquo; como nuevo {quickAddNoun}
								</button>
							)
							: null}

						{results.map((item) => (
							<button
								key={getId(item)}
								type="button"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => select(item)}
								className={cn(
									"flex w-full items-center justify-between rounded-sm p-2 text-left text-sm hover:bg-accent",
								)}
							>
								<span className="font-medium">{getLabel(item)}</span>
							</button>
						))}
					</div>,
					document.body,
				)
				: null}
		</div>
	);
}
