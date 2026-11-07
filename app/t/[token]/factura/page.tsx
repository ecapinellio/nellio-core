import type { Metadata } from "next";
import { notFound } from "next/navigation";
import QRCode from "qrcode";
import { createClient } from "@/lib/supabase/server";
import { publicLookupUrl, type Environment } from "@/lib/dte/hacienda";
import { DEPARTMENTS, DISTRICTS, MUNICIPALITIES } from "@/lib/dte/places";
import { formatLocalTime } from "@/lib/notifications/email";
import { PrintButton } from "@/app/t/[token]/factura/print-button";

export const metadata: Metadata = { title: "Factura electrónica" };

interface Address { departamento: string; municipio: string; distrito: string; complemento: string }
interface Party
{
	nit?: string | null;
	nrc?: string | null;
	tipoDocumento?: string | null;
	numDocumento?: string | null;
	nombre: string | null;
	nombreComercial?: string | null;
	codActividad?: string | null;
	descActividad?: string | null;
	direccion: Address | null;
	telefono: string | null;
	correo: string | null;
}
interface Dte
{
	identificacion: { tipoDte: string; ambiente: Environment; numeroControl: string; codigoGeneracion: string; fecEmi: string; horEmi: string; tipoModelo: number; tipoOperacion: number };
	emisor: Party;
	receptor: Party | null;
	cuerpoDocumento: { numItem: number; cantidad: number; descripcion: string; precioUni: number; ventaGravada: number }[];
	resumen: {
		totalGravada: number; subTotal: number; totalPagar: number; totalLetras: string; condicionOperacion: number;
		totalIva?: number; tributos: { descripcion: string; valor: number }[] | null;
	};
}
interface Invoice
{
	status: "issued" | "invalidated";
	document: Dte;
	reception_seal: string;
	processed_at: string;
	invalidated_at: string | null;
}

const TITLES: Record<string, string> = { "01": "Factura", "03": "Comprobante de Crédito Fiscal" };
const DOC_TYPES: Record<string, string> = { "36": "NIT", "13": "DUI", "03": "Pasaporte", "02": "Carnet de residente", "37": "Otro" };
const CONDITIONS: Record<number, string> = { 1: "Contado", 2: "Crédito", 3: "Otro" };
const money = (n: number) => `$${n.toFixed(2)}`;

function placeName(a: Address): string
{
	const dep = DEPARTMENTS.find((d) => d.code === a.departamento)?.name;
	const mun = MUNICIPALITIES.find((m) => m.department === a.departamento && m.code === a.municipio)?.name;
	const dis = DISTRICTS.find((d) => d.department === a.departamento && d.code === a.distrito)?.name;
	return [a.complemento, dis, mun, dep].filter(Boolean).join(", ");
}

function PartyBlock({ title, p }: { title: string; p: Party | null })
{
	if (!p)
	{
		return (
			<section className="flex flex-col gap-1">
				<h2 className="text-xs font-semibold uppercase text-muted-foreground">{title}</h2>
				<p className="text-sm">Consumidor final</p>
			</section>
		);
	}
	const doc = p.nit ? `NIT ${p.nit}` : p.numDocumento ? `${DOC_TYPES[p.tipoDocumento ?? ""] ?? "Documento"} ${p.numDocumento}` : null;
	return (
		<section className="flex flex-col gap-0.5 text-sm">
			<h2 className="text-xs font-semibold uppercase text-muted-foreground">{title}</h2>
			<p className="font-medium">{p.nombre}</p>
			{p.nombreComercial ? <p>{p.nombreComercial}</p> : null}
			{doc || p.nrc ? <p className="font-mono tabular-nums">{[doc, p.nrc ? `NRC ${p.nrc}` : null].filter(Boolean).join(" · ")}</p> : null}
			{p.descActividad ? <p>{p.descActividad}</p> : null}
			{p.direccion ? <p>{placeName(p.direccion)}</p> : null}
			{p.telefono || p.correo ? <p>{[p.telefono, p.correo].filter(Boolean).join(" · ")}</p> : null}
		</section>
	);
}

