"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Copy } from "lucide-react";
import type { Credentials } from "@/app/(app)/admin/users/actions";
import { roleLabel } from "@/lib/users/role-labels";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";

const LEAVE_WARNING =
	"No copiaste la contraseña. Si sales, se pierde y tendrás que restablecerla. ¿Salir de todas formas?";

/**
 * The generated password is shown exactly once and never stored (slice 2
 * design Decision 19). While it hasn't been copied this guards every way
 * out of the page: tab close/reload (beforeunload), in-app links (capture-
 * phase click — the dialog overlay already blocks most of them), and form
 * submits (the header's "Cerrar sesión" is a Server Action form whose
 * redirect never fires beforeunload).
 */
function useLeaveGuard(active: boolean)
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
			// page (and the password) stays put, so there's nothing to guard.
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
			if (window.confirm(LEAVE_WARNING))
			{
				router.push(href);
			}
		}

		function handleSubmit(e: SubmitEvent)
		{
			if (!window.confirm(LEAVE_WARNING))
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
	}, [active, router]);
}

/**
 * The one place a generated password is ever shown — after creating,
 * restoring or reactivating a user (design review D2). Titled with the
 * person's name so an owner reading it out over the phone can't give the
 * wrong one. Can't be dismissed (Esc, outside click) until copied; "Listo"
 * asks first if it wasn't.
 */
export function OneTimePasswordDialog({
	credentials,
	onClose,
}: {
	credentials: Credentials | null;
	onClose: () => void;
})
{
	const [copied, setCopied] = useState(false);
	const [justCopied, setJustCopied] = useState(false);
	const [copyError, setCopyError] = useState(false);
	const copyButtonRef = useRef<HTMLButtonElement>(null);

	// Fresh state per password — the dialog stays mounted between uses.
	// Reset during render, not in an effect (react.dev: "adjusting state
	// when a prop changes"), so a new password never renders as "copied".
	const [shownFor, setShownFor] = useState(credentials);
	if (credentials !== shownFor)
	{
		setShownFor(credentials);
		setCopied(false);
		setJustCopied(false);
		setCopyError(false);
	}

	useLeaveGuard(credentials !== null && !copied);

	function requestClose()
	{
		if (!copied && !window.confirm(LEAVE_WARNING))
		{
			return;
		}
		onClose();
	}

	async function handleCopy()
	{
		if (!credentials)
		{
			return;
		}
		try
		{
			await navigator.clipboard.writeText(credentials.password);
			setCopied(true);
			setCopyError(false);
			setJustCopied(true);
			setTimeout(() => setJustCopied(false), 2000);
		}
		catch
		{
			setCopyError(true);
		}
	}

	function blockUntilCopied(e: Event)
	{
		if (!copied)
		{
			e.preventDefault();
		}
	}

	return (
		<Dialog open={credentials !== null} onOpenChange={(open) => { if (!open) requestClose(); }}>
			<DialogContent
				showCloseButton={false}
				className="sm:max-w-md"
				onEscapeKeyDown={blockUntilCopied}
				onInteractOutside={blockUntilCopied}
				onOpenAutoFocus={(e) =>
				{
					// Design D12: land keyboard/screen-reader users on the one
					// element that matters, not the first focusable thing.
					e.preventDefault();
					copyButtonRef.current?.focus();
				}}
			>
				{credentials
					? (
						<>
							<DialogHeader>
								<DialogTitle>Contraseña nueva para {credentials.name}</DialogTitle>
								<DialogDescription>
									{credentials.email} · {roleLabel(credentials.role)}
								</DialogDescription>
							</DialogHeader>

							<div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-2.5">
								<span className="flex-1 select-all break-all font-mono text-base font-semibold tabular-nums">
									{credentials.password}
								</span>
								<Button
									ref={copyButtonRef}
									type="button"
									variant={copied ? "secondary" : "default"}
									size="sm"
									onClick={handleCopy}
								>
									{justCopied ? <Check /> : <Copy />}
									{justCopied ? "Copiado" : "Copiar"}
								</Button>
							</div>
							<span className="sr-only" aria-live="polite">{justCopied ? "Contraseña copiada" : ""}</span>

							{copyError
								? (
									<Alert variant="destructive">
										<AlertTriangle />
										<AlertDescription>No se pudo copiar automáticamente. Selecciona el texto.</AlertDescription>
									</Alert>
								)
								: null}

							{!copied
								? (
									<Alert variant="destructive">
										<AlertTriangle />
										<AlertDescription>Cópiala antes de cerrar: no se puede volver a ver.</AlertDescription>
									</Alert>
								)
								: null}

							<DialogFooter>
								<Button type="button" variant="secondary" onClick={requestClose}>Listo</Button>
							</DialogFooter>
						</>
					)
					: null}
			</DialogContent>
		</Dialog>
	);
}
