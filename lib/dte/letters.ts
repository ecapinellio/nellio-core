const UNITS = ["", "UNO", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE", "DIEZ",
	"ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISÉIS", "DIECISIETE", "DIECIOCHO", "DIECINUEVE", "VEINTE",
	"VEINTIUNO", "VEINTIDÓS", "VEINTITRÉS", "VEINTICUATRO", "VEINTICINCO", "VEINTISÉIS", "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE"];
const TENS = ["", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];
const HUNDREDS = ["", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS", "SEISCIENTOS",
	"SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS"];

function below1000(n: number): string
{
	if (n === 100)
	{
		return "CIEN";
	}
	const h = Math.floor(n / 100);
	const rest = n % 100;
	let words = "";
	if (rest < 30)
	{
		words = UNITS[rest];
	}
	else
	{
		words = TENS[Math.floor(rest / 10)] + (rest % 10 ? ` Y ${UNITS[rest % 10]}` : "");
	}
	return [HUNDREDS[h], words].filter(Boolean).join(" ");
}

// "UNO" before a noun is "UN": VEINTIÚN MIL, CIENTO UN MILLONES.
function asCount(words: string): string
{
	return words.replace(/VEINTIUNO$/, "VEINTIÚN").replace(/UNO$/, "UN");
}

function integerWords(n: number): string
{
	if (n === 0)
	{
		return "CERO";
	}
	const millions = Math.floor(n / 1_000_000);
	const thousands = Math.floor((n % 1_000_000) / 1000);
	const rest = n % 1000;
	const parts: string[] = [];
	if (millions)
	{
		parts.push(millions === 1 ? "UN MILLÓN" : `${asCount(integerWords(millions))} MILLONES`);
	}
	if (thousands)
	{
		parts.push(thousands === 1 ? "MIL" : `${asCount(below1000(thousands))} MIL`);
	}
	if (rest)
	{
		parts.push(below1000(rest));
	}
	return parts.join(" ");
}

/** totalLetras: 120.5 → "CIENTO VEINTE 50/100 DÓLARES". */
export function amountInWords(amount: number): string
{
	const cents = Math.round(amount * 100);
	const whole = Math.floor(cents / 100);
	return `${integerWords(whole)} ${String(cents % 100).padStart(2, "0")}/100 DÓLARES`;
}
