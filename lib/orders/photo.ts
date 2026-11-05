const MAX_SIDE = 1600;
const MAX_BYTES = 5 * 1024 * 1024; // bucket limit; the picker catch shows the Spanish message

/** Phone cameras give 5-10MB images: shrink to ~1600px JPEG before uploading. */
export async function downscalePhoto(file: File): Promise<Blob>
{
	const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
	const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(bitmap.width * scale);
	canvas.height = Math.round(bitmap.height * scale);
	canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
	bitmap.close();
	return new Promise((resolve, reject) =>
		canvas.toBlob((blob) => (blob?.type === "image/jpeg" && blob.size <= MAX_BYTES ? resolve(blob) : reject(new Error("toBlob failed"))), "image/jpeg", 0.8));
}
