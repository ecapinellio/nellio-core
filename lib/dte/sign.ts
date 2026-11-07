import { createHash, createPrivateKey, sign } from "node:crypto";

/**
 * Signs a DTE the way Hacienda's firmador does: compact JWS, RS512, payload =
 * the JSON text. The key comes from the .crt Hacienda issues (an XML with
 * <privateKey><encodied> = base64 PKCS#8 and <clave> = SHA-512 hex of the
 * private key's password).
 * shortcut: format taken from the public firmador, not from the (unreadable)
 * Manual Técnico; verify against apitest with ECTEC's real certificate.
 */
export function signDte(document: unknown, certificateXml: string, keyPassword: string): string
{
	const block = /<privateKey>([\s\S]*?)<\/privateKey>/.exec(certificateXml)?.[1];
	const encoded = block && /<encodied>([\s\S]*?)<\/encodied>/.exec(block)?.[1];
	const hash = block && /<clave>([\s\S]*?)<\/clave>/.exec(block)?.[1];
	if (!encoded || !hash)
	{
		throw new Error("El certificado de Hacienda no tiene la clave privada.");
	}
	if (createHash("sha512").update(keyPassword).digest("hex") !== hash.trim().toLowerCase())
	{
		throw new Error("La contraseña de la clave privada no coincide con el certificado.");
	}
	const key = createPrivateKey({ key: Buffer.from(encoded.replace(/\s/g, ""), "base64"), format: "der", type: "pkcs8" });

	const b64 = (s: string) => Buffer.from(s).toString("base64url");
	const input = `${b64(JSON.stringify({ alg: "RS512" }))}.${b64(JSON.stringify(document))}`;
	return `${input}.${sign("sha512", Buffer.from(input), key).toString("base64url")}`;
}
