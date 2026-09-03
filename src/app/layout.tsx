import type { Metadata, Viewport } from "next";
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
  title: "Flightscape - see your journey differently",
  description:
    "Watch a real aircraft flying right now, placed accurately on a 3D Earth, and switch the world around it.",
};

export const viewport: Viewport = {
  themeColor: "#04070d",
  // The globe fills the screen; a zoomable page would fight the map gestures.
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body className="h-full overflow-hidden bg-void text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
