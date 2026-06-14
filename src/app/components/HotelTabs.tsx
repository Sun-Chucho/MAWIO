"use client";

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { Download, Smartphone, Info } from 'lucide-react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export default function HotelTabs() {
  const [activeTab, setActiveTab] = useState<'standard' | 'platinum'>('standard');
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [installFeedback, setInstallFeedback] = useState("");
  const [isStandaloneApp, setIsStandaloneApp] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const standalone = window.matchMedia("(display-mode: standalone)").matches;
    setIsStandaloneApp(standalone);

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    };
  }, []);

  const handleInstallApp = async () => {
    if (installPrompt) {
      await installPrompt.prompt();
      const choice = await installPrompt.userChoice;
      setInstallPrompt(null);
      if (choice.outcome === "accepted") {
        setInstallFeedback("MAWIO is being installed successfully!");
      } else {
        setInstallFeedback("Installation dismissed.");
      }
    } else {
      setInstallFeedback("Please use your browser's menu to install MAWIO as a PWA app.");
    }
  };

  const standardLinks = [
    { name: "Barista POS", url: "/SBAR" },
    { name: "Reception Booking", url: "/SRB" },
    { name: "Standard Kitchen", url: "/SKIT" },
    { name: "Standard Inventory Manager", url: "/SIM" },
  ];

  const premiumLinks = [
    { name: "Premium Barista POS", url: "/PBAR" },
    { name: "Premium Reception Booking", url: "/PRB" },
    { name: "Premium Kitchen POS", url: "/PKIT" },
    { name: "Premium Inventory Manager", url: "/PIM" },
  ];

  const currentLinks = activeTab === 'standard' ? standardLinks : premiumLinks;

  return (
    <main
      className="flex min-h-screen flex-col items-center justify-center p-4 bg-cover bg-center bg-no-repeat relative"
      style={{
        backgroundImage: "linear-gradient(rgba(0, 0, 0, 0.65), rgba(0, 0, 0, 0.65)), url('/logo.png')",
        backgroundSize: "contain",
      }}
    >
      <div className="w-full max-w-lg rounded-2xl bg-white/95 backdrop-blur shadow-2xl overflow-hidden border border-white/20">
        {/* Title / Branding */}
        <div className="p-6 text-center border-b border-gray-100 bg-gray-50/50">
          <h1 className="text-3xl font-black tracking-tight text-gray-900">MAWIO</h1>
          <p className="text-xs font-bold uppercase tracking-wider text-gray-500 mt-1">Smart Hotel Management Suite</p>
        </div>

        {/* Tab selector */}
        <div className="flex bg-gray-100 p-1 m-4 rounded-xl">
          <button
            type="button"
            className={`flex-1 py-3 text-center font-bold text-sm rounded-lg transition-all duration-200 ${
              activeTab === 'standard'
                ? 'bg-blue-600 text-white shadow'
                : 'text-gray-600 hover:text-gray-950'
            }`}
            onClick={() => setActiveTab('standard')}
          >
            Standard Dashboard
          </button>
          <button
            type="button"
            className={`flex-1 py-3 text-center font-bold text-sm rounded-lg transition-all duration-200 ${
              activeTab === 'platinum'
                ? 'bg-amber-600 text-white shadow'
                : 'text-gray-600 hover:text-gray-950'
            }`}
            onClick={() => setActiveTab('platinum')}
          >
            Premium Dashboard
          </button>
        </div>

        {/* Links to login pages */}
        <div className="px-6 pb-6 pt-2 space-y-3">
          <p className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">Available Portals</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {currentLinks.map((link) => (
              <Link
                key={link.name}
                href={link.url}
                className={`flex items-center justify-center p-4 rounded-xl font-bold text-center border text-sm transition-all duration-200 ${
                  activeTab === 'standard'
                    ? 'border-blue-150 bg-blue-50/50 text-blue-900 hover:bg-blue-600 hover:text-white hover:border-blue-600'
                    : 'border-amber-150 bg-amber-50/50 text-amber-900 hover:bg-amber-600 hover:text-white hover:border-amber-600'
                }`}
              >
                {link.name}
              </Link>
            ))}
          </div>

          {/* Chrome PWA Install Button inside the app */}
          {!isStandaloneApp && (
            <div className="mt-6 pt-5 border-t border-gray-100">
              <div className="bg-emerald-50 rounded-xl p-4 border border-emerald-100 text-left">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-600 text-white shadow-sm">
                    <Smartphone className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-emerald-950">Install MAWIO App</h3>
                    <p className="text-xs font-medium text-emerald-800/80 mt-1 leading-relaxed">
                      Install this app on Chrome/Browser to access offline modes, shortcuts, and instant launch.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleInstallApp}
                  className="mt-3 flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 active:bg-emerald-800 font-bold text-xs uppercase tracking-wider transition-colors shadow-sm"
                >
                  <Download className="h-4 w-4" />
                  {installPrompt ? "Install Now" : "Show Install Steps"}
                </button>

                {installFeedback && (
                  <p className="mt-2 text-xs font-semibold text-emerald-800/90 flex items-center gap-1.5 bg-white/50 px-2 py-1 rounded">
                    <Info className="h-3 w-3 shrink-0" /> {installFeedback}
                  </p>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
