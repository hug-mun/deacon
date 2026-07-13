"use client";

import { ChangeEvent, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { sha256File } from "@/lib/upload/hash";

type UploadStage = "idle" | "hashing" | "preparing" | "uploading" | "finalizing" | "done" | "error";

function localDate() {
  const date = new Date();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

async function getErrorMessage(response: Response) {
  try {
    const body = await response.json();
    return body.error?.message ?? "The upload could not be completed.";
  } catch {
    return "The upload could not be completed.";
  }
}

export function UploadPanel() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<UploadStage>("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";

    if (!file) return;

    setMessage(null);
    setStage("hashing");

    try {
      const fileHash = await sha256File(file);
      setStage("preparing");

      const sessionResponse = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_date: localDate() }),
      });

      if (!sessionResponse.ok) {
        throw new Error(await getErrorMessage(sessionResponse));
      }

      const { session } = await sessionResponse.json();
      const prepareResponse = await fetch("/api/uploads/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: session.id,
          filename: file.name,
          mime_type: file.type,
          size_bytes: file.size,
          file_hash: fileHash,
        }),
      });

      if (!prepareResponse.ok) {
        throw new Error(await getErrorMessage(prepareResponse));
      }

      const prepared = await prepareResponse.json();
      if (prepared.duplicate) {
        setStage("done");
        setMessage("You already have this image in your library.");
        return;
      }

      setStage("uploading");
      const supabase = getSupabaseBrowserClient();
      const { error: storageError } = await supabase.storage
        .from("media")
        .upload(prepared.media.storage_key, file, {
          contentType: file.type,
          upsert: false,
        });

      if (storageError) {
        throw new Error(storageError.message);
      }

      setStage("finalizing");
      const completeResponse = await fetch("/api/uploads/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ media_id: prepared.media.id }),
      });

      if (!completeResponse.ok) {
        throw new Error(await getErrorMessage(completeResponse));
      }

      setStage("done");
      setMessage("Image added. It is getting ready for processing.");
      router.refresh();
    } catch (error) {
      setStage("error");
      setMessage(error instanceof Error ? error.message : "The upload could not be completed.");
    }
  }

  const isBusy = ["hashing", "preparing", "uploading", "finalizing"].includes(stage);
  const actionLabel = isBusy ? "Adding image…" : "Add an image";

  return (
    <section className="upload-panel" aria-labelledby="upload-heading">
      <div>
        <p className="eyebrow">Add to your library</p>
        <h2 id="upload-heading">Start with a screenshot.</h2>
        <p>Select one image from your phone or computer. We’ll create its session automatically.</p>
      </div>
      <button type="button" onClick={() => inputRef.current?.click()} disabled={isBusy}>
        {actionLabel}
      </button>
      <input
        ref={inputRef}
        className="visually-hidden"
        type="file"
        accept="image/jpeg,image/png,image/heic"
        onChange={handleFileChange}
      />
      {message ? (
        <p className={`upload-message ${stage === "error" ? "error" : "success"}`} role="status">
          {message}
        </p>
      ) : null}
    </section>
  );
}
