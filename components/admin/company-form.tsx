"use client";

import { useMemo, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";
import { formatOrderTimestamp } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PlaceFields, type PlaceField } from "@/components/place-fields";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Tenant = Database["public"]["Tables"]["tenants"]["Row"];

const TEXT_FIELDS = [
	{ key: "legal_name", label: "Razón social", placeholder: "Ecología Técnica, S.A. de C.V." },
	{ key: "commercial_name", label: "Nombre comercial", placeholder: "ECTEC" },
	{ key: "nit", label: "NIT", placeholder: "0614-010190-101-1", mono: true },
	{ key: "nrc", label: "NRC", placeholder: "123456-7", mono: true },
	{ key: "cod_actividad", label: "Código de actividad", placeholder: "46900", mono: true },
	{ key: "desc_actividad", label: "Giro", placeholder: "Venta al por mayor de productos químicos" },
	{ key: "address", label: "Dirección", placeholder: "Calle El Progreso 123, Colonia Escalón" },
	{ key: "phone", label: "Teléfono", placeholder: "2222-3333" },
	{ key: "email", label: "Correo", placeholder: "facturas@empresa.com.sv" },
] as const;

const CODE_FIELDS = [
	{ key: "establishment_code", label: "Establecimiento", placeholder: "M001", hint: "Tuyo: M, B, S o P + 3 números" },
	{ key: "pos_code", label: "Punto de venta", placeholder: "P001", hint: "Tuyo: P + 3 números" },
	{ key: "mh_establishment_code", label: "Establecimiento (Hacienda)", placeholder: "0001", hint: "El que asignó Hacienda" },
	{ key: "mh_pos_code", label: "Punto de venta (Hacienda)", placeholder: "0001", hint: "El que asignó Hacienda" },
] as const;

const ENV_LABEL: Record<string, string> = { "00": "Pruebas", "01": "Producción" };

type TextKey = (typeof TEXT_FIELDS)[number]["key"] | (typeof CODE_FIELDS)[number]["key"] | PlaceField;

export interface CredentialStatus
{
	configured: boolean;
	updated_at: string | null;
	environment: string | null;
}

/**
 * The emisor data for the DTE plus Hacienda's credentials (ADR-015). The
 * credentials are written to Supabase Vault and never come back: the screen
 * only knows whether they exist.
 */
