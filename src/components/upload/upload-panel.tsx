"use client";

import { ChangeEvent, DragEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { sha256File } from "@/lib/upload/hash";
import { appPath } from "@/lib/app-path";

type UploadStage =
  | "idle"
  | "hashing"
  | "preparing"
  | "uploading"
  | "finalizing"
  | "done"
  | "error";

function localDate() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

async function normalizeUploadFile(file: File) {
  if (file.type !== "image/heic") return file;

  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
    if (!blob) throw new Error("conversion_failed");
    return new File([blob], file.name.replace(/\.heic$/i, ".jpg"), { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    throw new Error("Este iPad entregó una imagen HEIC que el navegador no pudo convertir. Guárdala como JPG e inténtalo de nuevo.");
  }
}

async function getErrorMessage(response: Response) {
  try {
    const body = await response.json();
    return body.error?.message ?? "No se pudo completar la carga.";
  } catch {
    return "No se pudo completar la carga.";
  }
}

export function UploadPanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);
  const [stage, setStage] = useState<UploadStage>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [fileCount, setFileCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  async function uploadOne(selectedFile: File) {
    console.info("[deacon][upload] selected file", {
      filename: selectedFile.name,
      mimeType: selectedFile.type,
      sizeBytes: selectedFile.size,
    });

    const file = await normalizeUploadFile(selectedFile);
    const fileHash = await sha256File(file);
    setStage("preparing");
    console.info("[deacon][upload] hash computed", {
      filename: file.name,
      fileHashPrefix: fileHash.slice(0, 8),
    });

    const prepareResponse = await fetch(appPath("/api/uploads/prepare"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        session_date: localDate(),
        filename: file.name,
        mime_type: file.type,
        size_bytes: file.size,
        file_hash: fileHash,
      }),
    });

    if (!prepareResponse.ok) throw new Error(await getErrorMessage(prepareResponse));

    const prepared = await prepareResponse.json();
    console.info("[deacon][upload] prepare response", {
      duplicate: prepared.duplicate,
      mediaId: prepared.media?.id ?? prepared.existing?.id,
    });
    if (prepared.duplicate) return "duplicate" as const;

    setStage("uploading");
    console.info("[deacon][upload] uploading to storage", {
      mediaId: prepared.media.id,
      storageKey: prepared.media.storage_key,
    });
    const supabase = getSupabaseBrowserClient();
    const { error: storageError } = await supabase.storage
      .from("media")
      .upload(prepared.media.storage_key, file, {
        contentType: file.type,
        upsert: false,
      });

    if (storageError) throw new Error("No se pudo guardar el archivo en el almacenamiento.");

    setStage("finalizing");
    console.info("[deacon][upload] storage upload complete; finalizing", {
      mediaId: prepared.media.id,
    });
    const completeResponse = await fetch(appPath("/api/uploads/complete"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media_id: prepared.media.id }),
    });

    if (!completeResponse.ok) throw new Error(await getErrorMessage(completeResponse));
    console.info("[deacon][upload] complete", { mediaId: prepared.media.id });
    return "added" as const;
  }

  async function handleFiles(selectedFiles: File[]) {
    if (selectedFiles.length === 0) return;

    setMessage(null);
    setFileCount(selectedFiles.length);
    setStage("hashing");
    let added = 0;
    let duplicates = 0;
    const failures: string[] = [];

    for (const selectedFile of selectedFiles) {
      try {
        const result = await uploadOne(selectedFile);
        if (result === "added") added += 1;
        if (result === "duplicate") duplicates += 1;
      } catch (error) {
        console.error("[deacon][upload] failed", { filename: selectedFile.name, error });
        failures.push(`${selectedFile.name}: ${error instanceof Error ? error.message : "No se pudo cargar."}`);
      }
    }

    setStage(failures.length > 0 ? "error" : "done");
    setMessage(
      failures.length > 0
        ? "No se pudo añadir uno o más archivos."
        : duplicates > 0 && added === 0
          ? "Ese archivo ya está en tu biblioteca."
          : "Añadido.",
    );
    if (added > 0) router.refresh();
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files ?? []);
    event.target.value = "";
    await handleFiles(selectedFiles);
  }

  function handleDragEnter(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }

  function handleDragLeave(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setIsDragging(false);
    }
  }

  async function handleDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    await handleFiles(Array.from(event.dataTransfer.files));
  }

  const isBusy = ["hashing", "preparing", "uploading", "finalizing"].includes(
    stage,
  );
  const actionLabel = isBusy
    ? `Añadiendo ${fileCount > 1 ? `${fileCount} archivos` : "archivo"}…`
    : "Añadir";

  return (
    <div className="upload-panel">
      <button
        className="nav-upload-button"
        type="button"
        onClick={() => setIsOpen((open) => !open)}
        disabled={isBusy}
        aria-expanded={isOpen}
        aria-controls="upload-popover"
      >
        <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
          <path d="M12 5v14M5 12h14" />
        </svg>
        <span>{actionLabel}</span>
      </button>

      {isOpen ? (
        <div className="upload-popover" id="upload-popover">
          <button
            className="upload-close"
            type="button"
            onClick={() => setIsOpen(false)}
            aria-label="Cerrar añadir contenido"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" focusable="false">
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
          <label
            className={`upload-dropzone ${isDragging ? "is-dragging" : ""}`}
            htmlFor="library-file-upload"
            onDragEnter={handleDragEnter}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <span className="upload-drop-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" focusable="false">
                <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
              </svg>
            </span>
            <strong>Añadir contenido</strong>
            <span>Arrastra archivos aquí o toca para elegirlos</span>
            <small>PDF, JPG, PNG o HEIC</small>
          </label>
          <input
            id="library-file-upload"
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/heic"
            multiple
            onChange={handleFileChange}
          />
          {message ? (
            <p
              className={`upload-message ${stage === "error" ? "error" : "success"}`}
              role="status"
            >
              {message}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
