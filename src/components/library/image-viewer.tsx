/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useRef, useState } from "react";

type ImageViewerProps = {
  mediaId: string;
  src: string;
  alt: string;
  title: string;
  englishTitle?: string | null;
};

export function ImageViewer({ mediaId, src, alt, title, englishTitle = null }: ImageViewerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [hasError, setHasError] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleOpenImage(event: Event) {
      const detail = (event as CustomEvent<{ mediaId?: string }>).detail;
      if (detail.mediaId !== mediaId) return;
      setHasError(false);
      setIsOpen(true);
    }

    window.addEventListener("deacon:open-image", handleOpenImage);
    return () => window.removeEventListener("deacon:open-image", handleOpenImage);
  }, [mediaId]);

  useEffect(() => {
    if (!isOpen) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButtonRef.current?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setIsOpen(false);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen]);

  function openViewer() {
    setHasError(false);
    setIsOpen(true);
  }

  return (
    <>
      <button
        type="button"
        className="media-image-button"
        onClick={openViewer}
        aria-label={`Abrir imagen: ${title}`}
      >
        <img
          src={src}
          alt={alt}
          loading="lazy"
          decoding="async"
          onError={() => setHasError(true)}
        />
        <span className="media-image-open-hint" aria-hidden="true">Ver imagen</span>
      </button>

      {isOpen ? (
        <div
          className="image-viewer-backdrop"
          role="presentation"
          onClick={() => setIsOpen(false)}
        >
          <div
            className="image-viewer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="image-viewer-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="image-viewer-toolbar">
              <div className="image-viewer-heading">
                <strong id="image-viewer-title">{title}</strong>
                {englishTitle ? <span>{englishTitle}</span> : null}
              </div>
              <button
                ref={closeButtonRef}
                type="button"
                className="image-viewer-close"
                onClick={() => setIsOpen(false)}
                aria-label="Cerrar imagen"
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>

            <div className="image-viewer-stage">
              {hasError ? (
                <div className="image-viewer-error" role="alert">
                  <strong>No se pudo cargar esta imagen.</strong>
                  <button type="button" onClick={() => setHasError(false)}>Reintentar</button>
                </div>
              ) : (
                <img
                  src={src}
                  alt={alt}
                  className="image-viewer-image"
                  draggable="false"
                  decoding="async"
                  onError={() => setHasError(true)}
                />
              )}
            </div>

            <p className="image-viewer-help">Pellizca para ampliar · toca fuera para cerrar</p>
          </div>
        </div>
      ) : null}
    </>
  );
}
