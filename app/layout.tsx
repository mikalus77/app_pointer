import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Jarvis Time",
  description: "Application de pointage et de suivi d'activités",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="fr"
      translate="no"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased notranslate`}
    >
      <head>
        <meta name="google" content="notranslate" />
      </head>
      <body className="min-h-full flex flex-col notranslate">{children}</body>
    </html>
  );
}
