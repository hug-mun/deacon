import { redirect } from "next/navigation";
import { AppNav } from "@/components/app/app-nav";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function SearchPage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login?reason=session_missing");
  }

  return (
    <main className="library-shell">
      <AppNav active="search" />
      <section className="page-intro">
        <p className="eyebrow">Find anything</p>
        <h1>Search your knowledge.</h1>
        <p className="lede">Search will look across transcripts, screenshots, and notes as they become ready.</p>
      </section>
      <form className="search-form">
        <label htmlFor="search-query">Search your library</label>
        <div className="search-input-row">
          <input id="search-query" name="q" type="search" placeholder="Try “what did the instructor say about…”" disabled />
          <button type="button" disabled>Search</button>
        </div>
      </form>
      <section className="coming-soon-card">
        <p className="empty-state-icon">⌕</p>
        <h2>Search is next</h2>
        <p>We’ll connect this screen to OCR, transcripts, and embeddings in the next processing phases.</p>
      </section>
    </main>
  );
}
