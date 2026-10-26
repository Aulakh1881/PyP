import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pyp",
  description:
    "The agentic AI that runs your PayPal business, within your rules. An independent hackathon project, not affiliated with PayPal.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
