import { redirect } from "next/navigation";
import Link from "next/link";
import { AppNav } from "@/components/app/app-nav";
import { InlineSearch } from "@/components/search/inline-search";
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
      <AppNav />
      <section className="page-intro">
        <Link className="back-link" href="/library">
          ← Volver a la biblioteca
        </Link>
        <p className="eyebrow">Encuentra cualquier cosa</p>
        <h1>Busca en tu conocimiento.</h1>
        <p className="lede">Busca en el contenido visible de tus imágenes, transcripciones y notas.</p>
      </section>
      <InlineSearch />
    </main>
  );
}
