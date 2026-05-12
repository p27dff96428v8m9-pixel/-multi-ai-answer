import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "複数AIアンサー",
  description: "複数AIの回答を比較し、1つの最終回答にまとめるMVP",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
