import type { Metadata } from "next";
import Link from "next/link";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Recovery Console",
  description: "Detect, diagnose and recover failed payments — with every decision auditable.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${sans.variable} ${mono.variable} antialiased`}>
        <div className="sticky top-0 z-40 border-b border-white/6 bg-[#0a0c10]/70 backdrop-blur-xl">
          <div className="mx-auto flex h-12 max-w-[1240px] items-center justify-between px-6">
            <Link href="/" className="group flex items-center gap-2.5">
              <span
                aria-hidden
                className="grid size-6 place-items-center rounded-md bg-linear-to-b from-white/14 to-white/4 ring-1 ring-inset ring-white/12 shadow-[0_1px_2px_rgba(0,0,0,0.5)]"
              >
                <span className="size-2 rounded-[3px] bg-emerald-400 shadow-[0_0_8px_1px_var(--color-emerald-400)]" />
              </span>
              <span className="text-[13px] font-semibold tracking-tight text-foreground/90 transition-colors group-hover:text-foreground">
                Recovery Console
              </span>
            </Link>
            <span className="text-muted-foreground/70 hidden text-[11px] tracking-wide sm:inline">
              Detect · Diagnose · Decide · Validate · Act · Observe
            </span>
          </div>
        </div>
        {children}
      </body>
    </html>
  );
}
