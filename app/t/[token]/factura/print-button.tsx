"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Browser print → "Guardar como PDF" is the PDF (spec D12). */
export function PrintButton()
{
	return (
		<Button variant="outline" className="h-11 self-start md:h-9 print:hidden" onClick={() => window.print()}>
			<Printer />Imprimir o guardar PDF
		</Button>
	);
}
