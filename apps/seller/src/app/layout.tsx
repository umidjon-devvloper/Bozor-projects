import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from './providers';
import { SellerHeader } from '@/components/SellerHeader';
import './globals.css';

export const metadata: Metadata = {
  title: "Bozorlar — sotuvchi kabineti",
  description: "Buyurtmalar, mahsulotlar va hisob.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="uz">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Onest:wght@400;500;600&family=Unbounded:wght@500;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <Providers>
          <SellerHeader />
          {children}
        </Providers>
      </body>
    </html>
  );
}
