import type {Metadata, Viewport} from 'next';
import { Manrope, Playfair_Display } from 'next/font/google';
import { Toaster } from "@/components/ui/toaster";
import './globals.css';

const manrope = Manrope({
  subsets: ['latin'],
  variable: '--font-body',
});

const playfair = Playfair_Display({
  subsets: ['latin'],
  variable: '--font-headline',
});

export const metadata: Metadata = {
  title: 'MAWIO | Secure Booking',
  description: 'Book MAWIO Standard rooms online.',
  icons: {
    icon: '/logo.png',
    shortcut: '/logo.png',
    apple: [{ url: '/logo.png', sizes: 'any', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: 'MAWIO',
    statusBarStyle: 'black-translucent',
  },
  other: {
    'mobile-web-app-capable': 'yes',
    'apple-mobile-web-app-capable': 'yes',
    'application-name': 'MAWIO',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#f57c00',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={`${manrope.variable} ${playfair.variable} font-body antialiased bg-background`} suppressHydrationWarning>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
