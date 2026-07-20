"use client";

export default function GlobalError({ reset }: { reset: () => void }) {
  return (
    <html lang="es">
      <body>
        <main
          style={{
            minHeight: "100vh",
            display: "grid",
            placeItems: "center",
            padding: "2rem",
            background: "#f5f4ef",
            color: "#22352d",
            fontFamily: "Arial, sans-serif",
          }}
        >
          <section
            role="alert"
            style={{
              width: "min(100%, 34rem)",
              padding: "2rem",
              border: "1px solid #d8ddd6",
              borderRadius: "1rem",
              background: "white",
            }}
          >
            <p style={{ color: "#467762", fontWeight: 700 }}>Deacon</p>
            <h1>La aplicación necesita volver a cargarse.</h1>
            <p>Ocurrió un problema inesperado. Tu contenido permanece guardado.</p>
            <button
              type="button"
              onClick={() => reset()}
              style={{
                marginTop: "1rem",
                padding: "0.75rem 1rem",
                border: 0,
                borderRadius: "0.65rem",
                background: "#467762",
                color: "white",
                fontWeight: 700,
              }}
            >
              Volver a intentar
            </button>
          </section>
        </main>
      </body>
    </html>
  );
}