// Public representación gráfica (no login, excluded in proxy.ts under t/):
// get_order_invoice() returns the issued DTE for the tracking token, or null.
export default async function InvoicePage({ params }: { params: Promise<{ token: string }> })
{
	const { token } = await params;
	const supabase = await createClient();
	const { data, error } = await supabase.rpc("get_order_invoice", { p_token: token });
	if (error)
	{
		throw new Error("No se pudo cargar la factura.");
	}
	if (!data)
	{
		notFound();
	}
	const inv = data as unknown as Invoice;
	const d = inv.document;
	const id = d.identificacion;
	const lookup = publicLookupUrl(id.ambiente, id.codigoGeneracion, id.fecEmi);
	const qr = await QRCode.toString(lookup, { type: "svg", margin: 0, width: 120 });

	return (
		<main className="mx-auto flex w-full max-w-[800px] flex-col gap-6 px-4 py-8 print:py-0">
			{inv.status === "invalidated"
				? <p role="alert" className="border-l-[3px] border-destructive bg-destructive/10 px-3 py-2 text-sm font-medium">Este documento fue invalidado ante Hacienda.</p>
				: null}
			{id.ambiente === "00"
				? <p className="border-l-[3px] border-amber-600 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900 dark:bg-amber-950 dark:text-amber-200">Ambiente de pruebas: sin validez fiscal.</p>
				: null}

			<header className="flex flex-wrap items-start justify-between gap-4">
				<div className="flex flex-col gap-1">
					<p className="text-xs font-medium text-muted-foreground">Documento Tributario Electrónico</p>
					<h1 className="text-xl font-semibold">{TITLES[id.tipoDte] ?? "DTE"}</h1>
				</div>
				{/* Safe: qrcode draws our own lookup URL as SVG paths, no user text in the markup. */}
				<div className="shrink-0 bg-white p-1" aria-label="Código QR para verificar en Hacienda" dangerouslySetInnerHTML={{ __html: qr }} />
			</header>

			<dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
				<dt className="text-muted-foreground">Código de generación</dt>
				<dd className="break-all font-mono tabular-nums">{id.codigoGeneracion}</dd>
				<dt className="text-muted-foreground">Número de control</dt>
				<dd className="break-all font-mono tabular-nums">{id.numeroControl}</dd>
				<dt className="text-muted-foreground">Sello de recepción</dt>
				<dd className="break-all font-mono tabular-nums">{inv.reception_seal}</dd>
				<dt className="text-muted-foreground">Fecha y hora de emisión</dt>
				<dd className="font-mono tabular-nums">{id.fecEmi} {id.horEmi}</dd>
				<dt className="text-muted-foreground">Modelo · transmisión</dt>
				<dd>{id.tipoModelo === 1 ? "Previo" : "Diferido"} · {id.tipoOperacion === 1 ? "Normal" : "Contingencia"}</dd>
				<dt className="text-muted-foreground">Condición</dt>
				<dd>{CONDITIONS[d.resumen.condicionOperacion] ?? "—"}</dd>
			</dl>

			<div className="grid gap-6 border-t border-border pt-4 sm:grid-cols-2">
				<PartyBlock title="Emisor" p={d.emisor} />
				<PartyBlock title="Receptor" p={d.receptor} />
			</div>

			<div className="overflow-x-auto border-t border-border pt-4">
				<table className="w-full text-sm">
					<thead>
						<tr className="text-left text-xs text-muted-foreground">
							<th className="py-1 pr-2 font-medium">#</th>
							<th className="py-1 pr-2 text-right font-medium">Cantidad</th>
							<th className="py-1 pr-2 font-medium">Descripción</th>
							<th className="py-1 pr-2 text-right font-medium">Precio unitario</th>
							<th className="py-1 text-right font-medium">Ventas gravadas</th>
						</tr>
					</thead>
					<tbody className="font-mono tabular-nums">
						{d.cuerpoDocumento.map((i) => (
							<tr key={i.numItem} className="border-t border-border">
								<td className="py-1 pr-2">{i.numItem}</td>
								<td className="py-1 pr-2 text-right">{i.cantidad}</td>
								<td className="py-1 pr-2 font-sans">{i.descripcion}</td>
								<td className="py-1 pr-2 text-right">{money(i.precioUni)}</td>
								<td className="py-1 text-right">{money(i.ventaGravada)}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<dl className="ml-auto grid w-full max-w-[320px] grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
				<dt>Sumas (ventas gravadas)</dt>
				<dd className="text-right font-mono tabular-nums">{money(d.resumen.totalGravada)}</dd>
				{(d.resumen.tributos ?? []).map((t) => (
					<div key={t.descripcion} className="contents">
						<dt>{t.descripcion}</dt>
						<dd className="text-right font-mono tabular-nums">{money(t.valor)}</dd>
					</div>
				))}
				{d.resumen.totalIva !== undefined
					? <><dt className="text-muted-foreground">IVA incluido</dt><dd className="text-right font-mono tabular-nums text-muted-foreground">{money(d.resumen.totalIva)}</dd></>
					: null}
				<dt className="font-semibold">Total a pagar</dt>
				<dd className="text-right font-mono font-semibold tabular-nums">{money(d.resumen.totalPagar)}</dd>
			</dl>
			<p className="text-sm">{d.resumen.totalLetras}</p>

			<footer className="flex flex-col gap-3 border-t border-border pt-4 text-xs text-muted-foreground">
				<p>Procesado por Hacienda el {formatLocalTime(inv.processed_at)}. Verifícalo en <a href={lookup} className="break-all text-primary underline-offset-4 hover:underline">{lookup}</a></p>
				<PrintButton />
			</footer>
		</main>
	);
}
