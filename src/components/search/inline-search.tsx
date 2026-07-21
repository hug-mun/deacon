"use client";

import { FormEvent, useState } from "react";
import { appPath } from "@/lib/app-path";

type SearchResult = {
  id: string;
  media_item_id: string | null;
  original_filename: string | null;
  title_en: string | null;
  title_es: string | null;
  similarity: number;
  source_type: string;
  char_start: number | null;
  match_count: number;
  matches: Array<{
    id: string;
    char_start: number | null;
    char_end: number | null;
    score: number;
    snippet: string;
  }>;
};

const sourceLabels: Record<string, string> = {
  transcript: "Transcripción",
  image_ocr: "Texto de imagen",
  image_vision: "Descripción de imagen",
  note: "Nota",
};

export function InlineSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (query.trim().length < 2) {
      setMessage("Escribe al menos dos caracteres para buscar.");
      setNotice(null);
      setResults([]);
      return;
    }

    setIsSearching(true);
    setMessage(null);
    setNotice(null);
    try {
      const response = await fetch(appPath(`/api/search?q=${encodeURIComponent(query.trim())}`), {
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error?.message ?? "No se pudo completar la búsqueda.");
      }
      setResults(body.results ?? []);
      setNotice(body.notice?.message ?? null);
      if ((body.results ?? []).length === 0) {
        setMessage("No encontramos coincidencias en tus imágenes, transcripciones y notas.");
      }
    } catch (error) {
      setResults([]);
      setMessage(error instanceof Error ? error.message : "No se pudo completar la búsqueda.");
    } finally {
      setIsSearching(false);
    }
  }

  function openResult(result: SearchResult, match: SearchResult["matches"][number]) {
    if (!result.media_item_id) return;

    const target = document.getElementById(`media-${result.media_item_id}`);
    if (!target) return;

    if (target.matches("details")) {
      window.dispatchEvent(new CustomEvent("deacon:open-media", {
        detail: { mediaId: result.media_item_id, query, charStart: match.char_start },
      }));
      return;
    }

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add("search-result-target");
    window.setTimeout(() => target.classList.remove("search-result-target"), 1800);
  }

  const visibleMatches = results
    .flatMap((result) => result.matches.map((match) => ({ result, match })))
    .sort((left, right) => right.match.score - left.match.score)
    .slice(0, 3);

  return (
    <section className="library-search-action" aria-label="Búsqueda">
      <form className="search-bar" onSubmit={handleSearch}>
        <label className="visually-hidden" htmlFor="library-search-query">Buscar en tu biblioteca</label>
        <input
          id="library-search-query"
          name="q"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar en tu biblioteca…"
        />
        <button type="submit" disabled={isSearching} aria-label="Buscar">
          {isSearching ? "…" : "⌕"}
        </button>
      </form>
      {message ? <p className="search-message" role="status">{message}</p> : null}
      {notice ? <p className="search-notice" role="status">{notice}</p> : null}
      {visibleMatches.length > 0 ? (
        <div className="search-results" aria-live="polite">
          {visibleMatches.map(({ result, match }) => (
              <article className="search-result" key={match.id}>
                <div className="search-result-heading">
                  <strong>{result.title_es ?? result.title_en ?? result.original_filename ?? "Nota"}</strong>
                  {result.title_en && result.title_es ? <small>{result.title_en}</small> : null}
                  <small>{sourceLabels[result.source_type] ?? result.source_type}</small>
                </div>
                <span>{match.snippet}</span>
                {result.media_item_id ? (
                  <a
                    className="search-match"
                    href={`#media-${result.media_item_id}`}
                    onClick={(event) => {
                      event.preventDefault();
                      openResult(result, match);
                    }}
                  >
                    Abrir aquí →
                  </a>
                ) : null}
              </article>
          ))}
        </div>
      ) : null}
    </section>
  );
}
