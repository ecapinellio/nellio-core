"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

/** Customer tracking link (spec §10). Without an email nothing is sent, so the operator shares it by WhatsApp. */
export function TrackingLink({ token, customerEmail }: { token: string; customerEmail: string | null })
{
	const [copied, setCopied] = useState(false);
	const [failed, setFailed] = useState(false);
	const url = `${window.location.origin}/t/${token}`;

	async function copy()
	{
		try
		{
			await navigator.clipboard.writeText(url);
			setFailed(false);
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
		catch
		{
			setFailed(true);
		}
	}

	return (
		<div className="flex flex-col gap-2 border-t border-border pt-3">
			<Label>Seguimiento del cliente</Label>
			<p className="text-xs text-muted-foreground">
				{customerEmail
					? `Le avisamos por correo a ${customerEmail} en cada paso.`
					: "Sin correo: comparte el link por WhatsApp."}
			</p>
			<div className="flex items-center gap-2">
				<Button variant="outline" className="h-11 md:h-9" onClick={copy}>
					{copied ? <Check /> : <Copy />}
					{copied ? "Copiado" : "Copiar link"}
				</Button>
				<a href={url} target="_blank" rel="noreferrer" className="text-sm text-primary underline-offset-4 hover:underline">
					Abrir
				</a>
			</div>
			{failed ? <p className="break-all font-mono text-xs">{url}</p> : null}
		</div>
	);
}
