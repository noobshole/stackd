import type { Metadata, Viewport } from 'next';
import { Fraunces, Inter } from 'next/font/google';
import { Providers } from '@/components/providers';
import './globals.css';

// All UI text.
const inter = Inter({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-inter',
  display: 'swap',
});

// Logo and landing hero only.
const fraunces = Fraunces({
  subsets: ['latin'],
  weight: ['300'],
  style: ['italic'],
  variable: '--font-fraunces',
  display: 'swap',
});

export const metadata: Metadata = {
  title: {
    default: 'Stackd — turn receipts into equity',
    template: '%s · Stackd',
  },
  description:
    "Upload a receipt from McDonald's, Amazon, Nike, Costco and more, and get real tokenized shares back on Solana. Up to 4% of every purchase, in stock.",
  openGraph: {
    title: 'Stackd — turn receipts into equity',
    description:
      'Cashback that compounds. Upload a receipt, receive tokenized shares of the brand you just shopped at.',
    type: 'website',
  },
  icons: {
    icon: [{ url: '/icon.svg', type: 'image/svg+xml' }],
  },
};

export const viewport: Viewport = {
  themeColor: '#F7F5F0',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${fraunces.variable}`}>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
