"use client";

import { isValidActivityCode, isValidEmail, normalizeNrc } from "@/lib/customers/parse";
import { FISCAL_FIELDS, FISCAL_LABELS, type FiscalField } from "@/lib/customers/grid";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type FiscalValues = Record<FiscalField, string>;

const PLACEHOLDERS: Record<FiscalField, string> = {
	legal_name: "Distribuidora del Pacífico, S.A. de C.V.",
	nrc: "123456-7",
	cod_actividad: "46900",
	desc_actividad: "Venta al por mayor de productos químicos",
	email: "compras@empresa.com.sv",
};

/** Same rules as the grid's Fiscal cell and save_customers(). */
export function fiscalFieldError(field: FiscalField, value: string): string | null
{
	const v = value.trim();
	if (v === "")
	{
		return null;
	}
	switch (field)
	{
		case "nrc":
			return normalizeNrc(v) ? null : "NRC inválido (por ejemplo 123456-7)";
		case "cod_actividad":
			return isValidActivityCode(v) ? null : "Código de 5 o 6 dígitos";
		case "email":
			return isValidEmail(v) ? null : "Correo inválido";
		default:
			return v.length > 200 ? "Máximo 200 caracteres" : null;
	}
}

/** The five fiscal inputs, shared by the desktop panel and the phone sheet. */
export function FiscalFields({
	values,
	onChange,
	idPrefix,
	focusField,
}: {
	values: FiscalValues;
	onChange: (field: FiscalField, value: string) => void;
	idPrefix: string;
	/** Opened from a red Fiscal cell: land on the field with the problem. */
	focusField?: FiscalField;
})
{
	return (
		<div className="flex flex-col gap-4">
			{FISCAL_FIELDS.map((field) =>
			{
				const id = `${idPrefix}-${field}`;
				const error = fiscalFieldError(field, values[field]);
				return (
					<div key={field} className="flex flex-col gap-1.5">
						<Label htmlFor={id}>{FISCAL_LABELS[field]}</Label>
						<Input
							id={id}
							value={values[field]}
							onChange={(e) => onChange(field, e.target.value)}
							placeholder={PLACEHOLDERS[field]}
							inputMode={field === "nrc" || field === "cod_actividad" ? "numeric" : field === "email" ? "email" : undefined}
							autoFocus={field === focusField}
							aria-invalid={error ? true : undefined}
							aria-describedby={error ? `${id}-msg` : undefined}
							className={`h-11 md:h-9 ${field === "nrc" || field === "cod_actividad" ? "font-mono tabular-nums" : ""}`}
						/>
						{error ? <p id={`${id}-msg`} className="text-xs font-medium text-destructive">{error}</p> : null}
					</div>
				);
			})}
		</div>
	);
}

export function firstFiscalError(values: FiscalValues): FiscalField | undefined
{
	return FISCAL_FIELDS.find((field) => fiscalFieldError(field, values[field]) !== null);
}
