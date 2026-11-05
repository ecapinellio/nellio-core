"use client";

import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";

/** Draws with the finger; reports the PNG when a stroke ends, null when cleared. */
export function SignaturePad({ onChange }: { onChange: (blob: Blob | null) => void })
{
	const canvas = useRef<HTMLCanvasElement>(null);
	const drawing = useRef(false);

	function paintBackground()
	{
		const c = canvas.current!;
		const ctx = c.getContext("2d")!;
		// White on purpose: the proof must read the same in dark mode.
		ctx.fillStyle = "#fff";
		ctx.fillRect(0, 0, c.width, c.height);
		ctx.strokeStyle = "#09090b";
		ctx.lineWidth = 2.5 * (window.devicePixelRatio || 1);
		ctx.lineCap = "round";
		ctx.lineJoin = "round";
	}

	useEffect(() =>
	{
		const c = canvas.current!;
		const ratio = window.devicePixelRatio || 1;
		c.width = c.clientWidth * ratio;
		c.height = c.clientHeight * ratio;
		paintBackground();
	}, []);

	function point(e: React.PointerEvent<HTMLCanvasElement>)
	{
		const rect = canvas.current!.getBoundingClientRect();
		const ratio = canvas.current!.width / rect.width;
		return [(e.clientX - rect.left) * ratio, (e.clientY - rect.top) * ratio] as const;
	}

	function start(e: React.PointerEvent<HTMLCanvasElement>)
	{
		e.currentTarget.setPointerCapture(e.pointerId);
		drawing.current = true;
		const ctx = canvas.current!.getContext("2d")!;
		const [x, y] = point(e);
		ctx.beginPath();
		ctx.moveTo(x, y);
		ctx.lineTo(x + 0.01, y); // a tap leaves a dot
		ctx.stroke();
	}

	function move(e: React.PointerEvent<HTMLCanvasElement>)
	{
		if (!drawing.current)
		{
			return;
		}
		const ctx = canvas.current!.getContext("2d")!;
		const [x, y] = point(e);
		ctx.lineTo(x, y);
		ctx.stroke();
	}

	function end()
	{
		if (drawing.current)
		{
			drawing.current = false;
			canvas.current!.toBlob(onChange, "image/png");
		}
	}

	function clear()
	{
		paintBackground();
		onChange(null);
	}

	return (
		<div className="flex flex-col gap-2">
			<canvas
				ref={canvas}
				role="img"
				aria-label="Espacio para firmar con el dedo"
				className="h-40 w-full touch-none rounded-md border border-border"
				onPointerDown={start}
				onPointerMove={move}
				onPointerUp={end}
				onPointerCancel={end}
			/>
			<Button type="button" variant="secondary" className="h-11 self-start" onClick={clear}>Borrar</Button>
		</div>
	);
}
