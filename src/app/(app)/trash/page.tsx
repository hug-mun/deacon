import Link from "next/link";
import { redirect } from "next/navigation";
import { AppNav } from "@/components/app/app-nav";
import { TrashList } from "@/components/library/trash-list";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function TrashPage() {
  const supabase = await getSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login?reason=session_missing");

  return (
    <main className="library-shell">
      <AppNav />
      <header className="page-intro">
        <p className="eyebrow">Papelera</p>
        <h1>Contenido borrado.</h1>
        <p className="lede">Puedes recuperar imágenes y documentos durante 30 días.</p>
      </header>
      <TrashList />
      <Link className="back-link trash-back-link" href="/library">← Volver a la biblioteca</Link>
    </main>
  );
}
