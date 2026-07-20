import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Deacon",
  description: "Una base de conocimiento privada para clases magistrales.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