export function CompanyForm({ tenant, credentials }: {
	tenant: Tenant;
	credentials: CredentialStatus;
})
{
	const supabase = useMemo(() => createClient(), []);
	const [values, setValues] = useState<Record<TextKey, string>>(() =>
		Object.fromEntries([...TEXT_FIELDS, ...CODE_FIELDS].map((f) => [f.key, tenant[f.key] ?? ""])
			.concat([["department_code", tenant.department_code ?? ""], ["municipality_code", tenant.municipality_code ?? ""],
				["district_code", tenant.district_code ?? ""]])) as Record<TextKey, string>);
	const [vatIncluded, setVatIncluded] = useState(tenant.prices_include_vat);
	const [environment, setEnvironment] = useState(tenant.dte_environment);
	const [savedEnvironment, setSavedEnvironment] = useState(tenant.dte_environment);
	const [confirmingProduction, setConfirmingProduction] = useState(false);
	const [enabled, setEnabled] = useState(tenant.dte_enabled);
	const [saving, setSaving] = useState(false);
	const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

	const [cert, setCert] = useState<string | null>(null);
	const [certName, setCertName] = useState("");
	const [keyPassword, setKeyPassword] = useState("");
	const [apiPassword, setApiPassword] = useState("");
	const [credStatus, setCredStatus] = useState(credentials);
	const [credSaving, setCredSaving] = useState(false);
	const [credMessage, setCredMessage] = useState<{ ok: boolean; text: string } | null>(null);

	const set = (key: TextKey, value: string) => setValues((v) => ({ ...v, [key]: value }));

	async function save(e: React.FormEvent)
	{
		e.preventDefault();
		setSaving(true);
		setMessage(null);
		const { error } = await supabase.rpc("save_company_fiscal", {
			p_data: { ...values, prices_include_vat: vatIncluded, dte_environment: environment, dte_enabled: enabled },
		});
		setSaving(false);
		if (!error)
		{
			setSavedEnvironment(environment);
		}
		setMessage(error ? { ok: false, text: error.message } : { ok: true, text: "Guardado." });
	}

	async function saveCredentials(e: React.FormEvent)
	{
		e.preventDefault();
		setCredSaving(true);
		setCredMessage(null);
		const { error } = await supabase.rpc("set_dte_credentials", {
			p_certificate: cert as string,
			p_key_password: keyPassword || null as unknown as string,
			p_api_password: apiPassword || null as unknown as string,
		});
		setCredSaving(false);
		if (error)
		{
			setCredMessage({ ok: false, text: error.message });
			return;
		}
		setCert(null);
		setCertName("");
		setKeyPassword("");
		setApiPassword("");
		setCredStatus({ configured: true, updated_at: new Date().toISOString(), environment: savedEnvironment });
		setCredMessage({ ok: true, text: "Credenciales guardadas." });
	}

	return (
		<div className="flex max-w-[560px] flex-col gap-8">
			<div className="flex flex-col gap-1">
				<h1 className="text-xl font-semibold tracking-tight">Empresa</h1>
				<p className="text-sm text-muted-foreground">Datos del emisor de la factura electrónica (DTE) que se envía a Hacienda al entregar un pedido.</p>
			</div>

			<form onSubmit={save} noValidate className="flex flex-col gap-4">
				<h2 className="text-base font-semibold">Datos fiscales</h2>
				{TEXT_FIELDS.map((f) => (
					<div key={f.key} className="flex flex-col gap-1.5">
						<Label htmlFor={`co-${f.key}`}>{f.label}</Label>
						<Input id={`co-${f.key}`} value={values[f.key]} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder}
							className={`h-11 md:h-9 ${"mono" in f ? "font-mono tabular-nums" : ""}`} />
					</div>
				))}
				<PlaceFields values={values} onChange={set} idPrefix="co" />

				<div className="grid grid-cols-2 gap-4">
					{CODE_FIELDS.map((f) => (
						<div key={f.key} className="flex flex-col gap-1.5">
							<Label htmlFor={`co-${f.key}`}>{f.label}</Label>
							<Input id={`co-${f.key}`} value={values[f.key]} onChange={(e) => set(f.key, e.target.value.toUpperCase())}
								placeholder={f.placeholder} maxLength={4} className="h-11 font-mono tabular-nums md:h-9" />
							<p className="text-xs text-muted-foreground">{f.hint}</p>
						</div>
					))}
				</div>

				<h2 className="pt-2 text-base font-semibold">Facturación</h2>
				<label className="flex min-h-11 items-start gap-3 text-sm">
					<input type="checkbox" checked={vatIncluded} onChange={(e) => setVatIncluded(e.target.checked)} className="mt-0.5 size-5 accent-primary" />
					<span>Los precios del catálogo ya incluyen IVA (13%)</span>
				</label>
				<fieldset className="flex flex-col gap-2 text-sm">
					<legend className="mb-1 font-medium">Ambiente de Hacienda</legend>
					<label className="flex min-h-11 items-center gap-3">
						<input type="radio" name="env" checked={environment === "00"} onChange={() => setEnvironment("00")} className="size-5 accent-primary" />
						Pruebas (sin validez fiscal)
					</label>
					<label className="flex min-h-11 items-center gap-3">
						<input type="radio" name="env" checked={environment === "01"} onChange={() => setConfirmingProduction(true)} className="size-5 accent-primary" />
						Producción
					</label>
					{environment !== savedEnvironment
						? <p className="text-xs text-muted-foreground">Guarda y luego sube las credenciales de {ENV_LABEL[environment]}. Su numeración empieza aparte.</p>
						: null}
				</fieldset>
				<label className="flex min-h-11 items-start gap-3 text-sm">
					<input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="mt-0.5 size-5 accent-primary" />
					<span>
						<span className="font-medium">Emitir DTE al entregar</span>
						<span className="block text-muted-foreground">Cada pedido entregado se factura solo. Necesita los datos de arriba y las credenciales.</span>
					</span>
				</label>

				{message
					? <p role={message.ok ? "status" : "alert"} className={`text-sm font-medium ${message.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}>{message.text}</p>
					: null}
				<Button type="submit" className="h-11 self-start md:h-9" disabled={saving}>
					{saving ? <><Loader2 className="animate-spin" />Guardando…</> : "Guardar"}
				</Button>
			</form>

			<form onSubmit={saveCredentials} noValidate className="flex flex-col gap-4 border-t pt-8">
				<div className="flex flex-col gap-1">
					<h2 className="text-base font-semibold">Credenciales de Hacienda</h2>
					<p className="text-sm text-muted-foreground">
						{credStatus.configured
							? <><CheckCircle2 className="mr-1 inline size-4 text-emerald-600" />Configuradas para {ENV_LABEL[credStatus.environment ?? ""] ?? "otro ambiente"}{credStatus.updated_at ? ` · ${formatOrderTimestamp(credStatus.updated_at)}` : ""}. Se guardan cifradas y no se vuelven a mostrar. Llena solo lo que quieras cambiar.</>
							: "Del ambiente que elegiste arriba (factura.gob.sv → Certificado). Se guardan cifradas y no se vuelven a mostrar."}
					</p>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="co-cert">Certificado (.crt)</Label>
					<Input id="co-cert" type="file" accept=".crt,.xml,text/xml" className="h-11 md:h-9"
						onChange={async (e) =>
						{
							const file = e.target.files?.[0];
							setCert(file ? await file.text() : null);
							setCertName(file?.name ?? "");
						}} />
					{certName ? <p className="text-xs text-muted-foreground">{certName}</p> : null}
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="co-key">Contraseña de la clave privada</Label>
					<Input id="co-key" type="password" autoComplete="off" value={keyPassword} onChange={(e) => setKeyPassword(e.target.value)} className="h-11 md:h-9" />
				</div>
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="co-api">Contraseña API</Label>
					<Input id="co-api" type="password" autoComplete="off" value={apiPassword} onChange={(e) => setApiPassword(e.target.value)} className="h-11 md:h-9" />
				</div>
				{credMessage
					? <p role={credMessage.ok ? "status" : "alert"} className={`text-sm font-medium ${credMessage.ok ? "text-emerald-700 dark:text-emerald-400" : "text-destructive"}`}>{credMessage.text}</p>
					: null}
				<Button type="submit" variant="outline" className="h-11 self-start md:h-9" disabled={credSaving || (!cert && !keyPassword && !apiPassword)}>
					{credSaving ? <><Loader2 className="animate-spin" />Guardando…</> : "Guardar credenciales"}
				</Button>
			</form>

			<Dialog open={confirmingProduction} onOpenChange={setConfirmingProduction}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>¿Pasar a Producción?</DialogTitle>
						<DialogDescription>
							Desde que guardes, cada pedido entregado genera una factura real ante Hacienda, con validez fiscal y a nombre de la empresa. Hazlo solo cuando Hacienda haya autorizado a la empresa como emisor y tengas el certificado y la contraseña API de producción.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<Button type="button" variant="outline" className="h-11 md:h-9" onClick={() => setConfirmingProduction(false)}>Seguir en Pruebas</Button>
						<Button type="button" className="h-11 md:h-9" onClick={() =>
						{
							setEnvironment("01");
							setConfirmingProduction(false);
						}}>Pasar a Producción</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
