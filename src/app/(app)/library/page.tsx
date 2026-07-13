/* eslint-disable @next/next/no-img-element */
import { redirect } from "next/navigation";
import { AppNav } from "@/components/app/app-nav";
import { SignOutButton } from "@/components/auth/sign-out-button";
import { UploadPanel } from "@/components/upload/upload-panel";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?reason=session_missing");
  }

  const { data: mediaItems } = await supabase
    .from("media_items")
    .select("id, original_filename, storage_key, status, created_at")
    .eq("user_id", user.id)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  const media = await Promise.all(
    (mediaItems ?? []).map(async (item) => {
      const { data: signedUrl } = await supabase.storage
        .from("media")
        .createSignedUrl(item.storage_key, 300);

      return { ...item, signedUrl: signedUrl?.signedUrl ?? null };
    }),
  );

  return (
    <main className="library-shell">
      <AppNav />
      <header className="library-header">
        <div>
          <p className="eyebrow">Deacon library</p>
          <h1>Your classes.</h1>
          <p className="lede">Your recordings, screenshots, and notes will appear here.</p>
        </div>
        <SignOutButton />
      </header>
      <div id="upload-panel">
        <UploadPanel />
      </div>
      {media.length > 0 ? (
        <section className="media-section" aria-labelledby="media-heading">
          <div className="section-heading">
            <p className="eyebrow">Recent media</p>
            <h2 id="media-heading">Getting ready</h2>
          </div>
          <div className="media-grid">
            {media.map((item) => (
              <article className="media-card" key={item.id}>
                {item.signedUrl ? (
                  <img src={item.signedUrl} alt={item.original_filename} />
                ) : (
                  <div className="media-placeholder">Preview unavailable</div>
                )}
                <div className="media-card-body">
                  <strong>{item.original_filename}</strong>
                  <span>{item.status === "processing" ? "Getting ready" : item.status}</span>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}
      <section className="empty-state">
        <p className="empty-state-icon">＋</p>
        <h2>{media.length === 0 ? "Your library is empty" : "More awaits"}</h2>
        <p>
          {media.length === 0
            ? "Upload a screenshot above to create your first session."
            : "Your next recording, screenshot, or note can join this session flow."}
        </p>
      </section>
      <p className="account-line">Signed in as {user.email ?? "your account"}</p>
    </main>
  );
}
