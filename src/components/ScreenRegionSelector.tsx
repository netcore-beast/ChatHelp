"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { NormalizedCropRegion } from "@/lib/localOcr";

interface ScreenRegionSelectorProps {
  image: Blob;
  contactName: string;
  purpose: "profile" | "chat";
  onConfirm: (region: NormalizedCropRegion) => void;
  onCancel: () => void;
}

const DEFAULT_CHAT_REGION: NormalizedCropRegion = { x: 0.28, y: 0.1, width: 0.44, height: 0.8 };
const DEFAULT_PROFILE_REGION: NormalizedCropRegion = { x: 0.2, y: 0.08, width: 0.6, height: 0.84 };

function pointInSurface(event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width)),
    y: Math.min(1, Math.max(0, (event.clientY - bounds.top) / bounds.height)),
  };
}

export function ScreenRegionSelector({ image, contactName, purpose, onConfirm, onCancel }: ScreenRegionSelectorProps) {
  const [imageUrl] = useState(() => URL.createObjectURL(image));
  const [region, setRegion] = useState<NormalizedCropRegion>(() => purpose === "chat" ? DEFAULT_CHAT_REGION : DEFAULT_PROFILE_REGION);
  const dragStart = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    return () => URL.revokeObjectURL(imageUrl);
  }, [imageUrl]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onCancel]);

  function startSelection(event: ReactPointerEvent<HTMLDivElement>) {
    const point = pointInSurface(event);
    dragStart.current = point;
    event.currentTarget.setPointerCapture(event.pointerId);
    setRegion({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  function moveSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (!dragStart.current) return;
    const point = pointInSurface(event);
    const start = dragStart.current;
    setRegion({
      x: Math.min(start.x, point.x),
      y: Math.min(start.y, point.y),
      width: Math.abs(point.x - start.x),
      height: Math.abs(point.y - start.y),
    });
  }

  function endSelection(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragStart.current = null;
  }

  const valid = region.width >= 0.08 && region.height >= 0.08;
  const subject = purpose === "chat" ? `${contactName}'s message history` : `${contactName}'s profile information`;

  return <div className="crop-backdrop" role="dialog" aria-modal="true" aria-labelledby="crop-title">
    <section className="crop-dialog">
      <div className="crop-header">
        <div><p className="eyebrow">LOCAL PRIVACY CROP</p><h2 id="crop-title">Select only {subject}</h2></div>
        <button aria-label="Cancel screen-area selection" onClick={onCancel}>×</button>
      </div>
      <p className="crop-instructions">Drag a box around only the {purpose === "chat" ? "central message column, including speaker names, dates, and messages" : "main profile details you want DialogMint to use"}. Exclude LinkedIn navigation, other conversations, job suggestions, and side panels. The screenshot and crop remain on this device.</p>
      <div className="crop-image-shell">
        <div className="crop-surface" data-testid="crop-surface" onPointerDown={startSelection} onPointerMove={moveSelection} onPointerUp={endSelection} onPointerCancel={endSelection}>
          {/* A private blob preview cannot be optimized by next/image. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={imageUrl} alt="Captured screen; drag to select the relevant area" draggable={false} />
          <div className="crop-selection" style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }}><span>OCR only this area</span></div>
        </div>
      </div>
      <div className="crop-actions"><button onClick={onCancel}>Cancel</button><button className="primary" disabled={!valid} onClick={() => onConfirm(region)}>Use selected {purpose === "chat" ? "message area" : "profile area"}</button></div>
    </section>
  </div>;
}
