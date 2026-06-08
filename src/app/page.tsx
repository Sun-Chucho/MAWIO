import Link from 'next/link';
import { useState } from 'react';

export default function Home() {
  const [activeTab, setActiveTab] = useState<'standard' | 'platinum'>('standard');

  const tabColors = {
    standard: 'bg-blue-500 hover:bg-blue-600',
    platinum: 'bg-amber-500 hover:bg-amber-600',
  } as const;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-gray-100 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-lg">
        {/* Tab selector */}
        <div className="flex">
          <button
            type="button"
            className={`flex-1 py-3 text-center font-semibold text-white ${activeTab === 'standard' ? tabColors.standard : 'bg-gray-300'}`}
            onClick={() => setActiveTab('standard')}
          >
            Standard
          </button>
          <button
            type="button"
            className={`flex-1 py-3 text-center font-semibold text-white ${activeTab === 'platinum' ? tabColors.platinum : 'bg-gray-300'}`}
            onClick={() => setActiveTab('platinum')}
          >
            Platinum
          </button>
        </div>
        {/* Links to login pages */}
        <div className="p-6 text-center">
          <Link
            href={`/${activeTab}`}
            className="inline-block rounded bg-indigo-600 px-4 py-2 font-semibold text-white hover:bg-indigo-700"
          >
            Go to {activeTab.charAt(0).toUpperCase() + activeTab.slice(1)} Login
          </Link>
        </div>
      </div>
    </main>
  );
}
