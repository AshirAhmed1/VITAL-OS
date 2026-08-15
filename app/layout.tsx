import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { AuthProvider } from "@/components/auth-provider";
import { AppGate } from "@/components/app-gate";
import { ThemeProvider } from "@/components/theme-provider";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
});

export const metadata: Metadata = {
  title: "VITAL OS",
  description:
    "VITAL OS clinical workstation for ambient voice-driven patient charting and retrieval.",
  applicationName: "VITAL OS",
  keywords: [
    "clinical AI",
    "speech to speech",
    "doctor assistant",
    "SOAP note",
    "Gemini",
    "VITAL OS",
  ],
  authors: [{ name: "VITAL OS" }],
  icons: {
    icon: "/favicon.png",
    shortcut: "/favicon.png",
    apple: "/favicon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F8FAFC" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0612" },
  ],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans antialiased text-foreground" suppressHydrationWarning>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          storageKey="vital-os-theme"
          disableTransitionOnChange={false}
        >
          <AuthProvider>
            <AppGate>{children}</AppGate>
          </AuthProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
