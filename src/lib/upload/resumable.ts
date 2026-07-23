import * as tus from "tus-js-client";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

// Supabase Storage requires exactly 6 MB chunks on the resumable (TUS) endpoint.
const TUS_CHUNK_SIZE = 6 * 1024 * 1024;

// Large files (videos) go through the resumable protocol: the upload happens in
// 6 MB chunks and survives connection drops by retrying from the last confirmed
// chunk, instead of restarting a single long request from zero.
export async function uploadResumable(
  storageKey: string,
  file: File,
  onProgress?: (percentage: number) => void,
) {
  const supabase = getSupabaseBrowserClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session) throw new Error("Inicia sesión para cargar contenido.");

  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000],
      chunkSize: TUS_CHUNK_SIZE,
      headers: {
        authorization: `Bearer ${session.access_token}`,
        "x-upsert": "false",
      },
      metadata: {
        bucketName: "media",
        objectName: storageKey,
        contentType: file.type,
        cacheControl: "3600",
      },
      removeFingerprintOnSuccess: true,
      onError: (error) => reject(error),
      onProgress: (bytesUploaded, bytesTotal) => {
        onProgress?.(Math.round((bytesUploaded / bytesTotal) * 100));
      },
      onSuccess: () => resolve(),
    });

    // Resume a previously interrupted upload of the same file when possible.
    void upload.findPreviousUploads().then((previous) => {
      if (previous.length > 0) upload.resumeFromPreviousUpload(previous[0]);
      upload.start();
    });
  });
}
