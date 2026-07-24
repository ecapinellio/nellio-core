import type { Metadata } from "next";
import { CaptureForm } from "@/components/capture/capture-form";

export const metadata: Metadata = {
	title: "Capturar pedido — Nellio Core",
};

export default function CaptureOrderPage()
{
	return (
		<div className="flex flex-col gap-4">
			<div>
				<h1 className="text-xl font-semibold tracking-tight">Capturar pedido</h1>
				<p className="text-sm text-muted-foreground">Transcribe un pedido de WhatsApp a un pedido estructurado.</p>
			</div>
			<CaptureForm />
		</div>
	);
}
