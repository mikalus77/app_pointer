import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jarvis Time",
  description: "Application de pointage et de suivi d'activites",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" translate="no" className="h-full antialiased notranslate">
      <head>
        <meta name="google" content="notranslate" />
      </head>
      <body className="min-h-full flex flex-col notranslate">{children}</body>
    </html>
  );
}
