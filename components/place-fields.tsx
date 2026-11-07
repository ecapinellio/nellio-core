"use client";

import { DEPARTMENTS, DISTRICTS, MUNICIPALITIES, type Place } from "@/lib/dte/places";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type PlaceField = "department_code" | "municipality_code" | "district_code";
export type PlaceValues = Record<PlaceField, string>;

/**
 * Departamento → municipio → distrito (Hacienda's CAT-012/013/008), for the
 * DTE address. Changing the departamento clears the other two: their codes
 * only mean something inside it, so `onChange` runs three times in a row:
 * callers must use functional state updates.
 */
export function PlaceFields({
	values,
	onChange,
	idPrefix,
}: {
	values: PlaceValues;
	onChange: (field: PlaceField, value: string) => void;
	idPrefix: string;
})
{
	const dep = values.department_code;
	const select = (field: PlaceField, label: string, options: readonly Place[], disabled = false) =>
	{
		const id = `${idPrefix}-${field}`;
		return (
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={id}>{label}</Label>
				<Select value={values[field] || undefined} onValueChange={(v) => onChange(field, v)} disabled={disabled}>
					<SelectTrigger id={id} className="h-11 w-full md:h-9">
						<SelectValue placeholder={disabled ? "Elige el departamento" : "Elegir"} />
					</SelectTrigger>
					<SelectContent>
						{options.map((p) => <SelectItem key={p.code} value={p.code}>{p.name}</SelectItem>)}
					</SelectContent>
				</Select>
			</div>
		);
	};

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor={`${idPrefix}-department_code`}>Departamento</Label>
				<Select
					value={dep || undefined}
					onValueChange={(v) =>
					{
						onChange("department_code", v);
						onChange("municipality_code", "");
						onChange("district_code", "");
					}}
				>
					<SelectTrigger id={`${idPrefix}-department_code`} className="h-11 w-full md:h-9">
						<SelectValue placeholder="Elegir" />
					</SelectTrigger>
					<SelectContent>
						{DEPARTMENTS.map((p) => <SelectItem key={p.code} value={p.code}>{p.name}</SelectItem>)}
					</SelectContent>
				</Select>
			</div>
			{select("municipality_code", "Municipio", MUNICIPALITIES.filter((m) => m.department === dep), !dep)}
			{select("district_code", "Distrito", DISTRICTS.filter((d) => d.department === dep), !dep)}
		</div>
	);
}
